/* Encrypted, portable on-device backups.

   The encryption happens in the browser and the result is handed to the
   browser as a file. The app retains neither the passphrase nor an encryption
   key, so clearing site data does not make an already exported file useless.
*/
'use strict';

const FORMAT = 'hearth-bp-backup';
const VERSION = 1;
const ITERATIONS = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let out = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    out += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

function unb64(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('invalid-backup');
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('invalid-backup');
  }
}

async function key(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function createBackup(passphrase, payload) {
  if (!passphrase) throw new Error('missing-passphrase');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await key(passphrase, salt),
    enc.encode(JSON.stringify(payload)));
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv), data: b64(cipher) },
  }, null, 2);
}

export async function readBackup(passphrase, text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error('invalid-backup'); }
  if (envelope?.format !== FORMAT || envelope?.version !== VERSION
      || envelope?.kdf?.name !== 'PBKDF2' || envelope?.kdf?.hash !== 'SHA-256'
      || envelope?.kdf?.iterations !== ITERATIONS || envelope?.cipher?.name !== 'AES-GCM') {
    throw new Error('invalid-backup');
  }
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.cipher.iv) },
      await key(passphrase, unb64(envelope.kdf.salt)),
      unb64(envelope.cipher.data));
  } catch {
    const error = new Error('wrong-passphrase');
    error.code = 'wrong-passphrase';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(dec.decode(plain)); } catch { throw new Error('invalid-backup'); }
  if (!payload || !Array.isArray(payload.readings)) throw new Error('invalid-backup');
  return payload;
}

export function backupFilename(date = new Date()) {
  return `hearth-bp-backup-${date.toISOString().slice(0, 10)}.hbp`;
}
