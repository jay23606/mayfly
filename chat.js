import { app, $, el, esc, toast, state, idb, isOnline, initial, avatarHTML } from './core.js';
import { peer } from './rtc.js';
import { db } from './db.js';

// ===================== ephemeral P2P chat =====================
// Messages fly directly browser-to-browser (WebRTC) and are NEVER stored on a server.
// A device keeps its own local history in IndexedDB (chat:<uid>) so conversations
// survive a refresh — capped at the last 200 lines per friend. Live-only: both people
// must be online, matching the ephemeral spirit of the rest of mayfly.
const chats = new Map();          // uid -> { conn, username, logEl|null }
const unread = new Set();         // uids with unseen messages (drives the tab dot)
export const chatUnread = () => unread.size;
const onChange = () => window.dispatchEvent(new Event('chat-unread'));

const hist = (uid) => idb.get('chat:' + uid).then(h => h || []);
const save = async (uid, entry) => {
    const h = await hist(uid);
    h.push(entry); if (h.length > 200) h.splice(0, h.length - 200);
    await idb.set('chat:' + uid, h).catch(() => {});
};

const bubble = (logEl, text, cls) => {
    if (!logEl) return;
    logEl.appendChild(el(`<div class="b ${cls}">${esc(text)}</div>`));
    logEl.scrollTop = logEl.scrollHeight;
};

const wire = (uid, username, conn) => {
    const c = chats.get(uid) || { username };
    c.conn = conn; c.username = username; chats.set(uid, c);
    conn.on('open', () => setDot(uid, true));
    conn.on('data', (d) => {
        if (!d) return;
        if (d.t === 'typing') return setTyping(uid, username + ' is typing…');
        if (d.t === 'stop')   return setTyping(uid, '');
        if (d.t === 'msg') {
            setTyping(uid, '');
            save(uid, { me: false, text: d.text });
            if (c.logEl) bubble(c.logEl, d.text, 'them');
            else { unread.add(uid); onChange(); if (window.Notification?.permission === 'granted') new Notification('mayfly 🐛 ' + username, { body: d.text }); }
        }
    });
    conn.on('close', () => { setDot(uid, false); if (c.logEl) bubble(c.logEl, '(disconnected)', 'sys'); c.conn = null; });
    conn.on('error', () => {});
};
const setDot = (uid, on) => { const c = chats.get(uid); const dot = c?.logEl && $('.cdot', c.logEl.closest('.chatview')); if (dot) dot.style.opacity = on ? '1' : '.25'; };
const setTyping = (uid, t) => { const c = chats.get(uid); const el2 = c?.logEl && $('.ctyping', c.logEl.closest('.chatview')); if (el2) el2.textContent = t; };

// Connect (or reuse an open connection) to a friend.
const ensureConn = (uid, username) => {
    const c = chats.get(uid);
    if (c?.conn && c.conn.open) return;
    if (!isOnline(uid)) return;
    wire(uid, username, peer.connect(uid, { metadata: { kind: 'dm', user_id: state.me.id, username: state.profile.username } }));
};

// Full-screen conversation view (rendered into #app by the router).
export const openChat = async (uid) => {
    let username = chats.get(uid)?.username;
    if (!username) { const { data } = await db.profileById(uid); username = data?.username || 'friend'; }
    unread.delete(uid); onChange();
    app.innerHTML = `<main class="chatview">
        <div class="chathead">
          <button class="icon back" data-go="#/chat" aria-label="Back">‹</button>
          ${avatarHTML(username, null)}
          <div class="who"><b>${esc(username)}</b><div class="sub"><i class="cdot" style="opacity:${isOnline(uid) ? '1' : '.25'}"></i> ${isOnline(uid) ? 'online' : 'offline — live chat needs them online'}</div></div>
        </div>
        <div class="chatlog"></div>
        <div class="ctyping"></div>
        <form class="chatin"><input placeholder="Message…" autocomplete="off" aria-label="Message"><button type="submit">Send</button></form>
      </main>`;
    const logEl = $('.chatlog');
    const c = chats.get(uid) || { username }; c.username = username; c.logEl = logEl; chats.set(uid, c);
    (await hist(uid)).forEach(m => bubble(logEl, m.text, m.me ? 'me' : 'them'));
    ensureConn(uid, username);
    const form = $('.chatin'), input = $('input', form); let tt;
    form.onsubmit = (e) => {
        e.preventDefault();
        const t = input.value.trim(); if (!t) return;
        const cc = chats.get(uid);
        if (!(cc?.conn && cc.conn.open)) { ensureConn(uid, username); return bubble(logEl, isOnline(uid) ? '(connecting… try again in a second)' : '(they’re offline — messages are live P2P)', 'sys'); }
        try { cc.conn.send({ t: 'msg', text: t }); bubble(logEl, t, 'me'); save(uid, { me: true, text: t }); input.value = ''; }
        catch (e2) { bubble(logEl, '(send failed)', 'sys'); }
    };
    input.oninput = () => { const cc = chats.get(uid); if (!(cc?.conn && cc.conn.open)) return; try { cc.conn.send({ t: 'typing' }); } catch (e) {} clearTimeout(tt); tt = setTimeout(() => { try { cc.conn.send({ t: 'stop' }); } catch (e) {} }, 1200); };
};

// Called when the router leaves a chat view — detach the log so background messages
// go to the notification path instead of a dead element.
export const detachChat = (uid) => { const c = chats.get(uid); if (c) c.logEl = null; };
export const detachAll = () => chats.forEach(c => c.logEl = null);

// Chat list: your friends, most-recently-messaged surfaced by unread.
export const renderChatList = async (into) => {
    const { data: fr } = await db.friends();
    const friends = (fr || []).map(f => f.requester_id === state.me.id ? f.addressee : f.requester).filter(Boolean);
    into.innerHTML = '';
    if (!friends.length) return void (into.innerHTML = `<div class="empty">No friends yet. <a href="#/friends">Add some →</a></div>`);
    friends.forEach(u => {
        const row = el(`<button class="urow ${unread.has(u.id) ? 'unread' : ''}" data-go="#/chat/${u.id}">
            ${avatarHTML(u.username, u.avatar)}
            <div class="who"><b>${esc(u.username)}</b><div class="sub">${isOnline(u.id) ? '<i class="dot"></i>online' : 'tap to chat'}</div></div>
            ${unread.has(u.id) ? '<i class="unreaddot"></i>' : ''}</button>`);
        into.appendChild(row);
    });
};

// Background handler for an inbound connection (they messaged us first).
export const onIncomingDM = (conn) => {
    const meta = conn.metadata || {};
    const uid = meta.user_id || conn.peer;
    const username = meta.username || 'someone';
    if (uid) wire(uid, username, conn);
};
