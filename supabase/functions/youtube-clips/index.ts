import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { query = "funny", pageToken = "" } = await request.json();
    const key = Deno.env.get("YOUTUBE_API_KEY");
    if (!key) throw new Error("YouTube search is not configured");
    const search = new URL("https://www.googleapis.com/youtube/v3/search");
    search.search = new URLSearchParams({ key, part: "snippet", q: String(query).slice(0, 100), type: "video", maxResults: "12", videoEmbeddable: "true", safeSearch: "moderate", ...(pageToken ? { pageToken: String(pageToken) } : {}) }).toString();
    const searchJson = await fetch(search).then(async (r) => { if (!r.ok) throw new Error(`YouTube search failed (${r.status})`); return r.json(); });
    const ids = (searchJson.items || []).map((item: any) => item.id?.videoId).filter(Boolean);
    if (!ids.length) return Response.json({ items: [], nextPageToken: null }, { headers: cors });
    const details = new URL("https://www.googleapis.com/youtube/v3/videos");
    details.search = new URLSearchParams({ key, part: "status", id: ids.join(",") }).toString();
    const status = await fetch(details).then(async (r) => { if (!r.ok) throw new Error(`YouTube video check failed (${r.status})`); return r.json(); });
    const allowed = new Set((status.items || []).filter((item: any) => item.status?.embeddable && !item.status?.madeForKids).map((item: any) => item.id));
    const items = (searchJson.items || []).filter((item: any) => allowed.has(item.id?.videoId)).map((item: any) => ({ provider: "youtube", videoId: item.id.videoId, name: item.snippet.title, channel: item.snippet.channelTitle, thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || "" }));
    return Response.json({ items, nextPageToken: searchJson.nextPageToken || null }, { headers: { ...cors, "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load clips" }, { status: 500, headers: cors });
  }
});
