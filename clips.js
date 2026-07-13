import { app, el, esc, state, avatarHTML, toast, sb } from './core.js';
import { db } from './db.js';

const TOPICS = ['For You', 'Funny', 'Gaming', 'Music', 'Sports', 'Animals', 'DIY', 'News'];
const SEARCH_KEY = 'mayfly:clips-search', CACHE_PREFIX = 'mayfly:clips-cache:', PREFS_KEY = 'mayfly:clips-prefs', HINT_KEY = 'mayfly:clips-wheel-hint';
let feed = [], index = 0, query = 'funny', nextPageToken = null, exhausted = false, loading = false, soundOn = false, captionsOn = false, cleanup = () => {}, sendClipText = null, mode = 'search', channelId = '', prefetch = null;
let prefs = {};
const decodeTitle = (value = '') => { const node = document.createElement('textarea'); node.innerHTML = value; return node.value; };
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { return {}; } };
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} };
const setupPrefs = () => { prefs = readPrefs(); prefs.likes ||= {}; prefs.saved ||= {}; prefs.hidden ||= {}; prefs.follows ||= {}; prefs.interests ||= {}; captionsOn = !!prefs.captions; };
const clipKey = (clip) => clip.videoId;
const playerUrl = (clip, autoplay = true) => `https://www.youtube-nocookie.com/embed/${clip.videoId}?autoplay=${autoplay ? 1 : 0}&mute=${soundOn ? 0 : 1}&loop=1&playlist=${clip.videoId}&rel=0&playsinline=1${captionsOn ? '&cc_load_policy=1&cc_lang_pref=en' : ''}`;
const otherOf = (row) => row.requester_id === state.me.id ? row.addressee : row.requester;
const rememberInterest = (clip, amount = 1) => { const topic = String(clip.topic || query || 'funny').toLowerCase(); prefs.interests[topic] = (prefs.interests[topic] || 0) + amount; savePrefs(); };
const bestInterest = () => Object.entries(prefs.interests).sort((a, b) => b[1] - a[1])[0]?.[0] || localStorage.getItem(SEARCH_KEY) || 'funny';
const prefetchNext = () => {
    prefetch?.remove(); prefetch = null;
    const next = feed[index + 1]; if (!next) return;
    prefetch = document.createElement('link'); prefetch.rel = 'prefetch'; prefetch.as = 'document'; prefetch.href = playerUrl(next, false); document.head.appendChild(prefetch);
};
const enterClipFullscreen = async () => { try { const stage = document.querySelector('#clipstage'); if (stage && !document.fullscreenElement) await stage.requestFullscreen(); } catch (e) {} };
const leaveClipFullscreen = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) {} try { screen.orientation?.unlock?.(); } catch (e) {} };
const toggleSaved = (clip) => { const key = clipKey(clip); if (prefs.saved[key]) delete prefs.saved[key]; else prefs.saved[key] = clip; savePrefs(); renderClip(); };
const toggleLiked = (clip) => { const key = clipKey(clip); if (prefs.likes[key]) delete prefs.likes[key]; else { prefs.likes[key] = clip; rememberInterest(clip); } savePrefs(); renderClip(); };
const toggleFollow = (clip) => { if (!clip.channelId) return toast('Channel details are unavailable for this clip.'); const key = clip.channelId; if (prefs.follows[key]) delete prefs.follows[key]; else prefs.follows[key] = { id: key, name: clip.channel || 'Channel' }; savePrefs(); renderClip(); };
const hideClip = async (clip) => { prefs.hidden[clipKey(clip)] = true; savePrefs(); await move(1); toast('This clip will stay hidden in this browser.'); };

const shareClip = async () => {
    const clip = feed[index]; if (!clip) return;
    document.querySelector('.clipshare')?.remove();
    const sheet = el(`<div class="clipshare"><div class="clipsharecard"><div class="clipsharehead"><div><b>Share Clip</b><span>${esc(clip.name)}</span></div><button class="clipclose" aria-label="Close share menu">×</button></div><div class="clipquick"><button data-quick="like">${prefs.likes[clipKey(clip)] ? '♥ Liked' : '♡ Like'}</button><button data-quick="save">${prefs.saved[clipKey(clip)] ? '★ Saved' : '☆ Save'}</button><button data-quick="hide">Not interested</button></div><input class="recipsearch" id="clipcaption" maxlength="240" placeholder="Add a message…" autocomplete="off"><input class="recipsearch" id="clipfriendsearch" type="search" placeholder="Search friends" autocomplete="off"><div class="recips" id="clipfriends"><div class="spin">Loading friends...</div></div><button class="btn" id="clipsharego" disabled>Share</button></div></div>`);
    (document.fullscreenElement || document.body).appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelector('.clipclose').onclick = close; sheet.onclick = (event) => { if (event.target === sheet) close(); };
    sheet.querySelector('.clipquick').onclick = async (event) => { const action = event.target.dataset.quick; if (action === 'like') toggleLiked(clip); if (action === 'save') toggleSaved(clip); if (action === 'hide') { close(); await hideClip(clip); } else shareClip(); };
    const { data } = await db.friends(); const friends = (data || []).map(otherOf).filter(Boolean);
    const chosen = new Set(), search = sheet.querySelector('#clipfriendsearch'), box = sheet.querySelector('#clipfriends'), send = sheet.querySelector('#clipsharego');
    const refresh = () => { const q = search.value.trim().toLowerCase(), matches = q ? friends.filter((friend) => friend.username?.toLowerCase().includes(q)) : friends; box.innerHTML = ''; if (!matches.length) box.appendChild(el('<div class="empty" style="width:100%">No matching friends.</div>')); matches.forEach((friend) => { const chip = el(`<button class="recip ${chosen.has(friend.id) ? 'on' : ''}">${avatarHTML(friend.username, friend.avatar)}<span>${esc(friend.username)}</span></button>`); chip.onclick = () => { chosen.has(friend.id) ? chosen.delete(friend.id) : chosen.add(friend.id); refresh(); }; box.appendChild(chip); }); send.disabled = !chosen.size; send.textContent = chosen.size ? `Share to ${chosen.size}` : 'Share'; };
    search.oninput = refresh; refresh();
    send.onclick = async () => { send.disabled = true; send.textContent = 'Sharing...'; let sent = 0; const caption = sheet.querySelector('#clipcaption').value.trim(); for (const friend of friends.filter((item) => chosen.has(item.id))) if (await sendClipText?.(friend.id, friend.username || 'Friend', { ...clip, caption })) sent++; close(); toast(sent ? `Shared with ${sent} friend${sent === 1 ? '' : 's'}.` : 'Could not share that clip.'); };
};

const renderClip = () => {
    const stage = document.querySelector('#clipstage'); if (!stage || !feed[index]) return;
    const clip = feed[index], key = clipKey(clip), title = decodeTitle(clip.name); stage.innerHTML = '';
    const frame = el(`<iframe class="clipplayer" title="${esc(title)}" src="${playerUrl(clip)}" allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>`);
    const meta = el(`<div class="clipmeta"><b>${esc(title)}</b><span><button class="clipchannel" title="Show this channel">${esc(decodeTitle(clip.channel || 'YouTube'))}</button><button class="clipfollow" title="Follow channel">${prefs.follows[clip.channelId] ? 'Following' : '+ Follow'}</button></span><div class="clipactions"><button class="clipmini ${prefs.likes[key] ? 'on' : ''}" title="Like">♥</button><button class="clipmini ${prefs.saved[key] ? 'on' : ''}" title="Save">★</button><button class="clipmini" title="${captionsOn ? 'Turn captions off' : 'Request captions'}">CC</button></div><small>${index + 1}${exhausted ? ` / ${feed.length}` : ''}</small></div>`);
    meta.querySelector('.clipchannel').onclick = () => { if (!clip.channelId) return toast('Channel details are unavailable for this clip.'); mode = 'channel'; channelId = clip.channelId; query = clip.channel || 'Channel'; startFeed(); };
    meta.querySelector('.clipfollow').onclick = () => toggleFollow(clip); meta.querySelectorAll('.clipmini')[0].onclick = () => toggleLiked(clip); meta.querySelectorAll('.clipmini')[1].onclick = () => toggleSaved(clip); meta.querySelectorAll('.clipmini')[2].onclick = () => { captionsOn = !captionsOn; prefs.captions = captionsOn; savePrefs(); renderClip(); };
    const controls = el(`<div class="clipcontrols"><button class="clipcontrol clipaudio" aria-label="${soundOn ? 'Exit fullscreen and mute' : 'Fullscreen with sound'}" title="${soundOn ? 'Exit fullscreen and mute' : 'Fullscreen with sound'}">⛶</button><button class="clipcontrol clipsharebtn" aria-label="Share clip" title="Share clip">⤴</button></div>`);
    controls.querySelector('.clipaudio').onclick = async () => { soundOn = !soundOn; if (soundOn) await enterClipFullscreen(); else await leaveClipFullscreen(); renderClip(); };
    controls.querySelector('.clipsharebtn').onclick = shareClip; stage.append(frame, meta, controls); prefetchNext();
};
const setLocalFeed = (items) => { feed = items.filter(clip => !prefs.hidden[clipKey(clip)]); index = 0; exhausted = true; nextPageToken = null; };
const loadMore = async (reset = false) => {
    if (loading || (!reset && exhausted)) return; loading = true;
    try {
        if (mode === 'saved') return setLocalFeed(Object.values(prefs.saved));
        if (reset) { const cacheKey = CACHE_PREFIX + `${mode}:${channelId}:${query}`; try { const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); if (Array.isArray(cached?.items)) { feed = cached.items.filter(clip => !prefs.hidden[clipKey(clip)]); nextPageToken = cached.nextPageToken || null; exhausted = !nextPageToken; index = 0; return; } } catch (e) {} }
        const activeChannel = mode === 'following' ? Object.keys(prefs.follows)[0] : channelId;
        const { data: body, error } = await sb.functions.invoke('youtube-clips', { body: { query, pageToken: reset ? '' : nextPageToken, channelId: activeChannel || '' } });
        if (error || body?.error) throw new Error(error?.message || body.error);
        const additions = (body.items || []).map(clip => ({ ...clip, topic: query })).filter(clip => clip.videoId && !prefs.hidden[clipKey(clip)] && !(reset ? [] : feed).some(old => old.videoId === clip.videoId));
        feed = reset ? additions : [...feed, ...additions]; nextPageToken = body.nextPageToken || null; exhausted = !nextPageToken; if (reset) index = 0;
        if (reset) try { localStorage.setItem(CACHE_PREFIX + `${mode}:${channelId}:${query}`, JSON.stringify({ items: feed, nextPageToken })); } catch (e) {}
    } finally { loading = false; }
};
const startFeed = async () => { const stage = document.querySelector('#clipstage'); if (stage) stage.innerHTML = '<div class="spin">Loading clips...</div>'; try { await loadMore(true); if (!feed.length) throw new Error('No clips'); renderClip(); } catch { if (stage) stage.innerHTML = '<div class="empty">No clips are available here right now.</div>'; } };
const move = async (delta) => { const next = index + delta; if (next < 0) return; if (next >= feed.length) await loadMore(); if (next >= feed.length && exhausted && feed.length) { index = 0; renderClip(); } else if (next < feed.length) { index = next; rememberInterest(feed[index], .05); renderClip(); } };
export const closeClips = () => { cleanup(); cleanup = () => {}; document.querySelector('.clipshare')?.remove(); prefetch?.remove(); prefetch = null; try { screen.orientation?.unlock?.(); } catch (e) {} };

export const viewClips = async (shareText) => {
    closeClips(); sendClipText = shareText; setupPrefs(); query = localStorage.getItem(SEARCH_KEY) || 'funny'; mode = 'search'; channelId = '';
    app.innerHTML = `<main class="clipswrap"><form class="cliptop" id="clipsearch"><input class="recipsearch" id="clipquery" type="search" value="${esc(query)}" placeholder="Search clips" autocomplete="off" aria-label="Search clips"><button class="clipreload">Search</button></form><div class="clipchips" id="clipchips">${TOPICS.map(topic => `<button data-topic="${esc(topic)}" class="${topic === 'Funny' ? 'on' : ''}">${esc(topic)}</button>`).join('')}<button data-topic="Saved">Saved</button><button data-topic="Following">Following</button></div><section id="clipstage" class="clipstage" aria-live="polite"><div class="spin">Loading clips...</div></section><p class="clipnote">Swipe, scroll, or use ↑/↓ to keep watching.</p><p class="cliphint" id="cliphint" ${localStorage.getItem(HINT_KEY) ? 'hidden' : ''}>Mouse wheel moves one clip at a time.</p></main>`;
    const stage = document.querySelector('#clipstage'), chips = document.querySelector('#clipchips');
    const chooseMode = (name) => { if (name === 'Saved') { mode = 'saved'; query = 'Saved clips'; channelId = ''; } else if (name === 'Following') { mode = 'following'; query = 'Latest'; channelId = ''; if (!Object.keys(prefs.follows).length) return toast('Follow a channel to see it here.'); } else { mode = 'search'; channelId = ''; query = name === 'For You' ? bestInterest() : name.toLowerCase(); localStorage.setItem(SEARCH_KEY, query); } chips.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.topic === name)); document.querySelector('#clipquery').value = mode === 'search' ? query : ''; startFeed(); };
    chips.onclick = (event) => { const name = event.target.dataset.topic; if (name) chooseMode(name); };
    let startY = null, longPress = null, pressed = false, wheelDistance = 0, wheelLocked = false;
    const clearPress = () => { clearTimeout(longPress); longPress = null; };
    const onStart = (event) => { startY = event.touches?.[0]?.clientY ?? event.clientY; pressed = false; clearPress(); longPress = setTimeout(() => { pressed = true; shareClip(); }, 550); };
    const markHintSeen = () => { try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {} const hint = document.querySelector('#cliphint'); if (hint) hint.hidden = true; };
    const onEnd = (event) => { if (startY == null) return; const endY = event.changedTouches?.[0]?.clientY ?? event.clientY; const delta = startY - endY; startY = null; clearPress(); if (!pressed && Math.abs(delta) > 45) { markHintSeen(); move(delta > 0 ? 1 : -1); } };
    const onWheel = (event) => { event.preventDefault(); if (wheelLocked || !event.deltaY) return; wheelDistance += event.deltaY; if (Math.abs(wheelDistance) < 45) return; const direction = wheelDistance > 0 ? 1 : -1; wheelDistance = 0; wheelLocked = true; markHintSeen(); move(direction).finally(() => { setTimeout(() => { wheelLocked = false; }, 180); }); };
    const onKey = (event) => { if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); move(1); } if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); move(-1); } };
    stage.addEventListener('touchstart', onStart, { passive: true }); stage.addEventListener('touchend', onEnd, { passive: true }); stage.addEventListener('touchcancel', clearPress, { passive: true }); stage.addEventListener('pointerdown', onStart); stage.addEventListener('pointerup', onEnd); stage.addEventListener('wheel', onWheel, { passive: false }); window.addEventListener('keydown', onKey);
    cleanup = () => { clearPress(); stage.removeEventListener('touchstart', onStart); stage.removeEventListener('touchend', onEnd); stage.removeEventListener('touchcancel', clearPress); stage.removeEventListener('pointerdown', onStart); stage.removeEventListener('pointerup', onEnd); stage.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey); };
    document.querySelector('#clipsearch').onsubmit = (event) => { event.preventDefault(); query = document.querySelector('#clipquery').value.trim() || 'funny'; mode = 'search'; channelId = ''; localStorage.setItem(SEARCH_KEY, query); chips.querySelectorAll('button').forEach(button => button.classList.remove('on')); startFeed(); };
    await startFeed();
};
