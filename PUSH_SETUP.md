# Push notifications — deploy checklist

Web Push for **1:1 messages and 1:1 calls only** (no groups, no stories). Everything in the
repo is already wired; the steps below are the parts that touch the live Supabase project and
can't be done from the client. Until step 2 is done, push is completely inert — the app runs
exactly as before.

The moving parts:

```
mf_messages / mf_call_rings INSERT
        │  (Database Webhook)
        ▼
  Edge Function `notify`  ──reads──►  mf_push_subscriptions   (VAPID-signed Web Push)
        │
        ▼
  browser service worker `sw.js`  ──►  showNotification("New message from Alice")
```

The function only ever sees ciphertext + ids. The push body is a generic "New message /
Incoming call from `<name>`"; tapping it opens mayfly to that conversation, which then
decrypts the real content.

---

## 1. Apply the schema

Two new tables (`mf_push_subscriptions`, `mf_call_rings`) were added to `schema.sql`. Apply
them to the shared project (`zbtgonklxweikgukzukg`):

```sh
supabase db push --linked
# or paste just the two new CREATE TABLE / policy blocks into the SQL editor
```

## 2. Generate VAPID keys and wire the public one

```sh
npx web-push generate-vapid-keys
```

- Copy **publicKey** into `push.js` → `const VAPID_PUBLIC_KEY = '...'` (this is the only client
  edit; the public key is meant to be public).
- Keep **privateKey** for step 4 (secret — never commit it).

## 3. Deploy the Edge Function

```sh
supabase functions deploy notify --no-verify-jwt
```

`--no-verify-jwt` because a Database Webhook (not a logged-in user) calls it; access is instead
gated by the shared secret in step 4.

## 4. Set the function secrets

```sh
supabase secrets set \
  VAPID_PUBLIC_KEY="<publicKey from step 2>" \
  VAPID_PRIVATE_KEY="<privateKey from step 2>" \
  VAPID_SUBJECT="mailto:you@example.com" \
  WEBHOOK_SECRET="<any long random string>"
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set them.)

## 5. Create the two Database Webhooks

Dashboard → **Database → Webhooks → Create**, once per table:

| Setting | Value |
| --- | --- |
| Table | `mf_messages` (then repeat for `mf_call_rings`) |
| Events | **Insert** only |
| Type | Supabase Edge Function → `notify` (or HTTP POST to its function URL) |
| HTTP header | `x-webhook-secret: <WEBHOOK_SECRET from step 4>` |

That's it. New 1:1 messages and call rings now fan out as Web Push.

---

## Testing

- Desktop Chrome / Android Chrome: open mayfly, grant the notification prompt, background the
  tab, then have a friend message or call you → a system notification appears; clicking it
  focuses the conversation.
- Confirm a subscription row landed: `select count(*) from mf_push_subscriptions;`
- Watch delivery: `supabase functions logs notify` (look for `{ sent, total }`).

## iOS note

iOS only delivers Web Push when the PWA is **installed to the Home Screen**, and it only grants
permission from a **user gesture**. The boot-time `initPush()` covers desktop + Android; for
iOS, wire the already-exported `enablePush()` (in `push.js`) to a "Turn on notifications"
button and have the user tap it once after installing. That button is the only follow-up UI
this feature still needs.

## Notes / limits

- Delivery receipts and content stay client-side and E2E-encrypted; the server never learns
  message text — the push is metadata-only ("from `<name>`").
- A call `mf_call_rings` row is transient: the caller deletes it when the call ends, and a
  boot sweep (`delMyStaleRings`) clears any stragglers older than 2 minutes.
- Dead endpoints (HTTP 404/410) are pruned automatically by the function.
