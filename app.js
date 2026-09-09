import { sb, SNAP_BUCKET, $, $$, el, esc, app, toast, ago, initial, avatarHTML, isMediaUrl, icon,
    safeMediaUrl, state, presenceUsers, isOnline, setFriendActivity, activityText, processImage, processCanvas, processVideo, makeStoryPreview, makeRelayMedia, makeAvatar,
    idb, dataUrlToBytes } from './core.js';
import { db } from './db.js';
import { initPush, registerSW, enablePush, disablePush, pushPreference } from './push.js';
import { startRtc, fetchSnap } from './rtc.js';
import { loadOrCreateKeys, encryptSharedRelay, wrapSharedRelayKey } from './crypto.js';
import { FILTERS, drawFiltered, filterImageBlob } from './filters.js';
import { renderConvs, openConversation, onIncomingDM, onIncomingCall, detachAll, chatUnread, reconnectOpenChat, onMessageInsert, onSnapInsert, noteSentSnap, markSnapDelivered, markSnapOpened, markSnapRemoved, markMessageDelivered, sendStoryReply, sendClipShare, bootChat, syncMessages, clearAllLocalConversations } from './chat.js';
import { openGroupById, createGroupFlow, onIncomingGroupCall, onIncomingGroupData, renderGroupList, closeCurrentGroup, bootGroups, sendSnapToGroupChat, clearAllGroupConversations } from './groups.js';
import { viewClips, closeClips } from './clips.js';
import { saveMemory, viewMemories, closeMemories } from './memories.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2)));
const RELAY_LIMIT = 100;     // hard ceiling on a user's outstanding encrypted relay payloads
const RELAY_TTL_DAYS = 7;    // an offline snap self-destructs a week after it's sent if never opened
// The database RPC below independently verifies this immutable auth-user ID.
// This client check only controls whether the management UI is shown.
const MAYFLY_ADMIN_ID = '2f43626a-3056-402d-9daf-b0de5193a2f8';
window.addEventListener('unhandledrejection', (e) => console.error('[mayfly] unhandled rejection:', e.reason));
// Mobile browser chrome can change the visible viewport while a thread is being
// pulled or scrolled. Drive chat layout from VisualViewport so its composer stays
// inside the actually visible area rather than the larger layout viewport.
const syncVisualViewport = () => {
    const h = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--app-vh', Math.round(h) + 'px');
};
syncVisualViewport();
window.addEventListener('resize', syncVisualViewport);
window.visualViewport?.addEventListener('resize', syncVisualViewport);
window.visualViewport?.addEventListener('scroll', syncVisualViewport);

// ===================== presence =====================
let presenceCh = null;
let activityTimer = null, lastActivityWrite = 0;
const touchActivity = (force = false) => { if(!state.me||(!force&&Date.now()-lastActivityWrite<55_000))return;lastActivityWrite=Date.now();db.touchActivity().then(()=>{},()=>{}); };
const refreshFriendActivity = async () => { const {data}=await db.friendActivity();setFriendActivity(data||[]); };
const startPresence = () => {
    presenceCh = sb.channel('mayfly-presence', { config: { presence: { key: state.me.id } } });
    presenceCh.on('presence', { event: 'sync' }, () => {
        const st = presenceCh.presenceState();
        for (const k in presenceUsers) delete presenceUsers[k];
        for (const key in st) for (const m of st[key]) if (m.user_id) presenceUsers[m.user_id] = { username: m.username };
        if ($('#friendlist')) renderFriends();   // refresh online dots
        reconnectOpenChat();                      // connect an open chat once the friend comes online
    });
    presenceCh.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') { await presenceCh.track({ user_id: state.me.id, username: state.profile.username });touchActivity(true);refreshFriendActivity().then(()=>{},()=>{}); }
    });
    clearInterval(activityTimer);activityTimer=setInterval(()=>touchActivity(),60_000);
};

// A service worker cannot hold a Realtime websocket open while the operating
// system freezes a background PWA. It can, however, wake the page with a push.
// Rebuild the shared socket after a longer suspension so presence and signaling
// recover immediately instead of waiting for the next heartbeat timeout.
let backgroundedAt = 0, lastRealtimeRecovery = 0, recoveryTimer = null;
const recoverRealtime = async (forceSocket = false) => {
    if (!state.me || Date.now() - lastRealtimeRecovery < 1500) return;
    lastRealtimeRecovery = Date.now();
    try {
        const connected = sb.realtime.isConnected?.() ?? true;
        if (forceSocket || !connected) {
            await sb.realtime.disconnect();
            sb.realtime.connect();
        }
        // Channels rejoin automatically with the shared socket. Re-track as soon
        // as possible as well; this is harmless when the presence channel is
        // already joined and shortens the stale-offline window after a resume.
        if (presenceCh?.state === 'joined') {
            await presenceCh.track({ user_id: state.me.id, username: state.profile?.username });
        }
        db.touchDevice().then(() => {}, () => {});
        touchActivity();refreshFriendActivity().then(()=>{},()=>{});
        syncMessages().then(setChatDot, () => {});
        reconnectOpenChat();
        clearTimeout(recoveryTimer);
        recoveryTimer = setTimeout(() => {
            if (presenceCh?.state === 'joined' && state.me) {
                presenceCh.track({ user_id: state.me.id, username: state.profile?.username }).catch(() => {});
            }
        }, 1200);
    } catch (e) {}
};

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { backgroundedAt = Date.now();touchActivity(); }
    else recoverRealtime(backgroundedAt > 0 && Date.now() - backgroundedAt > 30_000);
}, { passive: true });
window.addEventListener('pageshow', (event) => recoverRealtime(!!event.persisted), { passive: true });
window.addEventListener('online', () => recoverRealtime(true), { passive: true });
window.addEventListener('focus', () => recoverRealtime(false), { passive: true });
// Chrome emits these Page Lifecycle events around tab freezing. Other browsers
// simply ignore them and use visibility/pageshow above.
document.addEventListener('freeze', () => { backgroundedAt = Date.now(); }, { passive: true });
document.addEventListener('resume', () => recoverRealtime(true), { passive: true });
navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'mf-wake') recoverRealtime(true);
});

// ===================== camera-first capture =====================
let stream = null, facing = 'user';
let cameraInputCleanup = () => {};
const stopStream = () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } };
const startCamera = async () => {
    const v = $('#cam'); if (!v) return;
    stopStream();
    try {
        // Chrome and Edge record the combined stream reliably as WebM (VP8 + Opus).
        // If microphone permission is denied, preserve the working video-only fallback.
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: facing },
                audio: { echoCancellation: true, noiseSuppression: true },
            });
        } catch (audioError) {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
        }
        v.srcObject = stream; v.play?.();
        $('#camerr').textContent = '';
    } catch (e) {
        $('#camerr').innerHTML = 'Camera unavailable. <b>Tap the photo icon</b> to pick from your gallery instead.';
    }
};
const viewCamera = (defaultRecipientId = null, groupId = null) => {
    cameraInputCleanup();
    stopStream();
    app.innerHTML = `<main class="camwrap">
      <div class="viewport">
        <video id="cam" autoplay playsinline muted disablepictureinpicture controlslist="nodownload noplaybackrate noremoteplayback"></video>
        <canvas id="filterpreview" hidden aria-hidden="true"></canvas>
        <div class="camerr" id="camerr"></div>
      </div>
      <select class="filterselect" id="filter" aria-label="Photo filter">${FILTERS.map(f => `<option value="${f.id}">${f.label}</option>`).join('')}</select>
      <div class="cambar">
        <button class="cbtn ghost" id="pick" title="From gallery" aria-label="Pick from gallery">🖼️</button>
        <button class="shutter" id="shoot" aria-label="Take photo; hold to record video"></button>
        <button class="cbtn ghost" id="flip" title="Flip camera" aria-label="Flip camera">🔄</button>
        <input id="file" type="file" accept="image/*,video/*" hidden>
      </div>
    </main>`;
    const finishShot = (shot) => compose(shot, defaultRecipientId, groupId);
    let activeFilter = 'normal', previewFrame = null, previewLastDraw = 0;
    const filter = $('#filter');
    const preview = $('#filterpreview');
    const drawLivePreview = (now) => {
        const video = $('#cam');
        if (activeFilter === 'normal' || !preview.isConnected) return;
        if (!video?.videoWidth) { previewFrame = requestAnimationFrame(drawLivePreview); return; }
        if (!previewLastDraw || now - previewLastDraw >= 180) {
            const scale = Math.min(1, 640 / video.videoWidth);
            preview.width = Math.max(1, Math.round(video.videoWidth * scale));
            preview.height = Math.max(1, Math.round(video.videoHeight * scale));
            const ctx = preview.getContext('2d');
            if (facing === 'user') { ctx.translate(preview.width, 0); ctx.scale(-1, 1); }
            drawFiltered(ctx, video, activeFilter);
            previewLastDraw = now;
        }
        previewFrame = requestAnimationFrame(drawLivePreview);
    };
    const updateFilter = () => {
        activeFilter = filter.value;
        $('#cam').style.filter = 'none';
        cancelAnimationFrame(previewFrame); previewFrame = null; previewLastDraw = 0;
        preview.hidden = activeFilter === 'normal';
        if (activeFilter !== 'normal') previewFrame = requestAnimationFrame(drawLivePreview);
    };
    filter.onchange = updateFilter;
    $('#flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
    $('#pick').onclick = () => $('#file').click();
    $('#file').onchange = async () => {
        const f = $('#file').files[0]; if (!f) return;
        try {
            if (f.type.startsWith('video/')) finishShot(await processVideo(f));
            else finishShot(await processImage(await filterImageBlob(f, activeFilter)));
        }
        catch (e) { toast('Could not read that media.'); }
    };
    const shoot = $('#shoot');
    shoot.onclick = null; // pointer handling below distinguishes a tap from a hold.
    const takePhoto = async () => {
        const v = $('#cam'); if (!v || !v.videoWidth) return toast('Camera not ready.');
        const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight });
        const ctx = c.getContext('2d');
        if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        drawFiltered(ctx, v, activeFilter);
        try { finishShot(await processCanvas(c)); }
        catch (e) { toast('Could not prepare that photo.'); }
    };
    const captureVideoPreview = () => {
        const v = $('#cam'); if (!v?.videoWidth) return null;
        const scale = 24 / Math.max(v.videoWidth, v.videoHeight);
        const c = Object.assign(document.createElement('canvas'), {
            width: Math.max(1, Math.round(v.videoWidth * scale)), height: Math.max(1, Math.round(v.videoHeight * scale)),
        });
        drawFiltered(c.getContext('2d'), v, activeFilter);
        return c.toDataURL('image/jpeg', 0.5);
    };
    let holdTimer = null, recorder = null, longPress = false;
    const stopRecording = () => {
        if (recorder?.state === 'recording') recorder.stop();
    };
    const startRecording = () => {
        if (!stream || !window.MediaRecorder) return toast('Video recording is not available in this browser.');
        if (activeFilter !== 'normal') toast('Filters apply to photos; video records unfiltered.');
        const chunks = [];
        const preview = captureVideoPreview();
        const captureMime = 'video/webm;codecs=vp8,opus';
        const options = MediaRecorder.isTypeSupported(captureMime) ? { mimeType: captureMime } : undefined;
        try { recorder = new MediaRecorder(stream, options); }
        catch (e) { return toast('Could not start video recording.'); }
        recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        recorder.onstop = async () => {
            shoot.classList.remove('recording');
            const blob = new Blob(chunks, { type: recorder.mimeType || captureMime });
            recorder = null;
            if (!blob.size) return;
            try {
                const shot = await processVideo(blob);
                if (preview) shot.preview = preview;
                finishShot(shot);
            }
            catch (e) { toast('Could not prepare that video.'); }
        };
        recorder.start(250);
        shoot.classList.add('recording');
    };
    shoot.onpointerdown = (e) => {
        e.preventDefault(); shoot.setPointerCapture?.(e.pointerId); longPress = false;
        holdTimer = setTimeout(() => { longPress = true; startRecording(); }, 300);
    };
    const releaseShutter = () => {
        clearTimeout(holdTimer);
        const wasLongPress = longPress; longPress = false;
        if (wasLongPress) stopRecording(); else takePhoto();
    };
    shoot.onpointerup = releaseShutter;
    shoot.onpointercancel = releaseShutter;
    // Chrome on some Android devices exposes the hardware volume key as VolumeUp;
    // other mobile browsers reserve it for system volume and never dispatch this event.
    let volumeHeld = false;
    const isVolumeUp = (e) => e.key === 'VolumeUp' || e.key === 'AudioVolumeUp';
    const volumeDown = (e) => {
        if (!isVolumeUp(e) || volumeHeld) return;
        e.preventDefault(); volumeHeld = true; longPress = false;
        holdTimer = setTimeout(() => { longPress = true; startRecording(); }, 300);
    };
    const volumeUp = (e) => {
        if (!isVolumeUp(e) || !volumeHeld) return;
        e.preventDefault(); volumeHeld = false; releaseShutter();
    };
    document.addEventListener('keydown', volumeDown);
    document.addEventListener('keyup', volumeUp);
    cameraInputCleanup = () => {
        document.removeEventListener('keydown', volumeDown);
        document.removeEventListener('keyup', volumeUp);
        clearTimeout(holdTimer);
        cancelAnimationFrame(previewFrame);
    };
    startCamera();
};

// ===================== compose: caption, timer, choose friends, send =====================
// A Snap normally stays in the recipient's chat. A positive timer makes it view-once.
let timer = 0;
const compose = async (shot, defaultRecipientId = null, defaultGroupId = null, initialStory = false, initialCaption = '') => {
    stopStream();
    const isVideo = shot.mime?.startsWith('video/');
    timer = 0;
    // Preview the original Blob URL. `full` remains the encoded payload used for delivery.
    const previewUrl = isVideo ? (shot.localPreviewUrl || shot.full) : shot.full;
    const releasePreview = () => { if (shot.localPreviewUrl) URL.revokeObjectURL(shot.localPreviewUrl); };
    app.innerHTML = `<main class="composewrap">
      <div class="preview ${isVideo ? 'video' : ''}" ${isVideo ? '' : `style="background-image:url('${safeMediaUrl(previewUrl)}')"`}>
        ${isVideo ? `<video class="composevideo" src="${safeMediaUrl(previewUrl)}" autoplay muted loop playsinline></video>` : ''}
        <input id="cap" class="capinput" value="${esc(initialCaption)}" placeholder="Add a caption…" maxlength="120" autocomplete="off">
        <div class="timerpick"><button class="tchip ${timer === 0 ? 'on' : ''}" data-t="0">Keep</button>${[3, 5, 10].map(t => `<button class="tchip ${t === timer ? 'on' : ''}" data-t="${t}">${t}s</button>`).join('')}</div>
        <button class="retake" id="retake" aria-label="Retake">✕</button>
      </div>
      <div class="sendrow">
        <button class="pill" id="savememory" type="button">Save to Memories</button>
        <div class="sendto">Send to…</div>
        <input id="recipsearch" class="recipsearch" type="search" placeholder="Search friends" autocomplete="off" aria-label="Search friends">
        <div id="recipmeta" class="recipmeta"></div>
        <div id="recips" class="recips"><div class="spin">Loading friends…</div></div>
        <button class="btn send" id="send" disabled>Send ▸</button>
      </div>
    </main>`;
    $('#retake').onclick = () => { releasePreview(); viewCamera(defaultRecipientId); };
    $('#savememory').onclick = async () => {
        const button = $('#savememory'); button.disabled = true; button.textContent = 'Saving…';
        try { await saveMemory(shot, $('#cap').value); button.textContent = 'Saved to Memories'; toast('Saved only in this browser.'); }
        catch (e) { button.disabled = false; button.textContent = 'Save to Memories'; toast('Could not save that Memory.'); }
    };
    if (isVideo) {
        const previewPlayer = $('.composevideo');
        previewPlayer.play().then(() => {
            previewPlayer.muted = false;
            return previewPlayer.play();
        }).catch(() => {
            // Autoplay sound can be blocked by the browser; keep the visual preview playing.
            previewPlayer.muted = true;
            previewPlayer.play().catch(() => {});
        });
    }
    $$('.tchip').forEach(b => b.onclick = () => { timer = +b.dataset.t; $$('.tchip').forEach(x => x.classList.toggle('on', x === b)); });
    const chosen = new Set(), chosenGroups = new Set();
    const RECENT_FRIEND_LIMIT = 50;
    const ALL_FRIENDS_LIMIT = 100;
    let toStory = initialStory, allFriends = false;
    const send = $('#send');
    const [{ data: friends }, { data: groups }] = await Promise.all([db.friends(), db.myGroups()]);
    const box = $('#recips'); if (!box) return;
    const list = (friends || []).map(f => {
        const friend = otherOf(f);
        return friend && { ...friend, friendSince: f.created_at };
    }).filter(Boolean).sort((a, b) => new Date(b.friendSince) - new Date(a.friendSince));
    const groupList = groups || [];
    const selectedFriendIds = () => allFriends
        ? list.slice(0, ALL_FRIENDS_LIMIT).map(u => u.id)
        : [...chosen];
    // A selected group counts as one destination — the Snap goes to its chat, not to
    // each member individually.
    const refreshSend = () => {
        const n = selectedFriendIds().length + chosenGroups.size + (toStory ? 1 : 0);
        send.disabled = !n;
        send.textContent = n ? `Send to ${n} ▸` : 'Send ▸';
    };
    // A Snap started from a chat or a friend row keeps that person selected.
    if (list.some(u => u.id === defaultRecipientId)) chosen.add(defaultRecipientId);
    if (groupList.some(g => g.id === defaultGroupId)) chosenGroups.add(defaultGroupId);
    const search = $('#recipsearch');
    const meta = $('#recipmeta');
    const renderRecipients = () => {
        const query = search.value.trim().toLowerCase();
        const matches = query ? list.filter(u => u.username.toLowerCase().includes(query)) : list;
        const visible = matches.slice(0, RECENT_FRIEND_LIMIT);
        box.innerHTML = '';
        // "My Story" — broadcast to all friends for 24h (always available)
        const storyChip = el(`<button class="recip story ${toStory ? 'on' : ''}"><span class="ring">⚡</span><span>My Story</span></button>`);
        storyChip.onclick = () => {
            if (isVideo) return toast('Video snaps can be sent directly to friends, not to Stories yet.');
            toStory = !toStory; renderRecipients(); refreshSend();
        };
        box.appendChild(storyChip);
        groupList.forEach(g => {
            const chip = el(`<button class="recip ${chosenGroups.has(g.id) ? 'on' : ''}"><span class="avatar">👥</span><span>${esc(g.name || 'Group')}</span></button>`);
            chip.onclick = () => {
                chosenGroups.has(g.id) ? chosenGroups.delete(g.id) : chosenGroups.add(g.id);
                renderRecipients(); refreshSend();
            };
            box.appendChild(chip);
        });
        if (list.length) {
            const allChip = el(`<button class="recip allfriends ${allFriends ? 'on' : ''}"><span class="avatar">👥</span><span>All friends${list.length > ALL_FRIENDS_LIMIT ? ` (first ${ALL_FRIENDS_LIMIT})` : ''}</span></button>`);
            allChip.onclick = () => {
                allFriends = !allFriends;
                if (allFriends) chosen.clear();
                renderRecipients(); refreshSend();
            };
            box.appendChild(allChip);
        }
        if (!list.length) box.appendChild(el(`<div class="empty" style="width:100%">No friends yet — <a href="#/friends">add some →</a> or just post to your Story.</div>`));
        visible.forEach(u => {
            const chip = el(`<button class="recip ${chosen.has(u.id) ? 'on' : ''}" data-uid="${u.id}">${avatarHTML(u.username, u.avatar)}<span>${esc(u.username)}</span>${isOnline(u.id) ? '<i class="dot"></i>' : ''}</button>`);
            chip.onclick = () => {
                allFriends = false;
                chosen.has(u.id) ? chosen.delete(u.id) : chosen.add(u.id);
                renderRecipients(); refreshSend();
            };
            box.appendChild(chip);
        });
        if (matches.length > RECENT_FRIEND_LIMIT) {
            box.appendChild(el(`<div class="recipmore">Showing ${RECENT_FRIEND_LIMIT} of ${matches.length}${query ? ' matches' : ' recent friends'} — search to narrow the list.</div>`));
        }
        meta.textContent = allFriends && list.length > ALL_FRIENDS_LIMIT
            ? `All-friends sends are limited to your ${ALL_FRIENDS_LIMIT} most recent friends at a time.`
            : (query ? `${matches.length} friend${matches.length === 1 ? '' : 's'} found` : `Showing your ${Math.min(RECENT_FRIEND_LIMIT, list.length)} most recent friends`);
    };
    search.oninput = renderRecipients;
    renderRecipients();
    refreshSend();
    // Build a File from the captured snap for group P2P delivery.
    const snapFile = async () => shot.rawBlob
        ? new File([shot.rawBlob], 'snap', { type: shot.mime || 'video/webm' })
        : new File([await dataUrlToBytes(shot.full)], 'snap.jpg', { type: shot.mime || 'image/jpeg' });
    send.onclick = async () => {
        const directIds = selectedFriendIds();
        if (allFriends && list.length > ALL_FRIENDS_LIMIT && !confirm(`Send this Snap to your ${ALL_FRIENDS_LIMIT} most recent friends? You have ${list.length} friends total, so the rest will not receive this one.`)) return;
        send.disabled = true;
        const caption = $('#cap').value.trim();
        // Friends receive an individual Snap; groups receive it in their chat only.
        let targets = list.filter(u => directIds.includes(u.id));
        const selectedGroups = groupList.filter(g => chosenGroups.has(g.id));
        const offlineTargets = targets.filter(u => !isOnline(u.id));
        targets = targets.filter(u => isOnline(u.id));
        let ok = 0, blocked = 0, toobig = 0, toomany = 0;
        if (toStory) { const s = await postStory(shot, caption); if (s) ok++; }
        const SEND_BATCH_SIZE = 5;
        let done = 0;
        for (let i = 0; i < targets.length; i += SEND_BATCH_SIZE) {
            const batch = targets.slice(i, i + SEND_BATCH_SIZE);
            send.textContent = `Sending ${done + 1}–${Math.min(done + batch.length, targets.length)} of ${targets.length}…`;
            const results = await Promise.all(batch.map(u => sendLiveSnap(shot, u, caption, timer)));
            results.forEach((r, index) => {
                if (r && r.id) { ok++; noteSentSnap(batch[index].id, r.id, r.kind); }
                else if (r === 'cap') blocked++;
                else if (r === 'toobig') toobig++;
                else if (r === 'toomany') toomany++;
            });
            done += batch.length;
        }
        if (offlineTargets.length) {
            send.textContent = `Preparing one encrypted relay for ${offlineTargets.length} friend${offlineTargets.length === 1 ? '' : 's'}...`;
            const relay = await sendSharedRelay(shot, offlineTargets, caption, timer);
            relay.sent.forEach(({ uid, id, kind }) => { ok++; noteSentSnap(uid, id, kind); });
            blocked += relay.blocked; toomany += relay.toomany; toobig += relay.toobig;
        }
        if (selectedGroups.length) {
            const file = await snapFile();
            for (const g of selectedGroups) {
                send.textContent = `Sending to ${g.name || 'group'}…`;
                if (await sendSnapToGroupChat(g.id, file, timer)) ok++;
            }
        }
        // one toast wins (it replaces), so prefer the most useful message
        if (toomany) toast(`You've hit ${RELAY_LIMIT} unopened offline snaps${ok ? ` · sent ${ok}` : ''}. Some couldn't be sent until they're opened or expire.`);
        else if (toobig) toast(`That video is too large for offline delivery (20 MB max)${ok ? ` · sent ${ok}` : ''}.`);
        else if (ok) toast(`Sent 🐛`);
        else if (blocked) toast('Some friends already have an unopened snap from you.');
        releasePreview();
        location.hash = defaultRecipientId ? '#/c/' + defaultRecipientId : (defaultGroupId ? '#/group/' + defaultGroupId : '#/chats');
    };
};

// Live recipients keep the original media in the sender's browser and pull it P2P.
const sendLiveSnap = async (shot, u, caption, secs) => {
    const base = { sender_id: state.me.id, recipient_id: u.id, preview: shot.preview,
        caption, w: shot.w, h: shot.h, timer: secs };
    const kind = shot.mime?.startsWith('video/') ? 'video' : 'photo';
    try {
        if (!isOnline(u.id)) return false;
        const { data } = await db.devicesForUser(u.id);
        const devices = (data || []).length ? data : [{ id: null }];
        const logicalId = uuid(), ids = devices.map(() => uuid());
        await Promise.all(ids.map(id => idb.set('snap:' + id, shot.rawBlob || shot.full)));
        const rows = devices.map((device, i) => ({ ...base, id: ids[i], logical_id: logicalId, sender_device_id: state.deviceId, recipient_device_id: device.id, delivery: `live:${encodeURIComponent(shot.mime || 'image/jpeg')}` }));
        const results = await Promise.all(rows.map(row => db.addSnap(row)));
        const failed = results.find(result => result.error);
        if (failed) { await Promise.all(ids.map(id => idb.del('snap:' + id))); throw failed.error; }
        db.bumpStreak(u.id).then(() => {}, () => {});
        return { id: ids[0], kind };
    } catch (e) { console.error('[mayfly] send failed', e); return false; }
};

// One encrypted media payload, with a small recipient-specific wrapped key per row.
const sendSharedRelay = async (shot, targets, caption, secs) => {
    const result = { sent: [], blocked: 0, toomany: 0, toobig: 0 };
    const checked = await Promise.all(targets.map(async (u) => {
        const { count } = await db.pendingRelayTo(u.id);
        if (count && count >= 1) return { u, ok: false, blocked: true };
        const { data } = await db.devicesForUser(u.id);
        const devices = (data || []).map(device => {
            try { return { id: device.id, pubkey: JSON.parse(device.pubkey) }; } catch (e) { return null; }
        }).filter(Boolean);
        // Legacy recipients retain the account-key envelope until they register
        // their first device with the multi-device release.
        if (!devices.length) try { if (u.pubkey) devices.push({ id: null, pubkey: JSON.parse(u.pubkey) }); } catch (e) {}
        return { u, ok: devices.length > 0, devices };
    }));
    const recipients = checked.filter(item => item.ok);
    result.blocked = checked.filter(item => item.blocked).length;
    if (!recipients.length) return result;

    const [{ count: legacy }, { count: shared }] = await Promise.all([db.pendingLegacyRelayTotal(), db.pendingSharedRelayTotal()]);
    if ((legacy || 0) + (shared || 0) >= RELAY_LIMIT) { result.toomany = recipients.length; return result; }

    const id = uuid();
    const expires_at = new Date(Date.now() + RELAY_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    let payloadCreated = false;
    try {
        const source = shot.rawBlob || await fetch(shot.full).then(r => r.blob());
        const { bytes, mime } = await makeRelayMedia(source);
        const { ciphertext, content_iv, rawKey } = await encryptSharedRelay(bytes);
        const { error: payloadError } = await db.addRelayPayload({ id, sender_id: state.me.id, content_iv, mime, expires_at });
        if (payloadError) throw payloadError;
        payloadCreated = true;
        const upload = await sb.storage.from(SNAP_BUCKET).upload(id, new Blob([ciphertext]), { contentType: 'application/octet-stream', upsert: false });
        if (upload.error) throw upload.error;

        const rows = await Promise.all(recipients.flatMap(({ u, devices }) => {
            const logicalId = uuid();
            return devices.map(async (device) => {
                try {
                const key = await wrapSharedRelayKey(device.pubkey, rawKey);
                const snapId = uuid();
                const { error } = await db.addSnap({
                    id: snapId, sender_id: state.me.id, recipient_id: u.id,
                    preview: shot.preview, caption, w: shot.w, h: shot.h, timer: secs,
                    delivery: `relay-shared:${encodeURIComponent(mime)}`,
                    relay_id: id, logical_id: logicalId, sender_device_id: state.deviceId, recipient_device_id: device.id,
                    wrapped_key: key.wrapped_key, iv: key.iv, eph_pub: key.eph_pub, expires_at,
                });
                if (error) throw error;
                return { uid: u.id, id: snapId, kind: mime.startsWith('video/') ? 'video' : 'photo' };
            } catch (e) { console.error('[mayfly] shared relay recipient failed', e); return null; }
            });
        }));
        const sentRows = rows.filter(Boolean), seen = new Set();
        result.sent = sentRows.filter(row => !seen.has(row.uid) && seen.add(row.uid));
        result.sent.forEach(({ uid }) => db.bumpStreak(uid).then(() => {}, () => {}));
        if (!result.sent.length) {
            await sb.storage.from(SNAP_BUCKET).remove([id]);
            await db.delRelayPayloads([id]);
        }
    } catch (e) {
        console.error('[mayfly] shared relay failed', e);
        if (e?.message === 'relay-video-too-large') result.toobig = recipients.length;
        if (payloadCreated) {
            await sb.storage.from(SNAP_BUCKET).remove([id]);
            await db.delRelayPayloads([id]);
        }
    }
    return result;
};

// Post to My Story: a 24h broadcast to all friends. The full image stays in our
// browser (served P2P like a live snap); only the LQIP preview lands in the DB.
const postStory = async (shot, caption) => {
    try {
        const id = uuid();
        const source = shot.rawBlob || await fetch(shot.full).then(r => r.blob());
        const preview = await makeStoryPreview(source);
        const { error } = await db.addStory({ id, preview, caption, w: shot.w, h: shot.h });
        if (error) throw error;
        await idb.set('story:' + id, shot.rawBlob || shot.full);
        return true;
    } catch (e) { console.error('[mayfly] story failed', e); return false; }
};

// ===================== stories =====================
// A horizontal bar of friends (and you) with an active story; tap a ring to play.
const renderStoriesBar = async (into) => {
    if (!into) return;
    const [{ data: stories }, { data: viewed }] = await Promise.all([db.activeStories(), db.myViewedStories()]);
    const seen = new Set((viewed || []).map(v => v.story_id));
    // group active stories by author, preserving chronological order within each
    const byUser = new Map();
    (stories || []).forEach(s => { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id).push(s); });
    const mine = byUser.get(state.me.id) || [];
    byUser.delete(state.me.id);
    const storyGroups = mine.length ? [{ items: mine, mine: true }] : [];
    into.innerHTML = '';
    // "Your Story" — either your ring, or a ＋ to add
    const meRing = el(`<button class="storyitem">
        <span class="ring ${mine.length ? 'mine' : 'add'}">${mine.length ? avatarHTML(state.profile.username, state.profile.avatar) : '＋'}</span>
        <span class="sname">Your Story</span></button>`);
    meRing.onclick = () => mine.length ? playStories(storyGroups, 0) : (location.hash = '#/camera');
    into.appendChild(meRing);
    for (const [uid, items] of byUser) {
        const groupIndex = storyGroups.length;
        storyGroups.push({ items, mine: false });
        const a = items[0].author || {};
        const allSeen = items.every(s => seen.has(s.id));
        const ring = el(`<button class="storyitem"><span class="ring ${allSeen ? 'seen' : 'fresh'}">${avatarHTML(a.username, a.avatar)}</span><span class="sname">${esc(a.username || '')}</span></button>`);
        ring.onclick = () => playStories(storyGroups, groupIndex);
        into.appendChild(ring);
    }
    if (!mine.length && !byUser.size) into.innerHTML = `<div class="muted tiny" style="padding:10px 4px">No stories yet — tap ◉ and post to <b>My Story</b>.</div>`;
};

// Full-screen story player. It advances through each person's stories, then the next person.
const playStories = (groups, startGroup = 0) => {
    if (!groups.length) return;
    let i = 0, groupIndex = startGroup, timerId = null, advanceStarted = 0, advanceRemaining = 5000, items, mine, closed = false;
    const ov = el(`<div class="player stories"><div class="segs"></div>
        <img alt="story"><div class="pcap"></div><div class="pname"></div>
        <div class="tapzones"><div class="tz left"></div><div class="tz right"></div></div>
        <form class="storyreply" hidden><input maxlength="120" placeholder="Reply to Story…" aria-label="Reply to Story"><button type="submit">Send</button></form>
        <button class="storymore" aria-label="Story options" title="Story options" hidden>⋮</button>
        <div class="storymenu" hidden><button class="storydelete" type="button">Delete story</button></div>
        <button class="storyclose" aria-label="Close stories" title="Close">×</button>
        <button class="storyprev" aria-label="Previous story" title="Previous story">‹</button>
        <button class="storynext" aria-label="Next story" title="Next story">›</button>
        <div class="viewers"></div></div>`);
    document.body.appendChild(ov);
    const img = $('img', ov), segs = $('.segs', ov), more = $('.storymore', ov), menu = $('.storymenu', ov), reply = $('.storyreply', ov);
    let ownStoryUrl = null;
    const stopAdvance = () => { clearTimeout(timerId); timerId = null; };
    const pauseAdvance = () => {
        if (!timerId) return;
        advanceRemaining = Math.max(0, advanceRemaining - (Date.now() - advanceStarted));
        stopAdvance();
        const bar = segs.querySelector(`i[data-seg="${i}"]`);
        if (!bar) return;
        const trackWidth = bar.parentElement?.getBoundingClientRect().width || 1;
        const width = Math.min(trackWidth, parseFloat(getComputedStyle(bar).width) || 0);
        bar.style.transition = 'none';
        bar.style.width = `${(width / trackWidth) * 100}%`;
    };
    const resumeAdvance = () => {
        if (timerId || closed) return;
        if (advanceRemaining <= 0) return void show(i + 1);
        const bar = segs.querySelector(`i[data-seg="${i}"]`);
        if (bar) requestAnimationFrame(() => { bar.style.transition = `width ${advanceRemaining}ms linear`; bar.style.width = '100%'; });
        advanceStarted = Date.now();
        timerId = setTimeout(() => show(i + 1), advanceRemaining);
    };
    const close = () => { closed = true; stopAdvance(); if (ownStoryUrl) URL.revokeObjectURL(ownStoryUrl); document.removeEventListener('keydown', onKeydown); ov.remove(); };
    const setGroup = (nextGroup, atEnd = false) => {
        groupIndex = nextGroup;
        ({ items, mine } = groups[groupIndex]);
        segs.innerHTML = items.map((_, k) => `<span><i data-seg="${k}"></i></span>`).join('');
        show(atEnd ? items.length - 1 : 0);
    };
    const show = async (k) => {
        stopAdvance();
        if (ownStoryUrl) { URL.revokeObjectURL(ownStoryUrl); ownStoryUrl = null; }
        if (k < 0) return groupIndex > 0 ? setGroup(groupIndex - 1, true) : show(0);
        if (k >= items.length) return groupIndex < groups.length - 1 ? setGroup(groupIndex + 1) : close();
        i = k;
        more.hidden = !mine;
        menu.hidden = true;
        reply.hidden = mine;
        segs.querySelectorAll('i').forEach((s, j) => { s.style.transition = 'none'; s.style.width = j < k ? '100%' : '0'; });
        const s = items[k];
        $('.pname', ov).textContent = (s.author?.username) || (mine ? 'You' : '');
        $('.pcap', ov).textContent = s.caption || '';
        // The database-backed Story preview is intentionally size-bounded, but it
        // should remain readable when the author is offline.
        img.style.filter = 'none'; img.src = safeMediaUrl(s.preview);
        if (!mine) db.viewStory(s.id).then(({ error }) => {
            if (!error) window.dispatchEvent(new Event('mf-story-viewed'));
        }, () => {});
        // pull the full image P2P (from our own IndexedDB if it's ours)
        const shownGroup = groupIndex;
        let full = mine ? await idb.get('story:' + s.id) : await fetchSnap(s.id, s.user_id);
        if (closed || shownGroup !== groupIndex || i !== k) return;
        if (mine && full instanceof Blob) { ownStoryUrl = URL.createObjectURL(full); full = ownStoryUrl; }
        if (full) { img.src = safeMediaUrl(full); img.style.filter = 'none'; }
        if (mine) showViewers(s.id);
        // advance the current segment bar, then move on
        advanceRemaining = 5000;
        resumeAdvance();
    };
    // A tappable list of everyone who viewed this Story, each with quick actions:
    // start a chat, or jump straight into their own Story if they have one live.
    const openViewerList = async (viewers) => {
        pauseAdvance();
        const storyByUid = new Map();   // viewers with an UNWATCHED live Story → ring their avatar
        try {
            const [{ data: act }, { data: viewed }] = await Promise.all([db.activeStories(), db.myViewedStories()]);
            const seen = new Set((viewed || []).map(v => v.story_id));
            (act || []).forEach(st => { if (st.user_id !== state.me.id && !seen.has(st.id)) (storyByUid.get(st.user_id) || storyByUid.set(st.user_id, []).get(st.user_id)).push(st); });
        } catch (e) {}
        const m = el(`<div class="modal viewerlist"><div class="sheet"><div class="mhead">Viewed by · ${viewers.length}<button class="x icon" aria-label="Close">✕</button></div><div class="mbody"></div></div></div>`);
        const listBody = $('.mbody', m);
        if (!viewers.length) listBody.innerHTML = `<div class="empty">No views yet.</div>`;
        viewers.forEach(v => {
            const u = v.viewer; if (!u) return;
            const theirStory = storyByUid.get(u.id);
            // Viewers with a live Story get a ring on their avatar; tapping it plays it.
            const avatar = theirStory
                ? `<button class="storyavatar" aria-label="View ${esc(u.username)}'s story">${avatarHTML(u.username, u.avatar, 'hasstory')}</button>`
                : avatarHTML(u.username, u.avatar);
            const row = el(`<div class="urow">${avatar}<div class="who"><b>${esc(u.username)}</b><div class="sub">${esc(ago(v.viewed_at))}</div></div><div class="acts"><button class="pill primary vchat">Chat</button></div></div>`);
            $('.vchat', row).onclick = () => { m.remove(); close(); location.hash = '#/c/' + u.id; };
            if (theirStory) $('.storyavatar', row).onclick = () => { m.remove(); close(); playStories([{ items: theirStory, mine: false }], 0); };
            listBody.appendChild(row);
        });
        const dismiss = () => { m.remove(); resumeAdvance(); };
        $('.x', m).onclick = dismiss;
        m.onclick = (e) => { if (e.target === m) dismiss(); };
        document.body.appendChild(m);
    };
    const showViewers = async (id) => {
        const { data } = await db.storyViewers(id);
        const viewers = data || [];
        const box = $('.viewers', ov);
        box.innerHTML = `👁 ${viewers.length}` + (viewers.length ? ' · ' + viewers.slice(0, 3).map(v => esc(v.viewer?.username || '')).filter(Boolean).join(', ') : '');
        box.classList.toggle('tappable', viewers.length > 0);
        box.onclick = (e) => { e.stopPropagation(); if (viewers.length) openViewerList(viewers); };
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowRight') show(i + 1);
        if (e.key === 'ArrowLeft') show(i - 1);
    };
    $('.tz.right', ov).onclick = () => show(i + 1);
    $('.tz.left', ov).onclick = () => show(i - 1);
    $('.storyclose', ov).onclick = close;
    reply.onsubmit = async (e) => {
        e.preventDefault();
        const text = $('input', reply).value.trim(), s = items[i];
        if (!text || mine || !s?.user_id) return;
        const send = $('button', reply); send.disabled = true;
        const sent = await sendStoryReply(s.user_id, s.author?.username || 'Story author', text, s);
        if (sent) { const input = $('input', reply); input.value = ''; input.blur(); toast('Story reply sent.'); }
        send.disabled = false;
    };
    const replyInput = $('input', reply);
    replyInput.onfocus = pauseAdvance;
    replyInput.onblur = resumeAdvance;
    more.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    $('.storydelete', ov).onclick = async (e) => {
        e.stopPropagation();
        const s = items[i];
        if (!mine || !s || !confirm('Delete this Story?')) return;
        const { error } = await db.delStory(s.id);
        if (error) return void toast('Could not delete that Story.');
        await idb.del('story:' + s.id);
        close();
        if ($('#storiesbar')) renderStoriesBar($('#storiesbar'));
    };
    $('.storyprev', ov).onclick = () => show(i - 1);
    $('.storynext', ov).onclick = () => show(i + 1);
    $('.viewers', ov).onclick = (e) => e.stopPropagation();
    document.addEventListener('keydown', onKeydown);
    setGroup(startGroup);
};

// ===================== chats (unified conversations: snaps + chat) =====================
// Responsive: two-pane (list + open thread) on wide screens; single-pane on mobile
// where opening a conversation swaps to the thread (the `showthread` class).
const viewChats = (activeUid, activeGroupId = null) => {
    const open = activeUid || activeGroupId;
    app.innerHTML = `<main class="chats ${open ? 'showthread' : ''}">
      <aside class="convlist">
        <div id="storiesbar" class="storiesbar"></div>
        <div class="grouphead">Groups <button class="pill primary" id="newgroup" aria-label="New group">＋</button></div>
        <div id="grouplist"></div>
        <div class="convhead">Chats <button class="icon allchatmore" aria-label="All chat options">${icon('more')}</button><div class="headmenu" hidden><button type="button" class="clearallchats">Clear all conversations on this device</button></div></div>
        <div id="convs"><div class="spin">Loading…</div></div>
      </aside>
      <section class="threadpane" id="threadpane">${open ? '<div class="spin">…</div>' : '<div class="threadempty">Pick a conversation, or tap ◉ on someone to snap them.</div>'}</section>
    </main>`;
    $('#newgroup').onclick = () => createGroupFlow();
    const allMenu = $('.convhead .headmenu'), allMore = $('.allchatmore');
    allMore.onclick = () => { allMenu.hidden = !allMenu.hidden; allMore.setAttribute('aria-expanded', String(!allMenu.hidden)); };
    $('.clearallchats').onclick = async () => {
        if (!confirm('Clear all local conversations and opened media from this device? Active delivery data and your account will stay intact.')) return;
        allMenu.hidden = true;
        await clearAllLocalConversations(); clearAllGroupConversations();
        location.hash = '#/chats'; toast('Local conversations cleared.');
    };
    renderStoriesBar($('#storiesbar'));
    renderGroupList($('#grouplist'), activeGroupId);
    renderConvs($('#convs'), activeUid);
    if (activeUid) openConversation($('#threadpane'), activeUid);
    else if (activeGroupId) openGroupById(activeGroupId, $('#threadpane'));
};

// ===================== friends =====================
const otherOf = (row) => row.requester_id === state.me.id ? row.addressee : row.requester;
let streakMap = {};
const pairKey = (x, y) => [x, y].sort().join('|');
const HIDDEN_KEY = 'mf_hidden';
const getHidden = () => { try { return new Set(JSON.parse(localStorage[HIDDEN_KEY] || '[]')); } catch { return new Set(); } };
const hideUser = (uid) => { const h = getHidden(); h.add(uid); localStorage[HIDDEN_KEY] = JSON.stringify([...h]); };
const viewFriends = () => {
    const forcedPrivate = Boolean(state.profile?.profile_private && state.profile?.privacy_locked);
    app.innerHTML = `<main>
      <h3 class="vtitle">Friends</h3>
      <input class="field searchbar" id="usearch" placeholder="Search people by username…" autocomplete="off">
      <div id="reqs"></div>
      <div id="friendlist"></div>
      <div class="section-title">Add people</div>
      <div id="discover"><div class="spin">Loading…</div></div>
    </main>`;
    const s = $('#usearch'); let t;
    if (forcedPrivate) {
        s.remove();
        const discover = $('#discover');
        discover.previousElementSibling?.remove();
        discover.innerHTML = '<div class="empty">Your account is private by administrator setting. You cannot add people while this is enabled.</div>';
    } else s.oninput = () => { clearTimeout(t); t = setTimeout(() => renderDiscover(s.value.trim()), 220); };
    renderRequests();
    renderFriends();
    if (!forcedPrivate) renderDiscover('');
};
// Discover: up to 50 people you can add — Add sends a request, ✕ hides them for good.
// Already-friends / pending-either-way / hidden people are filtered out.
const renderDiscover = async (q) => {
    const box = $('#discover'); if (!box) return;
    const [{ data: profs }, { data: fr }, { data: out }, { data: inc }] = await Promise.all([
        q ? db.searchProfiles(q) : db.allProfiles(),
        db.friends(), db.outgoingRequests(), db.incomingRequests(),
    ]);
    if (!$('#discover')) return;
    const exclude = getHidden(); exclude.add(state.me.id);
    (fr || []).forEach(f => exclude.add(f.requester_id === state.me.id ? f.addressee_id : f.requester_id));
    (out || []).forEach(o => exclude.add(o.addressee_id));
    (inc || []).forEach(i => exclude.add(i.requester_id));
    const list = (profs || []).filter(p => !exclude.has(p.id));
    box.innerHTML = '';
    if (!list.length) return void (box.innerHTML = `<div class="empty">${q ? 'No one matched that.' : 'No new people to add right now.'}</div>`);
    list.forEach(p => {
        const row = el(`<div class="urow" data-uid="${p.id}">${avatarHTML(p.username, p.avatar)}
            <div class="who"><button class="profilelink">${esc(p.username)}</button>${isOnline(p.id) ? '<div class="sub"><i class="dot"></i>online</div>' : ''}</div>
            <div class="acts"><button class="pill primary addbtn">Add</button><button class="pill hidebtn" aria-label="Hide">✕</button></div></div>`);
        $('.profilelink', row).onclick = () => { location.hash = '#/profile/' + p.id; };
        $('.addbtn', row).onclick = async () => {
            const b = $('.addbtn', row); b.disabled = true;
            const { error } = await db.sendRequest(p.id);
            if (error) { b.disabled = false; return toast('Could not send request.'); }
            b.textContent = 'Requested'; b.classList.remove('primary');
        };
        $('.hidebtn', row).onclick = () => { hideUser(p.id); row.remove(); if (!$('#discover .urow')) box.innerHTML = `<div class="empty">No more people to add.</div>`; };
        box.appendChild(row);
    });
};
const renderRequests = async () => {
    const box = $('#reqs'); if (!box) return;
    const { data } = await db.incomingRequests();
    box.innerHTML = '';
    if (!data || !data.length) return;
    box.appendChild(el(`<div class="section-title">Friend requests</div>`));
    data.forEach(r => {
        const u = r.requester || {};
        const row = el(`<div class="urow">${avatarHTML(u.username, u.avatar)}
            <div class="who"><b>${esc(u.username || 'someone')}</b><div class="sub">wants to be friends</div></div>
            <div class="acts"><button class="pill primary ok">Accept</button><button class="pill no">✕</button></div></div>`);
        $('.ok', row).onclick = async () => { await db.acceptRequest(r.requester_id); row.remove(); renderFriends(); };
        $('.no', row).onclick = async () => { await db.removeFriend(r.requester_id); row.remove(); };
        box.appendChild(row);
    });
};
const renderFriends = async () => {
    const box = $('#friendlist'); if (!box) return;
    const [{ data: fr }, { data: stk }, { data: activity }] = await Promise.all([db.friends(), db.streaks(), db.friendActivity()]);
    if (!$('#friendlist')) return;
    streakMap = {};
    (stk || []).forEach(s => streakMap[pairKey(s.user_a, s.user_b)] = s.count);
    setFriendActivity(activity || []);
    const friends = (fr || []).map(otherOf).filter(Boolean);
    box.innerHTML = `<div class="section-title">Your friends</div>`;
    if (!friends.length) return void box.appendChild(el(`<div class="empty">No friends yet — add someone from <b>Add people</b> below.</div>`));
    friends.forEach(u => {
        const streak = streakMap[pairKey(state.me.id, u.id)] || 0;
        const row = el(`<div class="urow">${avatarHTML(u.username, u.avatar)}
            <div class="who"><button class="profilelink">${esc(u.username)}</button>
              <div class="sub">${isOnline(u.id) ? '<i class="dot"></i>' : ''}${activityText(u.id)}${streak ? ` · 🔥 ${streak}` : ''}</div></div>
            <div class="acts"><button class="rowaction chatbtn" data-go="#/c/${u.id}" aria-label="Chat with ${esc(u.username)}" title="Chat">${icon('messageSquare', 20)}</button><button class="rowaction snapbtn" aria-label="Send a Snap to ${esc(u.username)}" title="Send Snap">${icon('camera', 20)}</button></div></div>`);
        $('.profilelink', row).onclick = () => { location.hash = '#/profile/' + u.id; };
        $('.snapbtn', row).onclick = () => { location.hash = '#/snap/' + u.id; };
        box.appendChild(row);
    });
};

// ===================== me / settings =====================
const viewMe = () => {
    const p = state.profile;
    const isAdmin = state.me.id === MAYFLY_ADMIN_ID;
    app.innerHTML = `<main>
      <div class="mehead">
        <div class="avatar big" id="mav">${isMediaUrl(p.avatar) ? `<img src="${p.avatar}" alt="">` : initial(p.username)}</div>
        <input id="mfile" type="file" accept="image/*" hidden>
        <button class="pill" id="mpick">Change photo</button>
      </div>
      <label class="lbl">Username</label>
      <input class="field" id="muser" value="${esc(p.username)}" autocomplete="off">
      <label class="lbl">Public profile</label>
      <textarea class="field profilebio" id="mbio" maxlength="200" placeholder="Tell people a little about yourself…">${esc(p.bio || '')}</textarea>
      <div class="muted tiny" id="biocount">${String(p.bio || '').length}/200</div>
      <div class="settingrow"><div><b>Private profile</b><div class="muted tiny">${p.privacy_locked ? 'Set by an administrator. Only an administrator can remove it.' : 'Hide your profile from Add People.'}</div></div><label class="switch"><input id="privacytoggle" type="checkbox" ${p.profile_private ? 'checked' : ''} ${p.privacy_locked ? 'disabled' : ''}><span></span></label></div>
      <div class="err" id="merr"></div>
      <button class="btn" id="msave">Save</button>
      <button class="pill" id="mmemories">Memories</button>
      <div class="settingrow"><div><b>Notifications</b><div class="muted tiny" id="pushstatus"></div></div><label class="switch"><input id="pushtoggle" type="checkbox"><span></span></label></div>
      ${isAdmin ? `<section class="adminpanel"><b>Admin tools</b><p class="muted tiny">Search a Mayfly user to manage profile privacy or remove their account.</p><input class="field" id="adminusersearch" placeholder="Find a user" autocomplete="off"><div id="adminuserresults" class="adminresults"></div></section>` : ''}
      <button class="btn ghost" id="mout">Log out</button>
      <p class="muted tiny">mayfly 🐛 — snaps vanish after they're opened. Full photos are never stored on our server: they stream peer-to-peer when your friend is online, or are end-to-end encrypted when they're not.</p>
    </main>`;
    let newAvatar = null;
    $('#mmemories').onclick = () => { location.hash = '#/memories'; };
    const bio = $('#mbio'), bioCount = $('#biocount');
    bio.oninput = () => { bioCount.textContent = `${bio.value.length}/200`; };
    const privacyToggle = $('#privacytoggle');
    privacyToggle.onchange = async () => {
        const profile_private = privacyToggle.checked;
        privacyToggle.disabled = true;
        const { error } = await db.updateProfile({ profile_private });
        if (error) { privacyToggle.checked = !profile_private; toast('Could not update profile privacy.'); }
        else { state.profile.profile_private = profile_private; toast(profile_private ? 'Profile is private' : 'Profile is public'); }
        privacyToggle.disabled = Boolean(state.profile.privacy_locked);
    };
    $('#mpick').onclick = () => $('#mfile').click();
    $('#mfile').onchange = async () => {
        const f = $('#mfile').files[0]; if (!f) return;
        try { newAvatar = await makeAvatar(f); $('#mav').innerHTML = `<img src="${safeMediaUrl(newAvatar)}" alt="">`; }
        catch (e) { $('#merr').textContent = 'Could not read that image.'; }
    };
    $('#msave').onclick = async () => {
        const username = $('#muser').value.trim();
        if (!/^[a-z0-9_.]{3,20}$/i.test(username)) return void ($('#merr').textContent = 'Username: 3–20 letters, numbers, _ or .');
        const profileBio = bio.value.trim();
        if (profileBio.length > 200) return void ($('#merr').textContent = 'Public profile: up to 200 characters.');
        const patch = { username, bio: profileBio }; if (newAvatar) patch.avatar = newAvatar;
        const { error } = await db.updateProfile(patch);
        if (error) return void ($('#merr').textContent = /duplicate|unique/i.test(error.message) ? 'That username is taken.' : error.message);
        Object.assign(state.profile, patch); mountChrome(true); toast('Saved');
    };
    const pushToggle = $('#pushtoggle'), pushStatus = $('#pushstatus');
    const refreshPushToggle = () => {
        const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
        pushToggle.checked = supported && pushPreference() && Notification.permission === 'granted';
        if (!supported) pushStatus.textContent = 'Notifications are not supported by this browser.';
        else if (!pushPreference()) pushStatus.textContent = 'Off on this device.';
        else if (Notification.permission === 'denied') pushStatus.textContent = 'Blocked in browser settings.';
        else if (Notification.permission === 'granted') pushStatus.textContent = 'On for 1:1 messages and calls.';
        else pushStatus.textContent = 'Tap the switch to enable notifications.';
    };
    refreshPushToggle();
    pushToggle.onchange = async () => {
        if (pushToggle.checked) {
            const enabled = await enablePush();
            if (!enabled) toast('Allow notifications in your browser settings to turn them on.');
        } else await disablePush();
        refreshPushToggle();
    };
    if (isAdmin) {
        const search = $('#adminusersearch'), results = $('#adminuserresults');
        let searchTimer = null;
        const showUsers = async () => {
            const q = search.value.trim();
            if (q.length < 2) { results.innerHTML = `<div class="muted tiny">Type at least two characters.</div>`; return; }
            results.innerHTML = `<div class="spin">Searching…</div>`;
            const { data, error } = await db.adminSearchProfiles(q);
            if (!$('#adminuserresults')) return;
            if (error) { results.innerHTML = `<div class="err">Could not search users.</div>`; return; }
            const users = (data || []).filter(u => u.id !== MAYFLY_ADMIN_ID);
            if (!users.length) { results.innerHTML = `<div class="muted tiny">No matching users.</div>`; return; }
            results.innerHTML = '';
            users.forEach((u) => {
                const row = el(`<div class="urow">${avatarHTML(u.username, u.avatar)}<div class="who"><b>${esc(u.username)}</b><div class="sub privacylabel">${u.privacy_locked ? 'Forced private' : (u.profile_private ? 'Private' : 'Public')}</div></div><select class="adminactions" aria-label="Manage ${esc(u.username)}"><option value="">Manage</option><option value="privacy">${u.privacy_locked ? 'Unlock privacy' : 'Force private'}</option><option value="remove">Remove account</option></select></div>`);
                const actions = $('.adminactions', row);
                actions.onchange = async () => {
                    const action = actions.value; actions.value = '';
                    if (!action) return;
                    if (action === 'privacy') {
                        const forcePrivate = !u.privacy_locked;
                        if (!confirm(forcePrivate ? `Force ${u.username}'s profile private and prevent them from adding people?` : `Remove the forced privacy lock for ${u.username}?`)) return;
                        actions.disabled = true;
                        const { error: privacyError } = await db.adminSetProfilePrivacy(u.id, forcePrivate);
                        actions.disabled = false;
                        if (privacyError) return toast('Could not update profile privacy.');
                        u.profile_private = forcePrivate; u.privacy_locked = forcePrivate;
                        actions.querySelector('option[value="privacy"]').textContent = forcePrivate ? 'Unlock privacy' : 'Force private';
                        $('.privacylabel', row).textContent = forcePrivate ? 'Forced private' : 'Public';
                        return toast(forcePrivate ? `${u.username} is now forced private.` : `Privacy lock removed for ${u.username}.`);
                    }
                    if (!confirm(`Remove ${u.username} from Mayfly and delete their server-side data? This cannot be undone.`)) return;
                    actions.disabled = true;
                    const { error: removeError } = await db.adminDeleteUser(u.id);
                    if (removeError) { actions.disabled = false; return toast('Could not remove that account.'); }
                    row.remove(); toast(`${u.username} was removed.`);
                    if (!results.children.length) results.innerHTML = `<div class="muted tiny">No matching users.</div>`;
                };
                results.appendChild(row);
            });
        };
        search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(showUsers, 220); };
        results.innerHTML = `<div class="muted tiny">Type at least two characters.</div>`;
    }
    $('#mout').onclick = async () => { stopStream(); await sb.auth.signOut(); };
};

const viewPublicProfile = async (uid) => {
    const [{ data: p, error }, { data: friendCount }] = await Promise.all([db.profileById(uid), db.publicFriendCount(uid)]);
    if (error || !p) { app.innerHTML = '<main><div class="empty">That profile is unavailable.</div></main>'; return; }
    const mine = uid === state.me.id;
    const joined = new Date(p.created_at);
    const joinedLabel = Number.isNaN(joined.getTime()) ? '' : `Joined ${joined.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
    const count = Math.max(0, Number(friendCount) || 0);
    app.innerHTML = `<main class="publicprofile"><button class="btn ghost inline" data-go="#/friends">‹ Back</button><div class="avatar publicavatar">${isMediaUrl(p.avatar) ? `<img src="${p.avatar}" alt="${esc(p.username)}">` : initial(p.username)}</div><h1 class="vtitle">${esc(p.username)}</h1><p class="publicbio">${esc(p.bio || 'No public description yet.')}</p><div class="profileactions">${mine ? '<button class="pill primary" data-go="#/me">Edit profile</button>' : `<button class="pill primary" data-go="#/c/${p.id}">Chat</button>`}</div></main>`;
    const bio = $('.publicbio');
    if (bio) bio.insertAdjacentHTML('beforebegin', `<div class="profilestats"><span>${count} friend${count === 1 ? '' : 's'}</span>${joinedLabel ? `<span class="statdot" aria-hidden="true">·</span><span>${joinedLabel}</span>` : ''}</div>`);
};

// ===================== chrome + router =====================
const tabbar = () => `<nav id="tabbar" aria-label="Primary">
    <button class="tab" data-go="#/chats" aria-label="Chats">💬<span class="badge-count" id="chatdot"></span></button>
    <button class="tab" data-go="#/friends" aria-label="Friends">👥</button>
    <button class="tab cam" data-go="#/camera" aria-label="Camera"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5 10 3.75h4l1.5 1.75H19A2.5 2.5 0 0 1 21.5 8v9A2.5 2.5 0 0 1 19 19.5H5A2.5 2.5 0 0 1 2.5 17V8A2.5 2.5 0 0 1 5 5.5h3.5Z"/><circle cx="12" cy="12.5" r="3.25"/></svg></button>
    <button class="tab" data-go="#/clips" aria-label="Clips">▶</button>
    <button class="tab" data-go="#/me" aria-label="You">${isMediaUrl(state.profile.avatar) ? `<span class="navavatar"><img src="${state.profile.avatar}" alt=""></span>` : `<span class="navavatar">${initial(state.profile.username)}</span>`}</button>
  </nav>`;
const header = () => `<header><span class="logo" data-go="#/chats">mayfly 🐛</span></header>`;
const mountChrome = (force) => {
    if (!state.profile) return;
    if (force) document.body.querySelectorAll('header, #tabbar').forEach(n => n.remove());
    if (!$('header')) document.body.insertAdjacentElement('afterbegin', el(header()));
    if (!$('#tabbar')) document.body.appendChild(el(tabbar()));
    const seg = (location.hash.slice(2) || '').split('/')[0];
    // Chat views reclaim the top: hide the app header so the sidebar + thread fill the screen.
    document.body.classList.toggle('inchat', seg === '' || seg === 'chats' || seg === 'c' || seg === 'group');
    const activeGo = (seg === '' || seg === 'c' || seg === 'group') ? '#/chats' : ((seg === 'snap' || seg === 'groupsnap') ? '#/camera' : ('#/' + seg));
    $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.go === activeGo));
};
const unmountChrome = () => document.body.querySelectorAll('header, #tabbar').forEach(n => n.remove());

const route = () => {
    const parts = (location.hash.slice(1) || '/').split('/');
    const seg = parts[1], arg = parts[2];
    stopStream();
    cameraInputCleanup();
    detachAll();               // leaving a conversation → background msgs go to notifications
    closeCurrentGroup();        // leaving a group view → tear its channel/call down
    closeClips();
    closeMemories();
    mountChrome();
    if (seg === 'chats') return viewChats();
    if (seg === 'c' && arg) return viewChats(arg);
    if (seg === 'friends') return viewFriends();
    if (seg === 'clips') return viewClips(sendClipShare);
    if (seg === 'camera') return viewCamera();
    if (seg === 'snap' && arg) return viewCamera(arg);
    if (seg === 'groupsnap' && arg) return viewCamera(null, arg);
    if (seg === 'group' && arg) return viewChats(null, arg);
    if (seg === 'me') return viewMe();
    if (seg === 'memories') return viewMemories(async (item, blob, toStory) => {
        try {
            if (toStory && item.mime?.startsWith('video/')) return toast('Video Memories cannot be added to Stories yet.');
            const shot = item.mime?.startsWith('video/') ? await processVideo(blob) : await processImage(blob);
            compose(shot, null, null, toStory, item.caption || '');
        } catch (e) { toast('Could not open that Memory.'); }
    });
    if (seg === 'profile' && arg) return viewPublicProfile(arg);
    return viewChats();
};
const setChatDot = () => { const d = $('#chatdot'); if (d) { const n = chatUnread(); d.textContent = n > 9 ? '9+' : n; d.classList.toggle('on', n > 0); } };
window.addEventListener('chat-unread', setChatDot);
// tapping a friend's ringed avatar in the chat list (chat.js) plays their Story
window.addEventListener('mf-play-story', (e) => { const items = e.detail?.items; if (items?.length) playStories([{ items, mine: false }], 0); });
// Keep both Story-ring surfaces in sync as soon as a view is recorded, rather than
// waiting for the next route render or page refresh.
window.addEventListener('mf-story-viewed', () => {
    const bar = $('#storiesbar'); if (bar) renderStoriesBar(bar);
    const convs = $('#convs');
    if (convs) {
        const match = location.hash.match(/^#\/c\/([^/]+)/);
        renderConvs(convs, match?.[1] || null);
    }
});
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) location.hash = g.dataset.go; });
window.addEventListener('hashchange', () => { mountChrome(); route(); });

// ===================== realtime =====================
const startRealtime = () => {
    sb.channel('mayfly-snaps')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mf_snaps', filter: `recipient_id=eq.${state.me.id}` }, (payload) => onSnapInsert(payload.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'mf_snaps' }, (payload) => {
          const s = payload.new;
          if (s?.sender_id !== state.me.id) return;
          if (s.opened_at) markSnapOpened(s.id);
          else if (s.delivered_at) markSnapDelivered(s.id);
      })
      // one of my sent snaps was opened/expired (row deleted) → drop my local copy + mark opened
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'mf_snaps' }, (payload) => {
          if (payload.old?.id) { idb.del('snap:' + payload.old.id); markSnapRemoved(payload.old.id); }
      })
      .subscribe();
    sb.channel('mayfly-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mf_messages', filter: `recipient_id=eq.${state.me.id}` }, (payload) => onMessageInsert(payload.new))
      // my sent message was ingested by the recipient (row deleted) → blue "Delivered" receipt
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'mf_messages' }, (payload) => { if (payload.old?.id) markMessageDelivered(payload.old.message_id || payload.old.id); })
      // The first inbox query can finish before this websocket is subscribed. A
      // second catch-up here closes that race, which is most visible on mobile.
      .subscribe((status) => { if (status === 'SUBSCRIBED') syncMessages().catch(() => {}); });
    sb.channel('mayfly-friends')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mf_friends' }, () => { if ($('#reqs')) { renderRequests(); renderFriends(); } })
      .subscribe();
    sb.channel('mayfly-stories')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mf_stories' }, () => { if ($('#storiesbar')) renderStoriesBar($('#storiesbar')); })
      .subscribe();
};

// Delete full snap/story images left in this device's IndexedDB whose row is gone
// (a snap was opened, or a story expired).
const sweepLocal = async () => {
    try {
        // No server cron, so each client garbage-collects the expired snaps it's party to:
        // delete the rows and, for relays, remove the encrypted Storage blobs. This keeps
        // unopened-and-expired offline snaps from accumulating in the database or the bucket.
        const [{ data: expired }, { data: expiredPayloads }] = await Promise.all([db.myExpiredSnaps(), db.myExpiredRelayPayloads()]);
        if (expiredPayloads?.length) {
            const ids = expiredPayloads.map(payload => payload.id);
            try { await sb.storage.from(SNAP_BUCKET).remove(ids); } catch (e) {}
            await db.delRelayPayloads(ids);
        }
        if (expired?.length) {
            const relayIds = expired.filter(r => r.delivery?.startsWith('relay') && !r.relay_id).map(r => r.id);
            if (relayIds.length) { try { await sb.storage.from(SNAP_BUCKET).remove(relayIds); } catch (e) {} }
            await db.delSnaps(expired.map(r => r.id));
        }
        await db.delExpiredMessages();   // drop undelivered chat older than a week
        db.delMyStaleRings().then(() => {}, () => {});   // clear any call-ring rows I left behind
        const [{ data: snaps }, { data: stories }, keys] = await Promise.all([db.mySpentSnaps(), db.myStories(), idb.keys()]);
        const live = new Set([...(snaps || []).map(r => 'snap:' + r.id), ...(stories || []).map(r => 'story:' + r.id)]);
        for (const k of keys) if (typeof k === 'string' && (k.startsWith('snap:') || k.startsWith('story:')) && !live.has(k)) idb.del(k);
    } catch (e) {}
};

// ===================== auth gate =====================
const viewGate = () => {
    unmountChrome();
    let mode = 'in';
    const render = () => {
        app.innerHTML = `<div id="gate">
          <span class="logo big">mayfly 🐛</span>
          <p class="tagline">snaps that live for a day, then vanish.</p>
          <form id="af">
            ${mode === 'up' ? `<input class="field" id="username" placeholder="Username" autocomplete="username">` : ''}
            <input class="field" id="email" type="email" placeholder="Email" autocomplete="email" required>
            <input class="field" id="password" type="password" placeholder="Password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" required>
            <div class="err" id="ae"></div>
            <button class="btn" id="go">${mode === 'up' ? 'Sign up' : 'Log in'}</button>
          </form>
          <div class="swap">${mode === 'up' ? 'Have an account?' : "New here?"}
            <button class="btn ghost inline" id="swap">${mode === 'up' ? 'Log in' : 'Sign up'}</button></div>
        </div>`;
        $('#swap').onclick = () => { mode = mode === 'up' ? 'in' : 'up'; render(); };
        $('#af').onsubmit = submit;
    };
    const submit = async (e) => {
        e.preventDefault();
        const email = $('#email').value.trim(), password = $('#password').value, errb = $('#ae'), go = $('#go');
        errb.textContent = ''; go.disabled = true;
        try {
            if (mode === 'up') {
                const username = $('#username').value.trim();
                if (!/^[a-z0-9_.]{3,20}$/i.test(username)) throw new Error('Username: 3–20 letters, numbers, _ or .');
                const { data: taken } = await sb.from('mf_profiles').select('id').eq('username', username).maybeSingle();
                if (taken) throw new Error('That username is taken.');
                const { error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
                if (error) throw error;
                if (!(await sb.auth.getSession()).data.session) { toast('Check your email to confirm, then log in.'); mode = 'in'; render(); return; }
            } else {
                const { error } = await sb.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err) { errb.textContent = err.message || 'Something went wrong'; go.disabled = false; }
    };
    render();
};

// ===================== boot =====================
let bootedFor = null;
const enterApp = async (session) => {
    if (bootedFor === session.user.id) { if (state.profile) route(); return; }
    bootedFor = session.user.id;
    state.me = session.user;
    // this device's E2E keypair (private stays local)
    const { priv, pubJwk, deviceId } = await loadOrCreateKeys();
    state.priv = priv; state.deviceId = deviceId;
    // Profiles retain a legacy public key for older installs. Current installs
    // publish their key per device and never overwrite another device's key.
    const { data: prof } = await db.myProfile();
    const username = prof?.username || state.me.user_metadata?.username || ('user_' + state.me.id.slice(0, 8));
    const { data: saved } = await db.upsertProfile({ username, pubkey: prof?.pubkey || JSON.stringify(pubJwk), avatar: prof?.avatar || '' });
    state.profile = saved || prof || { username };
    await db.registerDevice(pubJwk, navigator.userAgent.slice(0, 120));
    await startRtc(onIncomingDM, (c) => c.metadata?.group ? onIncomingGroupCall(c) : onIncomingCall(c), onIncomingGroupData);
    startPresence();
    startRealtime();
    bootGroups();
    sweepLocal();
    // Ask once for notification permission (also powers the in-app foreground notifications),
    // then register a Web Push subscription so 1:1 messages/calls can wake a backgrounded app.
    if (pushPreference() && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(() => initPush()).catch(() => {});
    else initPush();
    unmountChrome(); mountChrome();
    route();
    await bootChat();   // load unopened snaps + pull any messages waiting for me → sets the badge
    setChatDot();
};

sb.auth.onAuthStateChange((_evt, session) => {
    if (session) enterApp(session);
    else { bootedFor = null; stopStream(); sb.removeAllChannels(); unmountChrome(); viewGate(); }
});
const { data: { session } } = await sb.auth.getSession();
session ? enterApp(session) : viewGate();

// Register the cache-free service worker so Web Push can wake the app. It has no fetch
// handler, so app files are still always fetched fresh from the network; its activate step
// also clears any caches left behind by older offline workers (the reason we used to
// unregister on boot). initPush() reuses this same registration after login.
registerSW();
