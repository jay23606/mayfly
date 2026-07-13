# mayfly 🐛

Private, chat-first media for the web. Mayfly is a single-page PWA on **GitHub Pages + Supabase**, with **no build step**: peer-to-peer photo/video Snaps, bounded end-to-end encrypted offline photo relays, 24-hour Stories, encrypted chat, voice notes, files, groups, video/voice calls, creative camera filters, and opt-in Web Push for 1:1 messages and calls.

Sibling to [instamegle](https://github.com/jay23606/instamegle) — it reuses the same engine (Supabase auth/realtime, raw WebRTC over Realtime Broadcast, canvas image processing, IndexedDB). Where instamegle is a *persistent public feed*, mayfly is *directed and ephemeral*.

Read the architecture comparison: [**Snaps Without a Server — mayfly vs. Snapchat**](https://jay23606.github.io/mayfly/paper.html).

## How a snap travels

| Recipient is… | Delivery | Where the full image lives |
|---|---|---|
| **online** | live peer-to-peer (WebRTC) | full-quality photo or video streams directly from the sender's browser |
| **offline** | encrypted photo relay | a re-encoded ≤50 KB WebP/JPEG ciphertext in a private Storage bucket; video remains live-only |

- **End-to-end encryption** (`crypto.js`): every relayed snap is encrypted to the recipient's ECDH P-256 public key (ECIES → AES-GCM). The private key is generated on-device and never leaves it, so the server only ever holds random bytes.
- **The server never holds a viewable full Snap.** Postgres holds only small previews and metadata; relay media is encrypted to the recipient's device key before it reaches Storage.
- **Bounded offline delivery:** one pending relay per friend, at most **100** outstanding relay Snaps per sender, each capped at 50 KB and cleaned after seven days. Video Snaps require the recipient to be online.
- **Chat-first Snaps:** Snaps stay in the recipient's local chat history by default. Choosing a 3/5/10-second timer makes one view full-screen, then removes the delivery.
- **Receipts:** a sent Snap progresses through **Sent → Delivered → Opened**, or **Expired** after its delivery window.
- **Streaks** 🔥 count consecutive days you and a friend snap each other.

## Files

`index.html` shell · `styles.css` · ES modules: `util.js` (pure helpers) · `core.js` (config/Supabase/IndexedDB/image) · `crypto.js` (E2E) · `rtc.js` (WebRTC live delivery) · `db.js` (queries) · `app.js` (camera/compose/inbox/player/friends/boot) · `sw.js` (PWA cache) · `schema.sql` (Supabase tables + RLS).

## Setup

1. **Database:** open the Supabase project → SQL Editor → paste [`schema.sql`](schema.sql) → Run. It creates the `mf_`-prefixed tables, RLS policies, the streak function, and the private `mf-snaps` Storage bucket.
2. **Auth:** add the Pages URL to Auth → URL Configuration (Site URL + redirect allow-list). Autoconfirm signups (or wire up email) as you prefer.
3. **Deploy:** push to GitHub, enable Pages from `main` / root.

Runs entirely client-side — the publishable key in `core.js` is public-safe because every table is protected by Row Level Security.

## Also built

- **Stories** — 24-hour posts visible to friends, with replies, viewers, deletion controls, a full-image P2P path, and a capped 20 KB offline fallback. Each account keeps its five newest Stories.
- **Chat** — end-to-end encrypted text delivery (up to ten undelivered messages per offline recipient, with a seven-day TTL), plus live P2P voice notes and photo/video/file attachments.
- **Video calls** — 1:1 P2P video/voice (WebRTC) with echo-cancellation capture, camera switching, mid-call voice-to-video upgrades, and responsive full-frame mobile video; plus group mesh calls.
- **Group chats** — persistent membership, member-controlled naming/removal/leaving, live text, Snaps, files, voice clips, and P2P mesh calls.
- **PWA notifications** — opt-in, privacy-preserving Web Push for background 1:1 messages and incoming calls; notification bodies never include chat plaintext.
- **Camera tools** — live canvas previews and distinctive photo filters; photos are filtered before capture while video preserves its native recording path.

## Roadmap

- **Scheduled cleanup** — an Edge Function cron to sweep expired relay blobs/rows + stories server-side (today it's lazy client-side cleanup).
- **TURN** — relay creds so live P2P works on cellular / symmetric NAT.
