import { formatDuration, normalizeSearchQuery, parseIsoDuration } from "../../../../lib/youtube";
import type { VideoSummary } from "../../../../lib/types";

type CacheEntry = { expiresAt: number; videos: VideoSummary[] };
type RateEntry = { startedAt: number; count: number };

const cache = new Map<string, CacheEntry>();
const rateLimits = new Map<string, RateEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 12;

function json(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function allowRequest(ip: string): boolean {
  const now = Date.now();
  const current = rateLimits.get(ip);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_MAX;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const input = url.searchParams.get("q") ?? "";
  const query = normalizeSearchQuery(input);
  if (input.trim().length < 2 || !query) {
    return json({ error: "Digite pelo menos dois caracteres para buscar." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "local";
  if (!allowRequest(ip)) {
    return json({ error: "Muitas buscas em pouco tempo. Aguarde um minuto e tente novamente." }, 429);
  }

  const cacheKey = query.toLocaleLowerCase("pt-BR");
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return json({ query, videos: cached.videos }, 200, { "x-karaoke-cache": "hit" });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return json({ error: "A busca do YouTube ainda não foi configurada neste ambiente." }, 503);
  }

  try {
    const searchParams = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "12",
      order: "relevance",
      safeSearch: "moderate",
      q: query,
      key: apiKey,
    });
    const searchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`, {
      headers: { accept: "application/json" },
    });
    const searchData = await searchResponse.json() as {
      items?: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails: Record<string, { url: string }> } }>;
      error?: { errors?: Array<{ reason?: string }> };
    };
    if (!searchResponse.ok) {
      const reason = searchData.error?.errors?.[0]?.reason;
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        return json({ error: "O limite diário de buscas foi atingido. Tente novamente mais tarde." }, 429);
      }
      return json({ error: "O YouTube não conseguiu concluir a busca agora." }, 502);
    }

    const items = searchData.items ?? [];
    const ids = items.map((item) => item.id.videoId).filter(Boolean);
    if (!ids.length) return json({ query, videos: [] });

    const detailParams = new URLSearchParams({
      part: "status,contentDetails",
      id: ids.join(","),
      key: apiKey,
    });
    const detailResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detailParams}`, {
      headers: { accept: "application/json" },
    });
    if (!detailResponse.ok) return json({ error: "Não foi possível validar os vídeos encontrados." }, 502);
    const detailData = await detailResponse.json() as {
      items?: Array<{ id: string; status: { embeddable?: boolean; madeForKids?: boolean; privacyStatus?: string }; contentDetails: { duration?: string } }>;
    };
    const details = new Map((detailData.items ?? []).map((item) => [item.id, item]));

    const videos = items.flatMap((item): VideoSummary[] => {
      const detail = details.get(item.id.videoId);
      const durationSeconds = parseIsoDuration(detail?.contentDetails.duration ?? "");
      if (
        !detail?.status.embeddable ||
        detail.status.madeForKids ||
        detail.status.privacyStatus !== "public" ||
        durationSeconds < 30 ||
        durationSeconds > 20 * 60
      ) return [];
      const thumbnail = item.snippet.thumbnails.medium?.url
        ?? item.snippet.thumbnails.high?.url
        ?? item.snippet.thumbnails.default?.url
        ?? "";
      return [{
        id: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail,
        duration: formatDuration(durationSeconds),
        durationSeconds,
      }];
    });

    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, videos });
    return json({ query, videos }, 200, { "cache-control": "public, max-age=0, s-maxage=1800" });
  } catch {
    return json({ error: "Sem conexão com o YouTube. Verifique a internet e tente novamente." }, 502);
  }
}
