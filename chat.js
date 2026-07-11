import { app, $, el, esc, rand, toast, state, idb, isOnline, initial, avatarHTML, safeMediaUrl, chunkString, mimeKind } from './core.js';
import { peer } from './rtc.js';
import { db } from './db.js';

// ===================== ephemeral P2P chat =====================
// Messages (text, photos, videos, files, voice clips) fly directly browser-to-browser
// over WebRTC and are NEVER stored on a server. Each device keeps its own local history
// in IndexedDB (chat:<uid>) so conversations survive a refresh — capped at 200 entries.
// Live-only: both people must be online, matching mayfly's ephemeral spirit.
const chats = new Map();          // uid -> { conn, username, logEl|null, binOk, sendQ }
const unread = new Set();
export const chatUnread = () => unread.size;
const onChange = () => window.dispatchEvent(new Event('chat-unread'));

const hist = (uid) => idb.get('chat:' + uid).then(h => h || []);
const save = async (uid, entry) => {
    const h = await hist(uid);
    h.push(entry); if (h.length > 200) h.splice(0, h.length - 200);
    await idb.set('chat:' + uid, h).catch(() => {});
};
// Don't persist very large media locally — store a placeholder instead.
const saveMedia = (uid, entry) => (entry.data && entry.data.length > 12 * 1024 * 1024)
    ? save(uid, { me: entry.me, text: `[${entry.kind}] ${entry.name || ''} (too large to save)` })
    : save(uid, entry).catch(() => {});

const bubble = (logEl, text, cls) => { if (!logEl) return; logEl.appendChild(el(`<div class="b ${cls}">${esc(text)}</div>`)); logEl.scrollTop = logEl.scrollHeight; };
const mediaBubble = (logEl, m, cls) => {
    if (!logEl) return;
    const url = safeMediaUrl(m.data);   // peer-supplied → must be a data:/blob: media URL
    const inner = m.kind === 'image' ? `<img class="chatmedia" src="${url}" alt="${esc(m.name || 'image')}">`
        : m.kind === 'video' ? `<video class="chatmedia" src="${url}" controls playsinline></video>`
        : m.kind === 'audio' ? `<audio src="${url}" controls></audio>`
        : `<a class="chatfile" href="${url}" download="${esc(m.name || 'file')}">📎 ${esc(m.name || 'file')}</a>`;
    logEl.appendChild(el(`<div class="b ${cls} media">${inner}</div>`)); logEl.scrollTop = logEl.scrollHeight;
};
const progress = (logEl, meta) => { const b = el(`<div class="b sys">receiving ${esc(meta.name || meta.kind)}… 0%</div>`); logEl?.appendChild(b); if (logEl) logEl.scrollTop = logEl.scrollHeight; return b; };

// ---- media transfer over the data channel (raw binary, with backpressure) ----
const MAX_FILE = 20 * 1024 * 1024;
const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
const drainConn = async (conn) => { const dc = conn?.dataChannel; if (!dc) return; let g = 0; while (dc.bufferedAmount > 4 * 1024 * 1024 && g++ < 3000) await new Promise(r => setTimeout(r, 30)); };
const BIN = 16 * 1024;
const sendBytes = async (conn, buf) => { const dc = conn?.dataChannel; if (!dc) return; for (let o = 0, i = 0; o < buf.byteLength; o += BIN, i++) { try { dc.send(buf.slice(o, o + BIN)); } catch (e) { return; } if (i % 32 === 0) await drainConn(conn); } };
const sendFile = async (uid, file, kind) => {
    const c = chats.get(uid); const logEl = c?.logEl;
    if (!(c?.conn && c.conn.open)) return bubble(logEl, '(not connected — they may be offline)', 'sys');
    if (file.size > MAX_FILE) return bubble(logEl, `(too big — max ${Math.round(MAX_FILE / 1e6)} MB)`, 'sys');
    let dataUrl; try { dataUrl = await blobToDataURL(file); } catch (e) { return bubble(logEl, '(could not read file)', 'sys'); }
    const id = rand(), meta = { name: file.name || kind, mime: file.type, kind };
    c.sendQ = (c.sendQ || Promise.resolve()).then(async () => {
        try {
            if (c.binOk) { const buf = await file.arrayBuffer(); c.conn.send({ t: 'file-meta', id, bin: 1, bytes: buf.byteLength, ...meta }); await sendBytes(c.conn, buf); c.conn.send({ t: 'file-done', id }); }
            else { const chunks = chunkString(dataUrl); c.conn.send({ t: 'file-meta', id, parts: chunks.length, ...meta }); for (let i = 0; i < chunks.length; i++) { c.conn.send({ t: 'file-part', id, i, s: chunks[i] }); if (i % 32 === 0) await drainConn(c.conn); } }
        } catch (e) { bubble(logEl, '(send failed)', 'sys'); }
    });
    await c.sendQ;
    mediaBubble(logEl, { ...meta, data: dataUrl }, 'me'); saveMedia(uid, { me: true, ...meta, data: dataUrl });
};

const wire = (uid, username, conn) => {
    const c = chats.get(uid) || { username };
    c.conn = conn; c.username = username; chats.set(uid, c);
    const rx = {}; let binRx = null;
    const flag = () => { if (!c.logEl) { unread.add(uid); onChange(); if (window.Notification?.permission === 'granted') new Notification('mayfly 🐛 ' + username, { body: 'New message' }); } };
    conn.on('open', () => { setDot(uid, true); try { conn.send({ t: 'cap', bin: 1 }); } catch (e) {} });
    conn.on('data', (d) => {
        if (!d) return;
        if (d.t === 'cap')    return void (c.binOk = !!d.bin);
        if (d.t === 'typing') return setTyping(uid, username + ' is typing…');
        if (d.t === 'stop')   return setTyping(uid, '');
        if (d.t === 'msg')    { setTyping(uid, ''); save(uid, { me: false, text: d.text }); if (c.logEl) bubble(c.logEl, d.text, 'them'); else flag(); return; }
        if (d.t === 'file-meta') { if (d.bin) binRx = { meta: d, chunks: [], ph: progress(c.logEl, d) }; else rx[d.id] = { meta: d, buf: new Array(d.parts), got: 0, ph: progress(c.logEl, d) }; return; }
        if (d.t === 'file-done' && binRx) { const it = binRx; binRx = null; it.ph?.remove(); blobToDataURL(new Blob(it.chunks, { type: it.meta.mime || '' })).then(data => { const m = { kind: it.meta.kind, name: it.meta.name, mime: it.meta.mime, data }; if (c.logEl) mediaBubble(c.logEl, m, 'them'); else flag(); saveMedia(uid, { me: false, ...m }); }); return; }
        if (d.t === 'file-part') { const it = rx[d.id]; if (!it || it.buf[d.i] != null) return; it.buf[d.i] = d.s; it.got++; if (it.ph) it.ph.textContent = `receiving ${it.meta.name || it.meta.kind}… ${Math.round(it.got / it.meta.parts * 100)}%`; if (it.got === it.meta.parts) { const m = { kind: it.meta.kind, name: it.meta.name, mime: it.meta.mime, data: it.buf.join('') }; delete rx[d.id]; it.ph?.remove(); if (c.logEl) mediaBubble(c.logEl, m, 'them'); else flag(); saveMedia(uid, { me: false, ...m }); } return; }
    });
    conn.on('chunk', (ab) => { if (!binRx) return; binRx.chunks.push(ab); binRx.got = (binRx.got || 0) + ab.byteLength; if (binRx.ph) binRx.ph.textContent = `receiving ${binRx.meta.name || binRx.meta.kind}… ${Math.round(binRx.got / (binRx.meta.bytes || 1) * 100)}%`; });
    conn.on('close', () => { setDot(uid, false); if (c.logEl) bubble(c.logEl, '(disconnected)', 'sys'); c.conn = null; });
    conn.on('error', () => {});
};
const viewOf = (uid) => chats.get(uid)?.logEl?.closest('.chatview');
const setDot = (uid, on) => { const v = viewOf(uid); const dot = v && $('.cdot', v); if (dot) dot.style.opacity = on ? '1' : '.25'; };
const setTyping = (uid, t) => { const v = viewOf(uid); const e = v && $('.ctyping', v); if (e) e.textContent = t; };

const ensureConn = (uid, username) => { const c = chats.get(uid); if (c?.conn && c.conn.open) return; if (!isOnline(uid)) return; wire(uid, username, peer.connect(uid, { metadata: { kind: 'dm', user_id: state.me.id, username: state.profile.username } })); };

export const openChat = async (uid) => {
    let username = chats.get(uid)?.username;
    if (!username) { const { data } = await db.profileById(uid); username = data?.username || 'friend'; }
    unread.delete(uid); onChange();
    app.innerHTML = `<main class="chatview">
        <div class="chathead">
          <button class="icon back" data-go="#/chat" aria-label="Back">‹</button>
          ${avatarHTML(username, null)}
          <div class="who"><b>${esc(username)}</b><div class="sub"><i class="cdot" style="opacity:${isOnline(uid) ? '1' : '.25'}"></i> ${isOnline(uid) ? 'online' : 'offline — live chat needs them online'}</div></div>
          <button class="icon callbtn" aria-label="Video call">📹</button>
        </div>
        <div class="chatlog"></div>
        <div class="ctyping"></div>
        <form class="chatin">
          <button type="button" class="icon attach" aria-label="Attach photo, video, or file">📎</button>
          <button type="button" class="icon mic" aria-label="Record a voice note">🎤</button>
          <input placeholder="Message…" autocomplete="off" aria-label="Message"><button type="submit">Send</button>
          <input type="file" class="fileinput" hidden>
        </form>
      </main>`;
    const logEl = $('.chatlog');
    const c = chats.get(uid) || { username }; c.username = username; c.logEl = logEl; chats.set(uid, c);
    (await hist(uid)).forEach(m => m.kind ? mediaBubble(logEl, m, m.me ? 'me' : 'them') : bubble(logEl, m.text, m.me ? 'me' : 'them'));
    ensureConn(uid, username);
    $('.callbtn').onclick = () => callUser(uid, username);
    const form = $('.chatin'), textInput = $('.chatin input:not(.fileinput)'), fileInput = $('.fileinput'); let tt;
    $('.attach').onclick = () => fileInput.click();
    fileInput.onchange = () => { const f = fileInput.files[0]; if (f) sendFile(uid, f, mimeKind(f.type)); fileInput.value = ''; };
    // voice note: tap to start, tap again to stop & send
    let rec = null, recStream = null, recChunks = [];
    $('.mic').onclick = async () => {
        if (rec && rec.state === 'recording') return rec.stop();
        try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return bubble(logEl, '(microphone blocked)', 'sys'); }
        recChunks = []; rec = new MediaRecorder(recStream);
        rec.ondataavailable = (e) => { if (e.data?.size) recChunks.push(e.data); };
        rec.onstop = async () => { recStream.getTracks().forEach(t => t.stop()); $('.mic').classList.remove('recording'); const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' }); await sendFile(uid, new File([blob], 'voice-note', { type: blob.type }), 'audio'); };
        rec.start(); $('.mic').classList.add('recording');
    };
    form.onsubmit = (e) => {
        e.preventDefault();
        const t = textInput.value.trim(); if (!t) return;
        const cc = chats.get(uid);
        if (!(cc?.conn && cc.conn.open)) { ensureConn(uid, username); return bubble(logEl, isOnline(uid) ? '(connecting… try again in a second)' : '(they’re offline — messages are live P2P)', 'sys'); }
        try { cc.conn.send({ t: 'msg', text: t }); bubble(logEl, t, 'me'); save(uid, { me: true, text: t }); textInput.value = ''; } catch (e2) { bubble(logEl, '(send failed)', 'sys'); }
    };
    textInput.oninput = () => { const cc = chats.get(uid); if (!(cc?.conn && cc.conn.open)) return; try { cc.conn.send({ t: 'typing' }); } catch (e) {} clearTimeout(tt); tt = setTimeout(() => { try { cc.conn.send({ t: 'stop' }); } catch (e) {} }, 1200); };
};

export const detachChat = (uid) => { const c = chats.get(uid); if (c) c.logEl = null; };
export const detachAll = () => chats.forEach(c => c.logEl = null);

export const renderChatList = async (into) => {
    const { data: fr } = await db.friends();
    const friends = (fr || []).map(f => f.requester_id === state.me.id ? f.addressee : f.requester).filter(Boolean);
    into.innerHTML = '';
    if (!friends.length) return void (into.innerHTML = `<div class="empty">No friends yet. <a href="#/friends">Add some →</a></div>`);
    friends.forEach(u => into.appendChild(el(`<button class="urow ${unread.has(u.id) ? 'unread' : ''}" data-go="#/chat/${u.id}">
        ${avatarHTML(u.username, u.avatar)}
        <div class="who"><b>${esc(u.username)}</b><div class="sub">${isOnline(u.id) ? '<i class="dot"></i>online' : 'tap to chat'}</div></div>
        ${unread.has(u.id) ? '<i class="unreaddot"></i>' : ''}</button>`)));
};

export const onIncomingDM = (conn) => { const meta = conn.metadata || {}; const uid = meta.user_id || conn.peer; const username = meta.username || 'someone'; if (uid) wire(uid, username, conn); };

// ===================== 1:1 P2P video calling =====================
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
    banner.innerHTML = `<div class="avatar ib">${initial(username)}</div>
      <div style="flex:1"><b>${esc(username)}</b><div class="muted" style="font-size:12px">Incoming video call…</div></div>
      <button class="pill primary" id="acc">Accept</button><button class="pill" id="dec">Decline</button>`;
    banner.classList.add('on');
    const clear = () => banner.classList.remove('on');
    $('#dec', banner).onclick = () => { clear(); try { incoming.close(); } catch (e) {} };
    $('#acc', banner).onclick = async () => {
        clear();
        try { localStream = await getMedia(); } catch (e) { toast('Camera/mic blocked'); try { incoming.close(); } catch (e2) {} return; }
        $('#lv').srcObject = localStream; $('#callo').classList.add('on'); setStat('Connecting…');
        incoming.answer(localStream); wireCallMedia(incoming);
    };
};
// static call-bar controls (wired once)
$('#chang').onclick = endCall;
$('#cmute').onclick = () => { const a = localStream?.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; $('#cmute').style.opacity = a.enabled ? '1' : '.4'; } };
$('#ccam').onclick  = () => { const v = localStream?.getVideoTracks()[0]; if (v) { v.enabled = !v.enabled; $('#ccam').style.opacity = v.enabled ? '1' : '.4'; } };
