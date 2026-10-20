/**
 * End-to-end smoke test: server contract only, no browser.
 *
 * Run with:  node selftest.mjs
 * The server must be started with DEV_PANEL=1, because sections 5 and 6 use its
 * test hooks and a published instance answers 404 for those (see README).
 *
 * Covers the catalogue API, categories, the category pages, per-title config
 * injection, the gate, health aggregation, the parity routes, the live re-read
 * of storage/library.json, and the admin API.
 *
 * Sections 8, 9 and 10 write that file and restore it afterwards. Section 10
 * needs ADMIN_TOKEN in this process's environment to exercise the write paths;
 * without it, it checks that the admin is invisible instead.
 */
import { request } from "node:http";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeMedia, probeSlices } from "./media-probe.mjs";
import { planConversion, planRendition, isHdr } from "./media-convert.mjs";
import { parseSas, containerBase, blobNameFor } from "./azure-blob.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STORAGE = process.env.STORAGE_DIR || join(HERE, "storage");
const MANIFEST = join(STORAGE, "library.json");

const SITE = process.env.SITE || `http://127.0.0.1:${process.env.SITE_PORT || 8890}`;
const SITE_URL = new URL(SITE);
const CDN_BASE = Number(process.env.CDN_BASE_PORT || 8891);
const CDN_A = `http://127.0.0.1:${CDN_BASE}`;
const CDN_B = `http://127.0.0.1:${CDN_BASE + 1}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  cond ? pass++ : fail++;
};

/**
 * A one-shot liveness request over node:http, deliberately not fetch(): this
 * file exits early when the instance has no test hooks, and exiting while an
 * undici keep-alive socket is closing aborts Node on Windows.
 */
function probe(path) {
  return new Promise((resolve) => {
    const req = request(
      { hostname: SITE_URL.hostname, port: SITE_URL.port, path, agent: false, headers: { connection: "close" } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function waitForServer(path, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await probe(path)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function decodeConfig(html) {
  const tag = html.match(/<script id="mlbdInlinePlayerData"[^>]*data-s="([^"]+)"[^>]*data-r="([^"]+)"[^>]*>([\s\S]*?)<\/script>/);
  if (!tag) return null;
  const [, seed, roundsStr, payload] = tag;
  let r = parseInt(seed, 16) >>> 0;
  const rounds = parseInt(roundsStr, 10) || 0;
  for (let i = 0; i < rounds; i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;
  const bin = Buffer.from(payload.replace(/\s+/g, ""), "base64");
  const out = Buffer.alloc(bin.length);
  for (let i = 0; i < bin.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bin[i] ^ ((r >>> 16) & 0xff);
  }
  return { seed, rounds, json: JSON.parse(out.toString("utf8")) };
}

const getConfig = async (id) => decodeConfig(await (await fetch(`${SITE}/movie/${id}`)).text());
const catalogue = async () => (await fetch(`${SITE}/api/catalogue.json`)).json();

if (!(await waitForServer("/api/catalogue.json"))) {
  console.error("server did not come up");
  process.exit(1);
}

// Sections 5 and 6 drive the server's test hooks, which a published instance
// answers 404 for. Fail with the fix rather than on every dependent check.
if ((await probe("/api/dev/state")) === 404) {
  console.error("\nThe server's test hooks are disabled on this instance.");
  console.error("Start it with DEV_PANEL=1 and run this suite again.\n");
  process.exit(2);
}

// ---- 1. catalogue ---------------------------------------------------------
const browse = await (await fetch(`${SITE}/`)).text();
ok("browse page served", browse.includes('id="catalogue-root"'));

// The hero is the largest element and is chosen by script, so the server names
// its poster in the head; otherwise the download only starts after the JSON lands.
const heroPoster = (await catalogue()).titles[0].poster;
ok("the page names its hero poster before the script runs",
  browse.includes(`rel="preload" as="image" href="${heroPoster}"`), heroPoster);

const cat = await catalogue();
ok("catalogue lists the seeded titles", cat.ok === true && cat.count >= 4, `count=${cat.count}`);
ok("catalogue groups titles into rows", cat.rows.length >= 2 && cat.rows.every((r) => r.titles.length),
  cat.rows.map((r) => `${r.name}(${r.titles.length})`).join(" "));

const c0 = cat.titles[0];
ok("every card has a title, poster and a link",
  cat.titles.every((t) => t.title && t.poster && /^\/movie\//.test(t.url)));
ok("cards advertise their qualities", Array.isArray(c0.qualities) && c0.qualities.length > 0, (c0.qualities || []).join("/"));
ok("cards do not leak media urls or file names",
  cat.titles.every((t) => !JSON.stringify(t).match(/\/(p|d)\/|\.mp4|mg=/)));

// ---- 1b. categories -------------------------------------------------------
ok("cards carry category ids", cat.titles.every((t) => Array.isArray(t.categories) && t.categories.length),
  JSON.stringify(cat.titles.map((t) => `${t.id}:${t.categories.join("+")}`)));
ok("a title can belong to more than one category", cat.titles.some((t) => t.categories.length > 1));
ok("rows are categories, with a link each",
  cat.rows.every((r) => r.id && r.name) && cat.rows.filter((r) => r.url).every((r) => /^\/category\//.test(r.url)),
  cat.rows.map((r) => `${r.name}${r.url ? "" : " (no page)"}`).join(" "));
ok("rows only contain titles that claim the category",
  cat.rows.every((r) => r.url ? r.titles.every((t) => t.categories.includes(r.id)) : true));

const feat = cat.categories.find((c) => c.id === "featured");
ok("declared categories are listed with counts", Boolean(feat) && feat.count >= 2 && feat.name === "Featured",
  JSON.stringify(feat));
ok("a category nobody declared is derived, not dropped",
  cat.categories.some((c) => c.derived === true), cat.categories.map((c) => `${c.id}${c.derived ? "*" : ""}`).join(" "));
ok("every category count matches its row",
  cat.categories.every((c) => c.count === cat.rows.filter((r) => r.id === c.id).reduce((n, r) => n + r.titles.length, 0)));

// ---- 1c. category page ---------------------------------------------------
const catPage = await fetch(`${SITE}/category/featured`);
const catHtml = await catPage.text();
ok("category page is served", catPage.status === 200 && catHtml.includes('id="category-root"'));
ok("category page injects the category it is showing", catHtml.includes('"id":"featured"') && catHtml.includes("Featured"));
ok("category page title is filled in", !catHtml.includes("<!--MLBD_CATEGORY-->"));

const catJson = await (await fetch(`${SITE}/api/category/featured.json`)).json();
ok("category api agrees with the catalogue row",
  catJson.ok === true && catJson.count === feat.count &&
  catJson.titles.every((t) => t.categories.includes("featured")),
  `count=${catJson.count}`);
ok("category api serves the same card shape",
  catJson.titles.every((t) => t.url && t.poster && Array.isArray(t.categories)));
ok("unknown category page is 404", (await fetch(`${SITE}/category/nonexistent`)).status === 404);
ok("unknown category api is 404", (await fetch(`${SITE}/api/category/nonexistent.json`)).status === 404);

// ---- 1d. delivery: compression, discovery, a real 404 page -----------------
const gz = await fetch(`${SITE}/style/catalogue.css`, { headers: { "Accept-Encoding": "gzip" } });
const gzBody = Buffer.from(await gz.arrayBuffer());
ok("text assets travel gzipped when the browser offers it",
  gz.status === 200 && gz.headers.get("content-encoding") === "gzip" &&
  /text\/css/.test(gz.headers.get("content-type") || "") && gzBody.length > 0,
  `${gz.headers.get("content-encoding")} ${gzBody.length} bytes`);

const plain = await fetch(`${SITE}/style/catalogue.css`, { headers: { "Accept-Encoding": "identity" } });
ok("and uncompressed when the browser does not ask",
  plain.status === 200 && plain.headers.get("content-encoding") === null,
  String(plain.headers.get("content-encoding")));

const revalidated = await fetch(`${SITE}/style/catalogue.css`, {
  headers: { "If-None-Match": gz.headers.get("etag") || "" },
});
ok("a revalidated asset costs nothing", revalidated.status === 304, `status ${revalidated.status}`);

// The catalogue is fetched on every navigation; it must be cheap to re-check
// without ever being stale.
const catHead = await fetch(`${SITE}/api/catalogue.json`);
const catTag = catHead.headers.get("etag");
const catAgain = await fetch(`${SITE}/api/catalogue.json`, { headers: { "If-None-Match": catTag || "" } });
ok("the catalogue revalidates instead of refusing to be cached",
  Boolean(catTag) && /no-cache/.test(catHead.headers.get("cache-control") || "") && catAgain.status === 304,
  `${catTag} ${catHead.headers.get("cache-control")} -> ${catAgain.status}`);

// A card is 172px wide; sending the 500px poster to every card wasted most of
// the bytes. The small copy is generated once, beside the original.
const posterPath = (await catalogue()).titles
  .map((t) => t.poster)
  .find((u) => /^\/poster\/[A-Za-z0-9_-]+\.jpg$/.test(String(u || "")));
if (posterPath) {
  const fullRes = await fetch(`${SITE}${posterPath}`);
  const fullBytes = (await fullRes.arrayBuffer()).byteLength;
  const smallRes = await fetch(`${SITE}${posterPath.replace(/\.jpg$/, "-250.jpg")}`);
  const smallBytes = (await smallRes.arrayBuffer()).byteLength;
  ok("the card grid can fetch a poster a third of the size",
    smallRes.status === 200 && /image\/jpeg/.test(smallRes.headers.get("content-type") || "") &&
    smallBytes < fullBytes * 0.75,
    `${smallBytes} vs ${fullBytes} bytes`);
  ok("a poster carries a validator, so a repeat view is a 304",
    Boolean(smallRes.headers.get("etag")) &&
    (await fetch(`${SITE}${posterPath.replace(/\.jpg$/, "-250.jpg")}`, {
      headers: { "If-None-Match": smallRes.headers.get("etag") },
    })).status === 304,
    smallRes.headers.get("etag"));
} else {
  console.log("SKIP  poster thumbnail checks - no /poster/*.jpg in this library");
}

ok("responses declare their type, so a browser cannot sniff another",
  gz.headers.get("x-content-type-options") === "nosniff" &&
  Boolean(gz.headers.get("referrer-policy")),
  `${gz.headers.get("x-content-type-options")} / ${gz.headers.get("referrer-policy")}`);

const homeHtml = await (await fetch(`${SITE}/`)).text();
const versionedRef = (homeHtml.match(/href="(\/(?:style|vendor)\/[^"]+\?v=[a-f0-9]+)"/) || [])[1];
ok("pages name their assets by version, so a repeat visit re-downloads nothing",
  Boolean(versionedRef), versionedRef || "no versioned reference");
if (versionedRef) {
  const vres = await fetch(`${SITE}${versionedRef}`);
  ok("a versioned asset is cached for a year, immutably",
    vres.status === 200 && /immutable/.test(vres.headers.get("cache-control") || ""),
    vres.headers.get("cache-control"));
}

const robots = await (await fetch(`${SITE}/robots.txt`)).text();
ok("robots.txt points at the sitemap and keeps crawlers out of the admin",
  robots.includes("Sitemap:") && robots.includes("Disallow: /admin"), robots.split("\n")[0]);

const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
ok("the sitemap lists every title and every category",
  sitemap.includes("<urlset") &&
  cat.titles.every((t) => sitemap.includes(`/movie/${t.id}`)) &&
  cat.categories.every((c) => sitemap.includes(`/category/${c.id}`)),
  `${cat.titles.length} titles`);

const notFoundPage = await fetch(`${SITE}/no/such/page`, { headers: { Accept: "text/html" } });
const notFoundBody = await notFoundPage.text();
ok("a page that does not exist answers with a page, not a JSON blob",
  notFoundPage.status === 404 && /text\/html/.test(notFoundPage.headers.get("content-type") || "") &&
  notFoundBody.includes("Browse the library"),
  `${notFoundPage.status} ${notFoundPage.headers.get("content-type")}`);

// ---- 2. posters -----------------------------------------------------------
const generated = await fetch(`${SITE}/poster/big-buck-bunny.svg`);
const generatedBody = await generated.text();
ok("poster is generated when a title has none",
  generated.status === 200 && /image\/svg\+xml/.test(generated.headers.get("content-type") || "") &&
  generatedBody.includes("Big Buck Bunny"));

const again = await (await fetch(`${SITE}/poster/big-buck-bunny.svg`)).text();
ok("a generated poster is stable for the same title", again === generatedBody);

const filePoster = await fetch(`${SITE}/posters/sintel.svg`);
ok("a title can point at a poster file instead", filePoster.status === 200 &&
  /image\/svg\+xml/.test(filePoster.headers.get("content-type") || ""));

const noPoster = await fetch(`${SITE}/poster/not-a-title.svg`);
ok("poster for an unknown title is 404", noPoster.status === 404, `status ${noPoster.status}`);

const noTitle = await fetch(`${SITE}/movie/not-a-title`);
ok("unknown title page is 404", noTitle.status === 404, `status ${noTitle.status}`);

const sharedHtml = await (await fetch(`${SITE}/movie/demo-feature`)).text();
ok("a shared link unfurls with the poster, the title and a description",
  sharedHtml.includes('property="og:title"') &&
  /property="og:image" content="https?:\/\/[^"]+\.(?:jpg|jpeg|png|svg)"/.test(sharedHtml) &&
  sharedHtml.includes('property="og:description"') &&
  sharedHtml.includes('name="twitter:card"'),
  (sharedHtml.match(/og:image" content="([^"]+)"/) || [])[1] || "no og:image");

// ---- 3. one page per title, each with its own injected config -------------
const cfg = (await getConfig("demo-feature")).json;
ok("config has expected top-level keys",
  ["episodes", "view_event", "source_health_event", "download_bridge", "origin_fid", "title_id"]
    .every((k) => k in cfg),
  `${Object.keys(cfg).length} keys`);
ok("config knows which title it belongs to", cfg.title_id === "demo-feature" && cfg.title === "Demo Feature");

const sources = cfg.episodes[0].sources;
ok("5 sources with health_token", sources.length === 5 && sources.every((s) => s.health_token),
  sources.map((s) => s.quality).join("/"));
ok("sources carry health objects", sources.every((s) => s.health && typeof s.health.audio_status === "string"));
ok("sources rewritten to /p/<slug> hops", sources.every((s) => /\/127\.0\.0\.1:\d+\/p\//.test(s.url)), sources[0].url);
ok("media slugs are namespaced per title", sources.every((s) => s.url.includes("/p/demo-feature--")));

const other = (await getConfig("sintel")).json;
ok("a second title injects its own config", other.title_id === "sintel" && other.episodes[0].sources.length === 2);
ok("the two titles share no media slug",
  !other.episodes[0].sources.some((s) => sources.some((d) => d.url === s.url)));

const html = await (await fetch(`${SITE}/movie/demo-feature`)).text();
ok("config placeholder replaced", !html.includes("<!--MLBD_PLAYER_CONFIG-->"));
ok("title placeholder replaced", html.includes("Demo Feature") && !html.includes("<!--MLBD_TITLE-->"));
ok("page carries plain title meta for the catalogue row", html.includes('id="mlbdTitleMeta"'));

// ---- 4. gate token --------------------------------------------------------
const gate = await (await fetch(`${CDN_A}/g`)).json();
ok("gate mints a token", gate.ok === true && /^\d+\.\d+\.[A-Za-z0-9_-]{20,}$/.test(gate.g || ""), gate.g);
const token = gate.g;

const srcWithSlug = sources.find((s) => new RegExp(`:${CDN_BASE}/p/`).test(s.url));
const slugA = srcWithSlug.url.split("/p/")[1];
// a genuinely different asset on the same host, for the asset-scope checks
const otherSource = sources.find((s) => s.url !== srcWithSlug.url && new RegExp(`:${CDN_BASE}/p/`).test(s.url));
const slugB = otherSource.url.split("/p/")[1];

const noToken = await fetch(srcWithSlug.url, { headers: { Range: "bytes=0-1" } });
ok("media without mg= is refused", noToken.status === 403, `status ${noToken.status}`);

const withToken = await fetch(`${srcWithSlug.url}?mg=${encodeURIComponent(token)}`, { headers: { Range: "bytes=0-1" } });
ok("media with mg= is served", withToken.status === 206, `status ${withToken.status}`);
ok("range response is 2 bytes", Number(withToken.headers.get("content-length")) === 2,
  `content-length ${withToken.headers.get("content-length")}`);

const wrongSlug = await fetch(`${CDN_A}/p/does-not-exist?mg=${encodeURIComponent(token)}`);
ok("unknown slug still 404", wrongSlug.status === 404, `status ${wrongSlug.status}`);

// a sibling title's slug is a different asset, so an asset-scoped token will not do
const siblingSlug = other.episodes[0].sources[0].url.split("/p/")[1];
const crossTitle = await fetch(`${CDN_A}/p/${siblingSlug}?mg=${encodeURIComponent(token)}`, { headers: { Range: "bytes=0-1" } });
ok("a host-scoped token still works across titles on the same host", crossTitle.status === 206, `status ${crossTitle.status}`);

// tokens are scoped to the host that issues them
const onOtherCdn = sources.find((s) => new RegExp(`:${CDN_BASE + 1}/p/`).test(s.url));
const crossCdn = await fetch(`${onOtherCdn.url}?mg=${encodeURIComponent(token)}`, { headers: { Range: "bytes=0-1" } });
ok("host-scoped token refused by a sibling host", crossCdn.status === 403, `status ${crossCdn.status}`);

const cdnBGate = await (await fetch(`${CDN_B}/g`)).json();
ok("sibling host mints its own token", cdnBGate.ok === true && cdnBGate.g !== token && cdnBGate.host === "cdn-b");
const withSiblingToken = await fetch(`${onOtherCdn.url}?mg=${encodeURIComponent(cdnBGate.g)}`, { headers: { Range: "bytes=0-1" } });
ok("sibling token plays on its own host", withSiblingToken.status === 206, `status ${withSiblingToken.status}`);

// asset scope: a token minted for one slug cannot be replayed for another
const assetA = (await (await fetch(`${CDN_A}/g?s=${slugA}`)).json()).g;
const assetB = (await (await fetch(`${CDN_A}/g?s=${slugB}`)).json()).g;
ok("asset-scoped tokens differ per slug", assetA !== assetB, `${slugA} vs ${slugB}`);
const replayed = await fetch(`${otherSource.url}?mg=${encodeURIComponent(assetA)}`, { headers: { Range: "bytes=0-1" } });
ok("asset-scoped token rejected for another slug", replayed.status === 403, `status ${replayed.status}`);
const ownAsset = await fetch(`${srcWithSlug.url}?mg=${encodeURIComponent(assetA)}`, { headers: { Range: "bytes=0-1" } });
ok("asset-scoped token accepted for its own slug", ownAsset.status === 206, `status ${ownAsset.status}`);

const brokenSrc = sources.find((s) => new RegExp(`:${CDN_BASE + 2}/p/`).test(s.url));
const broken = await fetch(`${brokenSrc.url}?mg=${encodeURIComponent(token)}`);
ok("broken mirror returns 503", broken.status === 503, `status ${broken.status}`);

// ---- 5. expiry -----------------------------------------------------------
await fetch(`${SITE}/api/dev/expire-tokens`, { method: "POST" });
const afterExpiry = await fetch(`${srcWithSlug.url}?mg=${encodeURIComponent(token)}`, { headers: { Range: "bytes=0-1" } });
ok("token stops working after rotation", afterExpiry.status === 403, `status ${afterExpiry.status}`);
const fresh = await (await fetch(`${CDN_A}/g`)).json();
const afterRemint = await fetch(`${srcWithSlug.url}?mg=${encodeURIComponent(fresh.g)}`, { headers: { Range: "bytes=0-1" } });
ok("re-minted token works again", afterRemint.status === 206, `status ${afterRemint.status}`);
await fetch(`${SITE}/api/dev/rotate-back`, { method: "POST" });

// ---- 6. health aggregation ----------------------------------------------
const st0 = await (await fetch(`${SITE}/api/dev/state`)).json();
ok("server state lists the titles", Array.isArray(st0.titles) && st0.titles.length >= 4,
  (st0.titles || []).map((t) => t.id).join(", "));
ok("server state keys sources by <title>:<source> id",
  st0.sources.every((s) => s.gid === `${s.title_id}:${s.id}`));

const gid720 = "demo-feature:src-720-a";
ok("720p starts healthy/unknown",
  st0.sources.find((s) => s.gid === gid720).health.audio_status === "unknown");

const c720 = sources.find((s) => s.id === "src-720-a");
const report = (cid, event = "no_audio", evidence = "decoded-bytes-zero") =>
  fetch(`${SITE}/media/health`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ event, evidence, token: c720.health_token, cid }).toString(),
  }).then((r) => r.json());

const h1 = await report("viewer-1");
ok("viewer 1 reports no_audio -> suspected", h1.health && h1.health.audio_status === "suspected",
  `${h1.health && h1.health.audio_status} reports=${h1.health && h1.health.reports} remaining=${h1.health && h1.health.remaining}`);

const dup = await report("viewer-1");
ok("the same viewer cannot double-count", dup.duplicate === true, JSON.stringify(dup));

const h2 = await report("viewer-2");
ok("viewer 2 reaches the threshold -> no_audio + verified",
  h2.health && h2.health.audio_status === "no_audio" && h2.health.verified === true,
  `${h2.health && h2.health.audio_status} verified=${h2.health && h2.health.verified}`);

const bad = await (await fetch(`${SITE}/media/health`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ event: "no_audio", evidence: "x", token: "not.a.token" }).toString(),
})).json();
ok("forged health token rejected", bad.ok === false, JSON.stringify(bad));

const sameTitle = (await getConfig("demo-feature")).json.episodes[0].sources.find((s) => s.id === "src-720-a");
ok("next page load ships the degraded health", sameTitle.health.audio_status === "no_audio",
  `${sameTitle.health.audio_status} reports=${sameTitle.health.reports}`);

// health is per (title, source): the same source id in another title is untouched
const otherTitle = (await getConfig("big-buck-bunny")).json.episodes[0].sources.find((s) => s.id === "src-720-b");
ok("health does not bleed into another title's source", otherTitle.health.audio_status === "unknown",
  otherTitle.health.audio_status);

await fetch(`${SITE}/api/dev/heal`, { method: "POST" });
const healed = (await getConfig("demo-feature")).json.episodes[0].sources.find((s) => s.id === "src-720-a");
ok("heal resets to unknown", healed.health.audio_status === "unknown", healed.health.audio_status);

// ---- 7. parity routes ----------------------------------------------------
const shot = await (await fetch(`${SITE}/api/shot-meta.php?u=/media/poster.svg`)).json();
ok("shot-meta.php contract", typeof shot.n === "number" && typeof shot.r === "number", JSON.stringify(shot));
const ev = await (await fetch(`${SITE}/media/event`, { method: "POST", body: "event=view&token=x" })).json();
ok("player-event.php contract", ev.ok === true && typeof ev.views === "number", JSON.stringify(ev));
const pm = await (await fetch(`${SITE}/api/player-media.php?t=src-720-a`)).json();
ok("player-media.php resolve route", pm.ok === true && typeof pm.url === "string", pm.url);

// ---- 8. adding a title is a file drop, with no restart --------------------
let hadManifest = false;
let original = null;
try {
  original = await readFile(MANIFEST, "utf8");
  hadManifest = true;
} catch { /* no manifest yet */ }

try {
  // Start from a known-empty manifest: the assertion below measures a delta,
  // so it must not depend on whatever the store happened to contain already.
  await writeFile(MANIFEST, JSON.stringify({ titles: [] }), "utf8");
  const before = (await catalogue()).count;

  await writeFile(MANIFEST, JSON.stringify({
    titles: [{
      id: "just-added",
      title: "Just Added",
      year: 2026,
      categories: ["New on the demo"],
      description: "Written by selftest.mjs to prove the manifest is re-read live.",
      sources: [{ file: "audio-720.mp4", quality: 720, best: true, audio: "Hindi" }],
    }],
  }), "utf8");

  const after = await catalogue();
  ok("a title added to library.json appears with no restart", after.count === before + 1,
    `${before} -> ${after.count}`);
  ok("it gets its own row", after.rows.some((r) => r.name === "New on the demo"));
  const added = after.titles.find((t) => t.id === "just-added");
  ok("the new card is complete", Boolean(added && added.url === "/movie/just-added" && added.poster));

  const addedCfg = await getConfig("just-added");
  ok("its page serves a decodable config", Boolean(addedCfg) && addedCfg.json.title_id === "just-added");
  ok("its source is reachable through the gate",
    /\/p\/just-added--s1$/.test(addedCfg.json.episodes[0].sources[0].url),
    addedCfg.json.episodes[0].sources[0].url);
  ok("it gets a generated poster", (await fetch(`${SITE}/poster/just-added.svg`)).status === 200);

  // a manifest that mixes titles and loose sources is reported, not guessed at
  await writeFile(MANIFEST, JSON.stringify([{ file: "audio-720.mp4" }, { id: "x", sources: [] }]), "utf8");
  const mixed = await catalogue();
  ok("a mixed bare array is refused rather than misread", !mixed.titles.some((t) => t.id === "x"),
    `count=${mixed.count}`);
} finally {
  if (hadManifest) await writeFile(MANIFEST, original, "utf8");
  else await unlink(MANIFEST).catch(() => {});
}

const restored = await catalogue();
ok("removing the manifest removes the title again", !restored.titles.some((t) => t.id === "just-added"),
  `count=${restored.count}`);

// ---- 9. declared categories control order and sorting --------------------
try {
  await writeFile(MANIFEST, JSON.stringify({
    categories: [
      { id: "zebra", name: "Zebra First", order: 1 },
      { id: "alpha", name: "Alpha Second", order: 2, sort: "year" },
    ],
    titles: [
      { id: "old-one", title: "Old One", year: 1999, categories: ["Alpha Second"], sources: [{ file: "audio-720.mp4", quality: 720 }] },
      { id: "new-one", title: "New One", year: 2026, categories: ["Zebra First"], sources: [{ file: "audio-360.mp4", quality: 360 }] },
    ],
  }), "utf8");

  const declared = await catalogue();
  const ours = declared.rows.filter((r) => ["zebra", "alpha"].includes(r.id)).map((r) => r.id);
  ok("declared order wins over name order", ours.join(",") === "zebra,alpha", ours.join(","));
  ok("a reference by display name resolves to the declared id",
    declared.titles.find((t) => t.id === "old-one").categories.includes("alpha"));
  ok("a declared category keeps its display name",
    declared.categories.find((c) => c.id === "zebra").name === "Zebra First");
  ok("an undeclared reference becomes a derived category",
    declared.categories.every((c) => c.id !== "alpha" || c.derived === false));

  const alphaRow = declared.rows.find((r) => r.id === "alpha");
  ok("a place with one title has a page anyway",
    (await fetch(`${SITE}/category/alpha`)).status === 200 && alphaRow.titles.length === 1);
} finally {
  if (hadManifest) await writeFile(MANIFEST, original, "utf8");
  else await unlink(MANIFEST).catch(() => {});
}

// ---- 10. admin ------------------------------------------------------------
// Two contracts, and only one of them is testable per run: with ADMIN_TOKEN
// set the routes work, without it they must be invisible. Run this file with
// the same ADMIN_TOKEN as the server to exercise the first.
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
const ADMIN_HEADERS = { "X-Admin-Token": ADMIN_TOKEN };

if (!ADMIN_TOKEN) {
  ok("without ADMIN_TOKEN the admin api is 404, not 403",
    (await fetch(`${SITE}/api/admin/state`)).status === 404);
  ok("without ADMIN_TOKEN the admin page is 404",
    (await fetch(`${SITE}/admin`)).status === 404);
  console.log("SKIP  admin write tests — restart the server with ADMIN_TOKEN set and re-run with the same value");
} else {
  const json = (r) => r.json();
  const adminPost = (path, body) =>
    fetch(`${SITE}${path}`, {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  ok("admin page is served when configured", (await fetch(`${SITE}/admin`)).status === 200);
  ok("admin api refuses a missing token", (await fetch(`${SITE}/api/admin/state`)).status === 401);
  ok("admin api refuses a wrong token",
    (await fetch(`${SITE}/api/admin/state`, { headers: { "X-Admin-Token": "nope" } })).status === 401);
  ok("conversion is behind the same token as the rest of the admin",
    (await fetch(`${SITE}/api/admin/convert`)).status === 401);
  ok("publishing to Blob storage is behind the same token",
    (await fetch(`${SITE}/api/admin/azure`)).status === 401);

  const st1 = await (await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS })).json();
  ok("admin state exposes the library and the storage folder",
    st1.ok === true && Array.isArray(st1.titles) && Array.isArray(st1.files) && typeof st1.key === "string",
    `key=${st1.key} titles=${st1.titles.length} files=${st1.files.length}`);
  ok("admin state says whether Blob storage is usable, and at what scope",
    st1.azure && typeof st1.azure.configured === "boolean" &&
    (st1.azure.configured ? st1.azure.scope === "container" : st1.azure.container === null),
    JSON.stringify(st1.azure && { configured: st1.azure.configured, scope: st1.azure.scope }));
  if (st1.azure && !st1.azure.configured) {
    const refused = await adminPost("/api/admin/azure?file=anything.mp4", {});
    const body = await refused.json().catch(() => null);
    ok("with no Blob storage configured the site refuses the upload and says why",
      refused.status === 503 && body && body.error === "azure_off",
      `${refused.status} ${body && body.error}`);
  }
  ok("admin state says whether conversion is possible, and with which encoder",
    st1.conversion && typeof st1.conversion.available === "boolean" &&
    typeof st1.conversion.encoder === "string" && typeof st1.conversion.dir === "string",
    JSON.stringify(st1.conversion));
  ok("built-in demo titles are flagged read-only",
    st1.titles.filter((t) => ["demo-feature", "sintel", "big-buck-bunny", "failover-drill"].includes(t.id))
      .every((t) => t.builtin === true));

  // the same bytes as a real clip, so the upload path is exercised end to end
  // A run that was interrupted can leave its own fixture behind; clearing it
  // first keeps the derived-name assertion deterministic.
  for (const f of st1.files.filter((x) => /^selftest-movie-720(-\d+)?\.mp4$/.test(x.name))) {
    await unlink(join(STORAGE, f.name)).catch(() => {});
  }
  for (const n of ["selftest-movie-720.jpg", "selftest-movie-720-2.jpg"]) {
    await unlink(join(STORAGE, "posters", n)).catch(() => {});
  }
  const clip = await readFile(join(STORAGE, "audio-720.mp4"));
  const upRes = await fetch(
    `${SITE}/api/admin/upload?name=Selftest.Movie.720p.mp4&title=Selftest%20Movie&quality=720`,
    { method: "POST", headers: ADMIN_HEADERS, body: clip });
  const up = await json(upRes);
  ok("upload accepts a video and returns a server-derived name",
    upRes.status === 200 && up.ok === true && /^selftest-movie-720\.mp4$/.test(up.file), JSON.stringify(up));
  ok("the stored name does not come from the client's file name",
    !up.file.includes("Selftest.Movie") && up.original === "Selftest.Movie.720p.mp4");
  ok("the uploaded bytes are what arrived", up.bytes === clip.length, `${up.bytes} vs ${clip.length}`);
  ok("upload reports what the file really is",
    up.probe && up.probe.container === "mp4" && up.probe.video && up.probe.video.codec === "h264" &&
    up.probe.playable === true,
    JSON.stringify(up.probe && { container: up.probe.container, codec: up.probe.video && up.probe.video.codec }));
  ok("a browser-safe upload raises no warning", Array.isArray(up.warnings) && up.warnings.length === 0,
    JSON.stringify(up.warnings));

  // A poster is taken from the upload itself when ffmpeg is available, so a new
  // title never lands on the shelf as a grey rectangle.
  if (st1.conversion && st1.conversion.available) {
    ok("upload takes a poster frame from the video",
      typeof up.poster === "string" && /^\/poster\/[A-Za-z0-9_-]+\.jpg$/.test(up.poster), String(up.poster));
    const posterRes = await fetch(`${SITE}${up.poster}`);
    const posterBytes = Buffer.from(await posterRes.arrayBuffer());
    ok("that poster is a real JPEG, served as an image",
      posterRes.status === 200 && String(posterRes.headers.get("content-type")).startsWith("image/jpeg") &&
      posterBytes[0] === 0xff && posterBytes[1] === 0xd8 && posterBytes.length > 1000,
      `${posterRes.status} ${posterRes.headers.get("content-type")} ${posterBytes.length} bytes`);
  }
  ok("an unknown poster frame is 404, not a directory listing",
    (await fetch(`${SITE}/poster/not-a-real-file/../../library`)).status === 404 &&
    (await fetch(`${SITE}/poster/nope.jpg`)).status === 404);

  const badExt = await fetch(`${SITE}/api/admin/upload?name=notes.txt`, { method: "POST", headers: ADMIN_HEADERS, body: "x" });
  ok("upload refuses an extension that is not video", badExt.status === 400, `status ${badExt.status}`);

  const created = await json(await adminPost("/api/admin/title", {
    key: st1.key,
    title: "Selftest Movie",
    year: 2026,
    categories: ["selftest"],
    description: "Created by selftest.mjs through the admin API.",
    tags: ["Test"],
    sources: [{ file: up.file, quality: 720, cdn: 0, audio: "Hindi", best: true }],
  }));
  ok("admin creates a movie", created.ok === true && created.id === "selftest-movie" && created.created === true,
    JSON.stringify(created));

  const afterCreate = await catalogue();
  const mine = afterCreate.titles.find((t) => t.id === "selftest-movie");
  ok("the new movie shows up in the catalogue with no restart", Boolean(mine), `count=${afterCreate.count}`);
  ok("its category was created from the reference", Boolean(afterCreate.categories.find((c) => c.id === "selftest")));
  ok("its own page renders", (await fetch(`${SITE}/movie/selftest-movie`)).status === 200);
  ok("its category page renders", (await fetch(`${SITE}/category/selftest`)).status === 200);
  if (st1.conversion && st1.conversion.available) {
    ok("a title saved without artwork falls back to a frame of its own video",
      Boolean(mine && /^\/poster\/selftest-movie-720(-2)?\.jpg$/.test(mine.poster)), String(mine && mine.poster));
  }

  const cfgNew = await getConfig("selftest-movie");
  ok("its config is decodable and points at its own source",
    Boolean(cfgNew) && cfgNew.json.title_id === "selftest-movie" &&
    cfgNew.json.episodes[0].sources.length === 1, cfgNew && cfgNew.json.episodes[0].sources[0].url);

  const newSrc = cfgNew.json.episodes[0].sources[0];
  ok("the codec travels into the player config, so the player stops guessing",
    newSrc.codec === "h264" && newSrc.hevc === false && newSrc.playable === true,
    `${newSrc.codec}/${newSrc.hevc}/${newSrc.playable}`);
  const newGate = await (await fetch(`${CDN_A}/g`)).json();
  ok("a movie added through the admin actually streams",
    (await fetch(`${newSrc.url}?mg=${encodeURIComponent(newGate.g)}`, { headers: { Range: "bytes=0-1" } })).status === 206);

  const stale = await adminPost("/api/admin/title", {
    key: "1.1", title: "Stale Movie", sources: [{ file: up.file, quality: 480 }],
  });
  ok("a write with a stale key is refused with 409", stale.status === 409, `status ${stale.status}`);

  const invalid = await json(await adminPost("/api/admin/title", {
    key: (await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS }))).key,
    title: "",
    year: 1200,
    sources: [{ file: "../../etc/passwd", quality: 720 }],
  }));
  ok("validation rejects a bad title, year and file path at once",
    Array.isArray(invalid.errors) && invalid.errors.length >= 3 &&
    invalid.errors.some((e) => /bare file name/.test(e)), JSON.stringify(invalid.errors));

  const hijack = await adminPost("/api/admin/title", {
    key: "absent", originalId: "sintel", title: "Hijacked", sources: [{ file: up.file, quality: 720 }],
  });
  ok("a built-in demo title cannot be edited through the admin", hijack.status === 400, `status ${hijack.status}`);

  const keyNow = (await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS }))).key;
  const dupeBuiltin = await json(await adminPost("/api/admin/title", {
    key: keyNow, id: "sintel", title: "Someone Else", sources: [{ file: up.file, quality: 720 }],
  }));
  ok("taking a built-in title's id says who already holds it",
    dupeBuiltin.errors && dupeBuiltin.errors.includes('the id "sintel" is already used by "Sintel"'),
    JSON.stringify(dupeBuiltin.errors));
  const dupeMine = await json(await adminPost("/api/admin/title", {
    key: keyNow, id: "selftest-movie", title: "Another Name", sources: [{ file: up.file, quality: 720 }],
  }));
  ok("and it names a movie added earlier just as precisely",
    dupeMine.errors && dupeMine.errors.includes('the id "selftest-movie" is already used by "Selftest Movie"'),
    JSON.stringify(dupeMine.errors));

  const keyForDelete = (await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS }))).key;
  const del = await json(await fetch(
    `${SITE}/api/admin/title?id=selftest-movie&key=${encodeURIComponent(keyForDelete)}`,
    { method: "DELETE", headers: ADMIN_HEADERS }));
  ok("admin removes a movie and says the files are kept",
    del.ok === true && del.files_kept === true, JSON.stringify(del));
  ok("the removed movie is gone from the catalogue",
    !(await catalogue()).titles.some((t) => t.id === "selftest-movie"));

  const st2 = await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS }));
  const keptFile = st2.files.find((f) => f.name === up.file);
  ok("its file is still on disk", Boolean(keptFile));
  ok("and is now reported as unused rather than deleted",
    st2.orphans.includes(up.file) && keptFile && keptFile.referenced === false);

  // ---- 480p rendition ------------------------------------------------------
  // The player steps down to a smaller copy when a link cannot keep up, so the
  // pipeline has to be able to make one and the save path has to attach it to
  // the source it came from. A fixture of its own, so the test never deletes a
  // copy that was already on disk.
  const tallFixture = st1.files.some((f) => f.name === "check-720.mp4");
  if (tallFixture && st1.conversion.available && st1.conversion.rendition) {
    const tall = await readFile(join(STORAGE, "check-720.mp4"));
    const upTall = await json(await fetch(
      `${SITE}/api/admin/upload?name=Rendition.Source.720p.mp4&title=Rendition%20Source&quality=720`,
      { method: "POST", headers: ADMIN_HEADERS, body: tall }));
    const tallFile = upTall.file;
    const tallStem = String(tallFile).replace(/\.mp4$/, "");
    const smallFile = `${tallStem}-${st1.conversion.rendition}.mp4`;
    if (st1.files.some((f) => f.name === "audio-360.mp4")) {
      const tooSmallRes = await adminPost("/api/admin/convert?file=audio-360.mp4&rendition=1", {});
      const tooSmall = await tooSmallRes.json().catch(() => null);
      ok("a copy larger than its source is refused instead of upscaled",
        tooSmallRes.status === 400 && tooSmall && tooSmall.error === "already_small",
        `${tooSmallRes.status} ${tooSmall && tooSmall.error}`);
    }
    try {
      const started = await json(await adminPost(`/api/admin/convert?file=${encodeURIComponent(tallFile)}&rendition=1`, {}));      let job = started.job;
      const began = Date.now();
      while (job && job.status === "running" && Date.now() - began < 240000) {
        await new Promise((r) => setTimeout(r, 1000));
        job = (await json(await fetch(`${SITE}/api/admin/convert?id=${job.id}`, { headers: ADMIN_HEADERS }))).job;
      }
      ok("a file that already plays can be given a 480p copy",
        Boolean(job) && job.status === "done" && job.extra && job.extra.quality === 480,
        JSON.stringify(job && { status: job.status, error: job.error, extra: job.extra }));

      if (job && job.extra) {
        const small = await probeMedia(join(STORAGE, job.extra.file));
        ok("that copy really is 480p H.264",
          small.video && small.video.codec === "h264" && small.video.height <= 480,
          `${small.video && small.video.codec} ${small.video && small.video.width}x${small.video && small.video.height}`);

        const saveKey = (await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS }))).key;
        await adminPost("/api/admin/title", {
          key: saveKey, id: "rendition-test", title: "Rendition Test",
          sources: [{ file: tallFile, quality: 720 }],
        });
        const made = (await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS })))
          .titles.find((t) => t.id === "rendition-test");
        ok("saving a title attaches the copy that sits beside its source",
          Boolean(made) && made.raw.sources.length === 2 &&
          made.raw.sources.some((s) => s.file === job.extra.file && s.quality === 480),
          JSON.stringify(made && made.raw.sources.map((s) => `${s.file}:${s.quality}`)));

        const card = (await catalogue()).titles.find((t) => t.id === "rendition-test");
        ok("the catalogue then offers both qualities, so Auto has somewhere to step down",
          Boolean(card) && card.qualities.join(",") === "720,480", card && card.qualities.join(","));

        const cleanupKey = (await json(await fetch(`${SITE}/api/admin/state`, { headers: ADMIN_HEADERS }))).key;
        await fetch(`${SITE}/api/admin/title?id=rendition-test&key=${encodeURIComponent(cleanupKey)}`,
          { method: "DELETE", headers: ADMIN_HEADERS });
      }
    } finally {
      await unlink(join(STORAGE, tallFile)).catch(() => {});
      await unlink(join(STORAGE, smallFile)).catch(() => {});
      await unlink(join(STORAGE, "posters", `${tallStem}.jpg`)).catch(() => {});
    }
  }

  // put everything back the way we found it: the file, and the manifest the
  // admin created for the test movie.
  await unlink(join(STORAGE, up.file)).catch(() => {});
  // The poster taken from that upload is part of what the test created.
  if (up.poster) await unlink(join(STORAGE, "posters", String(up.poster).split("/").pop())).catch(() => {});
  if (hadManifest) await writeFile(MANIFEST, original, "utf8");
  else await unlink(MANIFEST).catch(() => {});

  ok("the admin test left the library as it found it",
    (await catalogue()).count === restored.count, `count=${(await catalogue()).count}`);
}

// ---------------------------------------------------------------------------
// 11. media identification
// ---------------------------------------------------------------------------
// Synthetic headers, so the verdict is tested against a fixture instead of
// whatever happens to be in storage/ today (a real film gets deleted, a
// fixture does not). Only the header matters: that is all the probe reads.
const hex = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const ebmlEl = (idHex, ...parts) => {
  const payload = Buffer.concat(parts);
  const size = Buffer.alloc(8);
  // 8-byte vint: marker 0x01 in the top byte, length in the low 7 bytes.
  // writeUIntBE tops out at 6 bytes, so write the whole thing as BigInt.
  size.writeBigUInt64BE(0x0100000000000000n + BigInt(payload.length), 0);
  return Buffer.concat([hex(idHex), size, payload]);
};
const ebmlStr = (idHex, value) => ebmlEl(idHex, Buffer.from(value, "latin1"));
const ebmlUint = (idHex, value, width = 2) => {
  const b = Buffer.alloc(width);
  b.writeUIntBE(value, 0, width);
  return ebmlEl(idHex, b);
};

const mkvBytes = Buffer.concat([
  ebmlEl("1a45dfa3", ebmlStr("4282", "matroska")),
  ebmlEl("18538067", ebmlEl("1654ae6b",
    ebmlEl("ae", ebmlUint("d7", 1, 1), ebmlUint("83", 1, 1), ebmlStr("86", "V_MPEGH/ISO/HEVC"),
      ebmlEl("e0", ebmlUint("b0", 1920), ebmlUint("ba", 800))),
    ebmlEl("ae", ebmlUint("d7", 2, 1), ebmlUint("83", 2, 1), ebmlStr("86", "A_AAC"),
      ebmlEl("e1", ebmlUint("9f", 6, 1))),
  )),
]);
const mkvVerdict = probeSlices({ prefix: mkvBytes, ext: ".mkv" });
ok("an HEVC Matroska file is read as HEVC + AAC and called unplayable",
  mkvVerdict.container === "mkv" && mkvVerdict.video && mkvVerdict.video.codec === "hevc" &&
  mkvVerdict.video.width === 1920 && mkvVerdict.audio.length === 1 &&
  mkvVerdict.audio[0].codec === "aac" && mkvVerdict.audio[0].channels === 6 &&
  mkvVerdict.playable === false,
  JSON.stringify(mkvVerdict));
ok("and the reason names both the container and the codec",
  /Matroska/.test(mkvVerdict.reason || "") && /HEVC/.test(mkvVerdict.reason || ""), mkvVerdict.reason);

const mp4Box = (type, ...parts) => {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};
// Sample entries: payload offsets match ISO/IEC 14496-12 (§12.1.3, §12.2.3).
const visual = (fourcc, w, h) => {
  const b = Buffer.alloc(78);
  b.writeUInt16BE(w, 24);
  b.writeUInt16BE(h, 26);
  return mp4Box(fourcc, b);
};
const auditory = (fourcc, channels) => {
  const b = Buffer.alloc(28);
  b.writeUInt16BE(channels, 16);
  return mp4Box(fourcc, b);
};
const trak = (handler, entry) => mp4Box("trak",
  mp4Box("mdia",
    mp4Box("hdlr", Buffer.alloc(8), Buffer.from(handler, "latin1"), Buffer.alloc(13)),
    mp4Box("minf", mp4Box("stbl", mp4Box("stsd", Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), entry))),
  ),
);

const mp4Verdict = probeSlices({
  prefix: Buffer.concat([
    mp4Box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isomiso2avc1mp41")),
    mp4Box("moov", trak("vide", visual("avc1", 1280, 720)), trak("soun", auditory("mp4a", 2))),
  ]),
  ext: ".mp4",
});
ok("an H.264/AAC MP4 is read as playable, with its dimensions",
  mp4Verdict.container === "mp4" && mp4Verdict.video && mp4Verdict.video.codec === "h264" &&
  mp4Verdict.video.width === 1280 && mp4Verdict.video.height === 720 &&
  mp4Verdict.audio.length === 1 && mp4Verdict.audio[0].codec === "aac" &&
  mp4Verdict.playable === true,
  JSON.stringify(mp4Verdict));

const hevcMp4Verdict = probeSlices({
  prefix: Buffer.concat([
    mp4Box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isomiso2hvc1mp41")),
    mp4Box("moov", trak("vide", visual("hvc1", 1920, 1080)), trak("soun", auditory("mp4a", 6))),
  ]),
  ext: ".mp4",
});
ok("HEVC inside MP4 is still called out, not excused by the container",
  hevcMp4Verdict.video && hevcMp4Verdict.video.codec === "hevc" && hevcMp4Verdict.playable === false,
  JSON.stringify({ codec: hevcMp4Verdict.video && hevcMp4Verdict.video.codec, playable: hevcMp4Verdict.playable }));

const unknownVerdict = probeSlices({ prefix: Buffer.from("this is not a video container"), ext: ".bin" });
ok("an unidentified file is neither blessed nor condemned",
  unknownVerdict.playable === null && unknownVerdict.reason === null, JSON.stringify(unknownVerdict));

// ---- conversion plan ---------------------------------------------------------
// The plan is pure data, so the decision that costs hours of CPU is testable
// without running ffmpeg at all: remux when the codecs are already safe, and a
// real re-encode when they are not.

const mkvHevc = { container: "mkv", video: { codec: "hevc", width: 1920, height: 800 }, audio: [{ codec: "aac" }] };
const mkvH264 = { container: "mkv", video: { codec: "h264", width: 1920, height: 1080 }, audio: [{ codec: "aac" }] };
const mp4Hevc = { container: "mp4", video: { codec: "hevc", width: 1920, height: 1080 }, audio: [{ codec: "aac" }] };
const mp4Aac = { container: "mp4", video: { codec: "h264", width: 1280, height: 720 }, audio: [{ codec: "aac" }] };
const mkvAc3 = { container: "mkv", video: { codec: "h264", width: 1280, height: 720 }, audio: [{ codec: "ac3" }] };
const flag = (args, key) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };

const hevcPlan = planConversion(mkvHevc);
ok("HEVC in Matroska is a re-encode, not a container swap",
  hevcPlan && hevcPlan.kind === "transcode" && flag(hevcPlan.args, "-c:v") === "libx264" &&
  hevcPlan.args.includes("-sn"), JSON.stringify(hevcPlan && hevcPlan.args));
ok("the re-encode keeps one audio track and drops subtitles",
  hevcPlan && hevcPlan.args.join(" ").includes("-map 0:a:0") && hevcPlan.args.includes("-sn") &&
  !hevcPlan.args.includes("0:s:0"), JSON.stringify(hevcPlan && hevcPlan.args));

const h264MkvPlan = planConversion(mkvH264);
ok("H.264 in Matroska only needs the container changed",
  h264MkvPlan && h264MkvPlan.kind === "remux" && flag(h264MkvPlan.args, "-c") === "copy",
  JSON.stringify(h264MkvPlan && h264MkvPlan.args));

ok("an MP4 that already plays needs nothing at all", planConversion(mp4Aac) === null);
ok("HEVC inside MP4 is not excused by the container", planConversion(mp4Hevc).kind === "transcode");
ok("AC-3 sound alone forces a re-encode", planConversion(mkvAc3).kind === "transcode");

const amfPlan = planConversion(mkvHevc, { encoder: "h264_amf", bitrate: "2500k" });
ok("a hardware encoder is driven by bitrate, not CRF",
  amfPlan && flag(amfPlan.args, "-c:v") === "h264_amf" && flag(amfPlan.args, "-b:v") === "2500k" &&
  !amfPlan.args.includes("-crf"), JSON.stringify(amfPlan && amfPlan.args));

const tonePlan = planConversion(mkvHevc, { tonemap: true });
ok("an HDR source gets tonemapped into SDR instead of coming out grey",
  tonePlan && tonePlan.args.includes("-vf") && flag(tonePlan.args, "-vf").includes("tonemap"),
  flag(tonePlan && tonePlan.args, "-vf"));

const downPlan = planConversion(mkvHevc, { maxHeight: 720 });
ok("a height cap becomes a scaling filter, aspect ratio preserved",
  downPlan && flag(downPlan.args, "-vf") === "scale=-2:720", flag(downPlan && downPlan.args, "-vf"));

const renditionPlan = planRendition({ height: 480, hasAudio: true });
ok("a rendition is a 480p H.264/AAC encode of the same film",
  renditionPlan && flag(renditionPlan.args, "-vf") === "scale=-2:480" &&
  flag(renditionPlan.args, "-c:v") === "libx264" && renditionPlan.args.includes("-c:a"),
  JSON.stringify(renditionPlan && renditionPlan.args));

ok("isHdr recognises PQ and HLG, and leaves SDR alone",
  isHdr({ streams: [{ codec_type: "video", color_transfer: "smpte2084" }] }) === true &&
  isHdr({ streams: [{ codec_type: "video", color_transfer: "arib-std-b67" }] }) === true &&
  isHdr({ streams: [{ codec_type: "video", color_transfer: "bt709", color_primaries: "bt709" }] }) === false &&
  isHdr(null) === false);

// ---------------------------------------------------------------------------
// 12. Blob storage transport
// ---------------------------------------------------------------------------
// The SAS is the only credential the site holds, so what it accepts is worth
// pinning: a blob-scoped token must be seen as one (it cannot publish a
// library), and a pasted container URL must never carry a signature into
// library.json or a rendered page.
const cSas = parseSas("?sv=2021-08-06&sr=c&sig=abc%3D&se=2030-01-01T00%3A00%3A00Z");
ok("a container SAS is recognised as container-wide",
  cSas && cSas.scope === "container" && cSas.query.includes("sig=abc%3D"), JSON.stringify(cSas));
ok("a single-blob SAS is recognised, not mistaken for a container one",
  parseSas("sv=2021-08-06&sr=b&sig=abc")?.scope === "blob");
ok("a query without a signature is not a SAS at all",
  parseSas("sv=2021-08-06&sr=c") === null && parseSas("") === null);
ok("the container URL keeps its path and drops any pasted signature",
  containerBase("https://acct.blob.core.windows.net/movies?sv=1&sig=secret") ===
    "https://acct.blob.core.windows.net/movies" &&
  containerBase("https://acct.blob.core.windows.net/movies/") ===
    "https://acct.blob.core.windows.net/movies",
  containerBase("https://acct.blob.core.windows.net/movies?sv=1&sig=secret"));
ok("a non-http container URL is refused rather than half-used",
  containerBase("file:///H:/movies") === "" && containerBase("") === "");

const blobA = blobNameFor("My Film (2024).mp4", "v1");
const blobB = blobNameFor("My Film (2024).mp4", "v1");
ok("a published name is readable and safe for a URL path",
  /^v1\/[0-9a-f]{12}\/My_Film_2024\.mp4$/.test(blobA), blobA);
ok("the same file published twice does not overwrite the first copy",
  blobA !== blobB, `${blobA} vs ${blobB}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
