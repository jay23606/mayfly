import { app, el, esc, idb, safeMediaUrl, toast } from './core.js';

const INDEX_KEY = 'memories:index', PREFIX = 'memory:';
let releaseUrls = () => {};
const readIndex = async () => {
    try { const value = await idb.get(INDEX_KEY); return Array.isArray(value) ? value : []; }
    catch (e) { return []; }
};
const writeIndex = (items) => idb.set(INDEX_KEY, items);

export const saveMemory = async (shot, caption = '') => {
    const source = shot.rawBlob instanceof Blob ? shot.rawBlob : await fetch(shot.full).then(r => r.blob());
    const id = crypto.randomUUID();
    const item = {
        id, caption: String(caption || '').slice(0, 120), mime: shot.mime || source.type || 'image/jpeg',
        preview: shot.preview || shot.full || '', createdAt: Date.now(), kind: (shot.mime || source.type || '').startsWith('video/') ? 'video' : 'image',
    };
    const items = await readIndex();
    await idb.set(PREFIX + id, source);
    try { await writeIndex([item, ...items]); }
    catch (e) { await idb.del(PREFIX + id); throw e; }
    try { await navigator.storage?.persist?.(); } catch (e) {}
    return item;
};

export const closeMemories = () => { releaseUrls(); releaseUrls = () => {}; };

export const viewMemories = async (useMemory = null) => {
    closeMemories();
    app.innerHTML = `<main><div class="memorieshead"><div><h1 class="vtitle">Memories</h1><p class="muted tiny">Only saved in this browser.</p></div><button class="pill danger" id="clear-memories">Clear all</button></div><div class="memoriesgrid" id="memories"><div class="spin">Loading memories…</div></div></main>`;
    const box = document.querySelector('#memories');
    const items = await readIndex();
    if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="empty">No Memories yet. Save a Snap from the send screen to keep it here.</div>'; return; }
    box.innerHTML = '';
    const urls = [];
    for (const item of items) {
        const blob = await idb.get(PREFIX + item.id);
        if (!(blob instanceof Blob)) continue;
        const url = URL.createObjectURL(blob); urls.push(url);
        const card = el(`<article class="memorycard" role="button" tabindex="0" aria-label="Send saved Memory">${item.kind === 'video' ? `<video src="${safeMediaUrl(url)}" muted playsinline preload="metadata"></video><span class="memoryplay">▶</span>` : `<img src="${safeMediaUrl(url)}" alt="Saved Memory">`}<button class="memorydelete" aria-label="Delete memory" title="Delete memory">×</button><div class="memorymeta"><span>${new Date(item.createdAt).toLocaleDateString()}</span>${item.caption ? `<b>${esc(item.caption)}</b>` : ''}</div></article>`);
        card.querySelector('.memorydelete').onclick = async () => {
            if (!confirm('Delete this Memory from this browser?')) return;
            await idb.del(PREFIX + item.id); await writeIndex((await readIndex()).filter(x => x.id !== item.id));
            URL.revokeObjectURL(url); card.remove();
            if (!box.children.length) box.innerHTML = '<div class="empty">No Memories yet.</div>';
        };
        const openComposer = async () => { if (useMemory) await useMemory(item, blob, false); };
        card.onclick = (event) => { if (!event.target.closest('.memorydelete')) openComposer(); };
        card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openComposer(); } };
        box.appendChild(card);
    }
    releaseUrls = () => urls.forEach(URL.revokeObjectURL);
    document.querySelector('#clear-memories').onclick = async () => {
        if (!confirm('Delete all Memories from this browser?')) return;
        await Promise.all(items.map(item => idb.del(PREFIX + item.id))); await writeIndex([]); closeMemories(); viewMemories(useMemory); toast('Memories cleared from this browser.');
    };
};
