// Supabase Edge Function — the one server-side piece Web Push requires (it holds the VAPID
// private key). Triggered by Database Webhooks on INSERT into public.mf_messages and
// public.mf_call_rings. It only ever sees ciphertext + ids, so the push it sends is a generic
// "you have something from <name>"; the client opens mayfly and decrypts the real content.
//
// Deploy + secrets: see PUSH_SETUP.md.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected into every Edge Function. The service
// role bypasses RLS so we can read any recipient's subscriptions + the sender's public name.
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:push@mayfly.app",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  // Optional shared-secret gate: set WEBHOOK_SECRET and add a matching x-webhook-secret header
  // to each Database Webhook so only Supabase can invoke this.
  const secret = Deno.env.get("WEBHOOK_SECRET");
  if (secret && req.headers.get("x-webhook-secret") !== secret) return json({ error: "unauthorized" }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { type, table, record } = payload ?? {};
  if (type !== "INSERT" || !record) return json({ skipped: true });

  const isCall = table === "mf_call_rings";
  let recipientId: string | undefined, senderId: string | undefined;
  if (table === "mf_messages") { recipientId = record.recipient_id; senderId = record.sender_id; }
  else if (isCall) { recipientId = record.callee_id; senderId = record.caller_id; }
  else return json({ skipped: "unknown table" });
  if (!recipientId || !senderId) return json({ skipped: "missing ids" });

  // Public display name only — never any message content.
  const { data: sender } = await admin.from("mf_profiles").select("username").eq("id", senderId).maybeSingle();
  const name = sender?.username ?? "Someone";
  const callKind = record.kind === "video" ? "video call" : "call";
  const notification = JSON.stringify({
    title: "mayfly 🐛",
    body: isCall ? `Incoming ${callKind} from ${name}` : `New message from ${name}`,
    tag: isCall ? `call:${senderId}` : `msg:${senderId}`,
    url: `./#/c/${senderId}`,
  });

  const { data: subs } = await admin
    .from("mf_push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", recipientId);
  if (!subs?.length) return json({ sent: 0 });

  const results = await Promise.allSettled(subs.map((s: any) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, notification)
      .catch(async (err: any) => {
        // 404/410 → the push endpoint is gone; prune it so we stop retrying a dead device.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await admin.from("mf_push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
        throw err;
      })
  ));
  return json({ sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length });
});
