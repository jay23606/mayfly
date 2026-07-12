import { sb, SNAP_BUCKET, $, el, esc, rand, toast, state, idb, isOnline, initial, ago,
    avatarHTML, safeMediaUrl, chunkString, mimeKind, icon } from './core.js';
import { peer, fetchSnap } from './rtc.js';
import { db } from './db.js';
import { encryptText, decryptText, decryptWith } from './crypto.js';

// ===================== unified conversations (snaps + chat, Snapchat-style) =====================
// TEXT is async + end-to-end encrypted via mf_messages (works even when the friend is
// offline — they pick it up on next open, then the row is deleted). MEDIA / voice notes
// / video calls are live P2P (both online). Snaps normally become inline chat media;
// a positive timer keeps the full-screen view-once treatment.
// Each device keeps its own thread history in IndexedDB (thread:<uid>); nothing readable
// lives on the server.

const conns = new Map();          // uid -> live P2P data conn (for media/voice/typing)
const pubCache = new Map();       // uid -> recipient public-key JWK
let inboxByUser = {};             // uid -> [unopened snap rows]
const unreadMsg = new Set();      // uids with messages received while their thread was closed
let openUid = null;               // conversation currently on screen
let threadBox = null, convBox = null;
// Legacy photo snaps use plain "live" / "relay". Video snaps retain their MIME type
// in the existing delivery value, avoiding a database migration.
const snapMime = (s) => {
    const tag = s.delivery?.split(':')[1];
    try { return tag ? decodeURIComponent(tag) : 'image/jpeg'; }
    catch (e) { return 'image/jpeg'; }
};
const snapKind = (s) => snapMime(s).startsWith('video/') ? 'video' : 'photo';

const onChange = () => window.dispatchEvent(new Event('chat-unread'));
export const chatUnread = () => {
    const s = new Set(unreadMsg);
    for (const uid in inboxByUser) if (inboxByUser[uid]?.length) s.add(uid);
    return s.size;
};

// ---- local per-friend thread history ----
const histGet = (uid) => idb.get('thread:' + uid).then(h => h || []);
const histPush = async (uid, entry) => {
    const h = await histGet(uid);
    h.push(entry); if (h.length > 300) h.splice(0, h.length - 300);
    await idb.set('thread:' + uid, h).catch(() => {});
};
const lastLine = (h) => {
    if (!h || !h.length) return '';
    const m = h[h.length - 1];
    return m.kind === 'text' ? (m.me ? 'You: ' : '') + m.text
        : m.kind === 'snap' ? '📷 You sent a Snap'
        : m.kind === 'media' ? (m.me ? 'You: ' : '') + '📎 ' + (m.name || m.mediaKind || 'attachment') : '';
};

const pubOf = async (uid) => {
    if (pubCache.has(uid)) return pubCache.get(uid);
    const { data } = await db.profileById(uid);
    let jwk = null; try { jwk = data?.pubkey ? JSON.parse(data.pubkey) : null; } catch (e) {}
    pubCache.set(uid, jwk); return jwk;
};

// ---- pull any messages that arrived while we were offline ----
export const syncMessages = async () => {
    const { data } = await db.myUndelivered();
    for (const row of (data || [])) await ingestMessage(row);
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};
const ingestMessage = async (row) => {
    let text = ''; try { text = await decryptText(state.priv, row.eph_pub, row.iv, row.body); }
    catch (e) { return; }
    await histPush(row.sender_id, { me: false, kind: 'text', text, at: new Date(row.created_at).getTime() });
    await db.delMessage(row.id);          // ephemeral: delivered → gone from the server
    if (openUid === row.sender_id) appendBubble(text, 'them');
    else { unreadMsg.add(row.sender_id); if (window.Notification?.permission === 'granted') new Notification('mayfly 🐛', { body: 'New message' }); }
};
// realtime INSERT handler (from app.js)
export const onMessageInsert = (row) => { if (row.recipient_id === state.me.id) ingestMessage(row).then(() => { if (convBox) renderConvs(convBox, openUid); onChange(); }); };

// ---- a snap arrived for me / I sent one ----
export const onSnapInsert = async (row) => {
    if (row.recipient_id !== state.me.id) return;
    (inboxByUser[row.sender_id] = inboxByUser[row.sender_id] || []).unshift(row);
    if (openUid === row.sender_id && threadBox) renderThreadBody(row.sender_id);
    else if (window.Notification?.permission === 'granted') new Notification('mayfly 🐛', { body: `New ${snapKind(row) === 'video' ? 'video' : 'photo'} Snap!` });
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};
export const noteSentSnap = (uid, snapId = null, snapKind = 'photo') =>
    histPush(uid, { me: true, kind: 'snap', snapId, snapKind, status: 'delivered', at: Date.now() })
        .then(() => { if (convBox) renderConvs(convBox, openUid); });

// Snap ids the recipient has opened (their mf_snaps row was deleted → realtime DELETE).
// Sender-side only: flips the "Delivered" receipt to "Opened".
const openedSnapIds = new Set();
export const markSnapOpened = (id) => {
    if (!id) return;
    openedSnapIds.add(id);
    if (openUid) renderThreadBody(openUid);   // reconciles + persists the status
    if (convBox) renderConvs(convBox, openUid);
};
// The sender-side "Delivered"/"Opened" receipt shown under a sent snap.
const snapReceipt = (e) => `<div class="msgstatus me ${e.snapKind || 'photo'} ${e.status || 'delivered'}"${e.snapId ? ` data-snap="${e.snapId}"` : ''}><span class="si"></span><span class="sl">${e.status === 'opened' ? 'Opened' : 'Delivered'}</span></div>`;

const refreshInbox = async () => {
    const { data } = await db.inbox();
    inboxByUser = {};
    (data || []).forEach(s => (inboxByUser[s.sender_id] = inboxByUser[s.sender_id] || []).push(s));
};

// ===================== conversation list =====================
export const renderConvs = async (box, activeUid) => {
    convBox = box;
    const { data: fr } = await db.friends();
    const friends = (fr || []).map(f => f.requester_id === state.me.id ? f.addressee : f.requester).filter(Boolean);
    if (box !== convBox) return;
    // build each conversation's summary
    const rows = await Promise.all(friends.map(async (u) => {
        const h = await histGet(u.id);
        const pending = inboxByUser[u.id] || [];
        const snaps = pending.length;
        const kind = snaps ? snapKind(pending[0]) : null;
        const lastAt = h.length ? h[h.length - 1].at : 0;
        const unread = snaps > 0 || unreadMsg.has(u.id);
        const status = snaps ? `New ${kind === 'video' ? 'Video' : 'Photo'} Snap${snaps > 1 ? ` ×${snaps}` : ''}` : (lastLine(h) || 'Tap to chat');
        return { u, lastAt: Math.max(lastAt, snaps ? Date.now() : 0), unread, status, snaps, kind };
    }));
    rows.sort((a, b) => (b.unread - a.unread) || (b.lastAt - a.lastAt));
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = `<div class="empty">No friends yet. <a href="#/friends">Add some →</a></div>`; return; }
    rows.forEach(({ u, unread, status, snaps, kind }) => {
        const row = el(`<button class="conv ${u.id === activeUid ? 'active' : ''} ${unread ? 'unread' : ''} ${kind ? 'snap-' + kind : ''}" data-go="#/c/${u.id}">
            ${avatarHTML(u.username, u.avatar)}
            <div class="who"><b>${esc(u.username)}</b>
              <div class="sub ${unread ? 'hot' : ''}">${isOnline(u.id) ? '<i class="dot"></i>' : ''}${esc(status)}</div></div>
            <span class="camicon" data-snap="${u.id}" aria-label="Send a snap">${icon('camera', 20)}</span></button>`);
        $('.camicon', row).onclick = (e) => { e.preventDefault(); e.stopPropagation(); location.hash = '#/snap/' + u.id; };
        box.appendChild(row);
    });
};

// ===================== conversation thread =====================
export const openConversation = async (box, uid) => {
    openUid = uid; threadBox = box;
    unreadMsg.delete(uid); onChange();
    let username = pubCache.has(uid) ? null : null;
    const { data: prof } = await db.profileById(uid);
    username = prof?.username || 'friend';
    if (prof?.pubkey) { try { pubCache.set(uid, JSON.parse(prof.pubkey)); } catch (e) {} }
    box.innerHTML = `<div class="thread">
        <div class="thead">
          <button class="icon back" data-go="#/chats" aria-label="Back">‹</button>
          ${avatarHTML(username, prof?.avatar)}
          <div class="who"><b>${esc(username)}</b><div class="sub"><i class="cdot" style="opacity:${isOnline(uid) ? '1' : '.3'}"></i> ${isOnline(uid) ? 'active now' : 'offline'}</div></div>
          <button class="icon callbtn" aria-label="Call">${icon('phone')}</button>
        </div>
        <div class="tbody" id="tbody"><div class="spin">…</div></div>
        <div class="ctyping" id="ctyping"></div>
        <div class="voicepreview" hidden></div>
        <form class="tin">
          <button type="button" class="icon snapbtn" aria-label="Send a snap">${icon('camera')}</button>
          <input class="tinput" placeholder="Send a chat" autocomplete="off" enterkeyhint="send" aria-label="Message">
          <button type="button" class="icon mic" aria-label="Record a voice note">${icon('mic')}</button>
          <button type="button" class="icon attach" aria-label="Attach a file">${icon('paperclip')}</button>
          <input type="file" class="fileinput" hidden>
        </form>
      </div>`;
    $('.callbtn', box).onclick = (e) => callMenu(e.currentTarget, (video) => callUser(uid, username, video));
    $('.snapbtn', box).onclick = () => { location.hash = '#/snap/' + uid; };
    const fileInput = $('.fileinput', box);
    $('.attach', box).onclick = () => fileInput.click();
    fileInput.onchange = () => { const f = fileInput.files[0]; if (f) sendFile(uid, f, mimeKind(f.type)); fileInput.value = ''; };
    wireMic(box, uid);
    const form = $('.tin', box), input = $('.tinput', box);
    form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ''; sendText(uid, username, t); };
    input.oninput = () => { const c = conns.get(uid); if (c?.open) { try { c.send({ t: 'typing' }); } catch (e) {} clearTimeout(input._tt); input._tt = setTimeout(() => { try { c.send({ t: 'stop' }); } catch (e) {} }, 1200); } };
    await renderThreadBody(uid);
    ensureConn(uid, username);                     // best-effort live link for typing / media
    // grab any messages this friend sent while we were away
    const { data: pend } = await db.myUndelivered();
    for (const row of (pend || [])) if (row.sender_id === uid) await ingestMessage(row);
    renderThreadBody(uid);
    if (convBox) renderConvs(convBox, uid);
};

// Merge local history + unopened snap cards into one chronological timeline.
const renderThreadBody = async (uid) => {
    const body = $('#tbody'); if (!body || openUid !== uid) return;
    const h = await histGet(uid);
    // reconcile any snaps opened while this thread was closed, and persist the change
    let dirty = false;
    h.forEach(e => { if (e.kind === 'snap' && e.snapId && openedSnapIds.has(e.snapId) && e.status !== 'opened') { e.status = 'opened'; dirty = true; } });
    if (dirty) idb.set('thread:' + uid, h).catch(() => {});
    const snaps = (inboxByUser[uid] || []).map(s => ({ snap: s, at: new Date(s.created_at).getTime() }));
    const items = [...h.map(e => ({ entry: e, at: e.at })), ...snaps].sort((a, b) => a.at - b.at);
    body.innerHTML = '';
    if (!items.length) body.innerHTML = `<div class="threadhint">Say hi 👋 — messages are end-to-end encrypted.</div>`;
    for (const it of items) {
        if (it.snap) body.appendChild(snapCard(it.snap));
        else {
            const e = it.entry;
            if (e.kind === 'text') body.appendChild(el(`<div class="b ${e.me ? 'me' : 'them'}">${esc(e.text)}</div>`));
            else if (e.kind === 'snap') body.appendChild(el(snapReceipt(e)));
            else if (e.kind === 'media') body.appendChild(mediaBubble(e, e.me ? 'me' : 'them'));
        }
    }
    body.scrollTop = body.scrollHeight;
};
const snapCard = (s) => {
    const kind = snapKind(s), label = kind === 'video' ? 'Video Snap' : 'Photo Snap';
    const action = Number(s.timer) > 0 ? 'Tap to view' : 'Tap to open';
    const card = el(`<button class="snapcard ${kind} them"><span class="sq">${kind === 'video' ? '▶' : '●'}</span> ${action} ${label} <span class="sqt">${ago(s.created_at)}</span></button>`);
    card.onclick = () => openSnap(s, card);
    return card;
};
const appendBubble = (text, cls) => { const body = $('#tbody'); if (!body) return; const hint = $('.threadhint', body); if (hint) hint.remove(); body.appendChild(el(`<div class="b ${cls}">${esc(text)}</div>`)); body.scrollTop = body.scrollHeight; };
const appendMedia = (m, cls) => { const body = $('#tbody'); if (!body) return; body.appendChild(mediaBubble(m, cls)); body.scrollTop = body.scrollHeight; };

// ---- send an async encrypted text ----
const sendText = async (uid, username, text) => {
    await histPush(uid, { me: true, kind: 'text', text, at: Date.now() });
    appendBubble(text, 'me');
    if (convBox) renderConvs(convBox, uid);
    const pub = await pubOf(uid);
    if (!pub) return appendBubble('(can’t encrypt — they haven’t opened mayfly yet)', 'sys');
    const enc = await encryptText(pub, text);
    const { error } = await db.sendMessage({ sender_id: state.me.id, recipient_id: uid, iv: enc.iv, eph_pub: enc.eph_pub, body: enc.body });
    if (error) appendBubble('(failed to send)', 'sys');
    db.bumpStreak(uid);
};

// ===================== snap opening =====================
const openSnap = async (s, card) => {
    if (card) { card.disabled = true; card.classList.add('opening'); }
    let full = null;
    try {
        if (s.delivery?.startsWith('live')) full = await fetchSnap(s.id, s.sender_id);
        else { const dl = await sb.storage.from(SNAP_BUCKET).download(s.id); if (!dl.error) { const pt = await decryptWith(state.priv, s.eph_pub, s.iv, await dl.data.arrayBuffer()); full = URL.createObjectURL(new Blob([pt], { type: snapMime(s) })); } }
    } catch (e) { console.error('[mayfly] open snap', e); }
    if (!full) { toast(s.delivery === 'live' ? 'Snap expired — sender went offline.' : 'Snap unavailable.'); return burnSnap(s, card); }
    const video = snapMime(s).startsWith('video/');
    // The default (timer 0) saves the opened media into this device's chat history,
    // then consumes the encrypted/live delivery. It will render inline like any file.
    if (!(Number(s.timer) > 0)) {
        try {
            const blob = await fetch(full).then(r => r.blob());
            const m = {
                kind: 'media', me: false, name: video ? 'Video Snap' : 'Photo Snap',
                mime: snapMime(s), mediaKind: video ? 'video' : 'image',
                data: await blobToDataURL(blob), caption: s.caption || '', snap: true, snapId: s.id,
                at: new Date(s.created_at).getTime(),
            };
            await histPush(s.sender_id, m);
            if (full.startsWith('blob:')) URL.revokeObjectURL(full);
            await burnSnap(s, card);
            if (openUid === s.sender_id) {
                await renderThreadBody(s.sender_id);
                autoPlaySnapVideo($(`video.chatmedia[data-snap="${s.id}"]`, $('#tbody')));
            }
        } catch (e) {
            console.error('[mayfly] save inline snap', e);
            toast('Could not save this Snap into the chat.');
            card?.classList.remove('opening'); if (card) card.disabled = false;
        }
        return;
    }
    const u = s.sender || {};
    const media = video ? `<video src="${safeMediaUrl(full)}" autoplay muted controls playsinline></video>` : `<img src="${safeMediaUrl(full)}" alt="snap">`;
    const ov = el(`<div class="player">${media}${s.caption ? `<div class="pcap">${esc(s.caption)}</div>` : ''}<div class="pname">${esc(u.username || '')}</div><div class="pbar"><i></i></div></div>`);
    document.body.appendChild(ov);
    requestAnimationFrame(() => { const bar = $('.pbar i', ov); bar.style.transitionDuration = s.timer + 's'; bar.classList.add('run'); });
    let done = false;
    const finish = async () => { if (done) return; done = true; clearTimeout(t); ov.remove(); if (full.startsWith('blob:')) URL.revokeObjectURL(full); await burnSnap(s, card); };
    const t = setTimeout(finish, s.timer * 1000);
    if (video) {
        const v = $('video', ov);
        v.onended = finish;
        v.onclick = (e) => e.stopPropagation();
        v.play().then(() => {
            v.muted = false;
            return v.play();
        }).catch(() => {
            // Preserve automatic visual playback if the browser blocks autoplay sound.
            v.muted = true;
            v.play().catch(() => {});
        });
    }
    ov.onclick = finish;
};
const burnSnap = async (s, card) => {
    await db.delSnap(s.id);
    if (s.delivery?.startsWith('relay')) sb.storage.from(SNAP_BUCKET).remove([s.id]);
    inboxByUser[s.sender_id] = (inboxByUser[s.sender_id] || []).filter(x => x.id !== s.id);
    card?.remove();
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};

// ===================== live P2P: media, voice, typing =====================
const MAX_FILE = 20 * 1024 * 1024;
const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
const drainConn = async (conn) => { const dc = conn?.dataChannel; if (!dc) return; let g = 0; while (dc.bufferedAmount > 4 * 1024 * 1024 && g++ < 3000) await new Promise(r => setTimeout(r, 30)); };
const sendBytes = async (conn, buf) => { const dc = conn?.dataChannel; if (!dc) return; for (let o = 0, i = 0; o < buf.byteLength; o += 16384, i++) { try { dc.send(buf.slice(o, o + 16384)); } catch (e) { return; } if (i % 32 === 0) await drainConn(conn); } };
const autoPlaySnapVideo = (video) => {
    if (!video) return;
    const play = () => video.play().catch(() => {
        // Browsers may require a direct user gesture for sound. Keep the Snap moving
        // even then, while preserving sound whenever the policy permits it.
        video.muted = true;
        video.play().catch(() => {});
    });
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) play();
    else video.addEventListener('canplay', play, { once: true });
};
const openMediaViewer = (m, inlinePlayer = null) => {
    const video = m.mediaKind === 'video';
    const reusePlayer = video && inlinePlayer;
    const tag = reusePlayer ? '' : video ? `<video src="${safeMediaUrl(m.data)}" controls autoplay playsinline></video>` : `<img src="${safeMediaUrl(m.data)}" alt="${esc(m.name || 'image')}">`;
    const ov = el(`<div class="media-viewer" role="dialog" aria-modal="true"><button class="media-close" aria-label="Close media">✕</button>${tag}</div>`);
    const marker = reusePlayer ? document.createComment('inline video') : null;
    if (reusePlayer) { inlinePlayer.before(marker); ov.appendChild(inlinePlayer); }
    const close = () => {
        ov.remove(); window.removeEventListener('keydown', onKey);
        if (marker?.parentNode) marker.replaceWith(inlinePlayer);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    $('.media-close', ov).onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    document.body.appendChild(ov);
    window.addEventListener('keydown', onKey);
    if (video) autoPlaySnapVideo(reusePlayer ? inlinePlayer : $('video', ov));
};
const mediaBubble = (m, cls) => {
    const url = safeMediaUrl(m.data);
    const inner = m.mediaKind === 'image' ? `<img class="chatmedia" src="${url}" alt="">`
        : m.mediaKind === 'video' ? `<video class="chatmedia" data-snap="${esc(m.snapId || '')}" src="${url}" controls playsinline></video>`
        : m.mediaKind === 'audio' ? `<audio src="${url}" controls></audio>`
        : `<a class="chatfile" href="${url}" download="${esc(m.name || 'file')}">📎 ${esc(m.name || 'file')}</a>`;
    const bubble = el(`<div class="b ${cls} media">${inner}${m.caption ? `<div class="snapcaption">${esc(m.caption)}</div>` : ''}</div>`);
    const media = $('.chatmedia', bubble);
    if (media) {
        media.classList.add('expandable');
        media.title = 'Open larger';
        media.onclick = () => { if (!media.closest('.media-viewer')) openMediaViewer(m, media); };
    }
    return bubble;
};
const sendFile = async (uid, file, kind) => {
    const c = conns.get(uid);
    if (!(c && c.open)) { ensureConn(uid); return appendBubble('(they need to be online to receive media)', 'sys'); }
    if (file.size > MAX_FILE) return appendBubble(`(too big — max ${Math.round(MAX_FILE / 1e6)} MB)`, 'sys');
    let dataUrl; try { dataUrl = await blobToDataURL(file); } catch (e) { return appendBubble('(could not read file)', 'sys'); }
    const id = rand(), meta = { name: file.name || kind, mime: file.type, mediaKind: kind };
    c.sendQ = (c.sendQ || Promise.resolve()).then(async () => {
        try { const buf = await file.arrayBuffer(); c.send({ t: 'file-meta', id, bytes: buf.byteLength, ...meta }); await sendBytes(c, buf); c.send({ t: 'file-done', id }); }
        catch (e) { appendBubble('(send failed)', 'sys'); }
    });
    await c.sendQ;
    const m = { kind: 'media', me: true, ...meta, data: dataUrl, at: Date.now() };
    appendMedia(m, 'me'); histPush(uid, m);
};
const wireMic = (box, uid) => {
    let rec = null, stream = null, chunks = [], holding = false, cancelled = false, draft = null, draftUrl = null;
    const mic = $('.mic', box), tray = $('.voicepreview', box);
    const reset = () => {
        mic.classList.remove('recording'); tray.hidden = true;
        if (draftUrl) URL.revokeObjectURL(draftUrl);
        draft = null; draftUrl = null; tray.innerHTML = '';
    };
    const stop = () => { if (rec?.state === 'recording') rec.stop(); };
    const start = async (e) => {
        e?.preventDefault();
        if (rec?.state === 'recording' || draft) return;
        holding = true; mic.setPointerCapture?.(e?.pointerId);
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return appendBubble('(microphone blocked)', 'sys'); }
        if (!holding) { stream.getTracks().forEach(t => t.stop()); return; }
        chunks = []; cancelled = false; rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        rec.onstop = () => {
            stream.getTracks().forEach(t => t.stop()); mic.classList.remove('recording');
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); rec = null;
            if (cancelled || !blob.size) return reset();
            draft = new File([blob], 'voice-note', { type: blob.type }); draftUrl = URL.createObjectURL(draft);
            tray.hidden = false;
            tray.innerHTML = `<audio src="${safeMediaUrl(draftUrl)}" controls></audio><button type="button" class="vxc" aria-label="Discard voice clip">✕</button><button type="button" class="vsend">Send</button>`;
            $('.vxc', tray).onclick = reset;
            $('.vsend', tray).onclick = async () => { const clip = draft; reset(); await sendFile(uid, clip, 'audio'); };
        };
        rec.start(); mic.classList.add('recording');
    };
    mic.onpointerdown = start;
    mic.onpointerup = () => { holding = false; stop(); };
    mic.onpointercancel = () => { holding = false; cancelled = true; stop(); };
};

// P2P data connection for typing + media (text no longer needs it — it's async).
const wire = (uid, conn) => {
    conns.set(uid, conn);
    const rx = {}; let binRx = null;
    conn.on('open', () => { try { conn.send({ t: 'cap' }); } catch (e) {} });
    conn.on('data', (d) => {
        if (!d) return;
        if (d.t === 'typing') { const el2 = $('#ctyping'); if (el2 && openUid === uid) el2.textContent = 'typing…'; return; }
        if (d.t === 'stop') { const el2 = $('#ctyping'); if (el2) el2.textContent = ''; return; }
        if (d.t === 'file-meta') { binRx = { meta: d, chunks: [] }; return; }
        if (d.t === 'file-done' && binRx) { const it = binRx; binRx = null; blobToDataURL(new Blob(it.chunks, { type: it.meta.mime || '' })).then(data => { const m = { kind: 'media', me: false, name: it.meta.name, mime: it.meta.mime, mediaKind: it.meta.mediaKind, data, at: Date.now() }; if (openUid === uid) appendMedia(m, 'them'); else { unreadMsg.add(uid); onChange(); } histPush(uid, m); if (convBox) renderConvs(convBox, openUid); }); return; }
    });
    conn.on('chunk', (ab) => { if (binRx) binRx.chunks.push(ab); });
    conn.on('close', () => { if (conns.get(uid) === conn) conns.delete(uid); });
    conn.on('error', () => {});
};
const ensureConn = (uid) => { const c = conns.get(uid); if (c && c.open) return; if (!isOnline(uid)) return; wire(uid, peer.connect(uid, { metadata: { kind: 'dm', user_id: state.me.id, username: state.profile.username } })); };
export const onIncomingDM = (conn) => { const uid = conn.metadata?.user_id || conn.peer; if (uid) wire(uid, conn); };
export const reconnectOpenChat = () => { if (openUid) ensureConn(openUid); };
export const detachAll = () => { openUid = null; threadBox = null; };
export const bootChat = async () => { await refreshInbox(); await syncMessages(); };

// ===================== 1:1 calling (video or voice) =====================
const getMedia = (video, facing = 'user') => navigator.mediaDevices.getUserMedia({
    video: video ? { facingMode: { ideal: facing } } : false,
    audio: true,
});
let localStream = null, remoteStream = null, curCall = null, callPeerName = '', cameraFacing = 'user', localIsMain = false;
const setStat = (t) => { const s = $('#cstat'); if (s) s.textContent = t; };
// swap a control button's glyph + dim (red) it when the track is off
const setCtl = (btn, on, onName, offName) => { if (!btn) return; btn.innerHTML = icon(on ? onName : offName); btn.classList.toggle('off', !on); };
// A small popover anchored to the header call button: pick a video or voice call.
export const callMenu = (anchor, pick) => {
    document.querySelector('.callmenu')?.remove();
    const m = el(`<div class="callmenu"><button class="cmi" data-v="1">${icon('video')}<span>Video call</span></button><button class="cmi" data-v="0">${icon('phone')}<span>Voice call</span></button></div>`);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px'; m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    document.body.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener('click', onDoc, true); };
    const onDoc = (e) => { if (!m.contains(e.target) && e.target !== anchor) close(); };
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    m.querySelectorAll('.cmi').forEach(b => b.onclick = () => { close(); pick(b.dataset.v === '1'); });
};
const openCallStage = (video) => {
    $('#callo').classList.toggle('voice', !video);
    $('#ccam').style.display = video ? '' : 'none';   // no camera toggle on a voice call
    $('#cflip').style.display = video ? '' : 'none';
    localIsMain = false;
    renderCallViews();
};
const playVideo = (node) => node?.play().catch(() => {});
const renderCallViews = () => {
    const main = $('#rv'), pip = $('#lv'); if (!main || !pip) return;
    const mainStream = localIsMain ? localStream : remoteStream;
    const pipStream = localIsMain ? remoteStream : localStream;
    main.srcObject = mainStream || null; pip.srcObject = pipStream || null;
    // Never play our own microphone through the speakers. The remote stream stays
    // audible even when it occupies the small preview.
    main.muted = localIsMain;
    pip.muted = !localIsMain;
    playVideo(main); playVideo(pip);
};
const swapCallViews = () => {
    if (!localStream || !remoteStream || $('#callo').classList.contains('voice')) return;
    localIsMain = !localIsMain;
    renderCallViews();
};
const endCall = () => {
    try { curCall?.close(); } catch (e) {} curCall = null;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const rv = $('#rv'), lv = $('#lv'); if (rv) rv.srcObject = null; if (lv) lv.srcObject = null;
    remoteStream = null; localIsMain = false; cameraFacing = 'user';
    setCtl($('#cmute'), true, 'mic', 'micOff'); setCtl($('#ccam'), true, 'video', 'videoOff'); setCtl($('#cflip'), true, 'flipCamera', 'flipCamera');
    $('#callo').classList.remove('on', 'voice');
};
const wireCallMedia = (c) => {
    curCall = c;
    c.on('stream', (s) => {
        const remote = $('#rv'); if (!remote || !s) return;
        remoteStream = s;
        // `autoplay` is present in the markup, but explicitly playing here covers
        // browsers that do not restart a video after its srcObject changes.
        renderCallViews();
        setStat($('#callo').classList.contains('voice') ? callPeerName : '');
    });
    c.on('close', endCall); c.on('error', endCall);
};
export const callUser = async (uid, username, video = true) => {
    if (!isOnline(uid)) return toast(username + ' is offline.');
    if (curCall) return toast('Already in a call.');
    cameraFacing = 'user';
    try { localStream = await getMedia(video, cameraFacing); } catch (e) { return toast('Camera/mic blocked'); }
    callPeerName = username;
    openCallStage(video); $('#callo').classList.add('on'); setStat((video ? 'Calling ' : 'Ringing ') + username + '…');
    wireCallMedia(peer.call(uid, localStream, { metadata: { username: state.profile.username, video } }));
};
export const onIncomingCall = (incoming) => {
    if (curCall) return incoming.close();
    const username = incoming.metadata?.username || 'Someone';
    const video = incoming.metadata?.video !== false;
    callPeerName = username;
    const banner = $('#incall');
    banner.innerHTML = `<div class="avatar ib">${initial(username)}</div><div style="flex:1"><b>${esc(username)}</b><div class="muted" style="font-size:12px">Incoming ${video ? 'video' : 'voice'} call…</div></div><button class="pill primary" id="acc">Accept</button><button class="pill" id="dec">Decline</button>`;
    banner.classList.add('on');
    const clear = () => banner.classList.remove('on');
    $('#dec', banner).onclick = () => { clear(); try { incoming.close(); } catch (e) {} };
    $('#acc', banner).onclick = async () => {
        clear();
        cameraFacing = 'user';
        try { localStream = await getMedia(video, cameraFacing); }
        catch (e) { toast('Camera/mic blocked'); try { incoming.close(); } catch (e2) {} return; }
        openCallStage(video); $('#callo').classList.add('on'); setStat('Connecting…');
        wireCallMedia(incoming);
        try { await incoming.answer(localStream); }
        catch (e) { console.error('[mayfly] answer call', e); endCall(); toast('Could not connect the call.'); }
    };
};
$('#chang').onclick = endCall;
$('#cmute').onclick = () => { const a = localStream?.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; setCtl($('#cmute'), a.enabled, 'mic', 'micOff'); } };
$('#ccam').onclick = () => { const v = localStream?.getVideoTracks()[0]; if (v) { v.enabled = !v.enabled; setCtl($('#ccam'), v.enabled, 'video', 'videoOff'); } };
$('#cflip').onclick = async () => {
    const oldTrack = localStream?.getVideoTracks()[0];
    if (!oldTrack || !curCall?.replaceVideoTrack) return;
    const nextFacing = cameraFacing === 'user' ? 'environment' : 'user';
    let camera;
    try { camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: nextFacing } }, audio: false }); }
    catch (e) { return toast('Could not switch cameras.'); }
    const newTrack = camera.getVideoTracks()[0];
    try {
        newTrack.enabled = oldTrack.enabled;
        if (!await curCall.replaceVideoTrack(newTrack)) throw new Error('No video sender');
        localStream.removeTrack(oldTrack); localStream.addTrack(newTrack); oldTrack.stop();
        cameraFacing = nextFacing; renderCallViews();
    } catch (e) { newTrack.stop(); toast('Could not switch cameras.'); }
};
$('#lv').onclick = swapCallViews;
$('#lv').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); swapCallViews(); } };
setCtl($('#cmute'), true, 'mic', 'micOff'); setCtl($('#ccam'), true, 'video', 'videoOff'); setCtl($('#cflip'), true, 'flipCamera', 'flipCamera'); if ($('#chang')) $('#chang').innerHTML = icon('phoneOff');
