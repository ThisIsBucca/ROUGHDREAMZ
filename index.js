import 'dotenv/config'
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'

const TARGET_GROUP_SUBJECT = process.env.TARGET_GROUP_SUBJECT
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || '255778286840'
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER || '255776986840'

const logger = pino({ level: 'silent' })

let targetGroupJid = null

async function resolveGroupJid(sock) {
    if (!TARGET_GROUP_SUBJECT) return null
    try {
        const groups = await sock.groupFetchAllParticipating()
        for (const [jid, metadata] of Object.entries(groups)) {
            if (metadata.subject?.toLowerCase() === TARGET_GROUP_SUBJECT.toLowerCase()) {
                return jid
            }
        }
        console.log(`❌ No group found with subject "${TARGET_GROUP_SUBJECT}"`)
    } catch (err) {
        console.error('❌ Failed to fetch groups:', err.message)
    }
    return null
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
            targetGroupJid = await resolveGroupJid(sock)
            if (targetGroupJid) {
                console.log(`👀 Monitoring group: "${TARGET_GROUP_SUBJECT}"`)
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
                if (!targetGroupJid || jid !== targetGroupJid) continue

                let text = msg.message.conversation || msg.message.extendedTextMessage?.text
                if (!text) continue

                const forwardJid = FORWARD_TO_NUMBER.replace(/\D/g, '') + '@s.whatsapp.net'
                await sock.sendMessage(forwardJid, { text })
            } catch (err) {
                console.error('❌ Forward error:', err.message)
            }
        }
    })
}

startBot().catch(console.error)
