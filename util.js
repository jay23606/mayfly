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

// ---- inline line-icons (Lucide paths, stroked with currentColor) ----
// Keeps the whole app dependency-free: no icon font, no external SVG requests.
const ICONS = {
    camera:   '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    paperclip:'<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    mic:      '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    stop:     '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    micOff:   '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
    video:    '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    videoOff: '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><line x1="2" x2="22" y1="2" y2="22"/>',
    flipCamera:'<path d="M20 6h-3.6l-1.2-2H8.8l-1.2 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z"/><path d="M9 12a3 3 0 0 1 5.2-2"/><path d="m14 8 .2 2.3-2.3-.2"/><path d="M15 12a3 3 0 0 1-5.2 2"/><path d="m10 16-.2-2.3 2.3.2"/>',
    phone:    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    phoneOff: '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/>',
    pencil:   '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
};
export const icon = (name, size = 22) =>
    `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

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
