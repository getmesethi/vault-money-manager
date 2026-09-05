/* =========================================================
   crypto.js — PIN-derived encryption for the local vault.
   No plaintext PIN or password is ever stored. The vault
   (all accounts/categories/transactions/budgets/etc.) is
   encrypted at rest with AES-GCM using a key derived from
   the user's PIN via PBKDF2. Correctness of the PIN is
   proven implicitly by successful AES-GCM decryption
   (the auth tag fails to verify for a wrong key) — so we
   don't need to keep a separate password hash around.
   ========================================================= */
const VaultCrypto = (() => {
  const PBKDF2_ITER = 210000;

  function randomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  function toB64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function fromB64(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(pin, saltB64, iterations = PBKDF2_ITER) {
    const salt = fromB64(saltB64);
    const enc = new TextEncoder().encode(pin);
    const baseKey = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function newSalt() {
    return toB64(randomBytes(16));
  }

  async function encryptJSON(obj, key) {
    const iv = randomBytes(12);
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { iv: toB64(iv), data: toB64(cipher) };
  }

  async function decryptJSON(payload, key) {
    const iv = fromB64(payload.iv);
    const cipher = fromB64(payload.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // Wrap/unwrap a raw AES key with another key (used for biometric device-key convenience unlock)
  async function exportRawKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return toB64(raw);
  }
  async function importRawKey(b64) {
    const raw = fromB64(b64);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  async function generateDeviceKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  return {
    PBKDF2_ITER, toB64, fromB64, deriveKey, newSalt, encryptJSON, decryptJSON,
    exportRawKey, importRawKey, generateDeviceKey, randomBytes
  };
})();
