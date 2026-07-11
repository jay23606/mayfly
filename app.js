import { sb, SNAP_BUCKET, $, $$, el, esc, app, toast, ago, initial, avatarHTML, isMediaUrl,
    safeMediaUrl, state, presenceUsers, isOnline, processImage, processCanvas, makeAvatar,
    idb, dataUrlToBytes, bytesToDataUrl } from './core.js';
import { db } from './db.js';
import { startRtc, fetchSnap } from './rtc.js';
import { loadOrCreateKeys, encryptFor, decryptWith } from './crypto.js';
import { renderConvs, openConversation, onIncomingDM, onIncomingCall, detachAll, chatUnread, reconnectOpenChat, onMessageInsert, onSnapInsert, noteSentSnap, bootChat } from './chat.js';
import { openGroupById, createGroupFlow, onIncomingGroupCall, renderGroupList, closeCurrentGroup } from './groups.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2)));
window.addEventListener('unhandledrejection', (e) => console.error('[mayfly] unhandled rejection:', e.reason));

// ===================== presence =====================
let presenceCh = null;
const startPresence = () => {
    presenceCh = sb.channel('mayfly-presence', { config: { presence: { key: state.me.id } } });
    presenceCh.on('presence', { event: 'sync' }, () => {
        const st = presenceCh.presenceState();
        for (const k in presenceUsers) delete presenceUsers[k];
        for (const key in st) for (const m of st[key]) if (m.user_id) presenceUsers[m.user_id] = { username: m.username };
        const o = $('#online'); if (o) o.textContent = Object.keys(presenceUsers).length + ' online';
        if ($('#friendlist')) renderFriends();   // refresh online dots
        reconnectOpenChat();                      // connect an open chat once the friend comes online
    });
    presenceCh.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await presenceCh.track({ user_id: state.me.id, username: state.profile.username });
    });
};

// ===================== camera-first capture =====================
let stream = null, facing = 'user';
const stopStream = () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } };
const startCamera = async () => {
    const v = $('#cam'); if (!v) return;
    stopStream();
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
        v.srcObject = stream; v.play?.();
        $('#camerr').textContent = '';
    } catch (e) {
        $('#camerr').innerHTML = 'Camera unavailable. <b>Tap the photo icon</b> to pick from your gallery instead.';
    }
};
const viewCamera = () => {
    stopStream();
    app.innerHTML = `<main class="camwrap">
      <div class="viewport">
        <video id="cam" autoplay playsinline muted></video>
        <div class="camerr" id="camerr"></div>
      </div>
      <div class="cambar">
        <button class="cbtn ghost" id="pick" title="From gallery" aria-label="Pick from gallery">🖼️</button>
        <button class="shutter" id="shoot" aria-label="Capture"></button>
        <button class="cbtn ghost" id="flip" title="Flip camera" aria-label="Flip camera">🔄</button>
        <input id="file" type="file" accept="image/*" hidden>
      </div>
    </main>`;
    $('#flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
    $('#pick').onclick = () => $('#file').click();
    $('#file').onchange = async () => {
        const f = $('#file').files[0]; if (!f) return;
        try { compose(await processImage(f)); } catch (e) { toast('Could not read that image.'); }
    };
    $('#shoot').onclick = () => {
        const v = $('#cam'); if (!v || !v.videoWidth) return toast('Camera not ready — use 🖼️ instead.');
        const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight });
        const ctx = c.getContext('2d');
        if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }   // un-mirror the selfie
        ctx.drawImage(v, 0, 0);
        compose(processCanvas(c));
    };
    startCamera();
};

// ===================== compose: caption, timer, choose friends, send =====================
let timer = 5;
const compose = async (shot) => {
    stopStream();
    app.innerHTML = `<main class="composewrap">
      <div class="preview" style="background-image:url('${safeMediaUrl(shot.full)}')">
        <input id="cap" class="capinput" placeholder="Add a caption…" maxlength="120" autocomplete="off">
        <div class="timerpick">${[3, 5, 10].map(t => `<button class="tchip ${t === timer ? 'on' : ''}" data-t="${t}">${t}s</button>`).join('')}</div>
        <button class="retake" id="retake" aria-label="Retake">✕</button>
      </div>
      <div class="sendrow">
        <div class="sendto">Send to…</div>
        <div id="recips" class="recips"><div class="spin">Loading friends…</div></div>
        <button class="btn send" id="send" disabled>Send ▸</button>
      </div>
    </main>`;
    $('#retake').onclick = viewCamera;
    $$('.tchip').forEach(b => b.onclick = () => { timer = +b.dataset.t; $$('.tchip').forEach(x => x.classList.toggle('on', x === b)); });
    const chosen = new Set();
    let toStory = false;
    const send = $('#send');
    const refreshSend = () => { const n = chosen.size + (toStory ? 1 : 0); send.disabled = !n; send.textContent = n ? `Send ▸` : 'Send ▸'; };
    const { data: friends } = await db.friends();
    const box = $('#recips'); if (!box) return;
    const list = (friends || []).map(f => otherOf(f)).filter(Boolean);
    box.innerHTML = '';
    // "My Story" — broadcast to all friends for 24h (always available)
    const storyChip = el(`<button class="recip story"><span class="ring">⚡</span><span>My Story</span></button>`);
    storyChip.onclick = () => { toStory = !toStory; storyChip.classList.toggle('on', toStory); refreshSend(); };
    box.appendChild(storyChip);
    if (!list.length) box.appendChild(el(`<div class="empty" style="width:100%">No friends yet — <a href="#/friends">add some →</a> or just post to your Story.</div>`));
    list.forEach(u => {
        const chip = el(`<button class="recip" data-uid="${u.id}">${avatarHTML(u.username, u.avatar)}<span>${esc(u.username)}</span>${isOnline(u.id) ? '<i class="dot"></i>' : ''}</button>`);
        chip.onclick = () => {
            chip.classList.toggle('on');
            chosen.has(u.id) ? chosen.delete(u.id) : chosen.add(u.id);
            refreshSend();
        };
        box.appendChild(chip);
    });
    send.onclick = async () => {
        send.disabled = true; send.textContent = 'Sending…';
        const caption = $('#cap').value.trim();
        const targets = list.filter(u => chosen.has(u.id));
        let ok = 0, blocked = 0;
        if (toStory) { const s = await postStory(shot, caption); if (s) ok++; }
        for (const u of targets) { const r = await sendSnap(shot, u, caption, timer); if (r === true) { ok++; noteSentSnap(u.id); } else if (r === 'cap') blocked++; }
        if (ok) toast(`Sent 🐛`);
        if (blocked) toast('Some friends already have an unopened snap from you.');
        viewCamera();
    };
};

// Send one snap. Online recipient → live P2P (no server media). Offline → encrypted
// relay, capped at ONE unopened relay snap per recipient. Returns true | 'cap' | false.
const sendSnap = async (shot, u, caption, secs) => {
    const base = { sender_id: state.me.id, recipient_id: u.id, preview: shot.preview,
        caption, w: shot.w, h: shot.h, timer: secs };
    try {
        if (isOnline(u.id)) {
            const id = uuid();
            const { error } = await db.addSnap({ ...base, id, delivery: 'live' });
            if (error) throw error;
            await idb.set('snap:' + id, shot.full);   // held here; streamed P2P when they open it
            db.bumpStreak(u.id);
            return true;
        }
        // offline → relay. Enforce the one-pending-per-recipient cap.
        const { count } = await db.pendingRelayTo(u.id);
        if (count && count >= 1) return 'cap';
        if (!isMediaUrl(u.avatar) && !u.pubkey) { /* fallthrough */ }
        if (!u.pubkey) { toast(`${u.username} hasn't finished setting up mayfly.`); return false; }
        const id = uuid();
        const bytes = await dataUrlToBytes(shot.full);
        const { ct, iv, ephPub } = await encryptFor(JSON.parse(u.pubkey), bytes);
        const up = await sb.storage.from(SNAP_BUCKET).upload(id, new Blob([ct]), { contentType: 'application/octet-stream', upsert: false });
        if (up.error) throw up.error;
        const { error } = await db.addSnap({ ...base, id, delivery: 'relay', iv, eph_pub: ephPub });
        if (error) { await sb.storage.from(SNAP_BUCKET).remove([id]); throw error; }
        db.bumpStreak(u.id);
        return true;
    } catch (e) { console.error('[mayfly] send failed', e); return false; }
};

// Post to My Story: a 24h broadcast to all friends. The full image stays in our
// browser (served P2P like a live snap); only the LQIP preview lands in the DB.
const postStory = async (shot, caption) => {
    try {
        const id = uuid();
        const { error } = await db.addStory({ id, user_id: state.me.id, preview: shot.preview, caption, w: shot.w, h: shot.h });
        if (error) throw error;
        await idb.set('story:' + id, shot.full);
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
    into.innerHTML = '';
    // "Your Story" — either your ring, or a ＋ to add
    const meRing = el(`<button class="storyitem">
        <span class="ring ${mine.length ? 'mine' : 'add'}">${mine.length ? avatarHTML(state.profile.username, state.profile.avatar) : '＋'}</span>
        <span class="sname">Your Story</span></button>`);
    meRing.onclick = () => mine.length ? playStories(mine, true) : (location.hash = '#/');
    into.appendChild(meRing);
    for (const [uid, items] of byUser) {
        const a = items[0].author || {};
        const allSeen = items.every(s => seen.has(s.id));
        const ring = el(`<button class="storyitem"><span class="ring ${allSeen ? 'seen' : 'fresh'}">${avatarHTML(a.username, a.avatar)}</span><span class="sname">${esc(a.username || '')}</span></button>`);
        ring.onclick = () => playStories(items, false);
        into.appendChild(ring);
    }
    if (!mine.length && !byUser.size) into.innerHTML = `<div class="muted tiny" style="padding:10px 4px">No stories yet — tap ◉ and post to <b>My Story</b>.</div>`;
};

// Full-screen sequential story player (tap right = next, left = back, hold-free auto-advance).
const playStories = (items, mine) => {
    let i = 0, timerId = null;
    const ov = el(`<div class="player stories"><div class="segs"></div>
        <img alt="story"><div class="pcap"></div><div class="pname"></div>
        <div class="tapzones"><div class="tz left"></div><div class="tz right"></div></div>
        <div class="viewers"></div></div>`);
    document.body.appendChild(ov);
    const img = $('img', ov), segs = $('.segs', ov);
    segs.innerHTML = items.map((_, k) => `<span><i data-seg="${k}"></i></span>`).join('');
    const close = () => { clearTimeout(timerId); ov.remove(); };
    const show = async (k) => {
        clearTimeout(timerId);
        if (k < 0) k = 0;
        if (k >= items.length) return close();
        i = k;
        segs.querySelectorAll('i').forEach((s, j) => { s.style.transition = 'none'; s.style.width = j < k ? '100%' : '0'; });
        const s = items[k];
        $('.pname', ov).textContent = (s.author?.username) || (mine ? 'You' : '');
        $('.pcap', ov).textContent = s.caption || '';
        img.style.filter = 'blur(14px)'; img.src = safeMediaUrl(s.preview);
        if (!mine) db.viewStory(s.id);
        // pull the full image P2P (from our own IndexedDB if it's ours)
        let full = mine ? await idb.get('story:' + s.id) : await fetchSnap(s.id, s.user_id);
        if (full && items[i] === s) { img.src = safeMediaUrl(full); img.style.filter = 'none'; }
        if (mine) showViewers(s.id);
        // advance the current segment bar, then move on
        requestAnimationFrame(() => { const bar = segs.querySelector(`i[data-seg="${k}"]`); if (bar) { bar.style.transition = 'width 5s linear'; bar.style.width = '100%'; } });
        timerId = setTimeout(() => show(i + 1), 5000);
    };
    const showViewers = async (id) => {
        const { data } = await db.storyViewers(id);
        const box = $('.viewers', ov);
        box.textContent = `👁 ${(data || []).length}` + ((data || []).length ? ' · ' + data.slice(0, 3).map(v => v.viewer?.username).filter(Boolean).join(', ') : '');
    };
    $('.tz.right', ov).onclick = () => show(i + 1);
    $('.tz.left', ov).onclick = () => show(i - 1);
    $('.viewers', ov).onclick = (e) => e.stopPropagation();
    show(0);
};

// ===================== chats (unified conversations: snaps + chat) =====================
// Responsive: two-pane (list + open thread) on wide screens; single-pane on mobile
// where opening a conversation swaps to the thread (the `showthread` class).
const viewChats = (activeUid) => {
    app.innerHTML = `<main class="chats ${activeUid ? 'showthread' : ''}">
      <aside class="convlist">
        <div id="storiesbar" class="storiesbar"></div>
        <div class="grouphead">Groups <button class="pill primary" id="newgroup" aria-label="New group">＋</button></div>
        <div id="grouplist"></div>
        <div class="convhead">Chats</div>
        <div id="convs"><div class="spin">Loading…</div></div>
      </aside>
      <section class="threadpane" id="threadpane">${activeUid ? '<div class="spin">…</div>' : '<div class="threadempty">Pick a conversation, or tap ◉ on someone to snap them.</div>'}</section>
    </main>`;
    $('#newgroup').onclick = () => createGroupFlow();
    renderStoriesBar($('#storiesbar'));
    renderGroupList($('#grouplist'));
    renderConvs($('#convs'), activeUid);
    if (activeUid) openConversation($('#threadpane'), activeUid);
};

// ===================== friends =====================
const otherOf = (row) => row.requester_id === state.me.id ? row.addressee : row.requester;
let streakMap = {};
const pairKey = (x, y) => [x, y].sort().join('|');
const HIDDEN_KEY = 'mf_hidden';
const getHidden = () => { try { return new Set(JSON.parse(localStorage[HIDDEN_KEY] || '[]')); } catch { return new Set(); } };
const hideUser = (uid) => { const h = getHidden(); h.add(uid); localStorage[HIDDEN_KEY] = JSON.stringify([...h]); };
const viewFriends = () => {
    app.innerHTML = `<main>
      <h3 class="vtitle">Friends</h3>
      <input class="field searchbar" id="usearch" placeholder="Search people by username…" autocomplete="off">
      <div id="reqs"></div>
      <div id="friendlist"></div>
      <div class="section-title">Add people</div>
      <div id="discover"><div class="spin">Loading…</div></div>
    </main>`;
    const s = $('#usearch'); let t;
    s.oninput = () => { clearTimeout(t); t = setTimeout(() => renderDiscover(s.value.trim()), 220); };
    renderRequests();
    renderFriends();
    renderDiscover('');
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
            <div class="who"><b>${esc(p.username)}</b>${isOnline(p.id) ? '<div class="sub"><i class="dot"></i>online</div>' : ''}</div>
            <div class="acts"><button class="pill primary addbtn">Add</button><button class="pill hidebtn" aria-label="Hide">✕</button></div></div>`);
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
    const [{ data: fr }, { data: stk }] = await Promise.all([db.friends(), db.streaks()]);
    if (!$('#friendlist')) return;
    streakMap = {};
    (stk || []).forEach(s => streakMap[pairKey(s.user_a, s.user_b)] = s.count);
    const friends = (fr || []).map(otherOf).filter(Boolean);
    box.innerHTML = `<div class="section-title">Your friends</div>`;
    if (!friends.length) return void box.appendChild(el(`<div class="empty">No friends yet — add someone from <b>Add people</b> below.</div>`));
    friends.forEach(u => {
        const streak = streakMap[pairKey(state.me.id, u.id)] || 0;
        const row = el(`<div class="urow">${avatarHTML(u.username, u.avatar)}
            <div class="who"><b>${esc(u.username)}</b>
              <div class="sub">${isOnline(u.id) ? '<i class="dot"></i>online' : 'offline'}${streak ? ` · 🔥 ${streak}` : ''}</div></div>
            <div class="acts"><button class="pill chatbtn" data-go="#/chat/${u.id}">Chat</button><button class="pill snapbtn">Snap</button></div></div>`);
        $('.snapbtn', row).onclick = () => { location.hash = '#/'; };   // camera; they pick recipients there
        box.appendChild(row);
    });
};

// ===================== me / settings =====================
const viewMe = () => {
    const p = state.profile;
    app.innerHTML = `<main>
      <div class="mehead">
        <div class="avatar big" id="mav">${isMediaUrl(p.avatar) ? `<img src="${p.avatar}" alt="">` : initial(p.username)}</div>
        <input id="mfile" type="file" accept="image/*" hidden>
        <button class="pill" id="mpick">Change photo</button>
      </div>
      <label class="lbl">Username</label>
      <input class="field" id="muser" value="${esc(p.username)}" autocomplete="off">
      <div class="err" id="merr"></div>
      <button class="btn" id="msave">Save</button>
      <button class="btn ghost" id="mout">Log out</button>
      <p class="muted tiny">mayfly 🐛 — snaps vanish after they're opened. Full photos are never stored on our server: they stream peer-to-peer when your friend is online, or are end-to-end encrypted when they're not.</p>
    </main>`;
    let newAvatar = null;
    $('#mpick').onclick = () => $('#mfile').click();
    $('#mfile').onchange = async () => {
        const f = $('#mfile').files[0]; if (!f) return;
        try { newAvatar = await makeAvatar(f); $('#mav').innerHTML = `<img src="${safeMediaUrl(newAvatar)}" alt="">`; }
        catch (e) { $('#merr').textContent = 'Could not read that image.'; }
    };
    $('#msave').onclick = async () => {
        const username = $('#muser').value.trim();
        if (!/^[a-z0-9_.]{3,20}$/i.test(username)) return void ($('#merr').textContent = 'Username: 3–20 letters, numbers, _ or .');
        const patch = { username }; if (newAvatar) patch.avatar = newAvatar;
        const { error } = await db.updateProfile(patch);
        if (error) return void ($('#merr').textContent = /duplicate|unique/i.test(error.message) ? 'That username is taken.' : error.message);
        Object.assign(state.profile, patch); mountChrome(true); toast('Saved');
    };
    $('#mout').onclick = async () => { stopStream(); await sb.auth.signOut(); };
};

// ===================== chrome + router =====================
const tabbar = () => `<nav id="tabbar" aria-label="Primary">
    <button class="tab" data-go="#/chats" aria-label="Chats">💬<span class="badge-count" id="chatdot"></span></button>
    <button class="tab" data-go="#/friends" aria-label="Friends">👥</button>
    <button class="tab cam" data-go="#/" aria-label="Camera">◉</button>
    <button class="tab" data-go="#/me" aria-label="You">${isMediaUrl(state.profile.avatar) ? `<span class="navavatar"><img src="${state.profile.avatar}" alt=""></span>` : `<span class="navavatar">${initial(state.profile.username)}</span>`}</button>
  </nav>`;
const header = () => `<header><span class="logo" data-go="#/">mayfly 🐛</span><div class="grow"></div><span id="online" class="muted">…</span></header>`;
const mountChrome = (force) => {
    if (!state.profile) return;
    if (force) document.body.querySelectorAll('header, #tabbar').forEach(n => n.remove());
    if (!$('header')) document.body.insertAdjacentElement('afterbegin', el(header()));
    if (!$('#tabbar')) document.body.appendChild(el(tabbar()));
    const seg = (location.hash.slice(2) || '').split('/')[0];   // 'chats' | 'c' | 'friends' | 'me' | ''
    const activeGo = seg === 'c' ? '#/chats' : ('#/' + seg);
    $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.go === activeGo || (seg === '' && t.classList.contains('cam'))));
};
const unmountChrome = () => document.body.querySelectorAll('header, #tabbar').forEach(n => n.remove());

const route = () => {
    const parts = (location.hash.slice(1) || '/').split('/');
    const seg = parts[1], arg = parts[2];
    stopStream();
    detachAll();               // leaving a conversation → background msgs go to notifications
    closeCurrentGroup();        // leaving a group view → tear its channel/call down
    mountChrome();
    if (seg === 'chats') return viewChats();
    if (seg === 'c' && arg) return viewChats(arg);
    if (seg === 'friends') return viewFriends();
    if (seg === 'group' && arg) return openGroupById(arg);
    if (seg === 'me') return viewMe();
    return viewCamera();
};
const setChatDot = () => { const d = $('#chatdot'); if (d) { const n = chatUnread(); d.textContent = n > 9 ? '9+' : n; d.classList.toggle('on', n > 0); } };
window.addEventListener('chat-unread', setChatDot);
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) location.hash = g.dataset.go; });
window.addEventListener('hashchange', () => { mountChrome(); route(); });

// ===================== realtime =====================
const startRealtime = () => {
    sb.channel('mayfly-snaps')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mf_snaps', filter: `recipient_id=eq.${state.me.id}` }, (payload) => onSnapInsert(payload.new))
      // one of my sent snaps was opened/expired (row deleted) → drop my local copy
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'mf_snaps' }, (payload) => {
          if (payload.old?.id) idb.del('snap:' + payload.old.id);
      })
      .subscribe();
    sb.channel('mayfly-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mf_messages', filter: `recipient_id=eq.${state.me.id}` }, (payload) => onMessageInsert(payload.new))
      .subscribe();
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
    const { priv, pubJwk } = await loadOrCreateKeys();
    state.priv = priv;
    // self-heal the mf_profiles row + keep our published public key current
    const { data: prof } = await db.myProfile();
    const username = prof?.username || state.me.user_metadata?.username || ('user_' + state.me.id.slice(0, 8));
    const { data: saved } = await db.upsertProfile({ username, pubkey: JSON.stringify(pubJwk), avatar: prof?.avatar || '' });
    state.profile = saved || prof || { username };
    await startRtc(onIncomingDM, (c) => c.metadata?.group ? onIncomingGroupCall(c) : onIncomingCall(c));
    startPresence();
    startRealtime();
    sweepLocal();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
