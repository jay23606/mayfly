import { app, $, $$, el, esc, toast, state, initial, avatarHTML, safeMediaUrl, mimeKind, sb, isOnline } from './core.js';
import { peer } from './rtc.js';
import { db } from './db.js';

// ===================== group chats + mesh video calls =====================
// A group is persistent (mf_groups). While the view is open, members share a private
// Realtime channel: text rides ephemeral Broadcast (nothing stored) and a group video
// call is a full P2P *mesh* — every member connects to every other. Rendered as a full
// view; leaving the view tears the channel down (ephemeral room semantics).
let current = null;   // the open group panel, or null

const memberMap = (group) => { const m = {}; (group.mf_group_members || []).forEach(gm => { m[gm.user_id] = gm.profiles || {}; }); return m; };
const gLine = (gp, html) => { const l = $('.chatlog', gp.node); if (!l) return; l.appendChild(el(html)); l.scrollTop = l.scrollHeight; };
const gText = (gp, name, text, cls) => gLine(gp, `<div class="b ${cls}">${cls === 'them' ? `<span class="gwho">${esc(name)}</span>` : ''}${esc(text)}</div>`);
const gSys = (gp, text) => gLine(gp, `<div class="b sys">${esc(text)}</div>`);
const bcast = (gp, payload) => { try { gp.ch.send({ type: 'broadcast', event: 'g', payload: { from: state.me.id, name: state.profile.username, ...payload } }); } catch (e) {} };

// ---- group P2P media (files, clips, and view-once snaps) ----
const MEDIA_MAX = 20 * 1024 * 1024;
const gid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
const waitDrain = async (conn) => {
    const dc = conn?.dataChannel; if (!dc) return;
    while (dc.bufferedAmount > 4 * 1024 * 1024) await new Promise(r => setTimeout(r, 25));
};
const sendGroupBytes = async (conn, bytes) => {
    const dc = conn?.dataChannel; if (!dc) return;
    for (let o = 0, i = 0; o < bytes.byteLength; o += 16384, i++) {
        try { dc.send(bytes.slice(o, o + 16384)); } catch (e) { return false; }
        if (i % 32 === 0) await waitDrain(conn);
    }
    return true;
};
const groupMediaBubble = (gp, media, cls, name = '') => {
    const url = safeMediaUrl(media.url);
    const inner = media.kind === 'image' ? `<img class="chatmedia" src="${url}" alt="">`
        : media.kind === 'video' ? `<video class="chatmedia" src="${url}" controls playsinline></video>`
        : media.kind === 'audio' ? `<audio src="${url}" controls></audio>`
        : `<a class="chatfile" href="${url}" download="${esc(media.name || 'file')}">📎 ${esc(media.name || 'file')}</a>`;
    gLine(gp, `<div class="b ${cls} media">${cls === 'them' ? `<span class="gwho">${esc(name)}</span>` : ''}${inner}</div>`);
};
const groupSnapCard = (gp, media, cls, name = '') => {
    const card = el(`<button class="snapcard ${media.kind === 'video' ? 'video' : 'photo'} ${cls}"><span class="sq">${media.kind === 'video' ? '▶' : '●'}</span> Tap to view ${media.kind === 'video' ? 'Video' : 'Photo'} Snap</button>`);
    if (cls === 'them') card.insertAdjacentHTML('afterbegin', `<span class="gwho">${esc(name)}</span>`);
    card.onclick = () => {
        const tag = media.kind === 'video' ? `<video src="${safeMediaUrl(media.url)}" autoplay muted playsinline></video>` : `<img src="${safeMediaUrl(media.url)}" alt="snap">`;
        const ov = el(`<div class="player">${tag}<div class="pbar"><i></i></div></div>`);
        document.body.appendChild(ov);
        const finish = () => { clearTimeout(t); ov.remove(); URL.revokeObjectURL(media.url); card.remove(); };
        const t = setTimeout(finish, 5000);
        ov.onclick = finish;
        if (media.kind === 'video') $('video', ov).onended = finish;
    };
    $('.chatlog', gp.node)?.appendChild(card);
    $('.chatlog', gp.node).scrollTop = $('.chatlog', gp.node).scrollHeight;
};
const wireGroupData = (gp, uid, conn) => {
    if (gp.dataPeers.has(uid)) { try { conn.close(); } catch (e) {} return; }
    gp.dataPeers.set(uid, conn);
    let incoming = null;
    conn.on('data', (d) => {
        if (!d) return;
        if (d.t === 'gmedia-meta') { incoming = { meta: d, chunks: [] }; return; }
        if (d.t === 'gmedia-done' && incoming?.meta.id === d.id) {
            const item = incoming; incoming = null;
            const blob = new Blob(item.chunks, { type: item.meta.mime || '' });
            const media = { ...item.meta, url: URL.createObjectURL(blob) };
            if (media.snap) groupSnapCard(gp, media, 'them', item.meta.nameFrom);
            else groupMediaBubble(gp, media, 'them', item.meta.nameFrom);
        }
    });
    conn.on('chunk', (ab) => { if (incoming) incoming.chunks.push(ab); });
    conn.on('close', () => { if (gp.dataPeers.get(uid) === conn) gp.dataPeers.delete(uid); });
    conn.on('error', () => { if (gp.dataPeers.get(uid) === conn) gp.dataPeers.delete(uid); });
};
const syncGroupDataPeers = (gp) => {
    const st = gp.ch?.presenceState?.() || {};
    for (const uid of Object.keys(st)) {
        if (uid === state.me.id || !gp.members[uid] || gp.dataPeers.has(uid)) continue;
        if (state.me.id > uid) wireGroupData(gp, uid, peer.connect(uid, { metadata: { kind: 'group', group: gp.id, user_id: state.me.id } }));
    }
};
export const onIncomingGroupData = (conn) => {
    const gp = current && current.id === conn.metadata?.group ? current : null;
    if (!gp || !gp.members[conn.peer]) return conn.close();
    wireGroupData(gp, conn.peer, conn);
};
const sendGroupMedia = async (gp, file, snap = false) => {
    if (!file) return;
    if (file.size > MEDIA_MAX) return toast(`Media is too large (max ${Math.round(MEDIA_MAX / 1e6)} MB).`);
    syncGroupDataPeers(gp);
    const peers = [...gp.dataPeers.values()].filter(c => c.open);
    if (!peers.length) return toast('Group members need this chat open to receive media.');
    const kind = mimeKind(file.type), id = gid(), bytes = await file.arrayBuffer();
    const meta = { t: 'gmedia-meta', id, bytes: bytes.byteLength, mime: file.type, kind, name: file.name || kind, nameFrom: state.profile.username, snap };
    await Promise.all(peers.map(async (conn) => {
        conn.send(meta);
        const sent = await sendGroupBytes(conn, bytes);
        if (sent) conn.send({ t: 'gmedia-done', id });
    }));
    const media = { ...meta, url: URL.createObjectURL(file) };
    if (snap) groupSnapCard(gp, media, 'me'); else groupMediaBubble(gp, media, 'me');
};

// ---- mesh video ----
const tileFor = (gp, uid, stream, name, isLocal) => {
    let t = $(`.gtile[data-uid="${uid}"]`, gp.node);
    if (!t) { t = el(`<div class="gtile" data-uid="${uid}"><video autoplay playsinline ${isLocal ? 'muted' : ''}></video><span class="gname">${esc(name || '')}</span></div>`); $('.gvideos', gp.node).appendChild(t); }
    if (stream) $('video', t).srcObject = stream;
    gridClass(gp);
};
const removeTile = (gp, uid) => { $(`.gtile[data-uid="${uid}"]`, gp.node)?.remove(); gridClass(gp); };
const gridClass = (gp) => { const g = $('.gvideos', gp.node); if (g) g.dataset.n = Math.min($$('.gtile', gp.node).length, 4); };
const wireGroupPeer = (gp, uid, conn) => {
    gp.call.peers.set(uid, conn);
    conn.on('stream', (s) => tileFor(gp, uid, s, gp.members[uid]?.username));
    conn.on('close', () => { gp.call.peers.delete(uid); removeTile(gp, uid); });
};
// Reconcile the mesh with who's currently in the call (higher uid initiates → no glare).
const meshUpdate = (gp) => {
    if (!gp.call) return;
    const st = gp.ch.presenceState(), inCall = new Set();
    for (const k in st) for (const m of st[k]) if (m.in_call) inCall.add(k);
    for (const uid of [...gp.call.peers.keys()]) if (!inCall.has(uid)) { try { gp.call.peers.get(uid).close(); } catch (e) {} gp.call.peers.delete(uid); removeTile(gp, uid); }
    for (const uid of inCall) {
        if (uid === state.me.id || gp.call.peers.has(uid)) continue;
        if (state.me.id > uid) wireGroupPeer(gp, uid, peer.call(uid, gp.call.localStream, { metadata: { group: gp.id } }));
    }
};
const joinCall = async (gp) => {
    if (gp.call) return;
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); } catch (e) { return toast('Camera/mic blocked'); }
    gp.call = { localStream: stream, peers: new Map() };
    gp.node.classList.add('incall');
    tileFor(gp, state.me.id, stream, 'You', true);
    $('.gcall', gp.node).textContent = '📵';
    await gp.ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: true });
    meshUpdate(gp);
};
const leaveCall = (gp) => {
    if (!gp.call) return;
    gp.call.peers.forEach(c => { try { c.close(); } catch (e) {} });
    gp.call.localStream.getTracks().forEach(t => t.stop());
    $('.gvideos', gp.node).innerHTML = '';
    gp.node.classList.remove('incall');
    gp.call = null;
    const b = $('.gcall', gp.node); if (b) b.textContent = '📹';
    gp.ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: false });
};
// incoming mesh leg (auto-answered if we're in that group's call)
export const onIncomingGroupCall = (c) => {
    const gp = current && current.id === c.metadata?.group ? current : null;
    if (!gp || !gp.call || gp.call.peers.has(c.peer)) return c.close();
    c.answer(gp.call.localStream);
    wireGroupPeer(gp, c.peer, c);
};

// ---- presence + messaging ----
const updatePresence = (gp) => {
    const st = gp.ch.presenceState();
    const o = $('.gonline', gp.node); if (o) o.textContent = `${Object.keys(st).length} online`;
    const othersInCall = Object.keys(st).some(k => k !== state.me.id && st[k].some(m => m.in_call));
    const btn = $('.gcall', gp.node);
    if (othersInCall && !gp.call && !gp.notified) { gSys(gp, 'Video call in progress — tap 📹 to join'); gp.notified = true; btn?.classList.add('ring'); }
    if (!othersInCall) { gp.notified = false; btn?.classList.remove('ring'); }
    if (gp.call) meshUpdate(gp);
    syncGroupDataPeers(gp);
};

const wireGroupMic = (gp) => {
    let recorder = null, stream = null, chunks = [], cancelled = false;
    const mic = $('.gmic', gp.node), recordBar = $('.grecord', gp.node);
    const reset = () => { mic.classList.remove('recording'); recordBar.hidden = true; };
    const stop = () => { if (recorder?.state === 'recording') recorder.stop(); };
    mic.onclick = async () => {
        if (recorder?.state === 'recording') return stop();
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { return toast('Microphone access is blocked.'); }
        chunks = []; cancelled = false;
        try { recorder = new MediaRecorder(stream); }
        catch (e) { stream.getTracks().forEach(t => t.stop()); return toast('Voice recording is unavailable.'); }
        recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        recorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop()); reset();
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            recorder = null;
            if (!cancelled && blob.size) await sendGroupMedia(gp, new File([blob], 'voice-note', { type: blob.type }));
        };
        recorder.start(); mic.classList.add('recording'); recordBar.hidden = false;
    };
    $('.gcancel', gp.node).onclick = () => { cancelled = true; stop(); };
    $('.gstop', gp.node).onclick = stop;
};

// Tear down the open group when navigating away.
export const closeCurrentGroup = () => {
    if (!current) return;
    leaveCall(current);
    current.dataPeers?.forEach(c => { try { c.close(); } catch (e) {} });
    try { current.ch.unsubscribe(); } catch (e) {}
    current = null;
};

const openGroup = (group) => {
    closeCurrentGroup();
    const members = memberMap(group);
    const avs = Object.entries(members).filter(([uid]) => uid !== state.me.id).slice(0, 3).map(([, p]) => avatarHTML(p.username, p.avatar, 'gav')).join('');
    app.innerHTML = `<main class="chatview group">
        <div class="chathead">
          <button class="icon back" data-go="#/chats" aria-label="Back">‹</button>
          <div class="gavatars">${avs || '👥'}</div>
          <div class="who"><b>${esc(group.name || 'Group')}</b><div class="sub gonline">…</div></div>
          <button class="icon gadd" aria-label="Add friend">＋</button>
          <button class="icon gcall" aria-label="Group video call">📹</button>
        </div>
        <div class="gvideos"></div>
        <div class="chatlog"></div>
        <div class="grecord" hidden><span>● Recording voice clip…</span><button type="button" class="gcancel">Cancel</button><button type="button" class="gstop">Send</button></div>
        <form class="chatin groupin">
          <button type="button" class="icon gsnap" aria-label="Send a Snap">◉</button>
          <button type="button" class="icon gattach" aria-label="Attach a file">📎</button>
          <button type="button" class="icon gmic" aria-label="Record voice clip">🎤</button>
          <input class="ginput" placeholder="Message the group…" autocomplete="off" aria-label="Message">
          <button type="submit">Send</button>
          <input class="gfile" type="file" hidden>
          <input class="gsnapfile" type="file" accept="image/*,video/*" capture="environment" hidden>
        </form>
      </main>`;
    const gp = { id: group.id, node: $('main'), members, call: null, ch: null, name: group.name, dataPeers: new Map() };
    current = gp;
    gSys(gp, `${group.name || 'Group'} · ${Object.keys(members).length} members`);

    const ch = sb.channel('mfgroup:' + group.id, { config: { private: true, presence: { key: state.me.id }, broadcast: { self: false } } });
    gp.ch = ch;
    ch.on('broadcast', { event: 'g' }, ({ payload }) => { if (payload && payload.from !== state.me.id && payload.t === 'msg') gText(gp, payload.name, payload.text, 'them'); });
    ch.on('presence', { event: 'sync' }, () => updatePresence(gp));
    ch.subscribe(async (s) => { if (s === 'SUBSCRIBED') await ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: false }); });

    $('.gcall', gp.node).onclick = () => gp.call ? leaveCall(gp) : joinCall(gp);
    $('.gadd', gp.node).onclick = () => pickFriends('Add to group', {
        exclude: new Set(Object.keys(members)),
        onPick: async (uid, username) => { const { error } = await db.addGroupMember(gp.id, uid); if (error) return toast('Could not add'); gp.members[uid] = { username }; gSys(gp, `${username} was added`); },
    });
    const form = $('.chatin', gp.node), input = $('.ginput', form);
    form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; bcast(gp, { t: 'msg', text: t }); gText(gp, 'You', t, 'me'); input.value = ''; };
    const file = $('.gfile', gp.node), snapFile = $('.gsnapfile', gp.node);
    $('.gattach', gp.node).onclick = () => file.click();
    file.onchange = () => { const f = file.files[0]; if (f) sendGroupMedia(gp, f); file.value = ''; };
    $('.gsnap', gp.node).onclick = () => snapFile.click();
    snapFile.onchange = () => { const f = snapFile.files[0]; if (f) sendGroupMedia(gp, f, true); snapFile.value = ''; };
    wireGroupMic(gp);
};

export const openGroupById = async (id) => {
    app.innerHTML = `<main><div class="spin">Loading group…</div></main>`;
    const { data, error } = await db.groupById(id);
    if (error || !data) return void (app.innerHTML = `<div class="empty">Group not found.</div>`);
    openGroup(data);
};

// ---- friends picker modal (create group / add member) ----
const pickFriends = async (title, opts) => {
    const body = el('<div><div class="spin">Loading…</div></div>');
    const m = el(`<div class="modal"><div class="sheet"><div class="mhead">${esc(title)}<button class="x icon" aria-label="Close">✕</button></div><div class="mbody"></div></div></div>`);
    $('.mbody', m).appendChild(body);
    $('.x', m).onclick = () => m.remove();
    m.onclick = (e) => { if (e.target === m) m.remove(); };
    document.body.appendChild(m);
    const { data: fr } = await db.friends();
    const friends = (fr || []).map(f => f.requester_id === state.me.id ? f.addressee : f.requester).filter(Boolean);
    const selected = new Map((opts.prefill || []).map(p => [p.uid, p.username]));
    body.innerHTML = opts.multi
        ? `<input class="field" id="gname" placeholder="Group name…" style="margin:6px 0"><div id="plist"></div><button class="btn" id="gcreate">Create group</button>`
        : `<div id="plist"></div>`;
    const list = $('#plist', body);
    const pickable = friends.filter(p => !(opts.exclude && opts.exclude.has(p.id)));
    if (!pickable.length) list.innerHTML = `<div class="empty">No friends to add.</div>`;
    pickable.forEach(p => {
        const row = el(`<div class="urow">${avatarHTML(p.username, p.avatar)}<div class="who"><b>${esc(p.username)}</b></div><div class="acts"></div></div>`);
        if (opts.multi) {
            const cb = el(`<button class="pill ${selected.has(p.id) ? 'primary' : ''}">${selected.has(p.id) ? 'Added' : 'Add'}</button>`);
            cb.onclick = () => { if (selected.has(p.id)) { selected.delete(p.id); cb.textContent = 'Add'; cb.classList.remove('primary'); } else { selected.set(p.id, p.username); cb.textContent = 'Added'; cb.classList.add('primary'); } };
            $('.acts', row).appendChild(cb);
        } else {
            const b = el('<button class="pill primary">Add</button>');
            b.onclick = () => { m.remove(); opts.onPick(p.id, p.username); };
            $('.acts', row).appendChild(b);
        }
        list.appendChild(row);
    });
    if (opts.multi) $('#gcreate', body).onclick = () => { if (!selected.size) return toast('Pick at least one friend'); const name = $('#gname', body).value.trim() || 'Group'; m.remove(); opts.onCreate(name, [...selected.keys()]); };
};

export const createGroupFlow = (prefill = []) => pickFriends('New group', {
    multi: true, prefill,
    onCreate: async (name, ids) => {
        const { data: g, error } = await db.createGroup(name, ids);
        if (error) return toast('Could not create group');
        location.hash = '#/group/' + g.id;
    },
});

// A compact list of your groups for the Chat tab.
export const renderGroupList = async (into) => {
    if (!into) return;
    const { data } = await db.myGroups();
    into.innerHTML = '';
    if (!data || !data.length) { into.innerHTML = `<div class="muted tiny" style="padding:4px 12px 8px">No groups yet — tap ＋ to start one.</div>`; return; }
    data.forEach(g => {
        const members = (g.mf_group_members || []).map(m => m.profiles?.username).filter(Boolean);
        into.appendChild(el(`<button class="conv" data-go="#/group/${g.id}"><div class="avatar">👥</div><div class="who"><b>${esc(g.name || 'Group')}</b><div class="sub">${esc(members.slice(0, 4).join(', ')) || (members.length + ' members')}</div></div></button>`));
    });
};
