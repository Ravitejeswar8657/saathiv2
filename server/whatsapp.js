// server/whatsapp.js — Baileys WhatsApp with persistent auth
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Use Railway volume if available, else local
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const AUTH_PATH = path.join(VOLUME, 'wa_auth');
fs.mkdirSync(AUTH_PATH, { recursive: true });

let sock = null;
let isConnected = false;
let qrData = null;
let initPromise = null;

// ── Incoming message handler ───────────────────────────────────────────────
const MP_NUMBER = '919652345570';
let _onIncomingMessage = null;

export function setOnIncomingMessage(callback) {
  _onIncomingMessage = callback;
}

function setupIncomingHandler(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const sender = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
      if (sender !== MP_NUMBER) continue;

      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';
      if (!text) continue;

      // Check for approve/reject patterns
      const approveMatch = text.match(/^approve\s+(.+)/i);
      const rejectMatch = text.match(/^reject\s+(.+)/i);
      if (!approveMatch && !rejectMatch) continue;

      const action = approveMatch ? 'approved' : 'rejected';
      const identifier = (approveMatch || rejectMatch)[1].trim();

      if (_onIncomingMessage) {
        try {
          await _onIncomingMessage({ action, identifier, rawText: text, sender });
        } catch (e) {
          console.error('Error in incoming message handler:', e.message);
        }
      }
    }
  });
}

const silent = {
  level: 'silent',
  trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){},
  child() { return this; },
};

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    sock = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Safari'),
      logger: silent,
      printQRInTerminal: true,
      connectTimeoutMs: 60000,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrData = qr;
        console.log('\n📱 Scan this QR in WhatsApp → Settings → Linked Devices\n');
      }
      if (connection === 'open') {
        isConnected = true;
        qrData = null;
        console.log('✓ WhatsApp connected and ready');
      }
      if (connection === 'close') {
        isConnected = false;
        const code = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode : 0;
        if (code !== DisconnectReason.loggedOut) {
          initPromise = null;
          setTimeout(init, 5000);
        } else {
          fs.rmSync(AUTH_PATH, { recursive: true, force: true });
          fs.mkdirSync(AUTH_PATH, { recursive: true });
          initPromise = null;
        }
      }
    });
    // Wire up incoming message listener on this socket
    setupIncomingHandler(sock);
    // Wait up to 20s for either QR or connection
    await new Promise(resolve => {
      const t = setInterval(() => {
        if (isConnected || qrData) { clearInterval(t); resolve(); }
      }, 400);
      setTimeout(() => { clearInterval(t); resolve(); }, 20000);
    });
  })();
  return initPromise;
}

export async function sendMessage(content, phone) {
  await init();
  if (!isConnected) {
    throw new Error(
      qrData
        ? 'Scan the QR code shown in the server terminal to activate WhatsApp sending.'
        : 'WhatsApp not connected yet. Start the server and scan the QR code.'
    );
  }
  const payload = typeof content === 'string' ? { text: content } : content;
  await sock.sendMessage(`${phone}@s.whatsapp.net`, payload);
  return true;
}

export const getStatus = () => ({ connected: isConnected, hasQR: !!qrData });
export const getQR = () => qrData;

// Start connecting immediately on module load
init().catch(() => {});

export default sendMessage;
