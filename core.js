import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { esc, rand, ago, initial, isMediaUrl, safeMediaUrl, chunkString, mimeKind, makeLru, icon } from './util.js';

// ===================== config =====================
// mayfly rides the SAME shared Supabase project as instamegle, but every table is
// mf_-prefixed so the two apps never collide. (See schema.sql.)
const SUPABASE_URL = 'https://zbtgonklxweikgukzukg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Tpkd3FzWhsfldMll-gIqfg_74YVroef';
const SNAP_BUCKET  = 'mf-snaps';   // Storage bucket holding E2E-encrypted relay blobs
const PREVIEW_PX   = 24;    // blurred LQIP shown in the inbox before you open a snap
const FULL_PX      = 1080;  // longest edge of the full snap image (P2P / encrypted)
const FULL_Q       = 0.85;  // JPEG quality of the full snap
const STORY_PREVIEW_MAX = 32 * 1024; // maximum database bytes for an offline Story preview
const SNAP_TTL_H   = 24;    // a snap self-destructs this many hours after it's sent
const STORY_TTL_H  = 24;    // stories are visible for one day

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===================== tiny DOM helpers =====================
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const app = $('#app');
const toast = (t) => { const n = $('#toast'); n.textContent = t; n.classList.add('show'); setTimeout(() => n.classList.remove('show'), 2400); };

// ===================== IndexedDB =====================
// Holds two kinds of thing, all device-only:
//   snap:<id>   the sender's own full snap image, served P2P to an online recipient
//   mykey:*     this device's private ECDH key (never leaves the device)
const idb = (() => {
    const dbp = new Promise((res, rej) => {
        const r = indexedDB.open('mayfly', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    const run = async (mode, fn) => {
        const db = await dbp;
        return new Promise((res, rej) => {
            const tx = db.transaction('kv', mode);
            const rq = fn(tx.objectStore('kv'));
            tx.oncomplete = () => res(rq && rq.result);
            tx.onerror = () => rej(tx.error);
        });
    };
    return {
        get: (k) => run('readonly',  s => s.get(k)),
        set: (k, v) => run('readwrite', s => s.put(v, k)),
        del: (k) => run('readwrite', s => s.delete(k)),
        keys: () => run('readonly', s => s.getAllKeys()),
    };
})();

// ===================== image processing (canvas) =====================
const loadImage = (src) => new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src;
});
const scaleTo = (im, max) => {
    const k = Math.min(1, max / Math.max(im.width, im.height));
    const w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(im, 0, 0, w, h);
    return c;
};
// Decode off the main thread when supported; imageOrientation respects EXIF so
// phone photos aren't sideways.
const decode = async (blob) => ('createImageBitmap' in window)
    ? await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => loadImage(URL.createObjectURL(blob)))
    : loadImage(URL.createObjectURL(blob));
// The display copy is capped to keep the composer quick, but rawBlob preserves the
// original file for live and encrypted-relay delivery.
const processImage = async (blob) => {
    const im = await decode(blob);
    const preview = scaleTo(im, PREVIEW_PX).toDataURL('image/jpeg', 0.5);
    const full    = scaleTo(im, FULL_PX).toDataURL('image/jpeg', FULL_Q);
    const out = { preview, full, rawBlob: blob, w: im.width, h: im.height, mime: blob.type || 'image/jpeg' };
    im.close?.();
    return out;
};
// Turn an already-drawn canvas (the live camera frame) into the same shape while
// retaining its native camera resolution for delivery.
const processCanvas = async (canvas) => {
    const im = canvas;
    const rawBlob = await new Promise((resolve, reject) => canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('Could not encode photo')), 'image/jpeg', 0.92,
    ));
    return {
        preview: scaleTo(im, PREVIEW_PX).toDataURL('image/jpeg', 0.5),
        full:    scaleTo(im, FULL_PX).toDataURL('image/jpeg', FULL_Q),
        rawBlob, w: im.width, h: im.height, mime: 'image/jpeg',
    };
};
// Stories get a real offline fallback instead of a 24px LQIP. Adapt resolution and
// JPEG quality until the entire base64 data URL fits in the database budget.
const makeStoryPreview = async (blob) => {
    const im = await decode(blob);
    let edge = Math.min(480, Math.max(im.width, im.height));
    for (; edge >= 64; edge = Math.floor(edge * 0.72)) {
        const canvas = scaleTo(im, edge);
        for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
            const preview = canvas.toDataURL('image/jpeg', quality);
            if (new TextEncoder().encode(preview).byteLength <= STORY_PREVIEW_MAX) {
                im.close?.();
                return preview;
            }
        }
    }
    const preview = scaleTo(im, 48).toDataURL('image/jpeg', 0.35);
    im.close?.();
    return preview;
};
// A video snap keeps its original recording and derives a tiny image preview for the inbox.
const processVideo = async (blob) => {
    const mime = blob.type || 'video/webm';
    const url = URL.createObjectURL(blob);
    const localPreviewUrl = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    try {
        await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; });
        // The first recorder frame is commonly black. Seek slightly into the clip before
        // drawing the still used by the inbox and compose preview.
        if (Number.isFinite(v.duration) && v.duration > 0.1) {
            v.currentTime = Math.min(0.1, v.duration / 2);
            await new Promise((res, rej) => { v.onseeked = res; v.onerror = rej; });
        } else {
            await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
        }
        const preview = scaleTo(v, PREVIEW_PX).toDataURL('image/jpeg', 0.5);
        return { preview, rawBlob: blob, w: v.videoWidth, h: v.videoHeight, mime, duration: v.duration, localPreviewUrl };
    } catch (e) {
        URL.revokeObjectURL(localPreviewUrl);
        throw e;
    } finally { URL.revokeObjectURL(url); }
};
// Avatars are small enough to store in the DB so they always show.
const AVATAR_PX = 128;
const makeAvatar = async (blob) => {
    const im = await decode(blob);
    const url = scaleTo(im, AVATAR_PX).toDataURL('image/jpeg', 0.7);
    im.close?.();
    return url;
};
const avatarHTML = (username, avatar, cls = '') =>
    `<div class="avatar ${cls}">${isMediaUrl(avatar) ? `<img src="${avatar}" alt="">` : initial(username)}</div>`;

// data: URL <-> ArrayBuffer (for handing a full snap to the crypto layer).
const dataUrlToBytes = async (dataUrl) => new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
const bytesToDataUrl = (bytes, mime = 'image/jpeg') => new Promise((res) => {
    const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(new Blob([bytes], { type: mime }));
});

// ===================== auth / session state =====================
const state = { me: null, profile: null, priv: null };   // priv = this device's ECDH private key
const presenceUsers = {};                                 // user_id -> { username }
const fullCache = makeLru(40);
const isOnline = (uid) => !!presenceUsers[uid];

export { sb, SNAP_BUCKET, SNAP_TTL_H, STORY_TTL_H, $, $$, el, esc, rand, app, toast, ago, initial, idb,
    processImage, processCanvas, processVideo, makeStoryPreview, makeAvatar, avatarHTML, dataUrlToBytes, bytesToDataUrl,
    isMediaUrl, safeMediaUrl, chunkString, mimeKind, icon, state, presenceUsers, fullCache, isOnline };
