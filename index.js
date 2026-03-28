const http = require("http");

const PORT = Number(process.env.PORT || 7005);
const HOST = process.env.HOST || "0.0.0.0";
const VIDSRC_URL = "https://vidsrcme.ru";
const TMDB_API_KEY =
  process.env.TMDB_API_KEY || "e6333b32409e02a4a6eba6fb7ff866bb";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const CLOUDNESTRA_DOMAIN_MAP = {
  "{v1}": "shadowlandschronicles.com",
  "{v2}": "cloudnestra.com",
  "{v3}": "thepixelpioneer.com",
  "{v4}": "putgate.org",
};

const manifest = {
  id: "org.codex.vidsrc",
  version: "0.2.0",
  name: "VidSrc Direct",
  description:
    "Movie and series streams from VidSrc/Cloudnestra for Cinemeta IMDb ids with per-quality HLS entries.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": USER_AGENT,
      accept: "*/*",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain,*/*",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.json();
}

async function resolveTmdbId(inputId, mediaType) {
  if (!inputId.startsWith("tt")) {
    throw new Error(`Unsupported ${mediaType} id: ${inputId}`);
  }

  const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(
    inputId
  )}?external_source=imdb_id&api_key=${TMDB_API_KEY}`;
  const payload = await fetchJson(findUrl);
  const resultList =
    mediaType === "movie" ? payload.movie_results : payload.tv_results;
  const media = resultList && resultList[0];
  if (!media || !media.id) {
    throw new Error(`TMDB ${mediaType} not found for ${inputId}`);
  }
  return String(media.id);
}

function parseSeriesResourceId(rawId) {
  const decoded = decodeURIComponent(rawId);
  const match = decoded.match(/^([^:]+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    imdbId: match[1],
    season: Number(match[2]),
    episode: Number(match[3]),
  };
}

function toAbsoluteUrl(baseUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, baseUrl).href;
}

function extractIframeUrl(embedHtml, embedUrl) {
  const iframeMatch = embedHtml.match(/<iframe[^>]+src="([^"]+)"/i);
  if (!iframeMatch) {
    throw new Error("VidSrc iframe URL not found");
  }
  return toAbsoluteUrl(embedUrl, iframeMatch[1]);
}

function extractProrcpUrl(iframeHtml, iframeUrl) {
  const prorcpMatch = iframeHtml.match(/src:\s*'([^']*\/prorcp\/[^']+)'/);
  if (!prorcpMatch) {
    throw new Error("Cloudnestra prorcp URL not found");
  }
  return toAbsoluteUrl(iframeUrl, prorcpMatch[1]);
}

function expandMasterUrl(rawUrl) {
  let expanded = rawUrl;
  for (const [placeholder, domain] of Object.entries(CLOUDNESTRA_DOMAIN_MAP)) {
    expanded = expanded.replaceAll(placeholder, domain);
  }
  return expanded;
}

function extractMasterUrls(playerHtml, playerPageUrl) {
  const fileMatch = playerHtml.match(/new Playerjs\(\{id:"player_parent", file: "([^"]+)"/);
  if (!fileMatch) {
    throw new Error("Playerjs master playlist block not found");
  }

  const urls = fileMatch[1]
    .split(" or ")
    .map((url) => expandMasterUrl(url.trim()))
    .filter((url) => /^https?:\/\/.+\.m3u8$/i.test(url))
    .map((url) => toAbsoluteUrl(playerPageUrl, url));

  return [...new Set(urls)];
}

function parseMasterVariants(masterUrl, playlistText) {
  const lines = playlistText.split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const nextLine = lines[index + 1];
    if (!nextLine || nextLine.startsWith("#")) continue;

    const resolutionMatch = line.match(/RESOLUTION=\d+x(\d+)/);
    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
    variants.push({
      quality: resolutionMatch ? Number(resolutionMatch[1]) : null,
      bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : null,
      url: toAbsoluteUrl(masterUrl, nextLine.trim()),
    });
  }

  return variants;
}

async function getQualityStreams(masterUrl) {
  const masterOrigin = new URL(masterUrl).origin;
  const playlistText = await fetchText(masterUrl, {
    headers: {
      Referer: `${masterOrigin}/`,
      Origin: masterOrigin,
    },
  });
  return parseMasterVariants(masterUrl, playlistText);
}

function dedupeStreamsByQuality(qualityStreams) {
  const byQuality = new Map();

  for (const stream of qualityStreams) {
    const key = String(stream.quality ?? "auto");
    const existing = byQuality.get(key);
    if (!existing || (stream.bandwidth || 0) > (existing.bandwidth || 0)) {
      byQuality.set(key, stream);
    }
  }

  return [...byQuality.values()].sort((a, b) => {
    const aq = a.quality || 0;
    const bq = b.quality || 0;
    return bq - aq;
  });
}

async function getVidsrcData({ mediaType, imdbId, season, episode }) {
  const tmdbId = await resolveTmdbId(imdbId, mediaType);
  const embedUrl =
    mediaType === "movie"
      ? `${VIDSRC_URL}/embed/movie?imdb=${encodeURIComponent(imdbId)}`
      : `${VIDSRC_URL}/embed/tv?imdb=${encodeURIComponent(
          imdbId
        )}&season=${season}&episode=${episode}`;

  const embedHtml = await fetchText(embedUrl, {
    headers: {
      Referer: `${VIDSRC_URL}/`,
      Origin: VIDSRC_URL,
    },
  });
  const iframeUrl = extractIframeUrl(embedHtml, embedUrl);

  const iframeHtml = await fetchText(iframeUrl, {
    headers: {
      Referer: embedUrl,
      Origin: new URL(VIDSRC_URL).origin,
    },
  });
  const prorcpUrl = extractProrcpUrl(iframeHtml, iframeUrl);

  const playerHtml = await fetchText(prorcpUrl, {
    headers: {
      Referer: iframeUrl,
      Origin: new URL(iframeUrl).origin,
    },
  });
  const masterUrls = extractMasterUrls(playerHtml, prorcpUrl);
  if (masterUrls.length === 0) {
    throw new Error(`VidSrc master playlists not found for ${imdbId}`);
  }

  return {
    mediaType,
    imdbId,
    tmdbId,
    season,
    episode,
    embedUrl,
    iframeUrl,
    prorcpUrl,
    masterUrls,
  };
}

async function resolvePlayableStreams(details) {
  const collected = [];

  for (const masterUrl of details.masterUrls) {
    try {
      const variants = await getQualityStreams(masterUrl);
      collected.push(...variants);
    } catch (_error) {
      // Ignore individual master failures and keep trying the rest.
    }
  }

  if (collected.length === 0) {
    return details.masterUrls.map((url) => ({
      quality: null,
      bandwidth: null,
      url,
    }));
  }

  return dedupeStreamsByQuality(collected);
}

function getBaseUrl(req) {
  const protocol =
    req.headers["x-forwarded-proto"] ||
    (req.socket && req.socket.encrypted ? "https" : "http");
  return `${protocol}://${req.headers.host}`;
}

function buildStreams(details, qualityStreams) {
  return qualityStreams.map((stream) => {
    const qualityLabel = stream.quality ? `${stream.quality}p` : "Auto";
    return {
      name: "VidSrc",
      title: `VidSrc ${qualityLabel}`,
      url: stream.url,
      behaviorHints: {
        notWebReady: true,
      },
      externalUrl: details.embedUrl,
    };
  });
}

function buildDebugPayload(details, qualityStreams) {
  return {
    mediaType: details.mediaType,
    imdbId: details.imdbId,
    tmdbId: details.tmdbId,
    season: details.season ?? null,
    episode: details.episode ?? null,
    embedUrl: details.embedUrl,
    iframeUrl: details.iframeUrl,
    prorcpUrl: details.prorcpUrl,
    masterUrls: details.masterUrls,
    qualityStreams,
  };
}

function selectQualityStream(qualityStreams, requestedQuality) {
  if (!requestedQuality || requestedQuality === "auto") {
    return qualityStreams[0] || null;
  }
  const numericQuality = Number(requestedQuality);
  return (
    qualityStreams.find((stream) => stream.quality === numericQuality) ||
    qualityStreams[0] ||
    null
  );
}

async function handleMovieStreamRequest(req, res, movieId) {
  try {
    const data = await getVidsrcData({ mediaType: "movie", imdbId: movieId });
    const streamsToReturn = await resolvePlayableStreams(data);
    sendJson(res, 200, {
      streams: buildStreams(data, streamsToReturn),
    });
  } catch (error) {
    sendJson(res, 200, {
      streams: [],
      error: error.message,
    });
  }
}

async function handleSeriesStreamRequest(req, res, seriesId, season, episode) {
  try {
    const data = await getVidsrcData({
      mediaType: "series",
      imdbId: seriesId,
      season,
      episode,
    });
    const streamsToReturn = await resolvePlayableStreams(data);
    sendJson(res, 200, {
      streams: buildStreams(data, streamsToReturn),
    });
  } catch (error) {
    sendJson(res, 200, {
      streams: [],
      error: error.message,
    });
  }
}

async function handleMoviePlayRequest(res, movieId, requestedQuality) {
  try {
    const data = await getVidsrcData({ mediaType: "movie", imdbId: movieId });
    const qualityStreams = await resolvePlayableStreams(data);
    const selectedStream = selectQualityStream(qualityStreams, requestedQuality);
    if (!selectedStream) {
      sendJson(res, 404, { error: "No playable stream found" });
      return;
    }
    redirect(res, selectedStream.url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleSeriesPlayRequest(
  res,
  seriesId,
  season,
  episode,
  requestedQuality
) {
  try {
    const data = await getVidsrcData({
      mediaType: "series",
      imdbId: seriesId,
      season,
      episode,
    });
    const qualityStreams = await resolvePlayableStreams(data);
    const selectedStream = selectQualityStream(qualityStreams, requestedQuality);
    if (!selectedStream) {
      sendJson(res, 404, { error: "No playable stream found" });
      return;
    }
    redirect(res, selectedStream.url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleMovieDebugRequest(res, movieId) {
  try {
    const data = await getVidsrcData({ mediaType: "movie", imdbId: movieId });
    const qualityStreams = await resolvePlayableStreams(data);
    sendJson(res, 200, buildDebugPayload(data, qualityStreams));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleSeriesDebugRequest(res, seriesId, season, episode) {
  try {
    const data = await getVidsrcData({
      mediaType: "series",
      imdbId: seriesId,
      season,
      episode,
    });
    const qualityStreams = await resolvePlayableStreams(data);
    sendJson(res, 200, buildDebugPayload(data, qualityStreams));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: "Missing URL" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (requestUrl.pathname === "/manifest.json") {
    sendJson(res, 200, manifest);
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true, name: manifest.name, version: manifest.version });
    return;
  }

  const streamMovieMatch = requestUrl.pathname.match(/^\/stream\/movie\/([^/]+)\.json$/);
  if (streamMovieMatch) {
    await handleMovieStreamRequest(req, res, decodeURIComponent(streamMovieMatch[1]));
    return;
  }

  const streamSeriesMatch = requestUrl.pathname.match(/^\/stream\/series\/([^/]+)\.json$/);
  if (streamSeriesMatch) {
    const parsed = parseSeriesResourceId(streamSeriesMatch[1]);
    if (!parsed) {
      sendJson(res, 400, { error: "Invalid series resource id" });
      return;
    }
    await handleSeriesStreamRequest(
      req,
      res,
      parsed.imdbId,
      parsed.season,
      parsed.episode
    );
    return;
  }

  const playMovieMatch = requestUrl.pathname.match(/^\/play\/movie\/([^/]+)\/([^/]+)\.m3u8$/);
  if (playMovieMatch) {
    await handleMoviePlayRequest(
      res,
      decodeURIComponent(playMovieMatch[1]),
      decodeURIComponent(playMovieMatch[2])
    );
    return;
  }

  const playSeriesMatch = requestUrl.pathname.match(
    /^\/play\/series\/([^/]+)\/(\d+)\/(\d+)\/([^/]+)\.m3u8$/
  );
  if (playSeriesMatch) {
    await handleSeriesPlayRequest(
      res,
      decodeURIComponent(playSeriesMatch[1]),
      Number(playSeriesMatch[2]),
      Number(playSeriesMatch[3]),
      decodeURIComponent(playSeriesMatch[4])
    );
    return;
  }

  const debugMovieMatch = requestUrl.pathname.match(/^\/debug\/movie\/([^/]+)\.json$/);
  if (debugMovieMatch) {
    await handleMovieDebugRequest(res, decodeURIComponent(debugMovieMatch[1]));
    return;
  }

  const debugSeriesMatch = requestUrl.pathname.match(/^\/debug\/series\/([^/]+)\.json$/);
  if (debugSeriesMatch) {
    const parsed = parseSeriesResourceId(debugSeriesMatch[1]);
    if (!parsed) {
      sendJson(res, 400, { error: "Invalid series resource id" });
      return;
    }
    await handleSeriesDebugRequest(
      res,
      parsed.imdbId,
      parsed.season,
      parsed.episode
    );
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`VidSrc Stremio addon listening on http://${HOST}:${PORT}/manifest.json`);
});
