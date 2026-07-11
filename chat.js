import { sb, SNAP_BUCKET, $, el, esc, rand, toast, state, idb, isOnline, initial, ago,
    avatarHTML, safeMediaUrl, chunkString, mimeKind } from './core.js';
import { peer, fetchSnap } from './rtc.js';
import { db } from './db.js';
import { encryptText, decryptText, decryptWith } from './crypto.js';

// ===================== unified conversations (snaps + chat, Snapchat-style) =====================
// TEXT is async + end-to-end encrypted via mf_messages (works even when the friend is
// offline — they pick it up on next open, then the row is deleted). MEDIA / voice notes
// / video calls are live P2P (both online). SNAPS show inline as "Tap to view" cards.
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
export const noteSentSnap = (uid) => histPush(uid, { me: true, kind: 'snap', at: Date.now() }).then(() => { if (convBox) renderConvs(convBox, openUid); });

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
            <span class="camicon" data-snap="${u.id}" aria-label="Send a snap">◉</span></button>`);
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
          <button class="icon callbtn" aria-label="Video call">📹</button>
        </div>
        <div class="tbody" id="tbody"><div class="spin">…</div></div>
        <div class="ctyping" id="ctyping"></div>
        <div class="voicepreview" hidden></div>
        <form class="tin">
          <button type="button" class="icon snapbtn" aria-label="Send a snap">◉</button>
          <button type="button" class="icon attach" aria-label="Attach">📎</button>
          <button type="button" class="icon mic" aria-label="Voice note">🎤</button>
          <input class="tinput" placeholder="Send a chat" autocomplete="off" aria-label="Message">
          <button type="submit" class="sendbtn" aria-label="Send">➤</button>
          <input type="file" class="fileinput" hidden>
        </form>
      </div>`;
    $('.callbtn', box).onclick = () => callUser(uid, username);
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
    const snaps = (inboxByUser[uid] || []).map(s => ({ snap: s, at: new Date(s.created_at).getTime() }));
    const items = [...h.map(e => ({ entry: e, at: e.at })), ...snaps].sort((a, b) => a.at - b.at);
    body.innerHTML = '';
    if (!items.length) body.innerHTML = `<div class="threadhint">Say hi 👋 — messages are end-to-end encrypted.</div>`;
    for (const it of items) {
        if (it.snap) body.appendChild(snapCard(it.snap));
        else {
            const e = it.entry;
            if (e.kind === 'text') body.appendChild(el(`<div class="b ${e.me ? 'me' : 'them'}">${esc(e.text)}</div>`));
            else if (e.kind === 'snap') body.appendChild(el(`<div class="b sys">📷 You sent a Snap</div>`));
            else if (e.kind === 'media') body.appendChild(mediaBubble(e, e.me ? 'me' : 'them'));
        }
    }
    body.scrollTop = body.scrollHeight;
};
const snapCard = (s) => {
    const kind = snapKind(s), label = kind === 'video' ? 'Video Snap' : 'Photo Snap';
    const card = el(`<button class="snapcard ${kind} them"><span class="sq">${kind === 'video' ? '▶' : '●'}</span> Tap to view ${label} <span class="sqt">${ago(s.created_at)}</span></button>`);
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

// ===================== view-once snap player =====================
const openSnap = async (s, card) => {
    if (card) { card.disabled = true; card.classList.add('opening'); }
    let full = null;
    try {
        if (s.delivery?.startsWith('live')) full = await fetchSnap(s.id, s.sender_id);
        else { const dl = await sb.storage.from(SNAP_BUCKET).download(s.id); if (!dl.error) { const pt = await decryptWith(state.priv, s.eph_pub, s.iv, await dl.data.arrayBuffer()); full = URL.createObjectURL(new Blob([pt], { type: snapMime(s) })); } }
    } catch (e) { console.error('[mayfly] open snap', e); }
    if (!full) { toast(s.delivery === 'live' ? 'Snap expired — sender went offline.' : 'Snap unavailable.'); return burnSnap(s, card); }
    const u = s.sender || {};
    const video = snapMime(s).startsWith('video/');
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
const mediaBubble = (m, cls) => {
    const url = safeMediaUrl(m.data);
    const inner = m.mediaKind === 'image' ? `<img class="chatmedia" src="${url}" alt="">`
        : m.mediaKind === 'video' ? `<video class="chatmedia" src="${url}" controls playsinline></video>`
        : m.mediaKind === 'audio' ? `<audio src="${url}" controls></audio>`
        : `<a class="chatfile" href="${url}" download="${esc(m.name || 'file')}">📎 ${esc(m.name || 'file')}</a>`;
    return el(`<div class="b ${cls} media">${inner}</div>`);
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

// ===================== 1:1 video calling =====================
const getMedia = () => navigator.mediaDevices.getUserMedia({ video: true, audio: true });
let localStream = null, curCall = null;
const setStat = (t) => { const s = $('#cstat'); if (s) s.textContent = t; };
const endCall = () => {
    try { curCall?.close(); } catch (e) {} curCall = null;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const rv = $('#rv'), lv = $('#lv'); if (rv) rv.srcObject = null; if (lv) lv.srcObject = null;
    $('#cmute').style.opacity = $('#ccam').style.opacity = '1';
    $('#callo').classList.remove('on');
};
const wireCallMedia = (c) => { curCall = c; c.on('stream', (s) => { $('#rv').srcObject = s; setStat(''); }); c.on('close', endCall); c.on('error', endCall); };
export const callUser = async (uid, username) => {
    if (!isOnline(uid)) return toast(username + ' is offline.');
    if (curCall) return toast('Already in a call.');
    try { localStream = await getMedia(); } catch (e) { return toast('Camera/mic blocked'); }
    $('#lv').srcObject = localStream; $('#callo').classList.add('on'); setStat('Calling ' + username + '…');
    wireCallMedia(peer.call(uid, localStream, { metadata: { username: state.profile.username } }));
};
export const onIncomingCall = (incoming) => {
    if (curCall) return incoming.close();
    const username = incoming.metadata?.username || 'Someone';
    const banner = $('#incall');
    banner.innerHTML = `<div class="avatar ib">${initial(username)}</div><div style="flex:1"><b>${esc(username)}</b><div class="muted" style="font-size:12px">Incoming video call…</div></div><button class="pill primary" id="acc">Accept</button><button class="pill" id="dec">Decline</button>`;
    banner.classList.add('on');
    const clear = () => banner.classList.remove('on');
    $('#dec', banner).onclick = () => { clear(); try { incoming.close(); } catch (e) {} };
    $('#acc', banner).onclick = async () => { clear(); try { localStream = await getMedia(); } catch (e) { toast('Camera/mic blocked'); try { incoming.close(); } catch (e2) {} return; } $('#lv').srcObject = localStream; $('#callo').classList.add('on'); setStat('Connecting…'); incoming.answer(localStream); wireCallMedia(incoming); };
};
$('#chang').onclick = endCall;
$('#cmute').onclick = () => { const a = localStream?.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; $('#cmute').style.opacity = a.enabled ? '1' : '.4'; } };
$('#ccam').onclick = () => { const v = localStream?.getVideoTracks()[0]; if (v) { v.enabled = !v.enabled; $('#ccam').style.opacity = v.enabled ? '1' : '.4'; } };
