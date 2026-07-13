import { app, el, esc, state, avatarHTML, toast, sb } from './core.js';
import { db } from './db.js';

// Public PeerTube test instance used as a no-cost proof of concept. Replace this
// endpoint with a moderated provider before making Clips a permanent product surface.
const PAGE_SIZE = 12;
let feed = [], index = 0, query = 'funny', nextPageToken = null, exhausted = false, loading = false, soundOn = false, cleanup = () => {}, sendClipText = null;

const playerUrl = (clip) => `https://www.youtube-nocookie.com/embed/${clip.videoId}?autoplay=1&mute=${soundOn ? 0 : 1}&loop=1&playlist=${clip.videoId}&rel=0&playsinline=1`;
const otherOf = (row) => row.requester_id === state.me.id ? row.addressee : row.requester;
const enterClipFullscreen = async (clip) => {
    const stage = document.querySelector('#clipstage');
    try { if (stage && !document.fullscreenElement) await stage.requestFullscreen(); } catch (e) {}
    try { await screen.orientation?.lock?.((clip.aspectRatio || 1) < 1 ? 'portrait' : 'landscape'); } catch (e) {}
};
const leaveClipFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) {}
    try { screen.orientation?.unlock?.(); } catch (e) {}
};

const shareClip = async () => {
    const clip = feed[index]; if (!clip) return;
    document.querySelector('.clipshare')?.remove();
    const sheet = el(`<div class="clipshare"><div class="clipsharecard"><div class="clipsharehead"><div><b>Share Clip</b><span>${esc(clip.name)}</span></div><button class="clipclose" aria-label="Close share menu">×</button></div><input class="recipsearch" id="clipfriendsearch" type="search" placeholder="Search friends" autocomplete="off"><div class="recips" id="clipfriends"><div class="spin">Loading friends...</div></div><button class="btn" id="clipsharego" disabled>Share</button></div></div>`);
    (document.fullscreenElement || document.body).appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelector('.clipclose').onclick = close;
    sheet.onclick = (event) => { if (event.target === sheet) close(); };
    const { data } = await db.friends();
    const friends = (data || []).map(otherOf).filter(Boolean);
    const chosen = new Set(), search = sheet.querySelector('#clipfriendsearch'), box = sheet.querySelector('#clipfriends'), send = sheet.querySelector('#clipsharego');
    const refresh = () => {
        const q = search.value.trim().toLowerCase();
        const matches = q ? friends.filter((friend) => friend.username?.toLowerCase().includes(q)) : friends;
        box.innerHTML = '';
        if (!matches.length) box.appendChild(el('<div class="empty" style="width:100%">No matching friends.</div>'));
        matches.forEach((friend) => {
            const chip = el(`<button class="recip ${chosen.has(friend.id) ? 'on' : ''}">${avatarHTML(friend.username, friend.avatar)}<span>${esc(friend.username)}</span></button>`);
            chip.onclick = () => { chosen.has(friend.id) ? chosen.delete(friend.id) : chosen.add(friend.id); refresh(); };
            box.appendChild(chip);
        });
        send.disabled = !chosen.size;
        send.textContent = chosen.size ? `Share to ${chosen.size}` : 'Share';
    };
    search.oninput = refresh; refresh();
    send.onclick = async () => {
        send.disabled = true; send.textContent = 'Sharing...';
        let sent = 0;
        for (const friend of friends.filter((item) => chosen.has(item.id))) if (await sendClipText?.(friend.id, friend.username || 'Friend', clip)) sent++;
        close(); toast(sent ? `Shared with ${sent} friend${sent === 1 ? '' : 's'}.` : 'Could not share that clip.');
    };
};

const renderClip = () => {
    const stage = document.querySelector('#clipstage');
    if (!stage || !feed[index]) return;
    const clip = feed[index];
    stage.innerHTML = '';
    const frame = el(`<iframe class="clipplayer" title="${esc(clip.name)}" src="${playerUrl(clip)}" allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>`);
    const meta = el(`<div class="clipmeta"><b>${esc(clip.name)}</b><span>${esc(clip.channel || 'YouTube')}</span><small>${index + 1}${exhausted ? ` / ${feed.length}` : ''}</small></div>`);
    const controls = el(`<div class="clipcontrols"><button class="clipcontrol clipaudio" aria-label="${soundOn ? 'Exit fullscreen and mute' : 'Fullscreen with sound'}" title="${soundOn ? 'Exit fullscreen and mute' : 'Fullscreen with sound'}">⛶</button><button class="clipcontrol clipsharebtn" aria-label="Share clip" title="Share clip">⤴</button></div>`);
    controls.querySelector('.clipaudio').onclick = async () => {
        soundOn = !soundOn;
        if (soundOn) await enterClipFullscreen(clip);
        else await leaveClipFullscreen();
        renderClip();
    };
    controls.querySelector('.clipsharebtn').onclick = shareClip;
    stage.append(frame, meta, controls);
};

const loadMore = async (reset = false) => {
    if (loading || (!reset && exhausted)) return;
    loading = true;
    try {
        const start = reset ? 0 : feed.length;
        const { data: body, error } = await sb.functions.invoke('youtube-clips', { body: { query, pageToken: reset ? '' : nextPageToken } });
        if (error || body?.error) throw new Error(error?.message || body.error);
        const additions = (body.items || []).filter((clip) => clip.videoId && !(reset ? [] : feed).some((old) => old.videoId === clip.videoId));
        feed = reset ? additions : [...feed, ...additions];
        nextPageToken = body.nextPageToken || null;
        exhausted = !nextPageToken;
        if (reset) index = 0;
    } finally { loading = false; }
};
const move = async (delta) => {
    const next = index + delta;
    if (next < 0) return;
    if (next >= feed.length) await loadMore();
    // Keep the swipe experience continuous when the public source has no more
    // results for this search. A future Mayfly-owned feed can append new clips here.
    if (next >= feed.length && exhausted && feed.length) { index = 0; renderClip(); }
    else if (next < feed.length) { index = next; renderClip(); }
};
export const closeClips = () => { cleanup(); cleanup = () => {}; document.querySelector('.clipshare')?.remove(); try { screen.orientation?.unlock?.(); } catch (e) {} };

export const viewClips = async (shareText) => {
    closeClips();
    sendClipText = shareText;
    app.innerHTML = `<main class="clipswrap"><form class="cliptop" id="clipsearch"><input class="recipsearch" id="clipquery" type="search" value="funny" placeholder="Search clips" autocomplete="off" aria-label="Search clips"><button class="clipreload">Search</button></form><section id="clipstage" class="clipstage" aria-live="polite"><div class="spin">Loading clips...</div></section><p class="clipnote">Searches public PeerTube videos. Swipe to keep watching.</p></main>`;
    const stage = document.querySelector('#clipstage');
    let startY = null, longPress = null, pressed = false;
    const clearPress = () => { clearTimeout(longPress); longPress = null; };
    const onStart = (event) => { startY = event.touches?.[0]?.clientY ?? event.clientY; pressed = false; clearPress(); longPress = setTimeout(() => { pressed = true; shareClip(); }, 550); };
    const onEnd = (event) => { if (startY == null) return; const endY = event.changedTouches?.[0]?.clientY ?? event.clientY; const delta = startY - endY; startY = null; clearPress(); if (!pressed && Math.abs(delta) > 45) move(delta > 0 ? 1 : -1); };
    const onKey = (event) => { if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); move(1); } if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); move(-1); } };
    stage.addEventListener('touchstart', onStart, { passive: true }); stage.addEventListener('touchend', onEnd, { passive: true }); stage.addEventListener('touchcancel', clearPress, { passive: true }); stage.addEventListener('pointerdown', onStart); stage.addEventListener('pointerup', onEnd); window.addEventListener('keydown', onKey);
    cleanup = () => { clearPress(); stage.removeEventListener('touchstart', onStart); stage.removeEventListener('touchend', onEnd); stage.removeEventListener('touchcancel', clearPress); stage.removeEventListener('pointerdown', onStart); stage.removeEventListener('pointerup', onEnd); window.removeEventListener('keydown', onKey); };
    const search = async (event) => { event.preventDefault(); query = document.querySelector('#clipquery').value.trim() || 'funny'; stage.innerHTML = '<div class="spin">Loading clips...</div>'; try { await loadMore(true); if (!feed.length) throw new Error('No clips'); renderClip(); } catch { stage.innerHTML = '<div class="empty">Clips are unavailable right now. Try another search.</div>'; } };
    document.querySelector('#clipsearch').onsubmit = search;
    await search(new Event('submit'));
};
