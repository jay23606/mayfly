import { app, el, esc } from './core.js';

// Public PeerTube test instance used as a no-cost proof of concept. Replace this
// endpoint with a moderated provider before making Clips a permanent product surface.
const INSTANCE = 'https://peertube.cpy.re';
const FEED_URL = `${INSTANCE}/api/v1/videos?count=12&sort=-publishedAt&nsfw=false`;
let feed = [], index = 0, cleanup = () => {};
const playerUrl = (clip) => `${INSTANCE}${clip.embedPath}?autoplay=1&muted=1&loop=1&title=0&warningTitle=0&controlBar=0&p2p=0`;

const renderClip = () => {
    const stage = document.querySelector('#clipstage');
    if (!stage || !feed[index]) return;
    const clip = feed[index];
    stage.innerHTML = '';
    const frame = el(`<iframe class="clipplayer" title="${esc(clip.name)}" src="${playerUrl(clip)}" allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>`);
    const meta = el(`<div class="clipmeta"><b>${esc(clip.name)}</b><span>${esc(clip.account?.displayName || clip.channel?.displayName || 'PeerTube')}</span><small>${index + 1} / ${feed.length}</small></div>`);
    stage.append(frame, meta);
};
const move = (delta) => { const next = index + delta; if (next >= 0 && next < feed.length) { index = next; renderClip(); } };
export const closeClips = () => { cleanup(); cleanup = () => {}; };

export const viewClips = async () => {
    closeClips();
    app.innerHTML = `<main class="clipswrap"><div class="cliptop"><div><h3>Clips</h3><p>Swipe for the next public video</p></div><button class="clipreload" aria-label="Reload clips">Reload</button></div><section id="clipstage" class="clipstage" aria-live="polite"><div class="spin">Loading clips...</div></section><p class="clipnote">Powered by public PeerTube videos. Playback starts muted.</p></main>`;
    const stage = document.querySelector('#clipstage');
    let startY = null;
    const onStart = (event) => { startY = event.touches?.[0]?.clientY ?? event.clientY; };
    const onEnd = (event) => { if (startY == null) return; const endY = event.changedTouches?.[0]?.clientY ?? event.clientY; const delta = startY - endY; startY = null; if (Math.abs(delta) > 45) move(delta > 0 ? 1 : -1); };
    const onKey = (event) => { if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); move(1); } if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); move(-1); } };
    stage.addEventListener('touchstart', onStart, { passive: true }); stage.addEventListener('touchend', onEnd, { passive: true }); stage.addEventListener('pointerdown', onStart); stage.addEventListener('pointerup', onEnd); window.addEventListener('keydown', onKey);
    cleanup = () => { stage.removeEventListener('touchstart', onStart); stage.removeEventListener('touchend', onEnd); stage.removeEventListener('pointerdown', onStart); stage.removeEventListener('pointerup', onEnd); window.removeEventListener('keydown', onKey); };
    const load = async () => {
        stage.innerHTML = '<div class="spin">Loading clips...</div>';
        try { const response = await fetch(FEED_URL); if (!response.ok) throw new Error(`Feed returned ${response.status}`); const body = await response.json(); feed = (body.data || []).filter((clip) => clip.embedPath); index = 0; if (!feed.length) throw new Error('No playable clips available'); renderClip(); }
        catch { stage.innerHTML = '<div class="empty">Clips are unavailable right now. Try reloading.</div>'; }
    };
    document.querySelector('.clipreload').onclick = load;
    await load();
};
