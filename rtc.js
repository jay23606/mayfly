import { sb, state, rand, idb } from './core.js';

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
const sendBinary = async (dc, buf, offset = 0) => { for (let o = offset; o < buf.byteLength; o += CHUNK) { try { dc.send(buf.slice(o, o + CHUNK)); } catch (e) { return false; } await drain(dc); } return true; };

let signalCh = null;
let onDataConn = null, onMediaConn = null;
const conns = new Map();
const signalSend = (to, msg) => { try { signalCh && signalCh.send({ type: 'broadcast', event: 'sig', payload: { to, from: state.me.id, from_device: state.deviceId, ...msg } }); } catch (e) {} };
const emitter = () => { const L = {}; return {
    on(ev, fn) { (L[ev] || (L[ev] = [])).push(fn); return this; },
    emit(ev, ...a) { (L[ev] || []).forEach(f => f(...a)); },
}; };

const makeDataConn = (remote, cid, initiator, metadata, targetDeviceId = null) => {
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
    pc.onicecandidate = (e) => { if (e.candidate) signalSend(remote, { cid, kind: 'data', to_device: targetDeviceId, ice: e.candidate }); };
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
          .then(() => signalSend(remote, { cid, kind: 'data', to_device: targetDeviceId, sdp: pc.localDescription, metadata }));
    } else { pc.ondatachannel = (e) => wireDC(e.channel); }
    conns.set(cid, { handleSignal: async (msg) => {
        if (msg.sdp) {
            await pc.setRemoteDescription(msg.sdp); remoteSet = true;
            pend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
            if (msg.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); signalSend(remote, { cid, kind: 'data', to_device: targetDeviceId, sdp: pc.localDescription }); }
        } else if (msg.ice) { remoteSet ? pc.addIceCandidate(msg.ice).catch(() => {}) : pend.push(msg.ice); }
    } });
    return api;
};

// Media (video/voice call) connection — same PeerJS-shaped surface as instamegle.
const makeMediaConn = (remote, cid, initiator, metadata, stream) => {
    const ev = emitter(); const pc = new RTCPeerConnection(ICE);
    let remoteSet = false, closed = false, remoteStream = null, established = false;
    let lastState = { connection: pc.connectionState, ice: pc.iceConnectionState }, discT = null, restartT = null, iceRestarts = 0; const pend = [];
    const fireClose = () => { if (closed) return; closed = true; clearTimeout(discT); clearTimeout(restartT); conns.delete(cid); ev.emit('close'); };
    const addTracks = (s) => s.getTracks().forEach(t => pc.addTrack(t, s));
    const api = {
        id: cid, peer: remote, metadata,
        // A callee can receive the offer's tracks before they tap Accept. Keep the
        // stream so attaching this listener later does not permanently lose video.
        on(e, fn) {
            ev.on(e, fn);
            if (e === 'stream' && remoteStream) queueMicrotask(() => fn(remoteStream));
            if (e === 'state') queueMicrotask(() => fn(lastState));
            return api;
        },
        answer: async (s) => { addTracks(s); await pc.setLocalDescription(await pc.createAnswer()); established = true; signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription }); },
        // Replaces the sender's camera track without renegotiating or interrupting
        // the audio stream (used by the mobile front/rear camera switch).
        replaceVideoTrack: async (track) => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (!sender || !track) return false;
            await sender.replaceTrack(track);
            return true;
        },
        // An audio-only call has no video sender to replace. Add one and perform a
        // normal WebRTC renegotiation so either person can turn a camera on later.
        addVideoTrack: async (track, source) => {
            if (!track || !established || pc.signalingState !== 'stable') return false;
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) { await sender.replaceTrack(track); return true; }
            pc.addTrack(track, source);
            await pc.setLocalDescription(await pc.createOffer());
            signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription });
            return true;
        },
        // Only the caller restarts ICE, avoiding competing offers when a network
        // briefly changes (for example Wi-Fi to cellular). The other peer already
        // handles a subsequent offer as a normal renegotiation.
        restartIce: async () => {
            if (!initiator || !established || iceRestarts >= 1 || pc.signalingState !== 'stable') return false;
            iceRestarts++;
            try {
                pc.restartIce?.();
                await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
                signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription });
                return true;
            } catch (e) { return false; }
        },
        close() { try { pc.close(); } catch (e) {} conns.delete(cid); },
    };
    pc.onicecandidate = (e) => { if (e.candidate) signalSend(remote, { cid, kind: 'media', ice: e.candidate }); };
    pc.ontrack = (e) => {
        if (e.streams?.[0]) remoteStream = e.streams[0];
        else {
            remoteStream ||= new MediaStream();
            if (!remoteStream.getTracks().some(t => t.id === e.track.id)) remoteStream.addTrack(e.track);
        }
        ev.emit('stream', remoteStream);
    };
    const emitState = () => {
        lastState = { connection: pc.connectionState, ice: pc.iceConnectionState };
        ev.emit('state', lastState);
    };
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        emitState();
        if (s === 'connected') {
            clearTimeout(discT); clearTimeout(restartT); discT = restartT = null; iceRestarts = 0;
        } else if (s === 'disconnected' || s === 'failed') {
            // Give an interrupted call time to recover, then try one ICE restart
            // before declaring it dead. A failed direct path still needs TURN for
            // networks where no peer-to-peer route exists.
            if (!restartT) restartT = setTimeout(() => { restartT = null; api.restartIce(); }, s === 'failed' ? 0 : 2000);
            if (!discT) discT = setTimeout(fireClose, 20000);
        } else if (s === 'closed') fireClose();
    };
    pc.oniceconnectionstatechange = emitState;
    if (initiator) {
        addTracks(stream);
        pc.createOffer().then(o => pc.setLocalDescription(o))
          .then(() => signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription, metadata }));
    }
    conns.set(cid, { handleSignal: async (msg) => {
        if (msg.sdp) {
            await pc.setRemoteDescription(msg.sdp); remoteSet = true;
            pend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
            if (msg.sdp.type === 'offer' && established) {
                await pc.setLocalDescription(await pc.createAnswer());
                signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription });
            } else if (msg.sdp.type === 'answer') established = true;
        }
        else if (msg.ice) { remoteSet ? pc.addIceCandidate(msg.ice).catch(() => {}) : pend.push(msg.ice); }
    } });
    return api;
};

const peer = {
    connect: (userId, opts = {}) => makeDataConn(userId, rand(), true, opts.metadata, opts.targetDeviceId),
    call: (userId, stream, opts = {}) => makeMediaConn(userId, rand(), true, opts.metadata, stream),
};

const onSignal = (p) => {
    if (!p || p.to !== state.me.id) return;
    if (p.to_device && p.to_device !== state.deviceId) return;
    let entry = conns.get(p.cid);
    if (!entry) {
        if (!p.sdp || p.sdp.type !== 'offer') return;   // stray candidate/answer for a dead conn
        if (p.kind === 'data') { const c = makeDataConn(p.from, p.cid, false, p.metadata, p.from_device || null); onDataConn && onDataConn(c); }
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
            const offset = Math.min(buf.byteLength, Math.max(0, Number(d.offset) || 0));
            c.send({ type: 'meta', id: d.id, bytes: buf.byteLength, mime, offset });
            if (!await sendBinary(c.dataChannel, buf, offset)) return;
            c.send({ type: 'done', id: d.id });
        });
    };
    signalCh = sb.channel('mayfly-signal', { config: { broadcast: { self: false } } });
    signalCh.on('broadcast', { event: 'sig' }, ({ payload }) => onSignal(payload));
    signalCh.subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); });
});

// Pull a snap/story's full image from the (online) author's browser. A video can
// take substantially longer than a photo, so the timeout is reset by every chunk
// of progress rather than expiring after one fixed transfer-wide deadline.
const fetchSnapOnce = (id, authorId, authorDeviceId = null, onProgress = null, transfer = null) => new Promise((resolve) => {
    const state = transfer || { mime: 'image/jpeg', expectedBytes: 0, receivedBytes: 0, parts: [] };
    let done = false, sawDone = false, timer = null;
    const c = peer.connect(authorId, { targetDeviceId: authorDeviceId });
    onProgress?.({ phase: 'Connecting', received: 0, total: 0 });
    const armTimeout = (ms = 30000) => { clearTimeout(timer); timer = setTimeout(() => finish(null), ms); };
    const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { c.close(); } catch (e) {}
        resolve(value);
    };
    const completeIfReady = () => {
        if (sawDone && (!state.expectedBytes || state.receivedBytes >= state.expectedBytes)) {
            finish(URL.createObjectURL(new Blob(state.parts, { type: state.mime })));
        }
    };
    armTimeout(); // Covers signaling and opening the data channel.
    c.on('open', () => { onProgress?.({ phase: state.receivedBytes ? 'Resuming' : 'Requesting', received: state.receivedBytes, total: state.expectedBytes }); c.send({ type: 'want', id, offset: state.receivedBytes }); });
    c.on('data', (d) => {
        if (!d || d.id !== id) return;
        if (d.type === 'miss') return finish(null);
        if (d.type === 'meta') {
            state.mime = d.mime || 'image/jpeg';
            state.expectedBytes = Math.max(0, Number(d.bytes) || 0);
            onProgress?.({ phase: 'Downloading', received: state.receivedBytes, total: state.expectedBytes });
            return armTimeout();
        }
        if (d.type === 'done') { sawDone = true; completeIfReady(); }
    });
    c.on('chunk', (ab) => {
        if (!ab) return;
        state.parts.push(ab);
        state.receivedBytes += ab.byteLength || 0;
        onProgress?.({ phase: 'Downloading', received: state.receivedBytes, total: state.expectedBytes });
        armTimeout();
        completeIfReady();
    });
    c.on('close', () => finish(null));
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fetchSnap = async (id, authorId, authorDeviceId = null, onProgress = null) => {
    if (!authorId) return null;
    // Preserve received chunks across reconnects and request only the remaining
    // byte range. Three connection attempts cover brief mobile network changes.
    const transfer = { mime: 'image/jpeg', expectedBytes: 0, receivedBytes: 0, parts: [] };
    for (let attempt = 0; attempt < 3; attempt++) {
        const full = await fetchSnapOnce(id, authorId, authorDeviceId, onProgress, transfer);
        if (full) return full;
        if (attempt < 2) await wait(350 * (attempt + 1));
    }
    return null;
};

export { peer, startRtc, fetchSnap };
