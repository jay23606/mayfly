// Web Push for 1:1 messages and calls. In mayfly's zero-server model the notification
// itself is sent by a Supabase Edge Function (it holds the VAPID private key); this module
// only (1) registers the service worker, (2) subscribes the browser, and (3) stores the
// subscription so the function can reach it. No message content is ever pushed — the push
// says "you have something", the client opens and decrypts.
import { db } from './db.js';

// Public half of the VAPID key pair. Generate a pair with `npx web-push generate-vapid-keys`,
// paste the publicKey here, and set the privateKey as the Edge Function's VAPID_PRIVATE_KEY
// secret (see PUSH_SETUP.md). Left blank → push stays completely inert; nothing breaks.
const VAPID_PUBLIC_KEY = 'BF98ezZNUkNO5vDJUFKK6W90C7WdSP_TB9aWy0szf1YkTge6Lrvx891ja3OM5TAQwZF0y4vjntywMogdb6LVTms';
const PUSH_PREF_KEY = 'mf_push_enabled';

// VAPID keys are URL-safe base64; PushManager wants the raw bytes.
const urlB64ToBytes = (b64) => {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const subToRow = (sub) => { const j = sub.toJSON(); return { endpoint: sub.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth }; };
const sameKey = (a, b) => a?.byteLength === b?.byteLength && a.every((value, i) => value === b[i]);
const matchesCurrentVapidKey = (sub) => sameKey(new Uint8Array(sub?.options?.applicationServerKey || []), urlB64ToBytes(VAPID_PUBLIC_KEY));
export const pushPreference = () => localStorage.getItem(PUSH_PREF_KEY) !== 'off';
export const browserNotificationsEnabled = () => pushPreference() && 'Notification' in window && Notification.permission === 'granted';

let swReady = null;
// Register the (cache-free) worker and resolve once it's controlling the page. Safe to call
// repeatedly — the browser dedupes an identical registration.
export const registerSW = async () => {
    if (!('serviceWorker' in navigator)) return null;
    try { await navigator.serviceWorker.register('sw.js'); swReady = await navigator.serviceWorker.ready; return swReady; }
    catch (e) { return null; }
};

// Boot path: if the user has already granted permission, make sure a live subscription is on
// file (push endpoints rotate, so re-subscribe + upsert each start). Never prompts on its own.
export const initPush = async () => {
    if (!pushPreference() || !VAPID_PUBLIC_KEY || !supported() || Notification.permission !== 'granted') return;
    const reg = swReady || await registerSW();
    if (!reg) return;
    try {
        let sub = await reg.pushManager.getSubscription();
        // A VAPID rotation invalidates the old subscription. Replace it rather than
        // silently re-saving an endpoint bound to the previous application key.
        if (sub && !matchesCurrentVapidKey(sub)) {
            db.delPushSub(sub.endpoint).then(() => {}, () => {});
            await sub.unsubscribe(); sub = null;
        }
        sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC_KEY) });
        db.savePushSub(subToRow(sub)).then(() => {}, () => {});
    } catch (e) {}
};

// Gesture path (wire to a "Turn on notifications" button — required on iOS, which only grants
// permission from a user gesture): request permission, then subscribe. Returns true if active.
export const enablePush = async () => {
    if (!VAPID_PUBLIC_KEY || !supported()) return false;
    let perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { return false; } }
    if (perm !== 'granted') return false;
    localStorage.setItem(PUSH_PREF_KEY, 'on');
    await initPush();
    return true;
};

// Unsubscribing is device-local: other browsers signed into Mayfly keep their own
// subscriptions and continue receiving notifications.
export const disablePush = async () => {
    localStorage.setItem(PUSH_PREF_KEY, 'off');
    if (!supported()) return true;
    try {
        const reg = swReady || await registerSW();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
            db.delPushSub(sub.endpoint).then(() => {}, () => {});
            await sub.unsubscribe();
        }
    } catch (e) {}
    return true;
};
