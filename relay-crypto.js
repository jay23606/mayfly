const AES = { name: 'AES-GCM', length: 256 };
export const CHUNKED_RELAY_FORMAT = 'aes-gcm-chunks-v1';
// AES-GCM adds a 16-byte authentication tag. Using 6 MiB minus the tag keeps
// every encrypted TUS PATCH at Supabase's recommended 6 MiB chunk size.
export const RELAY_PLAIN_CHUNK = 6 * 1024 * 1024 - 16;

const encode64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const decode64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const chunkIv = (baseIv, index) => {
    const iv = new Uint8Array(baseIv);
    if (iv.byteLength !== 12 || !Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('Invalid chunked relay IV');
    new DataView(iv.buffer, iv.byteOffset, iv.byteLength).setUint32(8, index, false);
    return iv;
};

export const encryptedChunkedSize = (plainSize, chunkSize = RELAY_PLAIN_CHUNK) => {
    if (!Number.isSafeInteger(plainSize) || plainSize < 0 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid relay size');
    return plainSize + Math.max(1, Math.ceil(plainSize / chunkSize)) * 16;
};

export async function createChunkedRelayEncryptor(file, chunkSize = RELAY_PLAIN_CHUNK) {
    const key = await crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
    const baseIv = crypto.getRandomValues(new Uint8Array(12));
    baseIv.fill(0, 8);
    return {
        content_iv: encode64(baseIv),
        rawKey: await crypto.subtle.exportKey('raw', key),
        plainSize: file.size,
        chunkSize,
        encryptedSize: encryptedChunkedSize(file.size, chunkSize),
        chunkCount: Math.max(1, Math.ceil(file.size / chunkSize)),
        encryptChunk: async index => {
            const start = index * chunkSize;
            const bytes = await file.slice(start, Math.min(start + chunkSize, file.size)).arrayBuffer();
            return crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(baseIv, index) }, key, bytes);
        },
    };
}

export async function importRelayKey(rawKey) {
    return crypto.subtle.importKey('raw', rawKey, AES, false, ['decrypt']);
}

export async function decryptSharedRelayChunk(key, contentIvB64, index, ciphertext) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(decode64(contentIvB64), index) }, key, ciphertext);
}
