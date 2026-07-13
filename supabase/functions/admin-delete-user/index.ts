import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_ID = "2f43626a-3056-402d-9daf-b0de5193a2f8";
const cors = {
  "access-control-allow-origin": "https://jay23606.github.io",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "content-type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || auth.user?.id !== ADMIN_ID) return json({ error: "unauthorized" }, 403);

  let targetId = "";
  try { targetId = String((await req.json())?.targetId || ""); } catch { return json({ error: "bad json" }, 400); }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) return json({ error: "invalid user" }, 400);
  if (targetId === ADMIN_ID) return json({ error: "cannot remove administrator" }, 400);

  const { data: profile, error: profileError } = await admin.from("mf_profiles").select("id, username").eq("id", targetId).maybeSingle();
  if (profileError || !profile) return json({ error: "Mayfly user not found" }, 404);

  const { data: snaps, error: snapError } = await admin.from("mf_snaps").select("id").or(`sender_id.eq.${targetId},recipient_id.eq.${targetId}`);
  if (snapError) return json({ error: "could not collect relay media" }, 500);
  const paths = (snaps || []).map((snap) => snap.id);
  if (paths.length) {
    const { error: storageError } = await admin.storage.from("mf-snaps").remove(paths);
    if (storageError) return json({ error: "could not remove relay media" }, 500);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(targetId);
  if (deleteError) return json({ error: "could not remove account" }, 500);
  return json({ ok: true, username: profile.username });
});
