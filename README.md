# mayfly 🐛

Ephemeral photo messaging — like Snapchat, but a single-page PWA on **GitHub Pages + Supabase**, with **no build step** and (almost) **no server-side media**. A snap lives for a day, then vanishes; it's destroyed the moment it's opened.

Sibling to [instamegle](https://github.com/jay23606/instamegle) — it reuses the same engine (Supabase auth/realtime, raw WebRTC over Realtime Broadcast, canvas image processing, IndexedDB). Where instamegle is a *persistent public feed*, mayfly is *directed and ephemeral*.

## How a snap travels

| Recipient is… | Delivery | Where the full image lives |
|---|---|---|
| **online** | live peer-to-peer (WebRTC) | only in the sender's browser until it's pulled; never on the server |
| **offline** | encrypted relay | end-to-end encrypted ciphertext in a private Storage bucket, deleted on open |

- **End-to-end encryption** (`crypto.js`): every relayed snap is encrypted to the recipient's ECDH P-256 public key (ECIES → AES-GCM). The private key is generated on-device and never leaves it, so the server only ever holds random bytes.
- **The server never holds a viewable photo.** The only image data in Postgres is a ~24px blurred LQIP preview so the inbox can show *something* before you open a snap.
- **Offline cap:** while a friend is offline you can have at most **one** unopened snap waiting for them (bounds relay storage).
- **Chat-first Snaps:** Snaps stay in the recipient's local chat history by default. Choosing a 3/5/10-second timer makes one view full-screen, then hard-deletes the row (and relay blob).
- **Streaks** 🔥 count consecutive days you and a friend snap each other.

## Files

`index.html` shell · `styles.css` · ES modules: `util.js` (pure helpers) · `core.js` (config/Supabase/IndexedDB/image) · `crypto.js` (E2E) · `rtc.js` (WebRTC live delivery) · `db.js` (queries) · `app.js` (camera/compose/inbox/player/friends/boot) · `sw.js` (PWA cache) · `schema.sql` (Supabase tables + RLS).

## Setup

1. **Database:** open the Supabase project → SQL Editor → paste [`schema.sql`](schema.sql) → Run. It creates the `mf_`-prefixed tables, RLS policies, the streak function, and the private `mf-snaps` Storage bucket.
2. **Auth:** add the Pages URL to Auth → URL Configuration (Site URL + redirect allow-list). Autoconfirm signups (or wire up email) as you prefer.
3. **Deploy:** push to GitHub, enable Pages from `main` / root.

Runs entirely client-side — the publishable key in `core.js` is public-safe because every table is protected by Row Level Security.

## Also built

- **Stories** — 24h posts visible to friends, replayable, with a viewer list (full image P2P, LQIP fallback).
- **Chat** — ephemeral P2P DMs: text, **voice notes**, and photo/video/file attachments (nothing on the server).
- **Video calls** — 1:1 P2P video/voice (WebRTC), plus **group mesh calls**.
- **Group chats** — persistent membership (`mf_groups`), ephemeral Realtime Broadcast text on member-only `mfgroup:` channels, full P2P mesh video.

## Roadmap

- **Scheduled cleanup** — an Edge Function cron to sweep expired relay blobs/rows + stories server-side (today it's lazy client-side cleanup).
- **TURN** — relay creds so live P2P works on cellular / symmetric NAT.
