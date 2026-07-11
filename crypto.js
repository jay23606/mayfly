// End-to-end encryption for relayed snaps (ECIES: ephemeral ECDH P-256 → AES-GCM).
//
// When a recipient is OFFLINE we can't stream the snap peer-to-peer, so we stash it
// as ciphertext in Supabase Storage. The server (and anyone who can read the bucket)
// only ever sees random bytes: each snap is encrypted to the recipient's PUBLIC key,
// and only their device — which holds the matching PRIVATE key in IndexedDB — can
// open it. The private key never leaves the device and is never uploaded.

import { idb } from './core.js';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = {
    enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
    dec: (s)  => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

// Load this device's keypair, generating + persisting it on first run.
// Returns { priv: CryptoKey, pubJwk } — pubJwk is published to mf_profiles.pubkey.
export async function loadOrCreateKeys() {
    let privJwk = await idb.get('mykey:priv');
    let pubJwk  = await idb.get('mykey:pub');
    if (!privJwk || !pubJwk) {
        const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
        privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
        pubJwk  = await crypto.subtle.exportKey('jwk', kp.publicKey);
        await idb.set('mykey:priv', privJwk);
        await idb.set('mykey:pub', pubJwk);
    }
    const priv = await crypto.subtle.importKey('jwk', privJwk, ECDH, false, ['deriveKey']);
    return { priv, pubJwk };
}

// Encrypt `bytes` for a recipient, given their published public-key JWK.
// Returns { ct (ArrayBuffer), iv (b64), ephPub (JSON string) } to store alongside the blob.
export async function encryptFor(recipientPubJwk, bytes) {
    const recipPub = await crypto.subtle.importKey('jwk', recipientPubJwk, ECDH, false, []);
    const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: recipPub }, eph.privateKey,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, bytes);
    const ephPubJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
    return { ct, iv: b64.enc(iv), ephPub: JSON.stringify(ephPubJwk) };
}

// Decrypt a relay blob with my private key + the sender's ephemeral public key.
// Returns an ArrayBuffer of plaintext (the JPEG bytes).
export async function decryptWith(myPriv, ephPubStr, ivB64, ctBuf) {
    const ephPub = await crypto.subtle.importKey('jwk', JSON.parse(ephPubStr), ECDH, false, []);
    const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: ephPub }, myPriv,
        { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(ivB64) }, aes, ctBuf);
}

// Convenience wrappers for short text (chat messages): everything base64 so it fits
// in a DB row. The server only ever stores the ciphertext.
export async function encryptText(recipientPubJwk, str) {
    const { ct, iv, ephPub } = await encryptFor(recipientPubJwk, new TextEncoder().encode(str));
    return { iv, eph_pub: ephPub, body: b64.enc(ct) };
}
export async function decryptText(myPriv, ephPubStr, ivB64, bodyB64) {
    const pt = await decryptWith(myPriv, ephPubStr, ivB64, b64.dec(bodyB64));
    return new TextDecoder().decode(pt);
}
