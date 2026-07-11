import { sb, state, rand, idb, fullCache } from './core.js';

// ===================== WebRTC over Supabase Realtime (no third-party signaling) =====================
// Borrowed almost verbatim from instamegle. The offer/answer/ICE handshake rides a
// Supabase Realtime Broadcast channel keyed by user_id; media/data then flow directly
// browser-to-browser. In mayfly this powers LIVE snap delivery: when the recipient is
// online, their device pulls the full snap straight from the sender's browser — the
// full image never touches the server at all. (Offline recipients get the encrypted
// relay path instead; see app.js / crypto.js.)
const TURN = [];   // fill in TURN creds to work on cellular / symmetric NAT; empty = STUN-only (Wi-Fi)
const ICE = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    ...TURN,
] };

const CHUNK = 16 * 1024;
const drain = (dc) => new Promise(res => { const t = () => (dc.bufferedAmount > (1 << 20) ? setTimeout(t, 20) : res()); t(); });
const sendBinary = async (dc, buf) => { for (let o = 0; o < buf.byteLength; o += CHUNK) { try { dc.send(buf.slice(o, o + CHUNK)); } catch (e) { return; } await drain(dc); } };

let signalCh = null;
let onDataConn = null, onMediaConn = null;
const conns = new Map();
const signalSend = (to, msg) => { try { signalCh && signalCh.send({ type: 'broadcast', event: 'sig', payload: { to, from: state.me.id, ...msg } }); } catch (e) {} };
const emitter = () => { const L = {}; return {
    on(ev, fn) { (L[ev] || (L[ev] = [])).push(fn); return this; },
    emit(ev, ...a) { (L[ev] || []).forEach(f => f(...a)); },
}; };

const makeDataConn = (remote, cid, initiator, metadata) => {
    const ev = emitter(); const pc = new RTCPeerConnection(ICE);
    let dc, remoteSet = false, closed = false; const pend = [];
    const fireClose = () => { if (closed) return; closed = true; api.open = false; conns.delete(cid); ev.emit('close'); };
    const api = {
        peer: remote, metadata, open: false,
        on(e, fn) { ev.on(e, fn); return api; },
        send(o) { try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(o)); } catch (e) {} },
        close() { try { dc && dc.close(); } catch (e) {} try { pc.close(); } catch (e) {} conns.delete(cid); },
        get dataChannel() { return dc; },
    };
    const wireDC = (ch) => {
        dc = ch;
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => { api.open = true; ev.emit('open'); };
        dc.onmessage = (m) => {
            if (typeof m.data === 'string') { let d; try { d = JSON.parse(m.data); } catch (e) { d = m.data; } ev.emit('data', d); }
            else ev.emit('chunk', m.data);
        };
        dc.onclose = fireClose;
    };
    pc.onicecandidate = (e) => { if (e.candidate) signalSend(remote, { cid, kind: 'data', ice: e.candidate }); };
    let discT = null;
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') { clearTimeout(discT); discT = null; }
        else if (s === 'disconnected') { clearTimeout(discT); discT = setTimeout(fireClose, 8000); }
        else if (s === 'failed' || s === 'closed') { clearTimeout(discT); fireClose(); }
    };
    if (initiator) {
        wireDC(pc.createDataChannel('d'));
        pc.createOffer().then(o => pc.setLocalDescription(o))
          .then(() => signalSend(remote, { cid, kind: 'data', sdp: pc.localDescription, metadata }));
    } else { pc.ondatachannel = (e) => wireDC(e.channel); }
    conns.set(cid, { handleSignal: async (msg) => {
        if (msg.sdp) {
            await pc.setRemoteDescription(msg.sdp); remoteSet = true;
            pend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
            if (msg.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); signalSend(remote, { cid, kind: 'data', sdp: pc.localDescription }); }
        } else if (msg.ice) { remoteSet ? pc.addIceCandidate(msg.ice).catch(() => {}) : pend.push(msg.ice); }
    } });
    return api;
};

// Media (video/voice call) connection — same PeerJS-shaped surface as instamegle.
const makeMediaConn = (remote, cid, initiator, metadata, stream) => {
    const ev = emitter(); const pc = new RTCPeerConnection(ICE);
    let remoteSet = false, closed = false; const pend = [];
    const fireClose = () => { if (closed) return; closed = true; conns.delete(cid); ev.emit('close'); };
    const addTracks = (s) => s.getTracks().forEach(t => pc.addTrack(t, s));
    const api = {
        peer: remote, metadata,
        on(e, fn) { ev.on(e, fn); return api; },
        answer: async (s) => { addTracks(s); await pc.setLocalDescription(await pc.createAnswer()); signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription }); },
        close() { try { pc.close(); } catch (e) {} conns.delete(cid); },
    };
    pc.onicecandidate = (e) => { if (e.candidate) signalSend(remote, { cid, kind: 'media', ice: e.candidate }); };
    pc.ontrack = (e) => ev.emit('stream', e.streams[0]);
    let discT = null;
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') { clearTimeout(discT); discT = null; }
        else if (s === 'disconnected') { clearTimeout(discT); discT = setTimeout(fireClose, 8000); }
        else if (s === 'failed' || s === 'closed') { clearTimeout(discT); fireClose(); }
    };
    if (initiator) {
        addTracks(stream);
        pc.createOffer().then(o => pc.setLocalDescription(o))
          .then(() => signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription, metadata }));
    }
    conns.set(cid, { handleSignal: async (msg) => {
        if (msg.sdp) { await pc.setRemoteDescription(msg.sdp); remoteSet = true; pend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {})); }
        else if (msg.ice) { remoteSet ? pc.addIceCandidate(msg.ice).catch(() => {}) : pend.push(msg.ice); }
    } });
    return api;
};

const peer = {
    connect: (userId, opts = {}) => makeDataConn(userId, rand(), true, opts.metadata),
    call: (userId, stream, opts = {}) => makeMediaConn(userId, rand(), true, opts.metadata, stream),
};

const onSignal = (p) => {
    if (!p || p.to !== state.me.id) return;
    let entry = conns.get(p.cid);
    if (!entry) {
        if (!p.sdp || p.sdp.type !== 'offer') return;   // stray candidate/answer for a dead conn
        if (p.kind === 'data') { const c = makeDataConn(p.from, p.cid, false, p.metadata); onDataConn && onDataConn(c); }
        else if (p.kind === 'media') { const c = makeMediaConn(p.from, p.cid, false, p.metadata); onMediaConn && onMediaConn(c); }
        entry = conns.get(p.cid);
    }
    entry && entry.handleSignal(p);
};

const startRtc = (dmHandler, callHandler, groupDataHandler) => new Promise((resolve) => {
    onMediaConn = callHandler;   // incoming video calls (1:1 or a group-mesh leg)
    // Incoming data connection is either a live chat (metadata.kind==='dm') or someone
    // asking for the full image of a snap/story we sent them (kept in our IndexedDB
    // under snap:<id> / story:<id>). Serve the JPEG as raw binary, then done.
    onDataConn = (c) => {
        if (c.metadata?.kind === 'dm') return dmHandler && dmHandler(c);
        if (c.metadata?.kind === 'group') return groupDataHandler && groupDataHandler(c);
        c.on('data', async (d) => {
            if (!d || d.type !== 'want') return;
            const full = await idb.get('snap:' + d.id) || await idb.get('story:' + d.id);
            if (!full) return c.send({ type: 'miss', id: d.id });
            const blob = full instanceof Blob ? full : await (await fetch(full)).blob();
            const mime = blob.type || 'image/jpeg';
            const buf = await blob.arrayBuffer();
            c.send({ type: 'meta', id: d.id, bytes: buf.byteLength, mime });
            await sendBinary(c.dataChannel, buf);
            c.send({ type: 'done', id: d.id });
        });
    };
    signalCh = sb.channel('mayfly-signal', { config: { broadcast: { self: false } } });
    signalCh.on('broadcast', { event: 'sig' }, ({ payload }) => onSignal(payload));
    signalCh.subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); });
});

// Pull a snap/story's full image from the (online) author's browser. Resolves to a
// blob: URL, or null if they went offline / didn't have it.
const fetchSnap = (id, authorId) => new Promise((resolve) => {
    if (fullCache.has(id)) return resolve(fullCache.get(id));
    if (!authorId) return resolve(null);
    let done = false, mime = 'image/jpeg'; const parts = [];
    const finish = (v) => { if (done) return; done = true; if (v) fullCache.set(id, v); try { c.close(); } catch (e) {} resolve(v); };
    const c = peer.connect(authorId);
    const timer = setTimeout(() => finish(null), 20000);
    c.on('open', () => c.send({ type: 'want', id }));
    c.on('data', (d) => {
        if (!d || d.id !== id) return;
        if (d.type === 'miss') { clearTimeout(timer); return finish(null); }
        if (d.type === 'meta') { mime = d.mime || 'image/jpeg'; return; }
        if (d.type === 'done') { clearTimeout(timer); return finish(URL.createObjectURL(new Blob(parts, { type: mime }))); }
    });
    c.on('chunk', (ab) => parts.push(ab));
    c.on('close', () => { clearTimeout(timer); finish(null); });
});

export { peer, startRtc, fetchSnap };
