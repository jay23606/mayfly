# mayfly

Browser-first private media for the web. Mayfly is a chat-first PWA with peer-to-peer photo/video Snaps and calls, recipient-encrypted offline media relays, encrypted 1:1 chat, Stories, groups, Clips, Memories, and browser push notifications.

It is intentionally **not serverless**: the static frontend uses Supabase for authentication, database policy, Realtime signaling, private relay storage, and Edge Functions. The distinguishing choice is that when two people are online, the full Snap and call media travel directly between their browsers over WebRTC instead of waiting in an application media store.

[Open Mayfly](https://jay23606.github.io/mayfly/) · [Read the implementation note](https://jay23606.github.io/mayfly/paper.html)

## Highlights

- **Resilient peer-to-peer media** — full photo/video Snaps, voice notes, files, 1:1 calls, group calls, and group media use browser-to-browser WebRTC paths when peers are online. Direct file transfers require a receiver acknowledgement, retry after interruption, and resume from the last received byte while the page session remains alive.
- **Encrypted relay fallback** — if a direct Snap, file, or voice-clip path is unavailable or fails, Mayfly queues an end-to-end encrypted copy in private Storage. Media is encrypted once and every active recipient device receives its own ECDH-wrapped content key.
- **Chat that stays client-first** — 1:1 text is encrypted before it reaches the database; delivered messages become device-local conversation history. Timed Snaps remain view-once, while untimed Snaps stay in local chat.
- **Multi-device presence and delivery** — accepted friends can see online/last-active state, messages fan out across registered devices, and relay payloads remain available until all intended device envelopes have been consumed.
- **Social layer** — 24-hour Stories, replies, viewers, streaks, public profiles, friend privacy controls, administrator-enforced privacy locks, and browser push notifications.
- **Clips, GIFs, and stickers** — a YouTube-backed Clips feed with local likes/saves/follows/interests and embedded chat shares; GIPHY-powered GIFs and stickers in chat.
- **Local Memories** — captured media can be saved, deleted, reused in a chat, or posted to a Story from IndexedDB on the current browser. They are not synced to the server.
- **Shared call activities** — Chess, Geometry Dash, Metro Rush, Flappy Race, Pac-Man, Pool, Air Hockey, Scrabble, Trivia, Icebreakers, Stack, and Tetris run during 1:1 calls.

## How a Snap travels

| Recipient | Delivery | Where the full media lives |
| --- | --- | --- |
| **Online** | acknowledged WebRTC transfer | directly between the sender's and recipient's browsers; interrupted downloads retry and resume |
| **Offline or failed P2P** | encrypted relay | ciphertext in a private Storage bucket; each intended device decrypts locally |

- A sender may have up to **10 logical outgoing relay items per recipient**, shared across photo/video Snaps, files, and voice clips. Device envelopes for the same item count once. The database enforces the limit atomically, including concurrent browser tabs.
- One ciphertext payload can fan out to multiple people or devices without storing duplicate media. Relay payloads expire after seven days and are removed after all linked device deliveries finish.
- Mayfly no longer imposes its former 20 MB client-side relay cap. Browser memory, network reliability, and the configured Supabase Storage plan still impose practical limits.
- Live Snaps retain their normal 24-hour delivery window. Group media remains live P2P and does not use the 1:1 relay queue.
- The backend still handles routing and lifecycle metadata, a tiny Snap preview, and any supplied caption. It does not receive the full live Snap or call-media payload.
- A recipient can still screenshot, record, or re-share what they receive. Ephemeral delivery is not DRM.

## Architecture at a glance

| Layer | Responsibility |
| --- | --- |
| Static PWA | UI, camera processing, WebRTC, local storage, client-side crypto, and service worker |
| Supabase | Auth, Postgres + RLS, Realtime signaling, private relay storage, and Edge Functions |
| WebRTC | resumable live Snaps, acknowledged/resumable file and voice transfers, direct calls, group-media legs, and in-call activity state |
| IndexedDB / localStorage | device key material, local threads, Memories, and Clips preferences |

Group membership is persistent and policy-protected. Open group text uses member-authorized Realtime Broadcast and is intentionally non-durable; it should not be described as end-to-end encrypted group text.

## Repository map

- `app.js` — boot, camera, Snaps, Stories, people, profiles, and local cleanup
- `chat.js` / `groups.js` — 1:1 conversations, group conversations, calls, live media, and receipts
- `core.js` / `crypto.js` / `rtc.js` — Supabase client, media processing, recipient encryption, and WebRTC
- `clips.js` / `memories.js` / `callapps.js` — Clips, browser-only Memories, and in-call activities
- `schema.sql` — data model, RLS, private Storage policy, and Realtime authorization
- `supabase/migrations/` — ordered production changes, including multi-device, presence, push repair, call claiming, and encrypted transfer relays
- `supabase/functions/` — YouTube Clips, GIPHY, push, and admin functions
- `paper.html` — implementation note with data paths, privacy boundaries, and current limitations

## Deploy your own copy

1. Create a Supabase project you control, run [`schema.sql`](schema.sql), and configure Auth redirect URLs for your HTTPS domain.
2. Replace the deployment-specific Supabase URL and publishable key in [`core.js`](core.js). The publishable key is safe to expose to the browser only because RLS and Storage policies enforce access; never put a service-role key in frontend code.
3. Configure and deploy the needed Edge Functions. Keep YouTube, GIPHY, VAPID, and service-role credentials in Supabase secrets, not in the repository.
4. Deploy the static files to an HTTPS host such as GitHub Pages, then test sign-in, calls, relay delivery, and your final CORS/Auth configuration from that domain.

For a commercially packaged version with buyer-owned configuration and deployment checklists, see the private `mayfly-white-label` repository.

## Production limits to plan for

- `rtc.js` has no TURN server configured. Some cellular, corporate, or symmetric-NAT networks will fail to connect peers until TURN is added.
- P2P byte-range resume survives connection changes within the current page session. A full page reload does not yet persist partially received chunks; durable resumable transfers should checkpoint chunks in IndexedDB.
- Expired relay cleanup is partly client-driven; larger deployments should add scheduled server-side cleanup for abandoned or expired payloads.
- Device-local encryption keys and Memories do not provide automatic multi-device recovery or backup.
- Relay files are encrypted before upload, but the current browser implementation processes the complete file in memory. Very large files should use chunked encryption and upload.
- YouTube, GIPHY, and dynamically loaded call-activity modules are external dependencies with their own availability and terms.
- Browser crypto and RLS are building blocks, not a substitute for abuse workflows, rate limits, audit practices, retention policies, and independent security review.
