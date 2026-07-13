import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { query = "", type = "gifs" } = await request.json();
    const collection = type === "stickers" ? "stickers" : "gifs", key = Deno.env.get("GIPHY_API_KEY");
    if (!key) throw new Error("GIF search is not configured");
    const endpoint = String(query).trim() ? "search" : "trending", url = new URL(`https://api.giphy.com/v1/${collection}/${endpoint}`);
    url.search = new URLSearchParams({ api_key: key, limit: "24", rating: "g", ...(endpoint === "search" ? { q: String(query).slice(0, 100) } : {}) }).toString();
    const body = await fetch(url).then(async response => { if (!response.ok) throw new Error(`GIF search failed (${response.status})`); return response.json(); });
    const items = (body.data || []).map((item: any) => ({ id: item.id, title: String(item.title || item.slug || collection).slice(0, 160), url: item.images?.fixed_width?.url || item.images?.original?.url || "", preview: item.images?.fixed_width_still?.url || item.images?.fixed_width?.url || "", type: collection === "stickers" ? "sticker" : "gif" })).filter((item: any) => item.id && item.url && item.preview);
    return Response.json({ items }, { headers: { ...cors, "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load GIFs" }, { status: 500, headers: cors });
  }
});
