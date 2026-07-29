// server/whatsapp.js — Baileys WhatsApp with persistent auth
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
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
let _onPublicMessage = null;

export function setOnIncomingMessage(callback) {
  _onIncomingMessage = callback;
}

// Registered separately from the MP handler above so the approve/reject contract
// (and its callback signature) never has to change to accommodate public intake.
export function setOnPublicMessage(callback) {
  _onPublicMessage = callback;
}

// Simple flood guard on open public intake: a sender who sends more than
// RATE_LIMIT_MAX messages within RATE_LIMIT_WINDOW_MS still gets forwarded (nothing
// is silently dropped) but tagged rateLimited so the caller can skip the Gemini call.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const recentSenderTimestamps = new Map(); // sender -> timestamps[]

function isRateLimited(sender) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (recentSenderTimestamps.get(sender) || []).filter(t => t > cutoff);
  timestamps.push(now);
  recentSenderTimestamps.set(sender, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function setupIncomingHandler(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      // Public intake is 1:1 only — a group the linked number happens to be in is
      // never treated as a constituent reporting their own grievance.
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      const sender = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';

      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';

      if (sender === MP_NUMBER) {
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
        continue;
      }

      // Any other 1:1 sender is open public grievance intake — typed text, or a
      // voice note (ptt — a shared/forwarded audio file is not treated as dictation).
      if (!_onPublicMessage) continue;
      const voiceNote = msg.message.audioMessage?.ptt ? msg.message.audioMessage : null;
      if (!text && !voiceNote) continue;

      const rateLimited = isRateLimited(sender);
      try {
        if (voiceNote) {
          const buffer = await downloadMediaMessage(
            msg, 'buffer', {}, { logger: silent, reuploadRequest: socket.updateMediaMessage },
          );
          await _onPublicMessage({
            sender, jid: msg.key.remoteJid, messageId: msg.key.id, rateLimited,
            audio: { buffer, mimeType: voiceNote.mimetype || 'audio/ogg; codecs=opus' },
          });
        } else {
          await _onPublicMessage({ sender, text, jid: msg.key.remoteJid, messageId: msg.key.id, rateLimited });
        }
      } catch (e) {
        console.error('Error in public message handler:', e.message);
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
          setTimeout(init, 1000);
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

export async function sendMessage(content, target) {
  await init();
  if (!isConnected) {
    throw new Error(
      qrData
        ? 'Scan the QR code shown in the server terminal to activate WhatsApp sending.'
        : 'WhatsApp not connected yet. Start the server and scan the QR code.'
    );
  }
  // A group JID already contains '@' (e.g. '1234-5678@g.us'); a plain phone number doesn't.
  const jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
  const payload = typeof content === 'string' ? { text: content } : content;
  await sock.sendMessage(jid, payload);
  return true;
}

export async function getGroups() {
  await init();
  if (!isConnected) {
    throw new Error(
      qrData
        ? 'Scan the QR code shown in the server terminal to activate WhatsApp sending.'
        : 'WhatsApp not connected yet. Start the server and scan the QR code.'
    );
  }
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map(g => ({ id: g.id, subject: g.subject, size: g.size }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

export async function logout() {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp is not connected.');
  }
  // Unlinks the device from the account and closes the socket with a 'loggedOut'
  // reason — the connection.update handler above wipes wa_auth/ and restarts init()
  // to show a fresh QR.
  await sock.logout();
  return true;
}

export const getStatus = () => ({ connected: isConnected, hasQR: !!qrData });
export const getQR = () => qrData;

// Start connecting immediately on module load
init().catch(() => {});

export default sendMessage;
