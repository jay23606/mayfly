// Shared activities for 1:1 calls. The activity modules live in Appmegle and
// use the small Appmegle register/mount/onData contract; this host adapts that
// contract to Mayfly's existing encrypted peer data connection.
const APP_BASE = 'https://jay23606.github.io/appmegle/';
const ACTIVITIES = [
    ['chess', 'Chess'], ['geodash', 'Geometry Dash'], ['pacman', 'Pac-Man'],
    ['metrorush', 'Metro Rush'],
    ['pool', 'Pool'], ['airhockey', 'Air Hockey'], ['scrabble', 'Scrabble'],
    ['trivia', 'Trivia'], ['icebreakers', 'Icebreakers'], ['stack', 'Stack'], ['tetris', 'Tetris'],
];
const labels = new Map(ACTIVITIES);
const apps = new Map(), loading = new Map(), inbox = [], pendingControls = [];
let root = null, stage = null, picker = null, send = null, amCaller = false, active = null, mounted = null, soundLoading = null;

const sound = (kind) => window.AppmegleSound?.play?.(kind);
const soundForMessage = (msg) => {
    const t = String(msg?.t || '');
    if (['eat', 'g', 'play', 'rev', 'boost', 'power', 'shield'].includes(t)) return sound('score');
    if (['reject', 'lock', 'crash'].includes(t)) return sound('wrong');
    if (['restart', 'reset', 'newreq', 'maze', 'q'].includes(t)) return sound('start');
    if (['result', 'over', 'win'].includes(t)) return sound('win');
    if (t === 'dead') return sound('lose');
};
const loadSound = () => {
    if (window.AppmegleSound) return Promise.resolve();
    if (!soundLoading) soundLoading = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = `${APP_BASE}apps/sfx.js`; script.onload = resolve; script.onerror = resolve;
        document.head.appendChild(script);
    });
    return soundLoading;
};

const styleFor = (path, id) => {
    if (!path || document.querySelector(`link[data-call-app="${id}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.dataset.callApp = id; link.href = new URL(path, APP_BASE).href;
    document.head.appendChild(link);
};
const register = (app) => { apps.set(app.id, app); styleFor(app.css, app.id); };
window.Appmegle = window.Appmegle || {};
window.Appmegle.register = register;

const load = (id) => {
    if (apps.has(id)) return Promise.resolve(apps.get(id));
    if (!labels.has(id)) return Promise.reject(new Error('Unknown activity'));
    if (!loading.has(id)) loading.set(id, loadSound().then(() => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${APP_BASE}apps/${id}.js`;
        script.onload = () => apps.has(id) ? resolve(apps.get(id)) : reject(new Error('Activity did not register'));
        script.onerror = () => reject(new Error('Activity could not load'));
        document.body.appendChild(script);
    })));
    return loading.get(id);
};
const setPicker = () => { if (picker) picker.value = active || ''; };
const clearStage = () => {
    const app = mounted && apps.get(mounted);
    try { app?.unmount?.(); } catch (e) {}
    mounted = null;
    if (stage) { stage.classList.remove('open'); stage.innerHTML = ''; }
};
const deliver = (id, msg) => {
    if (active !== id || mounted !== id) { inbox.push({ id, msg }); return; }
    try { apps.get(id)?.onData?.(msg); } catch (e) {}
};
const flush = (id) => {
    const queued = inbox.filter(item => item.id === id);
    for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].id === id) inbox.splice(i, 1);
    queued.forEach(item => deliver(id, item.msg));
};
const open = async (id, broadcast) => {
    if (!labels.has(id) || !stage) return;
    if (active === id && mounted === id) return;
    clearStage(); active = id; setPicker();
    stage.classList.add('open'); stage.innerHTML = '<div class="callapploading">Loading ' + labels.get(id) + '…</div>';
    if (broadcast) send?.({ k: 'host', t: 'open', id });
    try {
        const app = await load(id);
        if (active !== id || !stage) return;
        stage.innerHTML = '';
        app.mount({ root: stage, amCaller, send: (msg) => { soundForMessage(msg); send?.({ k: 'app', id, msg }); } });
        mounted = id; flush(id);
    } catch (e) {
        if (active === id && stage) { stage.innerHTML = '<div class="callapploading">Could not load this activity.</div>'; }
    }
};
const close = (broadcast) => {
    if (!active) return;
    clearStage(); active = null; setPicker();
    if (broadcast) send?.({ k: 'host', t: 'close' });
};

export const mountCallApps = (container, opts) => {
    root = container; send = opts.send; amCaller = !!opts.amCaller;
    root.innerHTML = `<div class="callappdock"><label>Activities <select aria-label="Choose a call activity"><option value="">Choose an activity</option>${ACTIVITIES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label><button type="button" class="callappclose" aria-label="Close activity" title="Close activity">×</button></div><div class="callappstage"></div>`;
    stage = root.querySelector('.callappstage'); picker = root.querySelector('select');
    picker.onchange = () => picker.value ? open(picker.value, true) : close(true);
    root.querySelector('.callappclose').onclick = () => close(true);
    stage.addEventListener('pointerup', () => sound('tap'));
    pendingControls.splice(0).forEach(receiveCallApp);
};
export const unmountCallApps = () => {
    clearStage(); active = null; inbox.length = 0; pendingControls.length = 0;
    if (root) root.innerHTML = '';
    root = stage = picker = send = null;
};
export const toggleCallApps = () => root?.classList.toggle('menuopen');
export const receiveCallApp = (payload) => {
    if (!payload) return;
    if (!stage && payload.k === 'host') { pendingControls.push(payload); return; }
    if (payload.k === 'host') { if (payload.t === 'open') open(payload.id, false); else if (payload.t === 'close') close(false); return; }
    if (payload.k === 'app' && typeof payload.id === 'string') { soundForMessage(payload.msg); deliver(payload.id, payload.msg); }
};
