/* =========================================================
   webauthn.js — Optional biometric "convenience unlock".

   IMPORTANT HONESTY NOTE (see README): this is a client-only,
   no-backend app. WebAuthn here proves the user is present on
   THIS device/browser (fingerprint/Face ID/Windows Hello via the
   platform authenticator) but there is no server to verify the
   assertion against. We use it purely as a local gate: on success
   we release a device-local key (stored in this browser only) that
   unwraps the vault's encryption key, so the PIN doesn't need to be
   typed again on this trusted device. The PIN remains the real
   credential and the only thing that can re-derive the vault key
   from scratch (e.g. after clearing browser data).
   ========================================================= */
const VaultWebAuthn = (() => {
  function isSupported() {
    return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  }

  async function platformAvailable() {
    if (!isSupported()) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) { return false; }
  }

  async function register(userId, userName) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Vault Money Manager' },
        user: {
          id: new TextEncoder().encode(userId),
          name: userName || 'vault-user',
          displayName: userName || 'Vault User'
        },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000
      }
    });
    if (!cred) return null;
    return VaultCrypto.toB64(new Uint8Array(cred.rawId));
  }

  async function verify(credentialIdB64) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const allowCredentials = credentialIdB64 ? [{
      id: VaultCrypto.fromB64(credentialIdB64), type: 'public-key'
    }] : [];
    const assertion = await navigator.credentials.get({
      publicKey: { challenge, allowCredentials, userVerification: 'required', timeout: 60000 }
    });
    return !!assertion;
  }

  return { isSupported, platformAvailable, register, verify };
})();
