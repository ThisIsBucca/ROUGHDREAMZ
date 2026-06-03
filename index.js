import 'dotenv/config'
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import http from 'node:http'

const PORT = process.env.PORT || 10000

http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('WhatsApp bot is running')
}).listen(PORT, () => {
    console.log(`✅ Health server listening on port ${PORT}`)
})

const RAW_TARGETS = (process.env.TARGET_GROUP_SUBJECTS || '').split(',').map(s => s.trim()).filter(Boolean)
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || '255778286840'
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER || '255776986840'

const logger = pino({ level: 'silent' })

let targetGroups = [] // [{ jid, subject }]

async function resolveTargetGroups(sock) {
    if (!RAW_TARGETS.length) return []
    try {
        const groups = await sock.groupFetchAllParticipating()
        const found = []
        for (const [jid, metadata] of Object.entries(groups)) {
            const match = RAW_TARGETS.find(
                t => t.toLowerCase() === metadata.subject?.toLowerCase()
            )
            if (match) {
                found.push({ jid, subject: metadata.subject })
            }
        }
        if (found.length < RAW_TARGETS.length) {
            const missing = RAW_TARGETS.filter(
                t => !found.some(f => f.subject.toLowerCase() === t.toLowerCase())
            )
            console.log(`⚠️ Could not find group(s): ${missing.join(', ')}`)
        }
        return found
    } catch (err) {
        console.error('❌ Failed to fetch groups:', err.message)
    }
    return []
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

    const sock = makeWASocket({
        auth: state,
        browser: Browsers.windows('Chrome'),
        logger,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        syncFullHistory: false,
        printQRInTerminal: false,
    })

    sock.ev.on('creds.update', saveCreds)

    let pairingRequested = false

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'connecting' && !state.creds.registered && !pairingRequested) {
            pairingRequested = true
            const phoneNumber = BOT_PHONE_NUMBER.replace(/\D/g, '')
            console.log(`\n📱 Requesting pairing code for +${phoneNumber}...`)

            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber)
                    console.log(`\n🔐 PAIRING CODE: ${code?.match(/.{1,4}/g)?.join('-') || code}`)
                    console.log('📱 WhatsApp > Settings > Linked Devices > Link a Device')
                    console.log('⏳ Enter the code on your phone — this window stays alive\n')
                } catch (err) {
                    console.error('❌ Pairing error:', err.message)
                }
            }, 3000)
        }

        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp successfully!')
            targetGroups = await resolveTargetGroups(sock)
            if (targetGroups.length) {
                console.log(`👀 Monitoring groups: ${targetGroups.map(g => `"${g.subject}"`).join(', ')}`)
                console.log(`📨 Forwarding to: ${FORWARD_TO_NUMBER}`)
            }
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            console.log(`❌ Disconnected (code: ${code})`)

            if (code === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Delete auth_info/ and restart.')
                process.exit(1)
            }

            setTimeout(() => startBot(), 5000)
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (!msg.message) continue
                const jid = msg.key.remoteJid
                if (!jid?.endsWith('@g.us')) continue

                const group = targetGroups.find(g => g.jid === jid)
                if (!group) continue

                let text = msg.message.conversation || msg.message.extendedTextMessage?.text
                if (!text) continue

                const forwardJid = FORWARD_TO_NUMBER.replace(/\D/g, '') + '@s.whatsapp.net'
                await sock.sendMessage(forwardJid, { text: `[${group.subject}]` })
                await sock.sendMessage(forwardJid, { text })
            } catch (err) {
                console.error('❌ Forward error:', err.message)
            }
        }
    })
}

startBot().catch(console.error)
