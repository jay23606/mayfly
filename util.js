// Pure, dependency-free helpers (no DOM / network) — importable in the browser
// modules *and* unit-testable in Node with `node --test`.

export const esc = (s) => (s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const rand = () => Math.random().toString(36).slice(2);
export const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();
export const ago = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return new Date(iso).toLocaleDateString();
};

// Only allow data:/blob: media URLs — a stored-XSS guard for user/peer-supplied
// strings that land in a src/href (`x" onerror=...`).
export const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
export const isMediaUrl = (s) => typeof s === 'string' && /^(data:(image|video|audio)\/|blob:)/i.test(s);
export const safeMediaUrl = (s) => isMediaUrl(s) ? s : BLANK;

export const mimeKind = (mime = '') =>
    mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' :
    mime.startsWith('audio/') ? 'audio' : 'file';

// Split a big string into ~16KB pieces for a WebRTC data channel (which caps
// single-message size and, with JSON serialization, doesn't chunk itself).
export const chunkString = (s, size = 16000) => { const out = []; for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size)); return out; };

// A tiny LRU-capped Map (get/set/has/delete) that evicts the oldest entry over `cap`.
export const makeLru = (cap) => {
    const m = new Map();
    return {
        has: (k) => m.has(k),
        get: (k) => m.get(k),
        delete: (k) => m.delete(k),
        set: (k, v) => { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > cap) m.delete(m.keys().next().value); },
        get size() { return m.size; },
    };
};
