import { app, $, $$, el, esc, toast, state, initial, avatarHTML, safeMediaUrl, mimeKind, sb, isOnline, icon } from './core.js';
import { peer } from './rtc.js';
import { callMenu } from './chat.js';
import { db } from './db.js';

// ===================== group chats + mesh video calls =====================
// A group is persistent (mf_groups). While the view is open, members share a private
// Realtime channel: text rides ephemeral Broadcast (nothing stored) and a group video
// call is a full P2P *mesh* — every member connects to every other. Rendered as a full
// view; leaving the view tears the channel down (ephemeral room semantics).
let current = null;   // the open group panel, or null
const backgrounds = new Map(); // groups subscribed while their window is not open

const memberMap = (group) => { const m = {}; (group.mf_group_members || []).forEach(gm => { m[gm.user_id] = gm.profiles || {}; }); return m; };
const gLine = (gp, html) => { if (!gp.node) return; const l = $('.chatlog', gp.node); if (!l) return; const line = el(html); l.appendChild(line); l.scrollTop = l.scrollHeight; return line; };
const gText = (gp, name, text, cls) => gLine(gp, `<div class="b ${cls}">${cls === 'them' ? `<span class="gwho">${esc(name)}</span>` : ''}${esc(text)}</div>`);
const gSys = (gp, text) => gLine(gp, `<div class="b sys">${esc(text)}</div>`);
const setGroupName = (gp, name) => {
    gp.name = name;
    gp.group.name = name;
    const title = gp.node && $('.group-title', gp.node);
    if (title) title.textContent = name;
};
const promptGroupName = async (group) => {
    const next = window.prompt('Group name', group.name || 'Group');
    if (next === null) return null;
    const name = next.trim().slice(0, 60);
    if (!name) { toast('Group name cannot be empty.'); return null; }
    if (name === group.name) return null;
    const { error } = await db.renameGroup(group.id, name);
    if (error) { toast('Could not rename the group.'); return null; }
    group.name = name;
    return name;
};
const bcast = (gp, payload) => { try { gp.ch.send({ type: 'broadcast', event: 'g', payload: { from: state.me.id, name: state.profile.username, ...payload } }); } catch (e) {} };
const notifyGroup = (gp, body) => { if (!gp.node && window.Notification?.permission === 'granted') new Notification(gp.name || 'Group', { body }); };

// ---- group P2P media (files, clips, inline Snaps, and timed view-once Snaps) ----
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
const autoPlayGroupSnapVideo = (video) => {
    if (!video) return;
    const play = () => video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
    });
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) play();
    else video.addEventListener('canplay', play, { once: true });
};
const openGroupMediaViewer = (media, inlinePlayer = null) => {
    const video = media.kind === 'video';
    const reusePlayer = video && inlinePlayer;
    const tag = reusePlayer ? '' : video ? `<video src="${safeMediaUrl(media.url)}" controls autoplay playsinline></video>` : `<img src="${safeMediaUrl(media.url)}" alt="${esc(media.name || 'image')}">`;
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
    if (video) autoPlayGroupSnapVideo(reusePlayer ? inlinePlayer : $('video', ov));
};
const groupMediaBubble = (gp, media, cls, name = '') => {
    const url = safeMediaUrl(media.url);
    const inner = media.kind === 'image' ? `<img class="chatmedia" src="${url}" alt="">`
        : media.kind === 'video' ? `<video class="chatmedia" data-snap="${esc(media.snap ? media.id : '')}" src="${url}" controls playsinline></video>`
        : media.kind === 'audio' ? `<audio src="${url}" controls></audio>`
        : `<a class="chatfile" href="${url}" download="${esc(media.name || 'file')}">📎 ${esc(media.name || 'file')}</a>`;
    const bubble = gLine(gp, `<div class="b ${cls} media">${cls === 'them' ? `<span class="gwho">${esc(name)}</span>` : ''}${inner}${media.caption ? `<div class="snapcaption">${esc(media.caption)}</div>` : ''}</div>`);
    const mediaEl = bubble && $('.chatmedia', bubble);
    if (mediaEl) {
        mediaEl.classList.add('expandable');
        mediaEl.title = 'Open larger';
        mediaEl.onclick = () => { if (!mediaEl.closest('.media-viewer')) openGroupMediaViewer(media, mediaEl); };
        if (media.snap && media.kind === 'video') autoPlayGroupSnapVideo(mediaEl);
    }
};
const groupSnapCard = (gp, media, cls, name = '') => {
    const l = $('.chatlog', gp.node); if (!l) return;
    const kind = media.kind === 'video' ? 'video' : 'photo';
    if (!(Number(media.timer) > 0)) return groupMediaBubble(gp, media, cls, name);
    if (cls === 'me') {
        // sender side: a Delivered → Opened receipt (no tappable card)
        l.appendChild(el(`<div class="msgstatus me ${kind} delivered" data-snap="${media.id}"><span class="si"></span><span class="sl">Delivered</span></div>`));
        l.scrollTop = l.scrollHeight;
        return;
    }
    const card = el(`<button class="snapcard ${kind} them"><span class="gwho">${esc(name)}</span><span class="sq">${media.kind === 'video' ? '▶' : '●'}</span> Tap to view ${media.kind === 'video' ? 'Video' : 'Photo'} Snap</button>`);
    card.onclick = () => {
        const tag = media.kind === 'video' ? `<video src="${safeMediaUrl(media.url)}" autoplay controls playsinline></video>` : `<img src="${safeMediaUrl(media.url)}" alt="snap">`;
        const ov = el(`<div class="player">${tag}<div class="pbar"><i></i></div></div>`);
        document.body.appendChild(ov);
        // tell the sender we opened it (they flip Delivered → Opened)
        const finish = () => { clearTimeout(t); ov.remove(); URL.revokeObjectURL(media.url); card.remove(); bcast(gp, { t: 'gsnap-opened', id: media.id }); };
        const t = setTimeout(finish, Number(media.timer) * 1000);
        ov.onclick = finish;
        if (media.kind === 'video') {
            const video = $('video', ov);
            video.onclick = (e) => e.stopPropagation();
            video.onended = finish;
            video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
        }
    };
    l.appendChild(card); l.scrollTop = l.scrollHeight;
};
// flip a sender-side group-snap receipt to Opened when a member reports opening it
const markGroupSnapOpened = (gp, id) => {
    const s = gp.node && $(`.msgstatus[data-snap="${id}"]`, gp.node);
    if (s) { s.classList.remove('delivered'); s.classList.add('opened'); const sl = $('.sl', s); if (sl) sl.textContent = 'Opened'; }
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
            if (gp.node) {
                if (media.snap) groupSnapCard(gp, media, 'them', item.meta.nameFrom);
                else groupMediaBubble(gp, media, 'them', item.meta.nameFrom);
            } else {
                gp.pending.push({ media, name: item.meta.nameFrom });
                notifyGroup(gp, `${item.meta.nameFrom || 'Someone'} sent ${media.snap ? 'a Snap' : 'media'}.`);
            }
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
const readyGroupPeers = async (gp) => {
    const st = gp.ch?.presenceState?.() || {};
    const online = Object.keys(st).filter(uid => uid !== state.me.id && gp.members[uid]);
    for (let i = 0; i < 40; i++) {
        syncGroupDataPeers(gp);
        const peers = [...gp.dataPeers.values()].filter(c => c.open);
        if (peers.length >= online.length || (peers.length && i > 8)) return peers;
        await new Promise(r => setTimeout(r, 100));
    }
    return [...gp.dataPeers.values()].filter(c => c.open);
};
export const onIncomingGroupData = (conn) => {
    const gp = current && current.id === conn.metadata?.group ? current : backgrounds.get(conn.metadata?.group);
    if (!gp || !gp.members[conn.peer]) return conn.close();
    wireGroupData(gp, conn.peer, conn);
};
const sendGroupMedia = async (gp, file, snap = false, timer = 0) => {
    if (!file) return;
    if (file.size > MEDIA_MAX) return toast(`Media is too large (max ${Math.round(MEDIA_MAX / 1e6)} MB).`);
    const peers = await readyGroupPeers(gp);
    if (!peers.length) return toast('Group members need this chat open to receive media.');
    const kind = mimeKind(file.type), id = gid(), bytes = await file.arrayBuffer();
    const meta = { t: 'gmedia-meta', id, bytes: bytes.byteLength, mime: file.type, kind, name: file.name || kind, nameFrom: state.profile.username, snap, timer: snap ? Math.max(0, Number(timer) || 0) : 0 };
    await Promise.all(peers.map(async (conn) => {
        conn.send(meta);
        const sent = await sendGroupBytes(conn, bytes);
        if (sent) conn.send({ t: 'gmedia-done', id });
    }));
    const media = { ...meta, url: URL.createObjectURL(file) };
    if (gp.node) {
        if (snap) groupSnapCard(gp, media, 'me'); else groupMediaBubble(gp, media, 'me');
    } else {
        gp.pending.push({ media, name: 'You', me: true });
    }
};

// Send a captured snap into a group's chat (not to members individually). Default
// Snaps land inline; choosing a timer turns them into a view-once card.
export const sendSnapToGroupChat = async (groupId, file, timer = 0) => {
    const gp = (current && current.id === groupId) ? current : backgrounds.get(groupId);
    if (!gp) return false;
    try { await sendGroupMedia(gp, file, true, timer); return true; }
    catch (e) { console.error('[mayfly] group snap failed', e); return false; }
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
const setGCtl = (gp, sel, on, onName, offName) => { const b = gp.node && $(sel, gp.node); if (b) { b.innerHTML = icon(on ? onName : offName); b.classList.toggle('off', !on); } };
const joinCall = async (gp, video = true) => {
    if (gp.call) return;
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: !!video, audio: true }); } catch (e) { return toast('Camera/mic blocked'); }
    gp.call = { localStream: stream, peers: new Map(), video: !!video };
    gp.node.classList.add('incall');
    gp.node.classList.toggle('voicecall', !video);
    tileFor(gp, state.me.id, stream, 'You', true);
    setGCtl(gp, '.gmute', true, 'mic', 'micOff');
    setGCtl(gp, '.gcam', true, 'video', 'videoOff');
    await gp.ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: true });
    meshUpdate(gp);
};
const leaveCall = (gp) => {
    if (!gp.call) return;
    gp.call.peers.forEach(c => { try { c.close(); } catch (e) {} });
    gp.call.localStream.getTracks().forEach(t => t.stop());
    if (gp.node) { $('.gvideos', gp.node).innerHTML = ''; gp.node.classList.remove('incall', 'voicecall'); }
    gp.call = null;
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
    const o = gp.node && $('.gonline', gp.node); if (o) o.textContent = `${Object.keys(st).length} online`;
    const othersInCall = Object.keys(st).some(k => k !== state.me.id && st[k].some(m => m.in_call));
    const btn = gp.node && $('.gcall', gp.node);
    if (gp.node && othersInCall && !gp.call && !gp.notified) { gSys(gp, 'Call in progress — tap the call button to join'); gp.notified = true; btn?.classList.add('ring'); }
    if (!othersInCall) { gp.notified = false; btn?.classList.remove('ring'); }
    if (gp.call) meshUpdate(gp);
    syncGroupDataPeers(gp);
};

const wireGroupMic = (gp) => {
    let recorder = null, stream = null, chunks = [], cancelled = false, draft = null, draftUrl = null, starting = false;
    const mic = $('.gmic', gp.node), recordBar = $('.grecord', gp.node);
    const setRecording = (on) => {
        mic.classList.toggle('recording', on); mic.innerHTML = icon(on ? 'stop' : 'mic');
        mic.setAttribute('aria-label', on ? 'Stop recording voice clip' : 'Record voice clip');
        mic.title = on ? 'Stop recording' : 'Record voice clip';
    };
    const reset = () => {
        setRecording(false); recordBar.hidden = true;
        if (draftUrl) URL.revokeObjectURL(draftUrl);
        draft = null; draftUrl = null;
        recordBar.innerHTML = '';
    };
    const stop = () => { if (recorder?.state === 'recording') recorder.stop(); };
    const start = async () => {
        if (recorder?.state === 'recording' || draft || starting) return;
        starting = true; mic.disabled = true;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { return toast('Microphone access is blocked.'); }
        finally { starting = false; mic.disabled = false; }
        chunks = []; cancelled = false;
        try { recorder = new MediaRecorder(stream); }
        catch (e) { stream.getTracks().forEach(t => t.stop()); return toast('Voice recording is unavailable.'); }
        recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        recorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop()); setRecording(false);
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            recorder = null;
            if (cancelled || !blob.size) return reset();
            draft = new File([blob], 'voice-note', { type: blob.type });
            draftUrl = URL.createObjectURL(draft);
            recordBar.hidden = false;
            recordBar.innerHTML = `<audio src="${safeMediaUrl(draftUrl)}" controls></audio><button type="button" class="gcancel" aria-label="Discard voice clip">✕</button><button type="button" class="gstop">Send</button>`;
            $('.gcancel', recordBar).onclick = reset;
            $('.gstop', recordBar).onclick = async () => { const clip = draft; reset(); await sendGroupMedia(gp, clip); };
        };
        recorder.start(); setRecording(true); recordBar.hidden = false;
        recordBar.innerHTML = '<span>● Recording… tap the mic again to stop</span>';
    };
    mic.onclick = () => recorder?.state === 'recording' ? stop() : start();
};

const startBackground = (group, pending = []) => {
    if (!group || backgrounds.has(group.id) || (current && current.id === group.id)) return;
    const gp = { id: group.id, group, node: null, members: memberMap(group), call: null, ch: null,
        name: group.name, dataPeers: new Map(), pending };
    const ch = sb.channel('mfgroup:' + group.id, { config: { private: true, presence: { key: state.me.id }, broadcast: { self: false } } });
    gp.ch = ch;
    ch.on('broadcast', { event: 'g' }, ({ payload }) => {
        if (!payload || payload.from === state.me.id) return;
        if (payload.t === 'gname' && payload.groupName) setGroupName(gp, payload.groupName);
        if (payload.t !== 'msg') return;
        gp.pending.push({ text: payload.text, name: payload.name });
        notifyGroup(gp, `${payload.name || 'Someone'}: ${payload.text}`);
    });
    ch.on('presence', { event: 'sync' }, () => updatePresence(gp));
    ch.subscribe(async (s) => { if (s === 'SUBSCRIBED') await ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: false }); });
    backgrounds.set(group.id, gp);
};
const pauseBackground = (id) => {
    const gp = backgrounds.get(id); if (!gp) return [];
    backgrounds.delete(id);
    gp.dataPeers.forEach(c => { try { c.close(); } catch (e) {} });
    try { gp.ch.unsubscribe(); } catch (e) {}
    return gp.pending || [];
};
export const bootGroups = async () => {
    const { data } = await db.myGroups();
    (data || []).forEach(g => startBackground(g));
};

// Tear down the open group when navigating away.
export const closeCurrentGroup = () => {
    if (!current) return;
    const gp = current; current = null;
    leaveCall(gp);
    gp.dataPeers?.forEach(c => { try { c.close(); } catch (e) {} });
    try { gp.ch.unsubscribe(); } catch (e) {}
    startBackground(gp.group, gp.pending || []);
};

const openGroup = (group, container = app) => {
    closeCurrentGroup();
    const pending = pauseBackground(group.id);
    const members = memberMap(group);
    const avs = Object.entries(members).filter(([uid]) => uid !== state.me.id).slice(0, 3).map(([, p]) => avatarHTML(p.username, p.avatar, 'gav')).join('');
    container.innerHTML = `<div class="chatview group">
        <div class="chathead">
          <button class="icon back" data-go="#/chats" aria-label="Back">‹</button>
          <div class="gavatars">${avs || '👥'}</div>
          <div class="who"><button type="button" class="group-title grename" aria-label="Rename group">${esc(group.name || 'Group')}</button><div class="sub gonline">…</div></div>
          <button class="icon gadd" aria-label="Add friend to group">${icon('userPlus')}</button>
          <button class="icon gcall" aria-label="Start a group call">${icon('phone')}</button>
        </div>
        <div class="gvideos"></div>
        <div class="gcallbar">
          <button class="icon gmute" aria-label="Mute microphone"></button>
          <button class="icon gcam" aria-label="Toggle camera"></button>
          <button class="icon ghang hang" aria-label="Leave call">${icon('phoneOff')}</button>
        </div>
        <div class="chatlog"></div>
        <div class="grecord" hidden><span>● Recording voice clip…</span><button type="button" class="gcancel">Cancel</button><button type="button" class="gstop">Send</button></div>
        <form class="chatin groupin">
          <button type="button" class="icon gsnap" aria-label="Send a Snap">${icon('camera')}</button>
          <input class="ginput" placeholder="Message the group…" autocomplete="off" enterkeyhint="send" aria-label="Message">
          <button type="button" class="icon gmic" aria-label="Record voice clip">${icon('mic')}</button>
          <button type="button" class="icon gattach" aria-label="Attach a file">${icon('paperclip')}</button>
          <input class="gfile" type="file" hidden>
        </form>
      </div>`;
    const gp = { id: group.id, group, node: container.firstElementChild, members, call: null, ch: null, name: group.name, dataPeers: new Map(), pending: [] };
    current = gp;
    gSys(gp, `${group.name || 'Group'} · ${Object.keys(members).length} members`);
    pending.forEach(item => {
        const cls = item.me ? 'me' : 'them';
        if (item.text) gText(gp, item.name, item.text, 'them');
        else if (item.media?.snap) groupSnapCard(gp, item.media, cls, item.name);
        else if (item.media) groupMediaBubble(gp, item.media, cls, item.name);
    });

    const ch = sb.channel('mfgroup:' + group.id, { config: { private: true, presence: { key: state.me.id }, broadcast: { self: false } } });
    gp.ch = ch;
    ch.on('broadcast', { event: 'g' }, ({ payload }) => {
        if (!payload || payload.from === state.me.id) return;
        if (payload.t === 'msg') gText(gp, payload.name, payload.text, 'them');
        else if (payload.t === 'gsnap-opened') markGroupSnapOpened(gp, payload.id);
        else if (payload.t === 'gname' && payload.groupName) {
            setGroupName(gp, payload.groupName);
            gSys(gp, `${payload.name || 'Someone'} renamed the group to ${payload.groupName}`);
        }
        else if (payload.t === 'gmember-removed') {
            if (payload.uid === state.me.id) {
                toast('You were removed from this group.');
                location.hash = '#/chats';
            } else {
                delete gp.members[payload.uid];
                gSys(gp, `${payload.username || 'Someone'} was removed`);
            }
        }
    });
    ch.on('presence', { event: 'sync' }, () => updatePresence(gp));
    ch.subscribe(async (s) => { if (s === 'SUBSCRIBED') await ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: false }); });

    $('.gcall', gp.node).onclick = (e) => gp.call ? leaveCall(gp) : callMenu(e.currentTarget, (video) => joinCall(gp, video));
    $('.gmute', gp.node).onclick = () => { const a = gp.call?.localStream.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; setGCtl(gp, '.gmute', a.enabled, 'mic', 'micOff'); } };
    $('.gcam', gp.node).onclick = () => { const v = gp.call?.localStream.getVideoTracks()[0]; if (v) { v.enabled = !v.enabled; setGCtl(gp, '.gcam', v.enabled, 'video', 'videoOff'); } };
    $('.ghang', gp.node).onclick = () => leaveCall(gp);
    $('.grename', gp.node).onclick = async () => {
        const name = await promptGroupName(gp.group);
        if (!name) return;
        setGroupName(gp, name);
        bcast(gp, { t: 'gname', groupName: name });
        gSys(gp, `You renamed the group to ${name}`);
    };
    $('.gadd', gp.node).onclick = () => pickFriends('Add to group', {
        exclude: new Set(Object.keys(members)),
        members: Object.entries(members).filter(([uid]) => uid !== state.me.id).map(([id, p]) => ({ id, ...p })),
        onPick: async (uid, username) => {
            const { error } = await db.addGroupMember(gp.id, uid);
            if (error) {
                console.error('[mayfly] add group member', error);
                toast(error.code === '23505' ? `${username} is already in this group.` : `Could not add ${username}.`);
                return false;
            }
            gp.members[uid] = { username };
            gSys(gp, `${username} was added`);
            toast(`${username} added to the group.`);
            return true;
        },
        onRemove: async (uid, username) => {
            const { error } = await db.removeGroupMember(gp.id, uid);
            if (error) {
                console.error('[mayfly] remove group member', error);
                toast(`Could not remove ${username}.`);
                return false;
            }
            delete gp.members[uid];
            bcast(gp, { t: 'gmember-removed', uid, username });
            gSys(gp, `${username} was removed`);
            toast(`${username} removed from the group.`);
            return true;
        },
        onLeave: async () => {
            if (!confirm('Leave this group?')) return false;
            const { error } = await db.leaveGroup(gp.id);
            if (error) { toast('Could not leave the group.'); return false; }
            toast('You left the group.');
            location.hash = '#/chats';
            return true;
        },
    });
    const form = $('.chatin', gp.node), input = $('.ginput', form);
    form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; bcast(gp, { t: 'msg', text: t }); gText(gp, 'You', t, 'me'); input.value = ''; };
    const file = $('.gfile', gp.node);
    $('.gattach', gp.node).onclick = () => file.click();
    file.onchange = () => { const f = file.files[0]; if (f) sendGroupMedia(gp, f); file.value = ''; };
    $('.gsnap', gp.node).onclick = () => { location.hash = '#/groupsnap/' + gp.id; };
    wireGroupMic(gp);
};

export const openGroupById = async (id, container = app) => {
    container.innerHTML = `<div class="spin">Loading group…</div>`;
    const { data, error } = await db.groupById(id);
    if (error || !data) return void (container.innerHTML = `<div class="empty">Group not found.</div>`);
    openGroup(data, container);
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
    const existing = opts.members || [];
    if (existing.length) {
        const label = el('<div class="picklabel">Members</div>');
        body.insertBefore(label, list);
        existing.forEach(p => {
            const row = el(`<div class="urow">${avatarHTML(p.username, p.avatar)}<div class="who"><b>${esc(p.username)}</b></div><div class="acts"></div></div>`);
            const remove = el('<button class="pill danger">Remove</button>');
            remove.onclick = async () => {
                remove.disabled = true; remove.textContent = 'Removing…';
                try {
                    const removed = await opts.onRemove(p.id, p.username);
                    if (removed !== false) row.remove();
                    else { remove.disabled = false; remove.textContent = 'Remove'; }
                } catch (e) {
                    console.error('[mayfly] group member removal', e);
                    toast(`Could not remove ${p.username}.`);
                    remove.disabled = false; remove.textContent = 'Remove';
                }
            };
            $('.acts', row).appendChild(remove);
            body.insertBefore(row, list);
        });
    }
    if (opts.onLeave) {
        const leave = el('<button type="button" class="btn ghost leavegroup">Leave group</button>');
        leave.onclick = async () => {
            leave.disabled = true;
            try {
                const left = await opts.onLeave();
                if (left !== false) m.remove();
                else leave.disabled = false;
            } catch (e) {
                console.error('[mayfly] leave group', e);
                toast('Could not leave the group.');
                leave.disabled = false;
            }
        };
        body.insertBefore(leave, list);
    }
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
            b.onclick = async () => {
                b.disabled = true; b.textContent = 'Adding…';
                try {
                    const added = await opts.onPick(p.id, p.username);
                    if (added !== false) m.remove();
                    else { b.disabled = false; b.textContent = 'Add'; }
                } catch (e) {
                    console.error('[mayfly] group picker', e);
                    toast('Could not add that friend.');
                    b.disabled = false; b.textContent = 'Add';
                }
            };
            $('.acts', row).appendChild(b);
        }
        list.appendChild(row);
    });
    if (opts.multi) $('#gcreate', body).onclick = async () => {
        if (!selected.size) return toast('Pick at least one friend');
        const create = $('#gcreate', body), name = $('#gname', body).value.trim() || 'Group';
        create.disabled = true; create.textContent = 'Creating…';
        try {
            const created = await opts.onCreate(name, [...selected.keys()]);
            if (created !== false) m.remove();
            else { create.disabled = false; create.textContent = 'Create group'; }
        } catch (e) {
            console.error('[mayfly] create group', e);
            toast('Could not create the group.');
            create.disabled = false; create.textContent = 'Create group';
        }
    };
};

export const createGroupFlow = (prefill = []) => pickFriends('New group', {
    multi: true, prefill,
    onCreate: async (name, ids) => {
        const { data: g, error } = await db.createGroup(name, ids);
        if (error) { console.error('[mayfly] create group', error); toast('Could not create group.'); return false; }
        location.hash = '#/group/' + g.id;
        return true;
    },
});

// A compact list of your groups for the Chat tab.
export const renderGroupList = async (into, activeId = null) => {
    if (!into) return;
    const { data } = await db.myGroups();
    into.innerHTML = '';
    if (!data || !data.length) { into.innerHTML = `<div class="muted tiny" style="padding:4px 12px 8px">No groups yet — tap ＋ to start one.</div>`; return; }
    data.forEach(g => {
        const members = (g.mf_group_members || []).map(m => m.profiles?.username).filter(Boolean);
        const row = el(`<button class="conv ${g.id === activeId ? 'active' : ''}" data-go="#/group/${g.id}"><div class="avatar">👥</div><div class="who"><b class="group-list-name" title="Rename group">${esc(g.name || 'Group')}</b><div class="sub">${esc(members.slice(0, 4).join(', ')) || (members.length + ' members')}</div></div></button>`);
        $('.group-list-name', row).onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const name = await promptGroupName(g);
            if (name) $('.group-list-name', row).textContent = name;
        };
        into.appendChild(row);
    });
};
