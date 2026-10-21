import { blobSas } from "../_lib/azure.js";
import { escapeHtml, fail } from "../_lib/http.js";
import { ADMIN_NAV } from "../_lib/nav.js";
import { buildConfig, cardOf, obfuscate, posterFor, rowToTitle } from "../_lib/titles.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Media URLs carry a read-only SAS, refreshed once a day.
 *
 * This is not access control - the container is public-read. Azure only returns
 * `Accept-Ranges: bytes` (and therefore lets a browser seek) when the request
 * uses a modern service version. Browsers never send `x-ms-version`, but a SAS
 * carries `sv=...`, and the service honours it. The expiry is rounded to the day
 * so every viewer gets the same URL and the browser can cache the bytes.
 */
async function signSources(env, config) {
  if (!env.AZURE_KEY) return config;
  const startOfDay = Math.floor(Date.now() / DAY) * DAY;
  const startMs = startOfDay - DAY;
  const expiryMs = startOfDay + 8 * DAY;

  await Promise.all(config.episodes.map(async (episode) => {
    await Promise.all(episode.sources.map(async (source) => {
      if (!source.blob) return;
      try {
        const url = await blobSas(env, { blob: source.blob, permissions: "r", startMs, expiryMs });
        source.url = url;
        source.download_url = url;
      } catch {
        // Keep the plain public URL; playback still works, seeking may not.
      }
    }));
  }));
  return config;
}

/**
 * GET /movie/:id
 *
 * Renders the player page with the same injected config the player expects.
 * The page is dynamic because the config is per-title and freshly obfuscated;
 * the assets it loads are static.
 */
export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || "");
  const row = await env.DB.prepare(
    "SELECT * FROM titles WHERE id = ? AND status = 'published'",
  ).bind(id).first();
  if (!row) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

  const t = rowToTitle(row);
  const config = await signSources(env, buildConfig(t));
  const cfg = obfuscate(JSON.stringify(config));

  const injected =
    `<script id="fpInlinePlayerData" type="application/json" data-s="${cfg.seed}" data-r="${cfg.rounds}">` +
    `${cfg.payload}</script>`;

  const meta =
    `<script id="fpTitleMeta" type="application/json">` +
    `${JSON.stringify(cardOf(t)).replace(/</g, "\\u003c")}</script>`;

  const origin = new URL(request.url).origin;
  const poster = posterFor(t);
  const posterAbs = /^https?:/i.test(poster) ? poster : `${origin}${poster}`;
  const label = `${t.title}${t.year ? ` (${t.year})` : ""}`;
  const blurb = (t.description || `${label} - stream it on Fast Player in the quality your connection can hold.`)
    .replace(/\s+/g, " ").trim().slice(0, 200);

  const remoteOrigins = new Set();
  for (const ep of config.episodes) {
    for (const source of ep.sources) {
      try { remoteOrigins.add(new URL(source.url).origin); } catch { /* not a URL */ }
    }
  }

  const headMeta = [
    `<meta name="description" content="${escapeHtml(blurb)}">`,
    '<meta property="og:type" content="video.movie">',
    '<meta property="og:site_name" content="Fast Player">',
    `<meta property="og:title" content="${escapeHtml(label)}">`,
    `<meta property="og:description" content="${escapeHtml(blurb)}">`,
    `<meta property="og:image" content="${escapeHtml(posterAbs)}">`,
    `<meta property="og:url" content="${escapeHtml(`${origin}/movie/${t.id}`)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<link rel="preload" as="image" href="${escapeHtml(posterAbs)}">`,
    ...[...remoteOrigins].map((o) => `<link rel="preconnect" href="${escapeHtml(o)}">`),
  ].join("\n");

  const asset = await env.ASSETS.fetch(new Request(new URL("/movie.html", request.url)));
  if (!asset.ok) return fail(500, "template_missing");
  const html = (await asset.text())
    .replace("<!--FP_PLAYER_CONFIG-->", injected)
    .replace("<!--FP_TITLE_META-->", meta)
    .replace("<!--FP_ADMIN_LINK-->", ADMIN_NAV)
    .replace("<!--FP_HEAD_META-->", headMeta)
    .replaceAll("<!--FP_TITLE-->", escapeHtml(t.title))
    .replace(/<!--FP_DEV_PANEL_START-->[\s\S]*?<!--FP_DEV_PANEL_END-->/, "")
    .replace('<script src="/devtools.js"></script>', "");

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
