import { sb, SNAP_BUCKET, $, el, esc, rand, toast, state, idb, isOnline, setFriendActivity, activityText, initial, ago,
    avatarHTML, safeMediaUrl, chunkString, mimeKind, icon } from './core.js';
import { peer, fetchSnap } from './rtc.js';
import { db } from './db.js';
import { encryptText, decryptText, decryptWith, decryptSharedRelay, encryptSharedRelay, wrapSharedRelayKey } from './crypto.js';
import { browserNotificationsEnabled } from './push.js';
import { mountCallApps, unmountCallApps, toggleCallApps, receiveCallApp } from './callapps.js';

// ===================== unified conversations (snaps + chat, Snapchat-style) =====================
// TEXT is async + end-to-end encrypted via mf_messages (works even when the friend is
// offline — they pick it up on next open, then the row is deleted). MEDIA / voice notes
// / video calls are live P2P (both online). Snaps normally become inline chat media;
// a positive timer keeps the full-screen view-once treatment.
// Each device keeps its own thread history in IndexedDB (thread:<uid>); nothing readable
// lives on the server.

const MSG_MAX = 2000;             // max characters per chat message
const conns = new Map();          // uid -> live P2P data conn (for media/voice/typing)
let inboxByUser = {};             // uid -> [unopened snap rows]
const unreadMsg = new Set();      // uids with messages received while their thread was closed
let openUid = null;               // conversation currently on screen
let openUsername = 'friend';
window.addEventListener('mf-activity-updated',()=>{if(!openUid||!threadBox)return;const n=threadBox.querySelector('.friendactivity');if(n)n.textContent=activityText(openUid,'active now');});
let threadBox = null, convBox = null;
let setReplyDraft = () => {};
// A realtime INSERT and a catch-up query can legitimately see the same row. Keep
// one ingestion job per row so that overlap cannot add the same message twice.
const messageJobs = new Map();
const handledMessageIds = new Set();
// Reactions are delivered as small encrypted control messages. In the unusual case
// that a reaction reaches this device before the message it refers to, keep it long
// enough to apply when that message is ingested.
const pendingReactions = new Map();
// Legacy photo snaps use plain "live" / "relay". Video snaps retain their MIME type
// in the existing delivery value, avoiding a database migration.
const snapMime = (s) => {
    const tag = s.delivery?.split(':')[1];
    try { return tag ? decodeURIComponent(tag) : 'image/jpeg'; }
    catch (e) { return 'image/jpeg'; }
};
const snapKind = (s) => snapMime(s).startsWith('video/') ? 'video' : 'photo';
const receiptKey = (id) => 'snap-receipt:' + id;
const statusRank = { sent: 0, delivered: 1, expired: 2, opened: 3 };
const pendingSnapStatuses = new Map();
const THREAD_CLEAR_KEY = 'mf_thread_clear_marks';
const THREAD_HIDE_KEY = 'mf_thread_hide_marks';
const clearMarks = () => { try { return JSON.parse(localStorage.getItem(THREAD_CLEAR_KEY) || '{}'); } catch (e) { return {}; } };
const hideMarks = () => { try { return JSON.parse(localStorage.getItem(THREAD_HIDE_KEY) || '{}'); } catch (e) { return {}; } };
const clearAt = (uid) => { const marks = clearMarks(); return Math.max(Number(marks['*']) || 0, Number(marks[uid]) || 0); };
const clearAllAt = () => Number(clearMarks()['*']) || 0;
const markCleared = (uid) => { const marks = clearMarks(); marks[uid] = Date.now(); localStorage.setItem(THREAD_CLEAR_KEY, JSON.stringify(marks)); };
const hideAt = (uid) => Number(hideMarks()[uid]) || 0;
const markHidden = (uid) => { const marks = hideMarks(); marks[uid] = Date.now(); localStorage.setItem(THREAD_HIDE_KEY, JSON.stringify(marks)); };
const isAfterClear = (uid, at) => Number(at) > clearAt(uid);

const onChange = () => window.dispatchEvent(new Event('chat-unread'));
export const chatUnread = () => {
    const s = new Set(unreadMsg);
    for (const uid in inboxByUser) if (inboxByUser[uid]?.some(snap => isAfterClear(uid, new Date(snap.created_at).getTime()))) s.add(uid);
    return s.size;
};

// ---- local per-friend thread history ----
const histGet = (uid) => idb.get('thread:' + uid).then(h => h || []);
// A Story reply, an opened Snap, and an incoming chat can arrive close together.
// Serialize their read-modify-write cycle so one stale history snapshot cannot erase
// another entry when the page is later refreshed.
const histWrites = new Map();
const histUpdate = (uid, change) => {
    const previous = histWrites.get(uid) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        const history = await histGet(uid);
        const result = await change(history);
        await idb.set('thread:' + uid, history);
        return result;
    });
    histWrites.set(uid, task);
    void task.then(
        () => { if (histWrites.get(uid) === task) histWrites.delete(uid); },
        () => { if (histWrites.get(uid) === task) histWrites.delete(uid); },
    );
    return task;
};
const entryId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const histPush = (uid, entry) => histUpdate(uid, (history) => {
    entry.localId ||= entryId();
    history.push(entry); if (history.length > 300) history.splice(0, history.length - 300);
});
const lastLine = (h) => {
    if (!h || !h.length) return '';
    const m = h[h.length - 1];
    return m.kind === 'text' ? (m.me ? 'You: ' : '') + m.text
        : m.kind === 'story-reply' ? (m.me ? 'You: ' : '') + 'Story reply'
        : m.kind === 'snap' ? '📷 You sent a Snap'
        : m.kind === 'gif' ? (m.me ? 'You: ' : '') + (m.type === 'sticker' ? 'Sticker' : 'GIF')
        : m.kind === 'media' ? (m.me ? 'You: ' : '') + '📎 ' + (m.name || m.mediaKind || 'attachment') : '';
};

const deviceKeysOf = async (uid) => {
    const { data } = await db.devicesForUser(uid);
    const devices = (data || []).map(device => {
        try { return { id: device.id, pubkey: JSON.parse(device.pubkey) }; } catch (e) { return null; }
    }).filter(Boolean);
    // Keep a legacy delivery fallback for someone who has not upgraded yet.
    if (!devices.length) {
        const { data: profile } = await db.profileById(uid);
        try { if (profile?.pubkey) devices.push({ id: null, pubkey: JSON.parse(profile.pubkey) }); } catch (e) {}
    }
    return devices;
};

// ---- pull any messages that arrived while we were offline ----
export const syncMessages = async () => {
    const { data } = await db.myUndelivered();
    for (const row of (data || [])) await receiveMessage(row);
    if (convBox?.isConnected) renderConvs(convBox, openUid);
    onChange();
};
const storyReplyFromPayload = async (text, me = false, at = Date.now(), localPreview = null) => {
    try {
        const p = JSON.parse(text);
        if (p?.t !== 'story-reply' || typeof p.storyId !== 'string' || typeof p.text !== 'string') return null;
        let preview = localPreview, storyW = Number(p.w) || 0, storyH = Number(p.h) || 0;
        if (!preview || !storyW || !storyH) {
            const { data } = await db.storyById(p.storyId);
            preview ||= data?.preview || null; storyW ||= Number(data?.w) || 0; storyH ||= Number(data?.h) || 0;
        }
        return { me, kind: 'story-reply', text: p.text, storyId: p.storyId, preview, storyW, storyH, at };
    } catch (e) { return null; }
};
const clipFromPayload = (text, me = false, at = Date.now()) => {
    try { const p = JSON.parse(text); return p?.t === 'clip-share' && p.provider === 'youtube' && typeof p.name === 'string' && /^[\w-]{11}$/.test(p.videoId || '') ? { me, kind: 'clip', name: p.name, videoId: p.videoId, caption: typeof p.caption === 'string' ? p.caption.slice(0, 240) : '', at } : null; } catch (e) { return null; }
};
const gifFromPayload = (text, me = false, at = Date.now()) => {
    try { const p = JSON.parse(text), url = new URL(p?.url || ''); if (p?.t !== 'gif-share' || p.provider !== 'giphy' || !['gif', 'sticker'].includes(p.type) || !/^(media\d*|i)\.giphy\.com$/i.test(url.hostname)) return null; return { me, kind: 'gif', type: p.type, url: url.href, title: typeof p.title === 'string' ? p.title.slice(0, 160) : p.type, at }; } catch (e) { return null; }
};
const replyFromPayload = (text, me = false, at = Date.now()) => {
    try { const p = JSON.parse(text); return p?.t === 'chat-reply' && typeof p.text === 'string' && typeof p.reply === 'string' ? { me, kind: 'text', text: p.text.slice(0, MSG_MAX), replyTo: p.reply.slice(0, 240), at } : null; } catch (e) { return null; }
};
const reactionFromPayload = (text) => {
    try {
        const p = JSON.parse(text);
        return p?.t === 'chat-reaction' && typeof p.targetId === 'string' && p.targetId.length <= 160 && REACTION_VALUES.has(p.reaction)
            ? { targetId: p.targetId, reaction: p.reaction }
            : null;
    } catch (e) { return null; }
};
const REACTION_VALUES = new Set(['\u{1F44D}', '\u2665', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F525}']);
const repairStoredReactions = (history) => {
    let changed = false;
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        const reaction = entry?.kind === 'text' && !entry.me ? reactionFromPayload(entry.text) : null;
        if (!reaction) continue;
        const target = history.find(item => item.msgId === reaction.targetId);
        if (target) target.reaction = reaction.reaction;
        else pendingReactions.set(reaction.targetId, reaction.reaction);
        history.splice(i, 1);
        changed = true;
    }
    return changed;
};
const decodeTitle = (value = '') => { const node = document.createElement('textarea'); node.innerHTML = value; return node.value; };
const applyIncomingReaction = async (uid, targetId, reaction) => {
    const applied = await histUpdate(uid, (history) => {
        const entry = history.find(item => item.msgId === targetId);
        if (!entry) return false;
        entry.reaction = reaction;
        return true;
    }).catch(() => false);
    if (!applied) {
        pendingReactions.set(targetId, reaction);
        // Do not let an orphaned reaction remain in memory indefinitely.
        setTimeout(() => pendingReactions.delete(targetId), 2 * 60 * 1000);
    }
    return applied;
};
const ingestMessage = async (row) => {
    let text = ''; try { text = await decryptText(state.priv, row.eph_pub, row.iv, row.body); }
    catch (e) { return false; }
    const at = new Date(row.created_at).getTime();
    const incomingReaction = reactionFromPayload(text);
    if (incomingReaction) {
        await applyIncomingReaction(row.sender_id, incomingReaction.targetId, incomingReaction.reaction);
        await db.delMessage(row.id);
        if (openUid === row.sender_id) renderThreadBody(row.sender_id, true);
        return true;
    }
    const entry = await storyReplyFromPayload(text, false, at) || replyFromPayload(text, false, at) || gifFromPayload(text, false, at) || clipFromPayload(text, false, at) || { me: false, kind: 'text', text, at };
    // Both people need the same stable identifier to attach a reaction to a shared
    // item. The delivery row ID is available to the recipient before it is deleted.
    entry.msgId = row.message_id || row.id;
    const queuedReaction = pendingReactions.get(entry.msgId);
    if (queuedReaction) { entry.reaction = queuedReaction; pendingReactions.delete(entry.msgId); }
    await histPush(row.sender_id, entry);
    await db.delMessage(row.id);          // ephemeral: delivered → gone from the server
    if (openUid === row.sender_id) appendEntry(entry);
    else { unreadMsg.add(row.sender_id); if (browserNotificationsEnabled()) new Notification('mayfly 🐛', { body: 'New message' }); }
    return true;
};
const receiveMessage = (row) => {
    if (!row?.id || handledMessageIds.has(row.id)) return Promise.resolve(false);
    if (messageJobs.has(row.id)) return messageJobs.get(row.id);
    const job = ingestMessage(row).then((done) => {
        if (done) {
            handledMessageIds.add(row.id);
            // Keep enough IDs to protect the short realtime/catch-up overlap
            // without retaining a message ID for the life of the app.
            if (handledMessageIds.size > 500) handledMessageIds.delete(handledMessageIds.values().next().value);
        }
        return done;
    }).finally(() => messageJobs.delete(row.id));
    messageJobs.set(row.id, job);
    return job;
};
// realtime INSERT handler (from app.js)
export const onMessageInsert = (row) => {
    if (row.recipient_id !== state.me.id) return;
    if (row.recipient_device_id && row.recipient_device_id !== state.deviceId) return;
    receiveMessage(row).then(() => {
        if (convBox?.isConnected) renderConvs(convBox, openUid);
        onChange();
    }).catch((e) => console.warn('[mayfly] could not ingest live message', e));
};

// ---- a snap arrived for me / I sent one ----
export const onSnapInsert = async (row) => {
    if (row.recipient_id !== state.me.id) return;
    if (row.recipient_device_id && row.recipient_device_id !== state.deviceId) return;
    (inboxByUser[row.sender_id] = inboxByUser[row.sender_id] || []).unshift(row);
    if (!row.delivered_at) db.markSnapDelivered(row.id).then(() => {}, () => {});
    if (openUid === row.sender_id && threadBox) renderThreadBody(row.sender_id);
    else if (browserNotificationsEnabled()) new Notification('mayfly 🐛', { body: `New ${snapKind(row) === 'video' ? 'video' : 'photo'} Snap!` });
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};
export const noteSentSnap = async (uid, snapId = null, snapKind = 'photo') => {
    const status = snapId ? (pendingSnapStatuses.get(snapId) || 'sent') : 'sent';
    const entry = { me: true, kind: 'snap', snapId, snapKind, status, at: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    await histPush(uid, entry);
    if (snapId) { pendingSnapStatuses.delete(snapId); await idb.set(receiptKey(snapId), { uid, status }); }
    if (convBox) renderConvs(convBox, openUid);
};

const updateSentSnapStatus = async (id, status) => {
    if (!id) return;
    const receipt = await idb.get(receiptKey(id));
    if (!receipt) { pendingSnapStatuses.set(id, status); return; }
    if (statusRank[status] < statusRank[receipt.status || 'sent']) return;
    receipt.status = status;
    await idb.set(receiptKey(id), receipt);
    await histUpdate(receipt.uid, (history) => {
        const entry = history.find(e => e.kind === 'snap' && e.snapId === id);
        if (entry && statusRank[status] >= statusRank[entry.status || 'sent']) entry.status = status;
    }).catch(() => {});
    if (openUid === receipt.uid) renderThreadBody(receipt.uid);
    if (convBox) renderConvs(convBox, openUid);
};
export const markSnapDelivered = (id) => { updateSentSnapStatus(id, 'delivered'); };
export const markSnapOpened = (id) => { updateSentSnapStatus(id, 'opened'); };
export const markSnapRemoved = (id) => { setTimeout(() => updateSentSnapStatus(id, 'expired'), 250); };
const snapReceipt = (e) => `<div class="msgstatus me ${e.snapKind || 'photo'} ${e.status || 'sent'}"${e.snapId ? ` data-snap="${e.snapId}"` : ''}><span class="si"></span><span class="sl">${({ sent: 'Sent', delivered: 'Delivered', opened: 'Opened', expired: 'Expired' })[e.status] || 'Sent'}</span></div>`;
// Text delivery receipt (blue): a message row is deleted the moment the recipient's
// device ingests it, so its realtime DELETE tells the sender it was delivered.
const deliveredMsgIds = new Set();
export const markMessageDelivered = (id) => { if (!id) return; deliveredMsgIds.add(id); if (openUid) renderThreadBody(openUid); };
const textReceipt = (delivered) => `<div class="msgstatus me text ${delivered ? 'delivered' : ''}"><span class="si"></span><span class="sl">${delivered ? 'Delivered' : 'Sent'}</span></div>`;

const refreshInbox = async () => {
    const { data } = await db.inbox();
    inboxByUser = {};
    (data || []).forEach(s => (inboxByUser[s.sender_id] = inboxByUser[s.sender_id] || []).push(s));
    Promise.all((data || []).filter(s => !s.delivered_at).map(s => db.markSnapDelivered(s.id))).catch(() => {});
};

const clearReceiptsFor = async (uid = null) => {
    const keys = await idb.keys();
    await Promise.all(keys.filter(key => typeof key === 'string' && key.startsWith('snap-receipt:')).map(async key => {
        const receipt = await idb.get(key);
        if (!uid || receipt?.uid === uid) await idb.del(key);
    }));
};
export const clearConversation = async (uid) => {
    markCleared(uid); unreadMsg.delete(uid);
    await histUpdate(uid, history => {
        const retained = history.filter(entry => isAfterClear(uid, entry.at));
        history.splice(0, history.length, ...retained);
    });
    await clearReceiptsFor(uid).catch(() => {});
    if (openUid === uid) await renderThreadBody(uid);
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};
export const clearAllLocalConversations = async () => {
    const marks = clearMarks(); marks['*'] = Date.now(); localStorage.setItem(THREAD_CLEAR_KEY, JSON.stringify(marks));
    unreadMsg.clear();
    const keys = await idb.keys();
    const uids = new Set([...histWrites.keys(), ...keys.filter(key => typeof key === 'string' && key.startsWith('thread:')).map(key => key.slice(7))]);
    await Promise.all([...uids].map(uid => histUpdate(uid, history => {
        const retained = history.filter(entry => isAfterClear(uid, entry.at));
        history.splice(0, history.length, ...retained);
    })));
    await clearReceiptsFor();
    if (openUid) await renderThreadBody(openUid);
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};
export const hideConversation = (uid) => {
    markHidden(uid); unreadMsg.delete(uid);
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};

// ===================== conversation list =====================
export const renderConvs = async (box, activeUid) => {
    convBox = box;
    const [{ data: fr }, { data: activeStories }, { data: viewed }] = await Promise.all([db.friends(), db.activeStories(), db.myViewedStories()]);
    const friends = (fr || []).map(f => f.requester_id === state.me.id ? f.addressee : f.requester).filter(Boolean);
    if (box !== convBox) return;
    // friends with an UNWATCHED live Story → ring their avatar; tapping plays the unseen ones
    const seen = new Set((viewed || []).map(v => v.story_id));
    const storyByUid = new Map();
    (activeStories || []).forEach(st => { if (st.user_id !== state.me.id && !seen.has(st.id)) (storyByUid.get(st.user_id) || storyByUid.set(st.user_id, []).get(st.user_id)).push(st); });
    // build each conversation's summary
    const rows = (await Promise.all(friends.map(async (u) => {
        const h = await histGet(u.id);
        const pending = (inboxByUser[u.id] || []).filter(snap => isAfterClear(u.id, new Date(snap.created_at).getTime()));
        const snaps = pending.length;
        const kind = snaps ? snapKind(pending[0]) : null;
        const lastAt = h.length ? h[h.length - 1].at : 0;
        if (u.id !== activeUid && clearAllAt() && lastAt <= clearAllAt() && !snaps) return null;
        if (hideAt(u.id) && lastAt <= hideAt(u.id) && !pending.some(snap => new Date(snap.created_at).getTime() > hideAt(u.id))) return null;
        const unread = snaps > 0 || unreadMsg.has(u.id);
        const status = snaps ? `New ${kind === 'video' ? 'Video' : 'Photo'} Snap${snaps > 1 ? ` ×${snaps}` : ''}` : (lastLine(h) || 'Tap to chat');
        return { u, lastAt: Math.max(lastAt, snaps ? Date.now() : 0), unread, status, snaps, kind };
    }))).filter(Boolean);
    rows.sort((a, b) => (b.unread - a.unread) || (b.lastAt - a.lastAt));
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = `<div class="empty">No friends yet. <a href="#/friends">Add some →</a></div>`; return; }
    rows.forEach(({ u, unread, status, snaps, kind }) => {
        const theirStory = storyByUid.get(u.id);
        const avatar = theirStory
            ? `<span class="storyavatar" role="button" tabindex="0" aria-label="View ${esc(u.username)}'s story">${avatarHTML(u.username, u.avatar, 'hasstory')}</span>`
            : avatarHTML(u.username, u.avatar);
        const row = el(`<button class="conv ${u.id === activeUid ? 'active' : ''} ${unread ? 'unread' : ''} ${kind ? 'snap-' + kind : ''}" data-go="#/c/${u.id}">
            <span class="convhide" role="button" tabindex="0" aria-label="Hide conversation with ${esc(u.username)}" title="Hide conversation">×</span>
            ${avatar}
            <div class="who"><b>${esc(u.username)}</b>
              <div class="sub ${unread ? 'hot' : ''}">${isOnline(u.id) ? '<i class="dot"></i>' : ''}${esc(status)}</div></div>
            <span class="camicon" data-snap="${u.id}" aria-label="Send a snap">${icon('camera', 20)}</span></button>`);
        $('.camicon', row).onclick = (e) => { e.preventDefault(); e.stopPropagation(); location.hash = '#/snap/' + u.id; };
        const hide = $('.convhide', row);
        const doHide = (e) => { e.preventDefault(); e.stopPropagation(); hideConversation(u.id); if (openUid === u.id) location.hash = '#/chats'; };
        hide.onclick = doHide;
        hide.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') doHide(e); };
        if (theirStory) {
            const sa = $('.storyavatar', row);
            const playStory = (e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('mf-play-story', { detail: { items: theirStory } })); };
            sa.onclick = playStory;
            sa.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') playStory(e); };
        }
        box.appendChild(row);
    });
};

// ===================== conversation thread =====================
export const openConversation = async (box, uid) => {
    openUid = uid; threadBox = box;
    unreadMsg.delete(uid); onChange();
    const [{ data: prof }, { data: activity }] = await Promise.all([db.profileById(uid),db.friendActivity()]);setFriendActivity(activity||[]);
    const username = prof?.username || 'friend';
    openUsername = username;
    box.innerHTML = `<div class="thread">
        <div class="thead">
          <button class="icon back" data-go="#/chats" aria-label="Back">‹</button>
          ${avatarHTML(username, prof?.avatar)}
          <div class="who"><b>${esc(username)}</b><div class="sub"><i class="cdot" style="opacity:${isOnline(uid) ? '1' : '.3'}"></i> <span class="friendactivity">${activityText(uid,'active now')}</span></div></div>
          <button class="icon callbtn" aria-label="Call">${icon('phone')}</button>
          <button class="icon chatmore" aria-label="Chat options">${icon('more')}</button>
          <div class="headmenu" hidden><button type="button" class="clearthread">Clear chat on this device</button></div>
        </div>
        <div class="tbody" id="tbody"><div class="spin">…</div></div>
        <div class="ctyping" id="ctyping"></div>
        <div class="voicepreview" hidden></div>
        <div class="replydraft" id="replydraft" hidden><span></span><button type="button" aria-label="Cancel reply">×</button></div>
        <form class="tin">
          <button type="button" class="icon snapbtn" aria-label="Send a snap">${icon('camera')}</button>
          <input class="tinput" placeholder="Send a chat" autocomplete="off" enterkeyhint="send" maxlength="2000" aria-label="Message">
          <button type="button" class="icon mic" aria-label="Record a voice note">${icon('mic')}</button>
          <button type="button" class="icon gifbtn" aria-label="GIFs and Stickers"><span class="gifmark">GIF</span></button>
          <button type="button" class="icon attach" aria-label="Attach a file">${icon('paperclip')}</button>
          <input type="file" class="fileinput" hidden>
        </form>
      </div>`;
    $('.callbtn', box).onclick = (e) => callMenu(e.currentTarget, (video) => callUser(uid, username, video));
    const menu = $('.headmenu', box), more = $('.chatmore', box);
    more.onclick = () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); };
    $('.clearthread', box).onclick = async () => {
        if (!confirm(`Clear this chat with ${username} on this device?`)) return;
        menu.hidden = true; await clearConversation(uid); toast('Chat cleared on this device.');
    };
    $('.snapbtn', box).onclick = () => { location.hash = '#/snap/' + uid; };
    $('.gifbtn', box).onclick = () => openGifPicker(uid, username);
    const fileInput = $('.fileinput', box);
    $('.attach', box).onclick = () => fileInput.click();
    fileInput.onchange = () => { const f = fileInput.files[0]; if (f) sendFile(uid, f, mimeKind(f.type)); fileInput.value = ''; };
    wireMic(box, uid);
    const form = $('.tin', box), input = $('.tinput', box);
    let replyDraft = null;
    const replyBar = $('#replydraft');
    setReplyDraft = (entry) => {
        replyDraft = { text: String(entry.text || entry.name || entry.title || (entry.type === 'sticker' ? 'Sticker' : entry.type === 'gif' ? 'GIF' : 'Message')).slice(0, 240) };
        $('span', replyBar).textContent = `Replying to: ${replyDraft.text}`; replyBar.hidden = false; input.focus();
    };
    $('button', replyBar).onclick = () => { replyDraft = null; replyBar.hidden = true; };
    form.onsubmit = (e) => {
        e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = '';
        const msgId = entryId(), replyTo = replyDraft?.text || '';
        const payload = replyTo ? JSON.stringify({ t: 'chat-reply', text: t, reply: replyTo }) : t;
        replyDraft = null; replyBar.hidden = true;
        sendText(uid, username, payload, { me: true, kind: 'text', text: t, replyTo, at: Date.now(), msgId, status: 'sent', localId: entryId() });
    };
    input.oninput = () => { const c = conns.get(uid); if (c?.open) { try { c.send({ t: 'typing' }); } catch (e) {} clearTimeout(input._tt); input._tt = setTimeout(() => { try { c.send({ t: 'stop' }); } catch (e) {} }, 1200); } };
    await renderThreadBody(uid);
    ensureConn(uid, username);                     // best-effort live link for typing / media
    // grab any messages this friend sent while we were away
    const { data: pend } = await db.myUndelivered();
    for (const row of (pend || [])) if (row.sender_id === uid) await receiveMessage(row);
    renderThreadBody(uid);
    if (convBox) renderConvs(convBox, uid);
};

// Merge local history + unopened snap cards into one chronological timeline.
const closeMessageMenus = (except = null) => document.querySelectorAll('.messagemenu:not([hidden]), .reactiontray:not([hidden])').forEach(menu => { if (menu !== except) menu.hidden = true; });
const renderThreadBody = async (uid, preserveScroll = false) => {
    const body = $('#tbody'); if (!body || openUid !== uid) return;
    const scrollTop = body.scrollTop;
    let h = await histGet(uid);
    // Versions before the emoji picker treated a valid reaction payload as a
    // normal message. Repair those local entries without requiring deletion.
    if (repairStoredReactions(h)) {
        await histUpdate(uid, repairStoredReactions);
        h = await histGet(uid);
    }
    // Expire locally tracked receipts after their 24-hour delivery window.
    let dirty = false;
    const reconcile = (e) => {
        if (e.kind === 'snap' && e.expiresAt && e.expiresAt <= Date.now() && e.status !== 'opened' && e.status !== 'expired') { e.status = 'expired'; return true; }
        if (e.kind === 'text' && e.me && e.msgId && deliveredMsgIds.has(e.msgId) && e.status !== 'delivered') { e.status = 'delivered'; return true; }
        return false;
    };
    h.forEach(e => { if (!e.localId) { e.localId = entryId(); dirty = true; } if (reconcile(e)) dirty = true; });
    if (dirty) histUpdate(uid, (history) => { history.forEach(reconcile); }).catch(() => {});
    const snaps = (inboxByUser[uid] || []).filter(s => isAfterClear(uid, new Date(s.created_at).getTime())).map(s => ({ snap: s, at: new Date(s.created_at).getTime() }));
    const items = [...h.map(e => ({ entry: e, at: e.at })), ...snaps].sort((a, b) => a.at - b.at);
    body.innerHTML = '';
    if (!items.length) body.innerHTML = `<div class="threadhint">Say hi 👋 — messages are end-to-end encrypted.</div>`;
    for (const it of items) {
        if (it.snap) body.appendChild(snapCard(it.snap));
        else {
            const e = it.entry;
            if (e.kind === 'text') {
                const sharedGif = gifFromPayload(e.text, e.me, e.at), sharedClip = clipFromPayload(e.text, e.me, e.at);
                body.appendChild(sharedGif ? messageCard(uid, e, gifBubble(sharedGif)) : (sharedClip ? messageCard(uid, e, clipBubble(sharedClip)) : textBubble(uid, e)));
            }
            else if (e.kind === 'story-reply') body.appendChild(messageCard(uid, e, storyReplyBubble(e)));
            else if (e.kind === 'clip') body.appendChild(messageCard(uid, e, clipBubble(e)));
            else if (e.kind === 'gif') body.appendChild(messageCard(uid, e, gifBubble(e)));
            else if (e.kind === 'snap') body.appendChild(el(snapReceipt(e)));
            else if (e.kind === 'media') body.appendChild(messageCard(uid, e, mediaBubble(e, e.me ? 'me' : 'them')));
        }
    }
    // one Delivered/Sent receipt under the most recent message, only if it's one you sent
    const last = items[items.length - 1];
    if (last && !last.snap && last.entry?.me && last.entry.kind === 'text' && last.entry.msgId) {
        body.appendChild(el(textReceipt(deliveredMsgIds.has(last.entry.msgId) || last.entry.status === 'delivered')));
    }
    body.onclick = (event) => { if (!event.target.closest('.messagemenu, .reactiontray, .messagemore')) closeMessageMenus(); };
    body.scrollTop = preserveScroll ? Math.min(scrollTop, body.scrollHeight) : body.scrollHeight;
};
const snapCard = (s) => {
    const kind = snapKind(s), label = kind === 'video' ? 'Video Snap' : 'Photo Snap';
    const action = Number(s.timer) > 0 ? 'Tap to view' : 'Tap to open';
    const card = el(`<button class="snapcard ${kind} them"><span class="sq">${kind === 'video' ? '▶' : '●'}</span><span class="snaplabel">${action} ${label}</span><span class="sqt">${ago(s.created_at)}</span><span class="snapload" hidden><i></i><b>Connecting…</b></span></button>`);
    card.onclick = () => openSnap(s, card);
    return card;
};
const updateLocalEntry = async (uid, localId, update) => {
    await histUpdate(uid, (history) => { const entry = history.find(x => x.localId === localId); if (entry) update(entry, history); });
    if (openUid === uid) renderThreadBody(uid, true);
};
const messageCard = (uid, e, content) => {
    if (e.saved) content.classList.add('saved');
    if (e.reaction) content.appendChild(el(`<span class="localreaction">${esc(e.reaction)}</span>`));
    const card = el(`<div class="messagewrap ${e.me ? 'me' : 'them'}" data-local-id="${esc(e.localId)}"><div class="messagecontent"></div><button class="messagemore" aria-label="Message options" title="Message options">${icon('more', 18)}</button><div class="messagemenu" hidden><button data-action="open-reactions" aria-label="React" title="React">${icon('smilePlus', 20)}</button><button data-action="save" aria-label="${e.saved ? 'Unsave message' : 'Save message'}" title="${e.saved ? 'Unsave' : 'Save'}">${icon('bookmark', 19)}</button><button data-action="reply" aria-label="Reply" title="Reply">${icon('reply', 19)}</button><button data-action="delete" aria-label="Delete from this device" title="Delete from this device">${icon('trash', 19)}</button></div><div class="reactiontray" aria-label="Choose a reaction" hidden><button data-action="reaction" data-reaction="&#128514;" aria-label="React with laughing face">&#128514;</button><button data-action="reaction" data-reaction="&#10084;&#65039;" aria-label="React with heart">&#10084;&#65039;</button><button data-action="reaction" data-reaction="&#128077;" aria-label="React with thumbs up">&#128077;</button><button data-action="reaction" data-reaction="&#128558;" aria-label="React with surprised face">&#128558;</button><button data-action="reaction" data-reaction="&#128546;" aria-label="React with crying face">&#128546;</button><button data-action="reaction" data-reaction="&#128293;" aria-label="React with fire">&#128293;</button></div></div>`);
    card.querySelector('.messagecontent').appendChild(content);
    const menu = card.querySelector('.messagemenu');
    const tray = card.querySelector('.reactiontray');
    card.querySelector('.messagemore').onclick = (event) => { event.stopPropagation(); const opening = menu.hidden; closeMessageMenus(); menu.hidden = !opening; tray.hidden = true; };
    menu.onclick = async (event) => {
        const action = event.target.closest?.('[data-action]')?.dataset.action; if (!action) return;
        event.stopPropagation();
        if (action === 'open-reactions') { menu.hidden = true; tray.hidden = false; return; }
        menu.hidden = true; tray.hidden = true;
        if (action === 'reaction') {
            const reaction = event.target.closest('[data-reaction]').dataset.reaction;
            await updateLocalEntry(uid, e.localId, entry => { entry.reaction = reaction; });
            if (e.msgId) await sendReaction(uid, e.msgId, reaction);
            return;
        }
        if (action === 'reply') { setReplyDraft(e); return; }
        if (action === 'save') await updateLocalEntry(uid, e.localId, entry => { entry.saved = !entry.saved; });
        if (action === 'delete') await updateLocalEntry(uid, e.localId, (entry, history) => { history.splice(history.indexOf(entry), 1); });
    };
    tray.onclick = menu.onclick;
    return card;
};
const chatTime = (at) => new Date(Number(at) || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const textBubble = (uid, e) => {
    const reply = e.replyTo ? `<div class="replyquote">${esc(e.replyTo)}</div>` : '';
    const who = e.me ? 'Me' : openUsername;
    const card = messageCard(uid, e, el(`<article class="b chattext ${e.me ? 'me' : 'them'}"><div class="chatmeta"><span class="chatsender">${esc(who)}</span><time class="chattime">${chatTime(e.at)}</time></div><div class="chatbody">${reply}${esc(e.text)}</div></article>`));
    card.classList.add('textcard');
    return card;
};
const appendBubble = (text, cls) => { const body = $('#tbody'); if (!body) return; const hint = $('.threadhint', body); if (hint) hint.remove(); body.appendChild(el(`<div class="b ${cls}">${esc(text)}</div>`)); body.scrollTop = body.scrollHeight; };
const storyReplyBubble = (e) => {
    const w = Math.max(1, Math.min(4096, Number(e.storyW) || 4)), h = Math.max(1, Math.min(4096, Number(e.storyH) || 3));
    const preview = e.preview ? `<div class="storyreplypreview" style="aspect-ratio:${w} / ${h}"><img src="${safeMediaUrl(e.preview)}" alt="Story preview"></div>` : '';
    return el(`<div class="b ${e.me ? 'me' : 'them'} storyreplymsg"><div class="storyreplylabel">↩ Reply to Story</div>${preview}<div class="storyreplytext">${esc(e.text || 'Story reply')}</div></div>`);
};
const clipBubble = (e) => { const name = decodeTitle(e.name); return el(`<div class="b ${e.me ? 'me' : 'them'} clipbubble"><div class="storyreplylabel">YouTube Clip</div><iframe class="clipembed" title="${esc(name)}" src="https://www.youtube-nocookie.com/embed/${e.videoId}?autoplay=0&rel=0&playsinline=1" allow="autoplay; fullscreen; picture-in-picture"></iframe><div class="storyreplytext">${esc(name)}</div>${e.caption ? `<div class="clipcaption">${esc(e.caption)}</div>` : ''}</div>`); };
const gifBubble = (e) => el(`<div class="b ${e.me ? 'me' : 'them'} gifbubble ${e.type}"><img src="${esc(e.url)}" alt="${esc(e.title || e.type)}" loading="lazy" referrerpolicy="no-referrer"><span>${e.type === 'sticker' ? 'Sticker · GIPHY' : 'GIF · GIPHY'}</span></div>`);
const appendEntry = () => { if (openUid) renderThreadBody(openUid); };

// ---- send an async encrypted text ----
export const sendText = async (uid, username, text, localEntry = null, options = {}) => {
    const keepLocalHistory = options.keepLocalHistory !== false;
    const countTowardStreak = options.countTowardStreak !== false;
    text = text.slice(0, MSG_MAX);   // hard size cap (backstop to the input maxlength)
    const msgId = localEntry?.msgId || entryId();   // so the row's realtime DELETE = "delivered" receipt
    const entry = localEntry || { me: true, kind: 'text', text, at: Date.now(), msgId, status: 'sent', localId: entryId() };
    // Special entries (GIFs, Clips, Story replies) also need this ID so either person
    // can react to the same item after it arrives.
    entry.msgId ||= msgId;
    if (keepLocalHistory) {
        await histPush(uid, entry);
        if (openUid === uid) appendEntry(entry);
        if (convBox) renderConvs(convBox, uid);
    }
    const devices = await deviceKeysOf(uid);
    if (!devices.length) {
        // Retry the legacy key directly rather than treating an unavailable device
        // registry as a new-account setup failure. This keeps every existing friend
        // reachable during the multi-device rollout.
        try {
            const { data: profile } = await db.profileById(uid);
            const legacyKey = profile?.pubkey ? JSON.parse(profile.pubkey) : null;
            if (legacyKey) {
                const enc = await encryptText(legacyKey, text);
                const { error } = await db.sendMessage({ id: msgId, sender_id: state.me.id, recipient_id: uid, iv: enc.iv, eph_pub: enc.eph_pub, body: enc.body });
                if (!error) { if (countTowardStreak) db.bumpStreak(uid).then(() => {}, () => {}); return true; }
                console.error('[mayfly] legacy message retry', error);
            }
        } catch (e) { console.error('[mayfly] legacy message retry', e); }
        if (openUid === uid) appendBubble('(can’t encrypt — they haven’t opened Mayfly yet)', 'sys'); else toast('They have not finished setting up Mayfly.');
        return false;
    }
    let error = null;
    try {
        const rows = await Promise.all(devices.map(async (device) => {
            const enc = await encryptText(device.pubkey, text);
            return { id: entryId(), message_id: msgId, sender_id: state.me.id, recipient_id: uid, recipient_device_id: device.id, iv: enc.iv, eph_pub: enc.eph_pub, body: enc.body };
        }));
        ({ error } = await db.sendMessages(rows));
    } catch (e) {
        console.error('[mayfly] multi-device message send', e);
        error = e;
    }
    // Never let a device-fan-out problem strand normal chat. Older Mayfly clients
    // understand this account-key envelope, and it gives the sender a working
    // delivery path while a recipient's device registry is being refreshed.
    if (error) {
        try {
            const { data: profile } = await db.profileById(uid);
            const legacyKey = profile?.pubkey ? JSON.parse(profile.pubkey) : null;
            if (legacyKey) {
                const enc = await encryptText(legacyKey, text);
                ({ error } = await db.sendMessage({ id: msgId, sender_id: state.me.id, recipient_id: uid, iv: enc.iv, eph_pub: enc.eph_pub, body: enc.body }));
            }
        } catch (e) { console.error('[mayfly] legacy message fallback', e); }
    }
    if (error) { if (openUid === uid) appendBubble('(failed to send)', 'sys'); else toast('Could not send that reply.'); return false; }
    if (countTowardStreak) db.bumpStreak(uid).then(() => {}, () => {});
    return true;
};
const sendReaction = (uid, targetId, reaction) => sendText(
    uid,
    'your friend',
    JSON.stringify({ t: 'chat-reaction', targetId, reaction }),
    null,
    { keepLocalHistory: false, countTowardStreak: false },
);
export const sendStoryReply = async (uid, username, text, story) => {
    const storyW = Number(story.w) || 0, storyH = Number(story.h) || 0;
    const payload = JSON.stringify({ t: 'story-reply', storyId: story.id, text, w: storyW, h: storyH });
    return sendText(uid, username, payload, { me: true, kind: 'story-reply', text, storyId: story.id, preview: story.preview, storyW, storyH, at: Date.now() });
};
export const sendClipShare = (uid, username, clip) => sendText(uid, username, JSON.stringify({ t: 'clip-share', provider: 'youtube', name: clip.name, videoId: clip.videoId, caption: String(clip.caption || '').slice(0, 240) }), { me: true, kind: 'clip', name: clip.name, videoId: clip.videoId, caption: String(clip.caption || '').slice(0, 240), at: Date.now() });
const sendGifShare = (uid, username, gif) => sendText(uid, username, JSON.stringify({ t: 'gif-share', provider: 'giphy', type: gif.type, url: gif.url, title: gif.title }), { me: true, kind: 'gif', type: gif.type, url: gif.url, title: gif.title, at: Date.now() });

const openGifPicker = (uid, username) => {
    document.querySelector('.gifpicker')?.remove();
    let type = 'gif', timer = null;
    const sheet = el(`<div class="gifpicker"><div class="gifpickercard"><div class="gifpickerhead"><b>GIFs & Stickers</b><button class="gifclose" aria-label="Close">×</button></div><div class="giftypes"><button class="on" data-type="gif">GIFs</button><button data-type="sticker">Stickers</button></div><input class="recipsearch" id="gifsearch" type="search" placeholder="Search GIFs" autocomplete="off"><div class="gifresults"><div class="spin">Loading…</div></div><div class="gifcredit">Powered by GIPHY</div></div></div>`);
    document.body.appendChild(sheet);
    const close = () => sheet.remove(), input = sheet.querySelector('#gifsearch'), results = sheet.querySelector('.gifresults');
    sheet.querySelector('.gifclose').onclick = close; sheet.onclick = event => { if (event.target === sheet) close(); };
    const load = async () => {
        results.innerHTML = '<div class="spin">Loading…</div>';
        const { data, error } = await sb.functions.invoke('giphy', { body: { query: input.value.trim(), type: type === 'sticker' ? 'stickers' : 'gifs' } });
        if (error || data?.error || !data?.items?.length) { results.innerHTML = '<div class="empty">No GIFs found. Try another search.</div>'; return; }
        results.innerHTML = '';
        data.items.forEach(gif => { const button = el(`<button class="gifresult" title="${esc(gif.title)}"><img src="${esc(gif.preview)}" alt="${esc(gif.title)}" loading="lazy"></button>`); button.onclick = async () => { button.disabled = true; await sendGifShare(uid, username, gif); close(); }; results.appendChild(button); });
    };
    sheet.querySelector('.giftypes').onclick = event => { const next = event.target.dataset.type; if (!next) return; type = next; sheet.querySelectorAll('.giftypes button').forEach(button => button.classList.toggle('on', button.dataset.type === type)); input.placeholder = type === 'sticker' ? 'Search stickers' : 'Search GIFs'; load(); };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
    load();
};

// ===================== snap opening =====================
const relayDownload = async (path, onProgress) => {
    // A signed URL lets Fetch expose the response stream, unlike storage.download(),
    // so large encrypted videos can report bytes as they arrive.
    const { data, error } = await sb.storage.from(SNAP_BUCKET).createSignedUrl(path, 120);
    if (error || !data?.signedUrl) throw error || new Error('Could not create download URL');
    const response = await fetch(data.signedUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const total = Math.max(0, Number(response.headers.get('content-length')) || 0);
    if (!response.body?.getReader) {
        const blob = await response.blob();
        onProgress(blob.size, total || blob.size);
        return blob;
    }
    const reader = response.body.getReader(), chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); received += value.byteLength;
        onProgress(received, total);
    }
    return new Blob(chunks, { type: 'application/octet-stream' });
};
export const receiveRelayTransfer = async (row) => {
    if (!row || row.recipient_id !== state.me.id) return;
    if (row.recipient_device_id && row.recipient_device_id !== state.deviceId) return;
    try {
        const { data: relay } = await db.relayPayload(row.relay_id);
        if (!relay) return;
        const blob = await relayDownload(row.relay_id);
        const plain = await decryptSharedRelay(state.priv, row.eph_pub, row.iv, row.wrapped_key, relay.content_iv, await blob.arrayBuffer());
        const media = new Blob([plain], { type: row.mime || relay.mime || 'application/octet-stream' });
        const data = await blobToDataURL(media);
        const m = { kind: 'media', me: false, name: row.name, mime: row.mime, mediaKind: row.media_kind, data, at: new Date(row.created_at).getTime(), relay: true };
        await histPush(row.sender_id, m);
        const { data: completed, error: completeError } = await db.completeTransfer(row.id);
        if (completeError || !completed) throw completeError || new Error('transfer completion was not accepted');
        if (openUid === row.sender_id) renderThreadBody(row.sender_id); else { unreadMsg.add(row.sender_id); onChange(); }
        if (convBox) renderConvs(convBox, openUid);
    } catch (e) { console.error('[mayfly] relay transfer receive failed', e); }
};
const formatSnapProgress = ({ phase = 'Loading', received = 0, total = 0 }) => {
    if (total > 0) return `${Math.min(100, Math.round(received / total * 100))}%`;
    if (received > 0) return `${(received / 1024 / 1024).toFixed(received >= 1024 * 1024 ? 1 : 2)} MB`;
    return `${phase}…`;
};
const openSnap = async (s, card) => {
    const report = (progress) => {
        if (!card) return;
        const load = $('.snapload', card), fill = $('.snapload i', card), text = $('.snapload b', card);
        if (load) load.hidden = false;
        if (text) text.textContent = formatSnapProgress(progress);
        if (fill) fill.style.setProperty('--snap-progress', progress.total > 0 ? Math.min(1, progress.received / progress.total) : 0);
    };
    const resetProgress = () => {
        card?.classList.remove('opening');
        const load = card && $('.snapload', card); if (load) load.hidden = true;
        if (card) card.disabled = false;
    };
    if (card) { card.disabled = true; card.classList.add('opening'); report({ phase: 'Loading' }); }
    let full = null;
    try {
        if (s.delivery?.startsWith('live')) full = await fetchSnap(s.id, s.sender_id, s.sender_device_id, report);
        else if (s.relay_id) {
            const { data: relay } = await db.relayPayload(s.relay_id);
            if (relay) {
                const blob = await relayDownload(s.relay_id, (received, total) => report({ phase: 'Downloading', received, total }));
                report({ phase: 'Decrypting' });
                const pt = await decryptSharedRelay(state.priv, s.eph_pub, s.iv, s.wrapped_key, relay.content_iv, await blob.arrayBuffer());
                full = URL.createObjectURL(new Blob([pt], { type: relay.mime || snapMime(s) }));
            }
        } else {
            const blob = await relayDownload(s.id, (received, total) => report({ phase: 'Downloading', received, total }));
            report({ phase: 'Decrypting' });
            const pt = await decryptWith(state.priv, s.eph_pub, s.iv, await blob.arrayBuffer());
            full = URL.createObjectURL(new Blob([pt], { type: snapMime(s) }));
        }
    } catch (e) { console.error('[mayfly] open snap', e); }
    // Failing to fetch is not the same as being consumed, so the Snap stays put
    // and the card goes back to being tappable. Burning here destroyed Snaps that
    // were only briefly unreachable -- a live one whose sender had closed the tab
    // is readable the moment they reopen it, and a relay one can fail on nothing
    // worse than a dropped request. Either way the recipient got no second try,
    // and the Snap was gone for good well before its 24h expiry. Expiry is swept
    // separately; this path should leave the row alone.
    if (!full) {
        toast(s.delivery?.startsWith('live')
            ? 'Sender is offline — try again when they are back.'
            : 'Could not load this Snap — try again.');
        resetProgress();
        return;
    }
    if (s.logical_id) {
        const { data: claimed, error } = await db.claimSnap(s.id);
        if (error || !claimed) {
            if (full.startsWith('blob:')) URL.revokeObjectURL(full);
            toast('This Snap was opened on another device.');
            resetProgress();
            return;
        }
    }
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
            resetProgress();
        }
        return;
    }
    const u = s.sender || {};
    const media = video ? `<video src="${safeMediaUrl(full)}" autoplay muted controls playsinline></video>` : `<img src="${safeMediaUrl(full)}" alt="snap">`;
    const ov = el(`<div class="player">${media}${s.caption ? `<div class="pcap">${esc(s.caption)}</div>` : ''}<div class="pname">${esc(u.username || '')}</div><div class="pbar"><i></i></div></div>`);
    document.body.appendChild(ov);
    let done = false, viewing = false, t = null, loadTimer = null;
    const release = () => { if (full.startsWith('blob:')) URL.revokeObjectURL(full); };
    const fail = () => {
        if (done) return;
        done = true;
        clearTimeout(t); clearTimeout(loadTimer);
        ov.remove(); release();
        toast('This Snap could not start — try again.');
        resetProgress();
    };
    const finish = async () => {
        if (done || !viewing) return;
        done = true;
        clearTimeout(t); clearTimeout(loadTimer);
        ov.remove(); release();
        await burnSnap(s, card);
    };
    const startViewing = () => {
        if (done || viewing) return;
        viewing = true;
        clearTimeout(loadTimer);
        requestAnimationFrame(() => { const bar = $('.pbar i', ov); if (bar) { bar.style.transitionDuration = s.timer + 's'; bar.classList.add('run'); } });
        t = setTimeout(finish, s.timer * 1000);
        if (!video) return;
        const v = $('video', ov);
        v.play().then(() => {
            v.muted = false;
            return v.play();
        }).catch(() => {
            // Preserve automatic visual playback if the browser blocks autoplay sound.
            v.muted = true;
            v.play().catch(() => {});
        });
    };
    // Do not burn a timed Snap while its media is still loading. This matters most
    // for video: a slow decode or a transient P2P hiccup should leave it available
    // to retry rather than consume it unseen.
    loadTimer = setTimeout(fail, 30000);
    if (video) {
        const v = $('video', ov);
        v.preload = 'auto';
        v.onended = finish;
        v.onloadeddata = startViewing;
        v.onerror = fail;
        v.onclick = (e) => e.stopPropagation();
        if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) startViewing();
    } else {
        const im = $('img', ov);
        im.onload = startViewing;
        im.onerror = fail;
        if (im.complete && im.naturalWidth) startViewing();
    }
    ov.onclick = () => { if (viewing) finish(); };
};
// Only ever called once a Snap has actually been seen, so it always marks it
// opened. The old wasOpened=false caller burned Snaps that failed to load.
const burnSnap = async (s, card) => {
    await db.markSnapOpened(s.id);
    // The last recipient/device to claim a shared relay may remove its encrypted
    // payload. Policies keep fan-out media intact while anyone still has it unopened.
    if (s.relay_id) {
        const removed = await sb.storage.from(SNAP_BUCKET).remove([s.relay_id]);
        if (!removed.error) await db.delRelayPayloads([s.relay_id]);
    }
    await db.delSnap(s.id);
    // Legacy single-recipient relay objects predate shared relay payload rows.
    if (s.delivery?.startsWith('relay') && !s.relay_id) sb.storage.from(SNAP_BUCKET).remove([s.id]);
    inboxByUser[s.sender_id] = (inboxByUser[s.sender_id] || []).filter(x => x.id !== s.id);
    card?.remove();
    if (convBox) renderConvs(convBox, openUid);
    onChange();
};

// ===================== live P2P: media, voice, typing =====================
const TRANSFER_RELAY_LIMIT = 10;
const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
const drainConn = async (conn) => { const dc = conn?.dataChannel; if (!dc) return; let g = 0; while (dc.bufferedAmount > 4 * 1024 * 1024 && g++ < 3000) await new Promise(r => setTimeout(r, 30)); };
const sendBytes = async (conn, buf, offset = 0) => { const dc = conn?.dataChannel; if (!dc) throw new Error('connection unavailable'); for (let o = offset, i = 0; o < buf.byteLength; o += 16384, i++) { if (!conn.open || dc.readyState !== 'open') throw new Error('connection closed'); dc.send(buf.slice(o, o + 16384)); if (i % 32 === 0) await drainConn(conn); } };
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
// A chat bubble is inserted before an image/video knows its final dimensions.
// Scroll again after metadata arrives, otherwise tall mobile media expands below
// the visible end of the thread and makes the recipient scroll manually.
const pinThreadAfterMediaLoads = (media) => {
    if (!media) return;
    const pin = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        const body = media.closest('.tbody');
        if (body) body.scrollTop = body.scrollHeight;
    }));
    media.addEventListener('load', pin, { once: true });
    media.addEventListener('loadedmetadata', pin, { once: true });
    media.addEventListener('canplay', pin, { once: true });
    if (media instanceof HTMLImageElement && media.complete) pin();
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
        pinThreadAfterMediaLoads(media);
    }
    return bubble;
};
const relayFile = async (uid, file, kind, meta, dataUrl) => {
    const [{ count }, { data: devices }] = await Promise.all([db.pendingTransfersTo(uid), db.devicesForUser(uid)]);
    if ((count || 0) >= TRANSFER_RELAY_LIMIT) return appendBubble(`(relay queue full — ${TRANSFER_RELAY_LIMIT} pending items for this person)`, 'sys');
    const recipients = (devices || []).map(device => { try { return { ...device, key: JSON.parse(device.pubkey) }; } catch (e) { return null; } }).filter(Boolean);
    if (!recipients.length) return appendBubble('(recipient has no encryption key yet)', 'sys');
    const relayId = crypto.randomUUID(), logicalId = crypto.randomUUID(), expires_at = new Date(Date.now() + TRANSFER_TTL_MS).toISOString();
    try {
        const { ciphertext, content_iv, rawKey } = await encryptSharedRelay(await file.arrayBuffer());
        const { error: payloadError } = await db.addRelayPayload({ id: relayId, sender_id: state.me.id, content_iv, mime: file.type || 'application/octet-stream', expires_at });
        if (payloadError) throw payloadError;
        const upload = await sb.storage.from(SNAP_BUCKET).upload(relayId, new Blob([ciphertext]), { contentType: 'application/octet-stream' });
        if (upload.error) throw upload.error;
        const rows = await Promise.all(recipients.map(async device => {
            const wrapped = await wrapSharedRelayKey(device.key, rawKey);
            return { id: crypto.randomUUID(), logical_id: logicalId, relay_id: relayId, sender_id: state.me.id, recipient_id: uid, recipient_device_id: device.id, name: meta.name, mime: meta.mime, media_kind: kind, bytes: file.size, wrapped_key: wrapped.wrapped_key, iv: wrapped.iv, eph_pub: wrapped.eph_pub, expires_at };
        }));
        const { error } = await db.addTransferDelivery(rows);
        if (error) throw error;
        await histPush(uid, { kind: 'media', me: true, ...meta, data: dataUrl, at: Date.now(), relay: true });
        if (openUid === uid) renderThreadBody(uid);
        if (convBox) renderConvs(convBox, openUid);
    } catch (e) {
        console.error('[mayfly] transfer relay failed', e);
        try { await sb.storage.from(SNAP_BUCKET).remove([relayId]); } catch (cleanupError) {}
        try { await db.delRelayPayloads([relayId]); } catch (cleanupError) {}
        appendBubble('(relay send failed)', 'sys');
    }
};
const sendFile = async (uid, file, kind) => {
    let dataUrl; try { dataUrl = await blobToDataURL(file); } catch (e) { return appendBubble('(could not read file)', 'sys'); }
    const id = rand(), meta = { name: file.name || kind, mime: file.type, mediaKind: kind };
    const buf = await file.arrayBuffer();
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        let c = conns.get(uid); if (!(c && c.open)) { ensureConn(uid); await new Promise(r => setTimeout(r, 700)); c = conns.get(uid); }
        if (!(c && c.open)) break;
        try { sent = await sendP2PTransfer(c, id, buf, meta); } catch (e) { sent = false; }
    }
    if (!sent) return relayFile(uid, file, kind, meta, dataUrl);
    const m = { kind: 'media', me: true, ...meta, data: dataUrl, at: Date.now() };
    await histPush(uid, m);
    if (openUid === uid) renderThreadBody(uid);
    if (convBox) renderConvs(convBox, openUid);
};
const wireMic = (box, uid) => {
    let rec = null, stream = null, chunks = [], cancelled = false, draft = null, draftUrl = null, starting = false;
    const mic = $('.mic', box), tray = $('.voicepreview', box);
    const setRecording = (on) => {
        mic.classList.toggle('recording', on); mic.innerHTML = icon(on ? 'stop' : 'mic');
        mic.setAttribute('aria-label', on ? 'Stop recording voice note' : 'Record a voice note');
        mic.title = on ? 'Stop recording' : 'Record a voice note';
    };
    const reset = () => {
        setRecording(false); tray.hidden = true;
        if (draftUrl) URL.revokeObjectURL(draftUrl);
        draft = null; draftUrl = null; tray.innerHTML = '';
    };
    const stop = () => { if (rec?.state === 'recording') rec.stop(); };
    const start = async () => {
        if (rec?.state === 'recording' || draft || starting) return;
        starting = true; mic.disabled = true;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { return appendBubble('(microphone blocked)', 'sys'); }
        finally { starting = false; mic.disabled = false; }
        chunks = []; cancelled = false;
        try { rec = new MediaRecorder(stream); }
        catch (e) { stream.getTracks().forEach(t => t.stop()); return appendBubble('(voice recording is unavailable)', 'sys'); }
        rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        rec.onstop = () => {
            stream.getTracks().forEach(t => t.stop()); setRecording(false);
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); rec = null;
            if (cancelled || !blob.size) return reset();
            draft = new File([blob], 'voice-note', { type: blob.type }); draftUrl = URL.createObjectURL(draft);
            tray.hidden = false;
            tray.innerHTML = `<audio src="${safeMediaUrl(draftUrl)}" controls></audio><button type="button" class="vxc" aria-label="Discard voice clip">✕</button><button type="button" class="vsend">Send</button>`;
            $('.vxc', tray).onclick = reset;
            $('.vsend', tray).onclick = async () => { const clip = draft; reset(); await sendFile(uid, clip, 'audio'); };
        };
        rec.start(); setRecording(true);
    };
    mic.onclick = () => rec?.state === 'recording' ? stop() : start();
};

// P2P data connection for typing + media (text no longer needs it — it's async).
const incomingTransfers = new Map(), outgoingSignals = new Map();
const sendP2PTransfer = (conn, id, buf, meta) => new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timeout); if (outgoingSignals.get(id) === handler) outgoingSignals.delete(id); resolve(ok); };
    const timeout = setTimeout(() => finish(false), 30000);
    const handler = async (d) => {
        if (d.t === 'file-resume') { try { await sendBytes(conn, buf, Math.max(0, Number(d.offset) || 0)); conn.send({ t: 'file-done', id }); } catch (e) { finish(false); } }
        if (d.t === 'file-ack') finish(true);
    };
    outgoingSignals.set(id, handler);
    conn.on('close', () => finish(false));
    conn.send({ t: 'file-meta', id, bytes: buf.byteLength, ...meta });
});
const wire = (uid, conn) => {
    conns.set(uid, conn);
    const rx = {}; let binRx = null;
    conn.on('open', () => { try { conn.send({ t: 'cap' }); } catch (e) {} if (uid === callPeerId) flushCallApps(uid); });
    conn.on('data', (d) => {
        if (!d) return;
        if (d.t === 'call-app') { if (!callPeerId || uid === callPeerId) receiveCallApp(d.payload); return; }
        if (d.t === 'typing') { const el2 = $('#ctyping'); if (el2 && openUid === uid) el2.textContent = 'typing…'; return; }
        if (d.t === 'stop') { const el2 = $('#ctyping'); if (el2) el2.textContent = ''; return; }
        if (d.t === 'file-resume' || d.t === 'file-ack') { outgoingSignals.get(d.id)?.(d); return; }
        if (d.t === 'file-meta') { const key = `${uid}:${d.id}`; binRx = incomingTransfers.get(key) || { meta: d, chunks: [], bytes: 0 }; incomingTransfers.set(key, binRx); conn.send({ t: 'file-resume', id: d.id, offset: binRx.bytes }); return; }
        if (d.t === 'file-done' && binRx) { const it = binRx; if (it.bytes < Number(it.meta.bytes || 0)) { conn.send({ t: 'file-resume', id: d.id, offset: it.bytes }); return; } binRx = null; incomingTransfers.delete(`${uid}:${d.id}`); blobToDataURL(new Blob(it.chunks, { type: it.meta.mime || '' })).then(async data => { const m = { kind: 'media', me: false, name: it.meta.name, mime: it.meta.mime, mediaKind: it.meta.mediaKind, data, at: Date.now() }; await histPush(uid, m); conn.send({ t: 'file-ack', id: d.id }); if (openUid === uid) renderThreadBody(uid); else { unreadMsg.add(uid); onChange(); } if (convBox) renderConvs(convBox, openUid); }); return; }
    });
    conn.on('chunk', (ab) => { if (binRx) { binRx.chunks.push(ab); binRx.bytes += ab.byteLength || 0; } });
    conn.on('close', () => { if (conns.get(uid) === conn) conns.delete(uid); });
    conn.on('error', () => {});
};
const ensureConn = (uid) => { const c = conns.get(uid); if (c && c.open) return; if (!isOnline(uid)) return; wire(uid, peer.connect(uid, { metadata: { kind: 'dm', user_id: state.me.id, username: state.profile.username } })); };
export const onIncomingDM = (conn) => { const uid = conn.metadata?.user_id || conn.peer; if (uid) wire(uid, conn); };
export const reconnectOpenChat = () => { if (openUid) ensureConn(openUid); };
export const detachAll = () => { openUid = null; threadBox = null; };
export const bootChat = async () => { await refreshInbox(); await syncMessages(); const { data } = await db.incomingTransfers(); for (const row of (data || [])) await receiveRelayTransfer(row); };

// ===================== 1:1 calling (video or voice) =====================
const callAudio = { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true }, channelCount: 1 };
const getMedia = (video, facing = 'user') => navigator.mediaDevices.getUserMedia({
    video: video ? { facingMode: { ideal: facing } } : false,
    // Without these constraints a speakerphone's remote audio can be picked up by
    // the mic and sent back as an echo, especially on mobile voice calls.
    audio: callAudio,
});
let localStream = null, remoteStream = null, curCall = null, callPeerName = '', cameraFacing = 'user', localIsMain = false, callStatusTimer = null, curRingId = null, callPeerId = null, callAmCaller = false;
const callAppOutbox = [];
const flushCallApps = (uid) => {
    const conn = conns.get(uid);
    if (!conn?.open) return;
    while (callAppOutbox.length) { try { conn.send({ t: 'call-app', payload: callAppOutbox.shift() }); } catch (e) { break; } }
};
const sendCallApp = (payload) => {
    if (!callPeerId) return;
    const conn = conns.get(callPeerId);
    if (conn?.open) { try { conn.send({ t: 'call-app', payload }); return; } catch (e) {} }
    callAppOutbox.push(payload);
    ensureConn(callPeerId);
};
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
    // This also releases the portrait lock retained by an older installed Mayfly
    // manifest. Browsers that do not implement the API simply keep normal system
    // auto-rotation behaviour.
    try { screen.orientation?.unlock?.(); } catch (e) {}
    try { screen.unlockOrientation?.(); } catch (e) {}
    $('#callo').classList.toggle('voice', !video);
    $('#ccam').style.display = '';
    $('#cflip').style.display = video ? '' : 'none';
    setCtl($('#ccam'), video, 'video', 'videoOff');
    localIsMain = false;
    renderCallViews();
    mountCallApps($('#callapps'), { send: sendCallApp, amCaller: callAmCaller });
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
    clearTimeout(callStatusTimer); callStatusTimer = null;
    if (curRingId) { db.delRing(curRingId).then(() => {}, () => {}); curRingId = null; }
    try { curCall?.close(); } catch (e) {} curCall = null;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const rv = $('#rv'), lv = $('#lv'); if (rv) rv.srcObject = null; if (lv) lv.srcObject = null;
    remoteStream = null; localIsMain = false; cameraFacing = 'user';
    unmountCallApps(); callPeerId = null; callAppOutbox.length = 0;
    setCtl($('#cmute'), true, 'mic', 'micOff'); setCtl($('#ccam'), true, 'video', 'videoOff'); setCtl($('#cflip'), true, 'flipCamera', 'flipCamera');
    $('#callo').classList.remove('on', 'voice');
};
const wireCallMedia = (c) => {
    curCall = c;
    clearTimeout(callStatusTimer);
    callStatusTimer = setTimeout(() => {
        if (curCall === c && !remoteStream) setStat('Still connecting — check your network or try again.');
    }, 12000);
    c.on('stream', (s) => {
        const remote = $('#rv'); if (!remote || !s) return;
        remoteStream = s;
        // A peer may upgrade an audio call to video later. Reveal the stage as
        // soon as its new track arrives, even if this device stays audio-only.
        if (s.getVideoTracks().length) $('#callo').classList.remove('voice');
        // `autoplay` is present in the markup, but explicitly playing here covers
        // browsers that do not restart a video after its srcObject changes.
        renderCallViews();
        clearTimeout(callStatusTimer); callStatusTimer = null;
        setStat(callPeerName);
    });
    c.on('state', ({ connection, ice }) => {
        if (connection === 'connected' || ice === 'connected' || ice === 'completed') {
            clearTimeout(callStatusTimer); callStatusTimer = null;
            return;
        }
        if (connection === 'disconnected' || ice === 'disconnected') setStat('Reconnecting…');
        if (connection === 'failed' || ice === 'failed') setStat('Reconnecting…');
    });
    c.on('close', endCall); c.on('error', endCall);
};
export const callUser = async (uid, username, video = true) => {
    if (!isOnline(uid)) return toast(username + ' is offline.');
    if (curCall) return toast('Already in a call.');
    cameraFacing = 'user';
    try { localStream = await getMedia(video, cameraFacing); } catch (e) { return toast('Camera/mic blocked'); }
    callPeerId = uid; callAmCaller = true; ensureConn(uid);
    callPeerName = username;
    openCallStage(video); $('#callo').classList.add('on'); setStat((video ? 'Calling ' : 'Ringing ') + username + '…');
    // transient ring row → push webhook wakes their backgrounded app (deleted in endCall)
    db.ringCall(uid, video ? 'video' : 'audio').then(({ data }) => { curRingId = data?.id || null; }, () => {});
    wireCallMedia(peer.call(uid, localStream, { metadata: { username: state.profile.username, video } }));
};
export const onIncomingCall = (incoming) => {
    if (curCall) return incoming.close();
    const username = incoming.metadata?.username || 'Someone';
    const video = incoming.metadata?.video !== false;
    callPeerName = username;
    const banner = $('#incall');
    banner.innerHTML = `<div class="incomingcard">
      <div class="avatar ib">${initial(username)}</div>
      <div class="incomingwho"><b>${esc(username)}</b><div>Incoming ${video ? 'video' : 'voice'} call</div></div>
      <div class="incomingactions"><button class="pill primary" id="acc">Accept</button><button class="pill" id="dec">Decline</button></div>
    </div>`;
    banner.classList.add('on');
    const clear = () => banner.classList.remove('on');
    $('#dec', banner).onclick = () => { clear(); unmountCallApps(); try { incoming.close(); } catch (e) {} };
    $('#acc', banner).onclick = async () => {
        clear();
        const { data: claimed, error: claimError } = await db.claimCall(incoming.id);
        if (claimError || !claimed) {
            toast('This call was answered on another device.');
            try { incoming.close(); } catch (e) {}
            return;
        }
        cameraFacing = 'user';
        try { localStream = await getMedia(video, cameraFacing); }
        catch (e) { toast('Camera/mic blocked'); try { incoming.close(); } catch (e2) {} return; }
        callPeerId = incoming.peer; callAmCaller = false;
        openCallStage(video); $('#callo').classList.add('on'); setStat('Connecting…');
        wireCallMedia(incoming);
        try { await incoming.answer(localStream); }
        catch (e) { console.error('[mayfly] answer call', e); endCall(); toast('Could not connect the call.'); }
    };
};
$('#chang').onclick = endCall;
$('#cmute').onclick = () => { const a = localStream?.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; setCtl($('#cmute'), a.enabled, 'mic', 'micOff'); } };
$('#ccam').onclick = async () => {
    let v = localStream?.getVideoTracks()[0];
    if (v) {
        v.enabled = !v.enabled;
        setCtl($('#ccam'), v.enabled, 'video', 'videoOff');
        return;
    }
    if (!curCall?.addVideoTrack || !localStream) return toast('Camera is unavailable for this call.');
    let camera;
    try { camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: cameraFacing } }, audio: false }); }
    catch (e) { return toast('Camera blocked or unavailable.'); }
    v = camera.getVideoTracks()[0];
    try {
        localStream.addTrack(v);
        if (!await curCall.addVideoTrack(v, localStream)) throw new Error('Could not add camera');
        $('#callo').classList.remove('voice');
        $('#cflip').style.display = '';
        setCtl($('#ccam'), true, 'video', 'videoOff');
        renderCallViews();
    } catch (e) {
        localStream.removeTrack(v); v.stop();
        toast('Could not turn on video during this call.');
    }
};
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
$('#capps').onclick = toggleCallApps;
$('#lv').onclick = swapCallViews;
$('#lv').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); swapCallViews(); } };
setCtl($('#cmute'), true, 'mic', 'micOff'); setCtl($('#ccam'), true, 'video', 'videoOff'); setCtl($('#cflip'), true, 'flipCamera', 'flipCamera'); if ($('#capps')) $('#capps').innerHTML = icon('gamepad'); if ($('#chang')) $('#chang').innerHTML = icon('phoneOff');
