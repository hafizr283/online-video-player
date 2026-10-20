/**
 * MovieLinkBD-style inline player â€” reference server.
 *
 * One process, four listeners, because the real system talks to a CDN on a
 * different origin than the site:
 *
 *   8890  site          catalogue, per-title page, config injection, assets, mock APIs
 *   8891  CDN "A"       /g gate mint, /p/<slug> playback with Range, provider "MLBD CDN"
 *   8892  CDN "B"       same, provider "FastCloud CDN"  (mirror of 8891)
 *   8893  CDN "C"       same, but every media request fails  (broken mirror)
 *
 * Routes:
 *   /                    catalogue: rows of titles, Netflix-style
 *   /movie/<id>          one title: injected player config + "more titles"
 *   /category/<id>       every title in one category, as a grid
 *   /api/catalogue.json  the listing both pages render from
 *   /api/category/<id>.json  one category and its cards
 *   /poster/<id>.svg     generated poster, so a new title needs no image
 *   /admin               add/edit movies (disabled unless ADMIN_TOKEN is set)
 *
 * Adding a title needs no code change and no restart: the admin writes
 * storage/library.json, which is re-read whenever its mtime or size changes.
 *
 * Everything the real player depends on is reproduced and, unlike the original,
 * the gate token is actually verified server-side.
 */
import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { readFile, readdir, rename, rm, stat, unlink, writeFile, mkdir, statfs, copyFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { probeMedia } from "./media-probe.mjs";
import { putBlob, headBlob, deleteBlob, parseSas, containerBase, blobNameFor } from "./azure-blob.mjs";
import {
  findFfmpeg, findFfprobe, ffprobeDetails, isHdr, durationOf, planConversion, planRendition,
  runConversion, capturePoster, shrinkImage,
} from "./media-convert.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
// Video originals live OUTSIDE the web root. The site origin can only reach
// public/, so the files are playable solely through the CDN's gated
// /p/<slug>?mg= route - there is no static path that skips the gate.
// Media and the manifest default to ./storage. STORAGE_DIR points them at a
// roomier disk without touching the code: the gate, the admin, the orphan list
// and the library file all read this one path.
const STORAGE = resolve(process.env.STORAGE_DIR || join(HERE, "storage"));
const MANIFEST = join(STORAGE, "library.json");

const SITE_PORT = Number(process.env.PORT || process.env.SITE_PORT || 8890);
const BIND_HOST = process.env.HOST || "127.0.0.1";

/**
 * How the mirrors are addressed.
 *
 *   "port" (default) - one listener per mirror on consecutive ports, exactly as
 *                      the desktop build runs them.
 *   "path"           - one listener; mirrors are mounted at /cdn/<label>. This is
 *                      the only shape that works behind a tunnel, because a
 *                      tunnel publishes one host:port and no others.
 */
const MIRROR_MODE = process.env.MIRROR_MODE === "path" ? "path" : "port";

/**
 * The origin browsers should use. Empty means "derive it from the request",
 * which is what a tunnel needs: the public hostname changes per tunnel and is
 * only visible in the forwarded headers.
 */
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const HIDE_SEEDS = process.env.HIDE_SEEDS === "1";
const DEV_PANEL = process.env.DEV_PANEL === "1";
// A public deployment normally manages its library from the machine it runs on.
// With this on, admin routes answer 404 to anything that arrived through a
// proxy, so a leaked token alone is not enough to reach them from the internet.
const ADMIN_LOCAL_ONLY = process.env.ADMIN_LOCAL_ONLY === "1";

const GATE_SECRET = process.env.GATE_SECRET || "demo-gate-secret-please-rotate";
const HEALTH_SECRET = process.env.HEALTH_SECRET || "demo-health-secret-please-rotate";
const KEY_ID = "152306"; // same shape as the real "<exp>.<keyid>.<sig>" token
const TOKEN_TTL_S = 600;
const CDN_BASE_PORT = Number(process.env.CDN_BASE_PORT || 8891);

/**
 * Logical CDN hosts. Each has its own origin (port), its own gate, and a
 * priority: lower wins when two sources are otherwise equal.
 */
const CDNS = [
  { port: CDN_BASE_PORT, provider: "MLBD CDN", priority: 1, label: "cdn-a", media: STORAGE },
  { port: CDN_BASE_PORT + 1, provider: "FastCloud CDN", priority: 2, label: "cdn-b", media: STORAGE },
  { port: CDN_BASE_PORT + 2, provider: "Fallback CDN", priority: 3, label: "cdn-c", media: STORAGE, broken: true },
];

const firstHeader = (value) => String(value || "").split(",")[0].trim();

/** The public origin of this request, as the browser sees it. */
function publicBase(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const proto = firstHeader(req.headers["x-forwarded-proto"]) || "http";
  const host = firstHeader(req.headers["x-forwarded-host"] || req.headers.host) || `${BIND_HOST}:${SITE_PORT}`;
  return `${proto}://${host}`;
}

/** The origin a browser should use for one mirror, under the current mode. */
function mirrorOrigin(req, cdn) {
  const base = publicBase(req);
  if (MIRROR_MODE === "path") return `${base}/cdn/${cdn.label}`;
  const u = new URL(base);
  return `${u.protocol}//${u.hostname}:${cdn.port}`;
}

/**
 * True only for a request that came straight from this machine. A reverse proxy
 * (the tunnel) always adds X-Forwarded-For, which is what separates a local
 * operator from a visitor.
 */
function isLocalRequest(req) {
  if (req.headers["x-forwarded-for"]) return false;
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// ---------------------------------------------------------------------------
// The library
//
// Two layers:
//   SEED_TITLES / SEED_CATEGORIES   built in, stand in for the real site's database
//   storage/library.json            the manifest, written by the admin
//
// Both go through the same normalizer, so there is one representation
// downstream. Categories are many-to-many: a title lists category references and
// the category list is either declared (for ordering and artwork) or derived
// from the references titles actually use.
//
// The demo deliberately reuses three public clips across several titles: the
// catalogue is what is being demonstrated, not the films.
// ---------------------------------------------------------------------------
const SEED_CATEGORIES = [
  { id: "featured", name: "Featured", order: 1 },
  { id: "animation", name: "Animation", order: 2 },
];

const SEED_TITLES = [
  {
    id: "demo-feature",
    fid: 16355,
    title: "Demo Feature",
    year: 2026,
    categories: ["featured"],
    poster: "/media/poster.svg",
    tags: ["Hindi", "Action", "1080p"],
    description:
      "A sample entry that ships with the library. Four renditions across three mirrors, so quality " +
      "selection and automatic failover can be tried before any real title is added.",
    subtitles: [{ url: "/subs/demo.vtt", label: "English (demo)", language: "en", kind: "subtitles" }],
    sources: [
      { id: "src-1080-a", quality: 1080, best: true, file: "silent-1080.mp4", cdn: 0, audio: "Hindi",
        name: "Demo.Feature.1080p.Hindi.AAC.h264.mp4", slug: "q1080-m1", unlock_id: "168fe5204c52da4d79d12f19" },
      { id: "src-720-a", quality: 720, file: "audio-720.mp4", cdn: 0, audio: "Hindi",
        name: "Demo.Feature.720p.Hindi.AAC.h264.mp4", slug: "q720-m1", unlock_id: "7a871fbd2dc69dde66e1da99" },
      { id: "src-360-a", quality: 360, file: "audio-360.mp4", cdn: 0, audio: "Hindi",
        name: "Demo.Feature.360p.Hindi.AAC.h264.mp4", slug: "q360-m1", unlock_id: "6f360e3718bced37ff211a5b" },
      // same 720p rendition on a second mirror -> exercises mirror selection
      { id: "src-720-b", quality: 720, file: "audio-720.mp4", cdn: 1, audio: "Hindi",
        name: "Demo.Feature.720p.Hindi.AAC.h264.mp4", slug: "q720-m2", unlock_id: "12cc1625a94220c603845567" },
      // a mirror that always fails -> exercises tier-3 failover
      { id: "src-1080-c", quality: 1080, file: "audio-720.mp4", cdn: 2, audio: "Hindi",
        name: "Demo.Feature.1080p.Hindi.AAC.h264.mp4", slug: "q1080-m3", unlock_id: "3f0e4b42a44731d93eb6e9a3" },
    ],
  },
  {
    id: "sintel",
    title: "Sintel",
    year: 2010,
    // two categories on purpose: a title can sit in as many rows as it belongs to
    categories: ["featured", "animation"],
    tags: ["Animation", "English"],
    description:
      "An open short film included as a second catalogue entry. Two renditions on separate mirrors " +
      "demonstrate source selection.",
    poster: "/posters/sintel.svg",
    sources: [
      { id: "src-720-a", quality: 720, best: true, file: "audio-720.mp4", cdn: 0, audio: "English" },
      { id: "src-360-b", quality: 360, file: "audio-360.mp4", cdn: 1, audio: "English" },
    ],
  },
  {
    id: "big-buck-bunny",
    title: "Big Buck Bunny",
    year: 2008,
    categories: ["animation"],
    tags: ["Animation", "1080p"],
    description:
      "An open animation short. Its best rendition carries no audio, so the player detects the problem " +
      "and moves down to a lower quality on its own.",
    sources: [
      { id: "src-1080-a", quality: 1080, best: true, file: "silent-1080.mp4", cdn: 0, audio: "Unknown" },
      { id: "src-720-b", quality: 720, file: "audio-720.mp4", cdn: 1, audio: "Unknown" },
    ],
  },
  {
    id: "failover-drill",
    title: "Failover Drill",
    year: 2026,
    categories: ["animation", "Drills"],
    tags: ["Hindi", "Mirrors"],
    description:
      "Every source points at the deliberately unavailable mirror, which makes this the quickest way " +
      "to watch the three-tier failover path end to end.",
    sources: [
      { id: "src-720-c", quality: 720, best: true, file: "audio-720.mp4", cdn: 2, audio: "Hindi" },
      { id: "src-360-c", quality: 360, file: "audio-360.mp4", cdn: 2, audio: "Hindi" },
    ],
  },
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function fnv1a(text) {
  let h = 2166136261 >>> 0;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** A stable, url-safe id from a display name. Category ids are derived here. */
function slugify(text) {
  const s = String(text).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "item";
}

const titleCase = (slug) => slug.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

/** Lookup by id and by display name, so a reference may use either. */
function categoryIndex(categories) {
  const byId = new Map();
  const byName = new Map();
  for (const c of categories) {
    byId.set(c.id, c);
    byName.set(c.name.trim().toLowerCase(), c);
  }
  return { byId, byName };
}

function normalizeCategory(raw, i) {
  const name = String(raw.name || raw.id || `Category ${i + 1}`).trim();
  const order = raw.order === undefined || raw.order === null || raw.order === "" ? i + 1 : Number(raw.order);
  return {
    id: slugify(raw.id || name),
    name,
    order: Number.isFinite(order) ? order : i + 1,
    sort: ["manual", "year", "name"].includes(raw.sort) ? raw.sort : "manual",
    poster: raw.poster ? String(raw.poster) : null,
    description: String(raw.description || ""),
  };
}

/**
 * A title references categories by id or by display name. A reference that
 * matches nothing declared still becomes a real category, derived from the
 * text. That is what lets a new movie invent a category without also editing
 * the category list: declaring a category controls its order and artwork, it
 * does not gate what may appear.
 *
 * The label is carried alongside the id rather than rebuilt from it, so an
 * undeclared "New on the demo" keeps the author's capitalisation instead of
 * being flattened to "New On The Demo".
 */
function normalizeCategoryRefs(raw, index) {
  const list = Array.isArray(raw.categories) ? raw.categories
    : typeof raw.collection === "string" ? [raw.collection] // manifests written before categories[]
    : [];
  const out = [];
  for (const item of list) {
    const text = typeof item === "string" ? item : item && (item.id || item.name);
    if (!text) continue;
    const key = String(text).trim();
    const hit = index.byId.get(key) || index.byId.get(slugify(key)) || index.byName.get(key.toLowerCase());
    const id = hit ? hit.id : slugify(key);
    if (!out.some((r) => r.id === id)) out.push({ id, label: hit ? hit.name : key });
  }
  return out;
}

function normalizeSource(raw, i, titleId) {
  const n = i + 1;
  const file = String(raw.file);
  return {
    id: String(raw.id || `src-${n}`),
    gid: "", // assigned by normalizeTitle: unique across the whole library
    mslug: "", // assigned by normalizeTitle: the public /p/<slug> handle
    title_id: titleId,
    quality: Number(raw.quality) || 480,
    file,
    container: String(raw.container || extname(file).slice(1) || "mp4"),
    // Filled in when the file was inspected. null means "not inspected", which
    // is different from "no": never report an unprobed file as unplayable.
    codec: String(raw.codec || ""),
    playable: raw.playable === true ? true : raw.playable === false ? false : null,
    cdn: clamp(Number(raw.cdn) || 0, 0, CDNS.length - 1),
    name: String(raw.name || file),
    audio: String(raw.audio || "Unknown"),
    slug: String(raw.slug || `s${n}`),
    unlock_id: String(raw.unlock_id || `${titleId}-${n}`),
    best: Boolean(raw.best),
    // A published copy in Blob storage, when the admin sent this file there.
    remote: normalizeRemote(raw.remote),
  };
}

/**
 * A blob we published. Only the facts the player needs: where it is, what it is
 * called there, and how big it was when we sent it. The URL is public by design
 * (the container is public-read); the unguessable path is the handle.
 */
function normalizeRemote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = String(raw.url || "");
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url,
    blob: String(raw.blob || ""),
    bytes: Number(raw.bytes) || 0,
    at: String(raw.at || ""),
  };
}

/**
 * One normalizer for seeded and manifest titles alike. Source ids are only
 * unique inside a title, so the global handles (gid for health, mslug for the
 * CDN path) are derived here and nowhere else.
 */
function normalizeTitle(raw, i, index) {
  const id = String(raw.id || raw.slug || `title-${i + 1}`);
  const refs = normalizeCategoryRefs(raw, index);
  const title = {
    id,
    fid: Number(raw.fid) || 10000 + (fnv1a(id) % 90000),
    title: String(raw.title || id),
    year: Number(raw.year) || null,
    categories: refs.map((r) => r.id),
    categoryLabels: Object.fromEntries(refs.map((r) => [r.id, r.label])),
    poster: raw.poster ? String(raw.poster) : null,
    description: String(raw.description || ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    subtitles: Array.isArray(raw.subtitles) ? raw.subtitles : [],
    sources: (Array.isArray(raw.sources) ? raw.sources : [])
      .filter((s) => s && typeof s.file === "string" && s.file)
      .map((s, j) => normalizeSource(s, j, id)),
  };
  for (const s of title.sources) {
    s.gid = `${title.id}:${s.id}`;
    s.mslug = `${title.id}--${s.slug}`;
  }
  return title;
}

const SEED_CATS = SEED_CATEGORIES.map(normalizeCategory);
const SEED = SEED_TITLES.map((raw, i) => normalizeTitle(raw, i, categoryIndex(SEED_CATS)));

/**
 * storage/library.json accepts:
 *
 *   { "titles": [...], "categories": [...] }   canonical
 *   [ { "id": ..., "sources": [...] } ]        titles only
 *   [ { "file": ..., "quality": ... } ]        one implicit title (legacy)
 *
 * A bare array must be homogeneous. Mixing titles and loose sources is
 * reported rather than guessed at, because guessing would attach files to the
 * wrong title.
 */
function manifestParts(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.titles) ? raw.titles : null;
  if (!list) {
    console.warn('[library] expected {"titles":[...]} or a bare array of sources');
    return { titles: [], categories: [] };
  }
  if (Array.isArray(raw)) {
    const everyTitle = list.every((e) => e && Array.isArray(e.sources));
    const everySource = list.every((e) => e && typeof e.file === "string");
    if (everyTitle) return { titles: list, categories: [] };
    if (everySource) {
      return {
        titles: [{ id: "my-library", title: "My Library", categories: ["my-library"], sources: list }],
        categories: [],
      };
    }
    console.warn("[library] a bare array must be all titles or all sources; ignoring storage/library.json");
    return { titles: [], categories: [] };
  }
  return { titles: list, categories: Array.isArray(raw.categories) ? raw.categories : [] };
}

async function readManifest() {
  try {
    return JSON.parse(stripBom(await readFile(MANIFEST, "utf8")));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`[library] storage/library.json ignored: ${e.message}`);
    return null;
  }
}

let libraryCache = { key: null, titles: [], categories: [] };

/** Re-read the manifest when mtime/size change, so adding a title needs no restart. */
async function libraryState() {
  let key = "absent";
  try { const st = await stat(MANIFEST); key = `${st.mtimeMs}:${st.size}`; } catch { /* no manifest */ }
  if (libraryCache.key === key) return libraryCache;

  const parts = key === "absent" ? { titles: [], categories: [] } : manifestParts(await readManifest());
  const categories = parts.categories.map(normalizeCategory);
  // Titles may reference a category declared in the same manifest, so the index
  // is built from both layers before any title is normalized. Manifest
  // declarations come first so they win a name clash with a built-in.
  const index = categoryIndex([...categories, ...SEED_CATS]);
  const titles = parts.titles.map((raw, i) => normalizeTitle(raw, i, index));
  libraryCache = { key, titles, categories };

  const all = [...SEED, ...titles];
  for (const t of titles) {
    if (!t.sources.length) console.warn(`[library] title "${t.id}" has no usable sources (each needs a "file")`);
  }
  const seenTitle = new Set();
  const seenSlug = new Set();
  const seenCategory = new Set();
  for (const c of categories) {
    if (seenCategory.has(c.id)) console.warn(`[library] duplicate category id "${c.id}" - the first declaration wins`);
    seenCategory.add(c.id);
  }
  for (const t of all) {
    if (seenTitle.has(t.id)) console.warn(`[library] duplicate title id "${t.id}" - only the first is reachable`);
    seenTitle.add(t.id);
    for (const s of t.sources) {
      if (seenSlug.has(s.mslug)) console.warn(`[library] duplicate media slug "${s.mslug}" - only the first is reachable`);
      seenSlug.add(s.mslug);
    }
  }
  if (titles.length) console.log(`[library] ${titles.length} title(s) from storage/library.json`);
  return libraryCache;
}

const libraryTitles = async () => (await libraryState()).titles;
const allTitles = async () => [...SEED, ...(await libraryTitles())];
const catalogue = async () => (HIDE_SEEDS ? libraryTitles() : allTitles());

const titleById = async (id) => (await catalogue()).find((t) => t.id === id) || null;

const posterUrl = (t) => t.poster || `/poster/${t.id}.svg`;

/**
 * Every category in play: declared ones in their declared order, then anything
 * a title invented (appended in first-use order). Declared categories therefore
 * control ordering and artwork without being a permission list.
 *
 * The manifest is merged before the seeds so declaring a category the demo
 * already ships (re-ordering "Animation", say) actually overrides the built-in
 * default instead of being ignored by first-wins.
 */
async function allCategories() {
  const declared = [...(await libraryState()).categories, ...SEED_CATS];
  const byId = new Map();
  for (const c of declared) if (!byId.has(c.id)) byId.set(c.id, { ...c, derived: false });
  for (const t of await allTitles()) {
    for (const id of t.categories) {
      if (byId.has(id)) continue;
      // The first title to use an undeclared category names it, using the text
      // its author wrote rather than the slug it was reduced to.
      const label = (t.categoryLabels && t.categoryLabels[id]) || titleCase(id);
      byId.set(id, {
        id, name: label, order: 1000 + byId.size, sort: "manual",
        poster: null, description: "", derived: true,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

const sortTitles = (titles, mode) => {
  if (mode === "year") return [...titles].sort((a, b) => (b.year || 0) - (a.year || 0));
  if (mode === "name") return [...titles].sort((a, b) => a.title.localeCompare(b.title));
  return titles;
};

/** The public shape of a title: no file paths, no gate tokens, no sources. */
const cardOf = (t) => ({
  id: t.id,
  title: t.title,
  year: t.year,
  poster: posterUrl(t),
  tags: t.tags,
  categories: t.categories,
  qualities: [...new Set(t.sources.map((s) => s.quality))].sort((a, b) => b - a),
  source_count: t.sources.length,
  description: t.description,
  url: `/movie/${t.id}`,
});

/** One category plus its cards: everything the category page needs. */
async function categoryJson(id) {
  const category = (await allCategories()).find((c) => c.id === id);
  if (!category) return null;

  const all = await catalogue();
  const members = sortTitles(all.filter((t) => t.categories.includes(id)), category.sort);

  // A category that neither the manifest declares nor any visible title uses is
  // not a page: hiding the built-in titles can leave a built-in category with
  // nothing in it, and that must be a 404 rather than an empty shelf.
  const declared = (await libraryState()).categories.some((c) => c.id === id);
  if (!members.length && !declared) return null;

  return {
    ok: true,
    category: { ...category, count: members.length },
    count: members.length,
    movies: members.map(cardOf),
    titles: members.map(cardOf),
  };
}

async function catalogueJson() {
  const all = await catalogue();
  const categories = await allCategories();
  const cards = new Map(all.map((t) => [t.id, cardOf(t)]));

  const rows = [];
  for (const c of categories) {
    const members = sortTitles(all.filter((t) => t.categories.includes(c.id)), c.sort);
    if (!members.length) continue;
    rows.push({ id: c.id, name: c.name, url: `/category/${c.id}`, titles: members.map((t) => cards.get(t.id)) });
  }
  // A title in no category must not vanish just because it was never filed; it
  // gets a row of its own rather than being silently dropped from the page.
  const loose = all.filter((t) => !t.categories.length).map((t) => cards.get(t.id));
  if (loose.length) rows.push({ id: "more-titles", name: "More to watch", url: null, titles: loose });

  const counts = new Map(categories.map((c) => [c.id, all.filter((t) => t.categories.includes(c.id)).length]));
  return {
    ok: true,
    count: all.length,
    // Empty categories are left out of the browse chrome: a chip that opens an
    // empty page is noise, and a built-in category with no visible titles must
    // not linger at zero.
    categories: categories
      .filter((c) => counts.get(c.id) > 0)
      .map((c) => ({ ...c, count: counts.get(c.id), url: `/category/${c.id}` })),
    rows,
    titles: all.map((t) => cards.get(t.id)),
  };
}

// ---------------------------------------------------------------------------
// Generated posters
//
// A title with no poster of its own still needs artwork, otherwise adding a
// video would mean sourcing an image first. The hue is derived from the id, so
// the same title always gets the same poster.
// ---------------------------------------------------------------------------
const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function wrapTitle(text, max = 14, maxLines = 3) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function posterSvg(t, w = 400, h = 600) {
  const hue = fnv1a(t.id) % 360;
  const hue2 = (hue + 45) % 360;
  const lines = wrapTitle(t.title);
  const top = h / 2 - ((lines.length - 1) * 34) / 2;
  const year = t.year ? `<text x="${w / 2}" y="${h - 34}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="15" fill="#ffffff99">${t.year}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(t.title)}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 58% 28%)"/><stop offset="1" stop-color="hsl(${hue2} 68% 11%)"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="hsl(${hue} 75% 62% / .3)" stroke-width="2"/>
${lines.map((l, i) => `<text x="${w / 2}" y="${top + i * 34}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="27" font-weight="700" fill="#fff">${escapeXml(l)}</text>`).join("\n")}
${year}
</svg>`;
}

// ---------------------------------------------------------------------------
// Gate tokens  ("<exp>.<keyid>.<hmac>", replayed by the player as ?mg=...)
// ---------------------------------------------------------------------------
let gateEpoch = 1; // bumped by the dev endpoint to invalidate every issued token

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (secret, text) => createHmac("sha256", secret).update(text).digest("base64url");
const safeEqual = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Tokens are scoped to (issuing host, asset). Scopes, weakest first:
 *   host - signature covers "*", one token for every asset on that host
 *   asset - signature covers one slug (strongest)
 * The original token binds neither the host nor the asset, so it is replayable
 * anywhere in the fleet until it expires.
 */
function mintGateToken(host, slug) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const payload = `${exp}.${KEY_ID}`;
  return `${payload}.${sign(`${GATE_SECRET}:${gateEpoch}`, `${payload}.${host}.${slug || "*"}`).slice(0, 22)}`;
}

function verifyGateToken(token, host, slug) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, why: "shape" };
  const [exp, keyid, sig] = parts;
  if (keyid !== KEY_ID) return { ok: false, why: "keyid" };
  if (!(Number(exp) > Math.floor(Date.now() / 1000))) return { ok: false, why: "expired" };
  const digest = (scope) => sign(`${GATE_SECRET}:${gateEpoch}`, `${exp}.${keyid}.${host}.${scope}`).slice(0, 22);
  if (safeEqual(sig, digest(slug))) return { ok: true, exp: Number(exp), scope: "asset" };
  if (safeEqual(sig, digest("*"))) return { ok: true, exp: Number(exp), scope: "host" };
  return { ok: false, why: "sig" };
}

// ---------------------------------------------------------------------------
// Source audio health (crowdsourced, aggregated server-side, keyed per source)
// ---------------------------------------------------------------------------
const healthByKey = new Map();
const reportedBy = new Map(); // dedupe key -> timestamp

const healthKey = (s) => createHmac("sha256", "demo-health-key").update(`${s.gid}|${s.file}`).digest("hex");
const isAudioBad = (key) => {
  const h = healthByKey.get(key);
  return Boolean(h && h.audio_status === "no_audio" && h.verified);
};

function healthFor(s) {
  const h = healthByKey.get(healthKey(s));
  if (h) return { ...h };
  return {
    audio_status: "unknown", confidence: 0, reports: 0, threshold: 2, remaining: 2,
    confirmed_at: 0, last_report_at: 0, verification_method: "", verified: false, verified_at: 0,
    audio_track_count: null, last_probe_at: 0, last_evidence: "", updated_at: 0, notice: "",
  };
}

function applyReport(key, event, evidence) {
  const now = Math.floor(Date.now() / 1000);
  const h = healthByKey.get(key) || healthFor({ gid: key, file: "" });
  const out = { ...h };
  if (event === "audio_ok") {
    out.audio_status = "healthy";
    out.confidence = Math.max(Number(out.confidence) || 0, 99);
    out.verified = true;
    out.verified_at = now;
    out.verification_method = "browser_positive";
    out.reports = 0;
    out.remaining = out.threshold;
  } else {
    out.reports = (Number(out.reports) || 0) + 1;
    out.last_report_at = now;
    out.remaining = Math.max(0, out.threshold - out.reports);
    out.last_evidence = evidence || "multi-signal-no-audio";
    if (out.reports >= out.threshold) {
      out.audio_status = "no_audio";
      out.verified = true;
      out.verified_at = now;
      out.verification_method = "browser_positive";
      out.confidence = 99;
      out.notice = "Multiple viewers reported missing audio";
    } else {
      out.audio_status = "suspected";
    }
  }
  out.last_probe_at = now;
  out.updated_at = now;
  out.audio_track_count = null;
  healthByKey.set(key, out);
  return out;
}

const mintHealthToken = (s, t) => {
  const payload = {
    h: healthKey(s), o: String(t.fid), s: s.id, k: "movie", i: "movie", l: "Movie",
    n: s.name, q: s.quality, a: s.audio, u: s.unlock_id, y: s.container,
    e: Math.floor(Date.now() / 1000) + 86400, v: 1,
  };
  const p = b64u(JSON.stringify(payload));
  return `${p}.${sign(HEALTH_SECRET, p)}`;
};

function verifyHealthToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  if (!safeEqual(parts[1], sign(HEALTH_SECRET, parts[0]))) return null;
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Config build + LCG-XOR obfuscation (identical scheme to the original)
// ---------------------------------------------------------------------------
function buildConfig(t, req) {
  // Azure-only: a source without a published copy is not offered at all, so the
  // player has no way to fall back to this PC's uplink. The title stays in the
  // catalogue and says it is still being moved, rather than vanishing.
  const offered = AZURE_ONLY ? t.sources.filter((s) => s.remote && s.remote.url) : t.sources;
  const sources = offered.map((s) => ({
    id: s.id,
    health_key: healthKey(s),
    file_fid: s.slug.replace("-", "_"),
    quality: s.quality,
    audio: s.audio,
    audio_languages: [s.audio],
    provider: CDNS[s.cdn].provider,
    provider_priority: CDNS[s.cdn].priority,
    url: (s.remote && s.remote.url) || `${mirrorOrigin(req, CDNS[s.cdn])}/p/${s.mslug}`,
    download_url: `${mirrorOrigin(req, CDNS[s.cdn])}/d/${s.mslug}`,
    remote: Boolean(s.remote && s.remote.url),
    external_audio: [],
    external_subtitles: [],
    screenshot: posterUrl(t),
    type: s.container,
    is_best: Boolean(s.best),
    quality_label: s.best ? "Best Quality" : "",
    codec: s.codec || "",
    hevc: (s.codec || "") === "hevc",
    playable: s.playable === true ? true : s.playable === false ? false : null,
    name: s.name,
    unlock_id: s.unlock_id,
    health: healthFor(s),
    health_token: mintHealthToken(s, t),
  }));

  return {
    version: "78.01",
    screenshots: [{ url: posterUrl(t), label: "Movie" }],
    title: t.title,
    title_id: t.id,
    poster: posterUrl(t),
    content_type: "movie",
    completed: true,
    episodes: [{
      id: "movie", label: "Movie", number: null, season: null,
      range_start: null, range_end: null, kind: "movie", added_order: 0,
      sources,
      subtitles: t.subtitles,
    }],
    background_loaders: [],
    has_r2: true,
    origin_fid: t.fid,
    adult: false,
    download_bridge: "/media/download",
    view_event: "/media/event",
    source_health_event: "/media/health",
    requested_file: "",
    poster_kind: "portrait",
    post_shot: posterUrl(t),
    // True only in Azure-only mode, and only while this film is still local:
    // the player says so instead of reporting a broken source.
    pending_publish: Boolean(AZURE_ONLY && offered.length === 0 && t.sources.length > 0),
  };
}

/** base64( JSON XOR keystream(LCG seeded by data-s) ), exactly as the original. */
function obfuscate(json) {
  const seed = randomBytes(4).toString("hex");
  const rounds = 600;
  let r = parseInt(seed, 16) >>> 0;
  for (let i = 0; i < rounds; i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;
  const bytes = Buffer.from(json, "utf8");
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bytes[i] ^ ((r >>> 16) & 0xff);
  }
  return { payload: out.toString("base64"), seed, rounds };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".vtt": "text/vtt; charset=utf-8", ".webmanifest": "application/manifest+json",
  // Media types follow the container, not one hard-coded default: a phone that
  // receives video/x-matroska for an MP4 refuses to play it, and vice versa.
  ".mp4": "video/mp4", ".m4v": "video/mp4",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime",
};

/** Extensions a page may load from public/. No video, no html (see the route). */
const STATIC_EXT = new Set([".js", ".mjs", ".css", ".svg", ".vtt", ".json", ".webmanifest"]);

// ---------------------------------------------------------------------------
// Compression
//
// The tunnel carries every byte over a home uplink, and the player alone is a
// few hundred kilobytes of JavaScript. Text leaves the server gzipped, once per
// distinct body: the compressed copy is kept while it is warm, so a second
// visitor costs a hash and a buffer lookup rather than another deflate.
// ---------------------------------------------------------------------------
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i;
const GZIP_CACHE_MAX = 8 * 1024 * 1024;
const gzipCache = new Map();
let gzipCacheBytes = 0;

const wantsGzip = (req) => Boolean(req) && /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));

/** The gzipped body, or null when compressing would not be worth it. */
function gzipped(raw) {
  if (raw.length < 600) return null;
  const key = createHash("sha1").update(raw).digest("base64");
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const body = gzipSync(raw, { level: 6 });
  if (body.length >= raw.length * 0.95) return null;   // already compact
  if (gzipCacheBytes + body.length > GZIP_CACHE_MAX) { gzipCache.clear(); gzipCacheBytes = 0; }
  gzipCache.set(key, body);
  gzipCacheBytes += body.length;
  return body;
}

function send(res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  const type = String(headers["Content-Type"] || "");
  let encoded = false;
  if (status === 200 && COMPRESSIBLE.test(type) && wantsGzip(res.req)) {
    const z = gzipped(buf);
    if (z) { buf = z; encoded = true; }
  }
  res.writeHead(status, {
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(encoded ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
    ...headers,
  });
  res.end(buf);
}

const sendJson = (res, status, obj, headers) =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", ...headers });

/**
 * JSON with a content validator.
 *
 * The catalogue is fetched on every navigation and every "back", and it changes
 * only when the library does. `no-cache` plus an ETag lets the browser ask one
 * cheap question instead of re-downloading, while still guaranteeing the answer
 * is about the library as it is now - `no-store` was throwing that away.
 */
function sendJsonCached(req, res, obj) {
  const body = JSON.stringify(obj);
  const etag = `W/"${body.length.toString(16)}-${fnv1a(body).toString(16)}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ETag: etag,
  };
  if (String(req.headers["if-none-match"] || "") === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  return send(res, 200, body, headers);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Windows editors happily write a UTF-8 BOM, and JSON.parse rejects it. Strip it
 * once here so both the manifest and admin bodies tolerate a file saved by
 * Notepad instead of failing with a confusing parse error.
 */
const stripBom = (text) => (String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text));

const parseJson = (text) => JSON.parse(stripBom(text));

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Byte-range arithmetic, shared by every file response so the `Accept-Ranges`
 * header is only ever advertised where the range is actually honoured.
 * Returns { start, end } to serve a slice, null for the whole file, or the
 * string "unsatisfiable".
 */
function resolveByteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return "unsatisfiable";
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  else if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

/** One range-aware sender for both static assets and CDN playback. */
async function sendFile(req, res, file, { contentType, exposeHeaders, revalidate, immutable } = {}) {
  let st;
  try { st = await stat(file); } catch { return send(res, 404, "not found", { "Access-Control-Allow-Origin": "*" }); }
  if (!st.isFile()) return send(res, 404, "not found", { "Access-Control-Allow-Origin": "*" });

  // Site assets revalidate instead of never caching: a changed stylesheet or
  // player shows up on the next load (a 304 costs nothing when it has not), and
  // media stays no-store where a stale byte would be a correctness problem.
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = {
    "Content-Type": contentType || MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : (revalidate ? "no-cache" : "no-store"),
    ...(revalidate ? { ETag: etag } : {}),
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(exposeHeaders ? { "Access-Control-Expose-Headers": exposeHeaders } : {}),
  };

  if (revalidate && String(req.headers["if-none-match"] || "") === etag) {
    res.writeHead(304, base);
    return res.end();
  }

  // Site assets are text: send them compressed once, then let the ETag carry
  // every later request. Media never takes this path (no-store, ranges).
  if (!req.headers.range && revalidate && COMPRESSIBLE.test(base["Content-Type"]) && wantsGzip(req)) {
    try {
      const z = gzipped(await readFile(file));
      if (z) {
        res.writeHead(200, {
          ...base,
          "Content-Encoding": "gzip",
          Vary: "Accept-Encoding",
          "Content-Length": z.length,
        });
        return res.end(z);
      }
    } catch { /* fall through to the plain stream */ }
  }

  const range = resolveByteRange(req.headers.range, st.size);
  if (range === "unsatisfiable") {
    return send(res, 416, "bad range", { ...base, "Content-Range": `bytes */${st.size}` });
  }
  if (range) {
    res.writeHead(206, {
      ...base,
      "Content-Range": `bytes ${range.start}-${range.end}/${st.size}`,
      "Content-Length": range.end - range.start + 1,
    });
    return createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  }
  res.writeHead(200, { ...base, "Content-Length": st.size });
  return createReadStream(file).pipe(res);
}

async function serveStatic(req, res, rootDir, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const abs = resolve(rootDir, rel);
  if (abs !== resolve(rootDir) && !abs.startsWith(resolve(rootDir) + sep)) {
    return send(res, 403, "forbidden");
  }
  // A URL that names the current version can never go stale, so it is cached
  // for a year; anything else keeps revalidating, which is what makes the
  // first visit after a change pick it up.
  const asked = new URL(req.url, "http://localhost").searchParams.get("v");
  const version = await assetVersion(abs);
  const immutable = Boolean(asked && version && asked === version);
  return sendFile(req, res, abs, { revalidate: true, immutable });
}

// ---------------------------------------------------------------------------
// Asset versions
//
// A page names half a dozen CSS and JS files, and making each one revalidate on
// every visit costs a round trip per file over a home uplink. Naming the version
// in the URL lets the browser keep it for a year. The version is derived from the
// file's size and mtime, so replacing a file changes the URL and no cache can
// hand back the old one.
// ---------------------------------------------------------------------------
const assetVersions = new Map();   // absolute path -> { key, version }

async function assetVersion(abs) {
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) return null;
  const key = `${st.size}-${Math.floor(st.mtimeMs)}`;
  const hit = assetVersions.get(abs);
  if (hit && hit.key === key) return hit.version;
  const version = createHash("sha1").update(key).digest("hex").slice(0, 8);
  assetVersions.set(abs, { key, version });
  return version;
}

const ASSET_REF =
  /(href|src)="(\/(?!api\/|poster\/|cdn\/)[^"?#]+\.(?:css|js|mjs|svg|vtt|webmanifest))"/g;

/** Point local stylesheets, scripts and art at their content version. */
async function versionAssets(html) {
  const refs = [...new Set([...html.matchAll(ASSET_REF)].map((m) => m[2]))];
  if (!refs.length) return html;
  const versions = new Map(await Promise.all(refs.map(async (rel) => [
    rel, await assetVersion(join(PUBLIC, decodeURIComponent(rel))),
  ])));
  return html.replace(ASSET_REF, (whole, attr, rel) => {
    const version = versions.get(rel);
    return version ? `${attr}="${rel}?v=${version}"` : whole;
  });
}

/** A CDN playback endpoint: same sender, video type, explicit range exposure. */
async function serveRange(req, res, file, { broken } = {}) {
  if (broken) {
    return send(res, 503, "mirror unavailable", {
      "Content-Type": "text/plain; charset=utf-8",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    });
  }
  return sendFile(req, res, file, {
    contentType: MIME[extname(file).toLowerCase()] || "application/octet-stream",
    exposeHeaders: "Content-Range, Content-Length, Accept-Ranges",
  });
}

/** The source a CDN was asked for, by its globally unique media slug. */
async function sourceBySlug(slug) {
  for (const t of await catalogue()) {
    const s = t.sources.find((x) => x.mslug === slug);
    if (s) return { title: t, source: s };
  }
  return null;
}

/** /api/player-media.php?t=<token> -> the source definition (parity route). */
async function sourceForToken(token) {
  for (const t of await catalogue()) {
    const s = t.sources.find((x) => x.id === token || x.unlock_id === token || x.gid === token);
    if (s) return { title: t, source: s };
  }
  return null;
}

/**
 * Dev fault injection addresses a source as (title, id) because source ids are
 * only unique inside a title. The join to the global key stays here so callers
 * never have to know how gids are spelled.
 */
function resolveDevSource(all, q) {
  const id = q.get("id");
  if (!id) return null;
  const title = q.get("title");
  return all.find((s) => s.gid === id) || all.find((s) => s.gid === `${title}:${id}`) || null;
}

// ---------------------------------------------------------------------------
// Admin: the write path for storage/library.json
//
// Disabled entirely unless ADMIN_TOKEN is set, in which case every route below
// answers 404 - an unconfigured admin should not be discoverable at all. The
// token travels in a header rather than a query string so it cannot land in
// access logs or browser history; a header is also why no CSRF token is needed,
// since a cross-origin form cannot set one.
// ---------------------------------------------------------------------------
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
const ADMIN_ON = ADMIN_TOKEN.length > 0;

// The way into the library from every page. It is a control, not a text link:
// this is the one button that changes what the site contains, and the token
// behind it, not the link's visibility, is what actually guards it.
const ADMIN_BUTTON =
  '<a class="site-bar__admin" href="/admin" title="Manage videos" aria-label="Manage videos">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/>' +
  '<circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>' +
  "<span>Manage videos</span></a>";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024);
const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm", ".m4v", ".mov"]);

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/**
 * How much room an upload needs.
 *
 * A film sits on disk twice while it arrives - once as pieces, once joined - so
 * the question is never "does it fit?" but "does it fit twice?", with a margin
 * left for the rest of the machine.
 */
const UPLOAD_RESERVE = 512 * 1024 * 1024;
const freeBytes = async () => {
  const s = await statfs(STORAGE).catch(() => null);
  return s ? s.bavail * s.bsize : 0;
};
const roomFor = (size) => size * 2 + UPLOAD_RESERVE;

// ---------------------------------------------------------------------------
// Conversion: an upload that no browser can play is turned into H.264/AAC MP4.
//
// Reading the file's codecs (media-probe.mjs) decides whether the fix is a
// remux (seconds) or a re-encode (minutes). ffmpeg is optional: without it the
// admin simply keeps telling the truth about the file and nothing more happens.
// ---------------------------------------------------------------------------
const FFMPEG = findFfmpeg(process.env.FFMPEG_PATH || "");
const FFPROBE = findFfprobe(FFMPEG);
const TRANSCODE_DIR = resolve(process.env.TRANSCODE_DIR || join(STORAGE, ".transcode"));
const TRANSCODE_ENCODER = String(process.env.TRANSCODE_ENCODER || "libx264");
const TRANSCODE_MAX_HEIGHT = Number(process.env.TRANSCODE_MAX_HEIGHT || 0);
// A smaller copy made beside a conversion, so the player's adaptive quality has
// somewhere real to step down to. "none" (or 0) turns it off and saves the
// encode time on a machine that only ever serves one viewer.
const RENDITION_HEIGHT = (() => {
  const raw = String(process.env.TRANSCODE_RENDITIONS || "480").trim().toLowerCase();
  if (!raw || raw === "none" || raw === "off" || raw === "0") return 0;
  const value = Number.parseInt(raw.split(",")[0], 10);
  return Number.isFinite(value) && value >= 144 && value <= 1080 ? value : 480;
})();
const CONVERSIONS_KEPT = 8;

// Azure Blob, when the library has somewhere else to put the films.
//
//   AZURE_CONTAINER_URL  https://<account>.blob.core.windows.net/<container>
//   AZURE_SAS            "?sv=...&sig=..."  (a container SAS, write access)
//
// With a container SAS the site uploads a film straight to Blob and the player
// streams from Azure, so home upload bandwidth is no longer in the path. The
// local file is kept either way; offloading never deletes anything.
const AZURE_CONTAINER = containerBase(process.env.AZURE_CONTAINER_URL || "");
const AZURE_SAS = String(process.env.AZURE_SAS || "").trim();
const AZURE_SAS_INFO = parseSas(AZURE_SAS);
const AZURE_ON = Boolean(AZURE_CONTAINER && AZURE_SAS_INFO);
const AZURE_PREFIX = String(process.env.AZURE_PREFIX || "v1").trim() || "v1";
// Azure-only: never hand the browser a /p/ URL. The films are on Blob storage or
// they are not playable yet; nothing streams from this PC. Off by default,
// because a library that has not been published would have nothing to play.
const AZURE_ONLY = /^(1|true|yes|on)$/i.test(String(process.env.AZURE_ONLY || "").trim());
// Publishing must not starve the site it is publishing for: this is a ceiling in
// bytes per second on the upload itself. 0 means "as fast as the line allows",
// which is only safe when nobody is watching.
const AZURE_UPLOAD_BPS = Number.parseInt(process.env.AZURE_UPLOAD_BPS || "0", 10) || 0;

const conversions = new Map();   // id -> job, newest last
let runningConversion = null;    // the job holding ffmpeg right now

const jobView = (job) => ({
  id: job.id,
  file: job.file,
  output: job.output || null,
  status: job.status,
  kind: job.kind || null,
  phase: job.phase || null,
  percent: job.percent === null || job.percent === undefined ? null : Math.round(job.percent * 10) / 10,
  speed: job.speed || null,
  eta: job.eta === null || job.eta === undefined ? null : Math.round(job.eta),
  bytes: job.bytes || 0,
  extra: job.extra || null,
  rendition_error: job.rendition_error || null,
  error: job.error || null,
  started: job.started || null,
  finished: job.finished || null,
});

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const humanSize = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

// ---------------------------------------------------------------------------
// Posters taken from the film itself
//
// A new title used to need artwork sourced by hand or it fell back to a
// generated gradient. One frame, a fifth of the way in, is a better poster than
// either and costs about a second. The file lives beside the video so it moves
// with the storage folder, and it is served by its own route because storage is
// not web-reachable.
// ---------------------------------------------------------------------------
const POSTER_DIR = join(STORAGE, "posters");
const POSTER_THUMB_WIDTH = 250;
// A day of freshness, then stale-while-revalidate: a returning visitor sees the
// last poster immediately and one background 304 keeps it honest.
const POSTER_CACHE = "public, max-age=86400, stale-while-revalidate=604800";

/**
 * A narrower copy of a poster, for the card grid.
 *
 * Cards are 172px wide and the poster is 500, so every grid view was fetching
 * twice the pixels it could use. One small copy beside the original, fetched by
 * srcset, cuts that by roughly two thirds with no visible difference.
 * The name is derived (`<stem>-250.jpg`), so it needs no manifest field.
 */
async function posterThumbFile(stem) {
  const full = join(POSTER_DIR, `${stem}.jpg`);
  const small = join(POSTER_DIR, `${stem}-${POSTER_THUMB_WIDTH}.jpg`);
  if (await exists(small)) return small;
  if (!FFMPEG || !(await exists(full))) return null;
  await mkdir(POSTER_DIR, { recursive: true });
  // ffmpeg picks the writer from the extension, so the temp name keeps .jpg.
  const tmp = join(POSTER_DIR, `.${stem}-${randomBytes(4).toString("hex")}.jpg`);
  const made = await shrinkImage({ ffmpeg: FFMPEG, input: full, output: tmp, width: POSTER_THUMB_WIDTH });
  if (!made) { await unlink(tmp).catch(() => {}); return null; }
  try {
    await rename(tmp, small);
  } catch {
    // Another request made it first; rename onto an existing file loses on
    // Windows, and the winner's copy is as good as ours.
    await unlink(tmp).catch(() => {});
    if (!(await exists(small))) return null;
  }
  return small;
}

/**
 * Poster bytes with a validator, so a repeat view costs a 304 rather than the
 * file. Posters change only when the admin regenerates one, which is rare enough
 * for a day of caching to be safe.
 */
async function sendPoster(req, res, file) {
  let st;
  try { st = await stat(file); } catch { return send(res, 404, "no such poster", { "Content-Type": "text/plain; charset=utf-8" }); }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": POSTER_CACHE, ETag: etag };
  if (String(req.headers["if-none-match"] || "") === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let body;
  try { body = await readFile(file); } catch { return send(res, 404, "no such poster", { "Content-Type": "text/plain; charset=utf-8" }); }
  return send(res, 200, body, headers);
}

/** The poster URL for this video, taking one frame if it does not exist yet. */
async function posterFor(input, stem) {
  if (!FFMPEG || !stem) return null;
  const name = `${stem}.jpg`;
  const output = join(POSTER_DIR, name);
  if (await exists(output)) return `/poster/${name}`;
  try {
    await mkdir(POSTER_DIR, { recursive: true });
    const details = await ffprobeDetails(FFPROBE, input);
    const duration = durationOf(details);
    // A fifth of the way in skips title cards, black frames and studio logos.
    const at = duration > 60 ? Math.min(duration * 0.2, duration - 20) : Math.max(1, duration * 0.5);
    const saved = await capturePoster({ ffmpeg: FFMPEG, input, output, at });
    return saved ? `/poster/${name}` : null;
  } catch {
    return null;
  }
}

/**
 * Move a finished encode into storage. rename(2) refuses to cross volumes on
 * Windows (EXDEV), and the scratch folder is usually on a roomier drive, so the
 * fallback copies to a .part name in the destination first and renames that:
 * a half-copied file must never appear under the real name.
 */
async function moveIntoStorage(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  await copyFile(from, `${to}.part`);
  await rename(`${to}.part`, to);
  await unlink(from).catch(() => {});
}

function rememberConversion(job) {
  conversions.set(job.id, job);
  const finished = [...conversions.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => (b.started || 0) - (a.started || 0));
  for (const old of finished.slice(CONVERSIONS_KEPT)) conversions.delete(old.id);
}

/**
 * The smaller copy that sits beside a finished conversion.
 *
 * A failure here never fails the job: the 720p film that plays is worth more
 * than the fallback that does not, so the reason lands on the job and the main
 * result stays.
 */
async function encodeRendition(job, source, duration, hasAudio, tonemap, fromPercent) {
  if (!FFMPEG || !RENDITION_HEIGHT) return null;
  const stem = basename(source, extname(source));
  const name = `${stem}-${RENDITION_HEIGHT}.mp4`;
  const target = join(STORAGE, name);
  if (await exists(target)) return { file: name, quality: RENDITION_HEIGHT, reused: true };

  try {
    await mkdir(TRANSCODE_DIR, { recursive: true });
    job.phase = `rendition ${RENDITION_HEIGHT}p`;
    const plan = planRendition({ encoder: TRANSCODE_ENCODER, height: RENDITION_HEIGHT, hasAudio, tonemap });
    const partial = join(TRANSCODE_DIR, `${job.id}-r.mp4`);
    const span = Math.max(0, 100 - fromPercent);
    const run = runConversion({
      ffmpeg: FFMPEG, input: source, output: partial, plan, duration,
      onProgress: (p) => {
        job.percent = fromPercent + ((Number(p.percent) || 0) / 100) * span;
        job.speed = p.speed;
        job.eta = p.eta;
      },
    });
    job.cancel = run.cancel;
    const outcome = await run.done;
    job.cancel = null;

    if (!outcome.ok) {
      await unlink(partial).catch(() => {});
      job.rendition_error = outcome.cancelled ? "cancelled" : outcome.error;
      return null;
    }
    await moveIntoStorage(partial, target);
    const bytes = (await stat(target)).size;
    console.log(`[admin] made ${name} (${RENDITION_HEIGHT}p, ${humanSize(bytes)})`);
    return { file: name, quality: RENDITION_HEIGHT, bytes };
  } catch (e) {
    job.rendition_error = e.message;
    return null;
  } finally {
    job.phase = null;
  }
}

/** The work itself. Failures land on the job, never on the HTTP response. */
async function runConversionJob(job, input, inputSize) {
  try {
    await mkdir(TRANSCODE_DIR, { recursive: true });
    const space = await statfs(TRANSCODE_DIR).catch(() => null);
    if (space) {
      const free = space.bavail * space.bsize;
      // A trancode is often larger than the source; refuse early with a number
      // the person can act on instead of dying halfway through.
      if (free < inputSize * 1.05) {
        job.status = "failed";
        job.error = `Not enough space in ${TRANSCODE_DIR}: ${gb(free)} free, about ${gb(inputSize * 1.05)} needed. Set TRANSCODE_DIR to a roomier folder.`;
        return;
      }
    }

    const details = await ffprobeDetails(FFPROBE, input);
    const duration = durationOf(details);
    const hasAudio = Boolean(details && (details.streams || []).some((s) => s.codec_type === "audio"));
    const tonemap = isHdr(details);

    // "Make the smaller copy" is a job of its own: the file already plays, so
    // there is nothing to repair, only a rendition to add.
    if (job.rendition) {
      const extra = await encodeRendition(job, input, duration, hasAudio, tonemap, 0);
      if (!extra) {
        job.status = "failed";
        job.error = job.rendition_error || "The smaller copy could not be made.";
        return;
      }
      job.output = extra.file;
      job.extra = extra;
      job.bytes = extra.bytes || (await stat(join(STORAGE, extra.file))).size;
      job.percent = 100;
      job.eta = 0;
      job.status = "done";
      return;
    }

    const probe = await probeMedia(input);
    const plan = planConversion(probe, {
      encoder: TRANSCODE_ENCODER,
      tonemap,
      maxHeight: TRANSCODE_MAX_HEIGHT,
    });
    if (!plan) {
      job.status = "failed";
      job.error = "This file is already browser-playable; there is nothing to convert.";
      return;
    }

    job.kind = plan.kind;
    const partial = join(TRANSCODE_DIR, `${job.id}.mp4`);
    // The main encode owns the first part of the bar and the rendition finishes
    // it, so the number never drops back to zero halfway through the work.
    const sourceHeight = probe.video ? Number(probe.video.height) || 0 : 0;
    const makeRendition = Boolean(RENDITION_HEIGHT) && sourceHeight > RENDITION_HEIGHT + 40;
    const mainShare = makeRendition ? 85 : 100;
    const run = runConversion({
      ffmpeg: FFMPEG, input, output: partial, plan, duration,
      onProgress: (p) => {
        job.percent = ((Number(p.percent) || 0) / 100) * mainShare;
        job.speed = p.speed;
        job.eta = p.eta;
      },
    });
    job.cancel = run.cancel;

    const outcome = await run.done;
    job.cancel = null;

    if (!outcome.ok) {
      await unlink(partial).catch(() => {});
      job.status = outcome.cancelled ? "cancelled" : "failed";
      job.error = outcome.cancelled ? "cancelled" : outcome.error;
      return;
    }

    // Land it next to the original, under a name that cannot clash.
    const stem = basename(input, extname(input));
    let name = `${stem}.mp4`;
    for (let n = 2; await exists(join(STORAGE, name)); n++) name = `${stem}-${n}.mp4`;
    try {
      await moveIntoStorage(partial, join(STORAGE, name));
    } catch (e) {
      // The encode may have used all the room the scratch drive had to spare
      // but the media drive can still be full. Do not throw the finished work
      // away: report where it is and let the person move it after freeing space.
      job.status = "failed";
      job.error = `Converted, but it could not be moved into ${STORAGE} (${e.code || e.message}). The finished file is at ${partial}.`;
      return;
    }

    job.output = name;
    job.bytes = (await stat(join(STORAGE, name))).size;
    job.percent = mainShare;

    if (makeRendition) {
      const extra = await encodeRendition(job, join(STORAGE, name), duration, hasAudio, tonemap, mainShare);
      if (extra) job.extra = extra;
    }

    job.percent = 100;
    job.eta = 0;
    job.status = "done";
    console.log(`[admin] converted ${job.file} -> ${name} (${job.kind}${job.extra ? " + " + job.extra.file : ""})`);
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
  } finally {
    job.finished = Date.now();
    if (runningConversion === job) runningConversion = null;
  }
}

async function startConversion(res, url) {
  const file = String(url.searchParams.get("file") || "");
  if (!FFMPEG) {
    return sendJson(res, 503, {
      ok: false,
      error: "ffmpeg_missing",
      message: "Conversion needs ffmpeg. Set FFMPEG_PATH to ffmpeg.exe (or put ffmpeg on PATH) and restart.",
    });
  }
  if (!isBareName(file) || !(await exists(join(STORAGE, file)))) {
    return sendJson(res, 400, { ok: false, error: "unknown_file", message: "That file is not in the media folder." });
  }

  const input = join(STORAGE, file);
  const size = (await stat(input)).size;

  // ?rendition=1 asks for the small copy only, which is what a file that
  // already plays needs. Anything else is a repair.
  const wantRendition = /^(1|true|yes)$/i.test(String(url.searchParams.get("rendition") || ""));
  if (wantRendition && !RENDITION_HEIGHT) {
    return sendJson(res, 400, {
      ok: false, error: "renditions_off",
      message: "Renditions are off in this run (TRANSCODE_RENDITIONS=none).",
    });
  }
  if (wantRendition) {
    // A copy bigger than the original is not a fallback: say so instead of
    // spending minutes making one that no one should ever be served.
    const small = await probeMedia(input).catch(() => null);
    const height = small && small.video ? Number(small.video.height) || 0 : 0;
    if (height && height <= RENDITION_HEIGHT + 40) {
      return sendJson(res, 400, {
        ok: false, error: "already_small",
        message: `${file} is ${height}p already; a ${RENDITION_HEIGHT}p copy would be an upscale.`,
      });
    }
  }

  // Checked after the awaits: two uploads can arrive together, and only a check
  // in the same turn as the assignment below cannot be overtaken by the other.
  if (runningConversion) {
    return sendJson(res, 409, {
      ok: false, error: "busy", job: jobView(runningConversion),
      message: `Already converting ${runningConversion.file}. Wait for it to finish.`,
    });
  }

  const job = {
    id: randomBytes(6).toString("hex"),
    file, status: "running", percent: 0, speed: null, eta: null,
    rendition: wantRendition ? RENDITION_HEIGHT : 0,
    started: Date.now(), finished: null, output: null, error: null, bytes: 0, kind: null,
    cancel: null,
  };
  rememberConversion(job);
  runningConversion = job;

  // Answer first: a two-hour encode must not sit inside an HTTP request.
  sendJson(res, 202, { ok: true, job: jobView(job), encoder: TRANSCODE_ENCODER });
  runConversionJob(job, input, size).catch((e) => {
    job.status = "failed";
    job.error = e.message;
  });
}

function conversionStatus(res, url) {
  const id = String(url.searchParams.get("id") || "");
  if (id) {
    const job = conversions.get(id);
    return job
      ? sendJson(res, 200, { ok: true, job: jobView(job) })
      : sendJson(res, 404, { ok: false, error: "unknown_job" });
  }
  return sendJson(res, 200, {
    ok: true,
    ffmpeg: Boolean(FFMPEG),
    encoder: TRANSCODE_ENCODER,
    dir: TRANSCODE_DIR,
    active: runningConversion ? jobView(runningConversion) : null,
    jobs: [...conversions.values()].map(jobView),
  });
}

function cancelConversion(res, url) {
  const id = String(url.searchParams.get("id") || "");
  const job = conversions.get(id);
  if (!job) return sendJson(res, 404, { ok: false, error: "unknown_job" });
  if (job.status !== "running" || !job.cancel) {
    return sendJson(res, 409, { ok: false, error: "not_running", job: jobView(job) });
  }
  job.cancel();
  return sendJson(res, 200, { ok: true, job: jobView(job) });
}

// ---------------------------------------------------------------------------
// Publishing to Blob storage
//
// The film is uploaded once, from this machine, and from then on the browser
// fetches it from Azure instead of through the tunnel. The local file stays:
// this is a second home for the bytes, not a move. Every title that uses the
// file is pointed at the published copy in the same step, so the catalogue can
// never advertise a URL that is not there.
// ---------------------------------------------------------------------------
const uploads = new Map();      // id -> job, newest last
let runningUpload = null;

const uploadView = (job) => ({
  id: job.id,
  file: job.file,
  status: job.status,
  percent: Math.round(Number(job.percent) || 0),
  bytes: job.sent,
  total: job.total,
  count: job.files.length,
  index: job.index,
  files: job.files.map((f) => ({
    name: f.name,
    bytes: f.bytes,
    sent: f.sent,
    percent: Math.round(Number(f.percent) || 0),
    status: f.status,
    error: f.error || null,
    remote: f.remote || null,
  })),
  error: job.error || null,
  remote: job.remote || null,
  titles: job.titles || 0,
  started: job.started,
  finished: job.finished || null,
});

/** The bar covers the whole request: a film is its master *and* its renditions. */
function recountUpload(job) {
  let sent = 0;
  let total = 0;
  for (const f of job.files) {
    sent += Math.min(Number(f.sent) || 0, Number(f.bytes) || 0);
    total += Number(f.bytes) || 0;
  }
  job.sent = sent;
  job.total = total;
  job.percent = total > 0 ? (sent / total) * 100 : 0;
}

function rememberUpload(job) {
  uploads.set(job.id, job);
  while (uploads.size > CONVERSIONS_KEPT) {
    const oldest = [...uploads.values()].find((j) => j.status !== "running");
    if (!oldest) break;
    uploads.delete(oldest.id);
  }
}

/** Point every title that uses this file at the copy published to Blob. */
async function attachRemote(file, remote) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc, key } = await manifestDoc();
    let touched = 0;
    for (const t of doc.titles) {
      if (!t || !Array.isArray(t.sources)) continue;
      for (const s of t.sources) {
        if (s && s.file === file) { s.remote = remote; touched += 1; }
      }
    }
    if (!touched) return 0;
    try {
      await writeManifestDoc(doc, key);
      return touched;
    } catch (e) {
      if (e.code !== "CONFLICT") throw e;
    }
  }
  throw new Error("library.json kept changing; the upload finished but nothing was pointed at it");
}

/** Forget the published copy (the blob itself is left alone). */
async function detachRemote(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc, key } = await manifestDoc();
    let touched = 0;
    for (const t of doc.titles) {
      if (!t || !Array.isArray(t.sources)) continue;
      for (const s of t.sources) {
        if (s && s.file === file && s.remote) { delete s.remote; touched += 1; }
      }
    }
    if (!touched) return 0;
    try {
      await writeManifestDoc(doc, key);
      return touched;
    } catch (e) {
      if (e.code !== "CONFLICT") throw e;
    }
  }
  throw new Error("library.json kept changing; nothing was changed");
}

async function runUploadJob(job) {
  try {
    for (const [i, item] of job.files.entries()) {
      job.index = i;
      job.file = item.name;
      item.status = "running";
      const blob = blobNameFor(item.name, AZURE_PREFIX);
      console.log(`[azure] sending ${item.name} (${humanSize(item.bytes)})`);
      const result = await putBlob({
        container: AZURE_CONTAINER,
        sas: AZURE_SAS,
        name: blob,
        file: join(STORAGE, item.name),
        contentType: MIME[extname(item.name).toLowerCase()] || "video/mp4",
        signal: job.signal,
        bytesPerSecond: AZURE_UPLOAD_BPS,
        onProgress: (p) => {
          item.sent = p.sent;
          item.bytes = p.total || item.bytes;
          item.percent = p.percent;
          recountUpload(job);
        },
      });
      item.sent = result.bytes;
      item.percent = 100;
      recountUpload(job);
      // Trust, but check: a 201 with the wrong length would be a silent
      // truncation for every viewer, and a HEAD costs one request.
      const check = await headBlob({ url: result.url });
      if (check.ok && check.bytes && check.bytes !== result.bytes) {
        throw new Error(`Azure reports ${check.bytes} bytes but ${item.name} is ${result.bytes}`);
      }
      const remote = { url: result.url, blob, bytes: result.bytes, at: new Date().toISOString() };
      item.remote = remote;
      job.remote = remote;
      item.status = "done";
      job.titles += await attachRemote(item.name, remote);
      console.log(`[azure] published ${item.name} (${humanSize(result.bytes)}) -> ${result.url}`);
    }
    job.percent = 100;
    job.status = "done";
  } catch (e) {
    const current = job.files[job.index];
    if (current && current.status === "running") {
      current.status = e.message === "cancelled" ? "cancelled" : "failed";
      current.error = e.message;
    }
    job.status = e.message === "cancelled" ? "cancelled" : "failed";
    job.error = e.message;
    console.warn(`[azure] ${job.file}: ${e.message}`);
  } finally {
    job.finished = Date.now();
    if (runningUpload === job) runningUpload = null;
  }
}

async function startUpload(res, url) {
  if (!AZURE_ON) {
    return sendJson(res, 503, {
      ok: false, error: "azure_off",
      message: "Set AZURE_CONTAINER_URL and AZURE_SAS, then restart to publish to Blob storage.",
    });
  }
  if (AZURE_SAS_INFO.scope !== "container") {
    return sendJson(res, 400, {
      ok: false, error: "sas_scope",
      message: "That SAS is signed for a single blob. Create a container SAS (sr=c) with Read, Add, Create, Write, Delete.",
    });
  }
  const file = String(url.searchParams.get("file") || "");
  const titleId = String(url.searchParams.get("title") || "");
  // An automatic publish moves what is not on Azure yet. A manual ?title= still
  // re-sends every file, which is what "publish this again" means.
  const onlyLocal = String(url.searchParams.get("only") || "") === "local";

  // ?file= sends one file; ?title= sends the film â€” master, rendition and any
  // other copy the title lists â€” in one job, because the point of publishing is
  // that none of it is left on this PC.
  let names;
  if (titleId) {
    const t = await titleById(titleId);
    if (!t) return sendJson(res, 404, { ok: false, error: "unknown_title", message: `No title with id "${titleId}".` });
    names = [...new Set(t.sources.map((s) => String((s && s.file) || "")))].filter((n) => isBareName(n));
    if (onlyLocal) {
      names = names.filter((name) =>
        t.sources.some((s) => String((s && s.file) || "") === name && !(s.remote && s.remote.url)));
    }
    if (!names.length) {
      return onlyLocal
        ? sendJson(res, 200, { ok: true, nothing: true, message: "Every file of this film is already on Azure." })
        : sendJson(res, 400, { ok: false, error: "no_files", message: "That title lists no source files." });
    }
  } else {
    if (!isBareName(file) || !(await exists(join(STORAGE, file)))) {
      return sendJson(res, 400, { ok: false, error: "unknown_file", message: "That file is not in the media folder." });
    }
    names = [file];
  }

  const items = [];
  const absent = [];
  for (const name of names) {
    const abs = join(STORAGE, name);
    if (!(await exists(abs))) { absent.push(name); continue; }
    items.push({
      name, bytes: (await stat(abs)).size, sent: 0, percent: 0,
      status: "waiting", error: null, remote: null,
    });
  }
  if (!items.length) {
    return sendJson(res, 409, {
      ok: false, error: "missing_files",
      message: `Not in the media folder: ${absent.join(", ")}`,
    });
  }

  if (runningUpload) {
    return sendJson(res, 409, {
      ok: false, error: "busy", job: uploadView(runningUpload),
      message: `Already sending ${runningUpload.file}. Wait for it to finish.`,
    });
  }

  const job = {
    id: randomBytes(6).toString("hex"),
    file: items[0].name, files: items, index: 0,
    status: "running", percent: 0, sent: 0, total: 0,
    started: Date.now(), finished: null, error: null, remote: null, titles: 0,
    signal: null,
  };
  recountUpload(job);
  const controller = new AbortController();
  job.signal = controller.signal;
  job.cancel = () => controller.abort();
  rememberUpload(job);
  runningUpload = job;

  sendJson(res, 202, {
    ok: true, job: uploadView(job), container: AZURE_CONTAINER,
    skipped: absent,
  });
  runUploadJob(job).catch((e) => {
    job.status = "failed";
    job.error = e.message;
  });
}

function uploadStatus(res, url) {
  const id = String(url.searchParams.get("id") || "");
  if (id) {
    const job = uploads.get(id);
    return job
      ? sendJson(res, 200, { ok: true, job: uploadView(job) })
      : sendJson(res, 404, { ok: false, error: "unknown_job" });
  }
  return sendJson(res, 200, {
    ok: true,
    configured: AZURE_ON,
    container: AZURE_CONTAINER || null,
    scope: AZURE_SAS_INFO ? AZURE_SAS_INFO.scope : null,
    expires: AZURE_SAS_INFO ? AZURE_SAS_INFO.expires : null,
    active: runningUpload ? uploadView(runningUpload) : null,
    jobs: [...uploads.values()].map(uploadView),
  });
}

async function cancelUpload(res, url) {
  const id = String(url.searchParams.get("id") || "");
  const file = String(url.searchParams.get("file") || "");

  // ?file= is "stop serving this one from Azure", not "delete the blob".
  if (!id && file) {
    const touched = await detachRemote(file).catch((e) => e.message);
    return typeof touched === "string"
      ? sendJson(res, 409, { ok: false, error: "conflict", message: touched })
      : sendJson(res, 200, { ok: true, titles: touched });
  }

  const job = uploads.get(id);
  if (!job) return sendJson(res, 404, { ok: false, error: "unknown_job" });
  if (job.status !== "running") return sendJson(res, 409, { ok: false, error: "not_running", job: uploadView(job) });
  job.cancel();
  return sendJson(res, 200, { ok: true, job: uploadView(job) });
}

/**
 * Adopt a blob that is already in the container.
 *
 * Writing needs the container SAS, but a film uploaded through the Azure portal
 * (or from another machine, or with a token that has since expired) is already
 * there and public-read. Pointing a title at it needs no key at all: one HEAD
 * says whether it is really there and how big it is.
 */
async function adoptRemote(res, url) {
  if (!AZURE_CONTAINER) {
    return sendJson(res, 503, {
      ok: false, error: "azure_off",
      message: "Set AZURE_CONTAINER_URL, then restart, before adopting a blob.",
    });
  }
  const file = String(url.searchParams.get("file") || "");
  if (!isBareName(file) || !(await exists(join(STORAGE, file)))) {
    return sendJson(res, 400, { ok: false, error: "unknown_file", message: "That file is not in the media folder." });
  }

  let blob = String(url.searchParams.get("blob") || "").trim();
  if (!blob) {
    return sendJson(res, 400, {
      ok: false, error: "bad_blob",
      message: "Give the blob path inside the container, for example v1/abc123/Film.mp4.",
    });
  }
  // A pasted URL is reduced to its path, which also drops any signature in it.
  if (/^https?:\/\//i.test(blob)) {
    try {
      const u = new URL(blob);
      const root = new URL(AZURE_CONTAINER);
      if (u.origin === root.origin && u.pathname.startsWith(`${root.pathname}/`)) {
        blob = decodeURIComponent(u.pathname.slice(root.pathname.length + 1));
      }
    } catch { /* not a URL after all; use it as a path */ }
  }
  blob = blob.replace(/^\/+/, "");
  if (!blob || blob.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(blob)) {
    return sendJson(res, 400, {
      ok: false, error: "bad_blob",
      message: "That is not a path inside this container.",
    });
  }

  const target = `${AZURE_CONTAINER}/${blob.split("/").map(encodeURIComponent).join("/")}`;
  const head = await headBlob({ url: target });
  if (!head.ok) {
    return sendJson(res, 404, {
      ok: false, error: "blob_missing", blob,
      message: `No blob at "${blob}" in that container (${head.status || head.reason || "not found"}).`,
    });
  }

  const remote = { url: target, blob, bytes: head.bytes || 0, at: new Date().toISOString() };
  const titles = await attachRemote(file, remote).catch((e) => e.message);
  if (typeof titles === "string") {
    return sendJson(res, 409, { ok: false, error: "conflict", message: titles });
  }
  return sendJson(res, 200, { ok: true, file, remote, titles });
}

const adminTokenOk = (req) => ADMIN_ON && safeEqual(String(req.headers["x-admin-token"] || ""), ADMIN_TOKEN);
/** 404 when admin is off (do not advertise it), 401 when the token is wrong. */
const adminDenied = (res) =>
  ADMIN_ON
    ? sendJson(res, 401, { ok: false, error: "admin_token", message: "Send the admin token in the X-Admin-Token header." })
    : sendJson(res, 404, { ok: false, error: "not_found" });

/** The manifest as an editable document, plus the key that guards concurrent writes. */
async function manifestDoc() {
  let key = "absent";
  try { const st = await stat(MANIFEST); key = `${st.mtimeMs}:${st.size}`; } catch { /* absent */ }
  const raw = await readManifest();
  let doc;
  if (!raw) doc = { titles: [], categories: [] };
  else if (!Array.isArray(raw) && Array.isArray(raw.titles)) doc = { ...raw };
  else {
    const parts = manifestParts(raw); // normalizes the legacy shapes on write
    doc = { titles: parts.titles, categories: parts.categories };
  }
  if (!Array.isArray(doc.titles)) doc.titles = [];
  if (!Array.isArray(doc.categories)) doc.categories = [];
  return { doc, key };
}

/**
 * Temp file then rename, so a crash mid-write cannot leave a half-parsed
 * catalogue. `expectedKey` is the key the editor loaded: if the file changed on
 * disk since then - because it was hand-edited - the write is refused instead
 * of clobbering that edit.
 */
async function writeManifestDoc(doc, expectedKey) {
  const current = (await manifestDoc()).key;
  if (expectedKey !== undefined && expectedKey !== null && String(expectedKey) !== current) {
    const e = new Error("The manifest changed on disk since it was loaded.");
    e.code = "CONFLICT";
    throw e;
  }
  const tmp = join(STORAGE, `.library-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    await rename(tmp, MANIFEST);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return (await manifestDoc()).key;
}

async function storageFiles() {
  const names = await readdir(STORAGE).catch(() => []);
  return names.filter((n) => !n.startsWith(".") && VIDEO_EXT.has(extname(n).toLowerCase())).sort();
}

/** A bare file name only: no separators, no traversal, no absolute paths. */
const isBareName = (name) => typeof name === "string" && name.length > 0 && name.length <= 200 &&
  !name.includes("/") && !name.includes("\\") && !name.includes("..") && name === name.trim();

/**
 * Turn submitted form data into the raw title object stored in the manifest.
 * Source ids and slugs are assigned here so they stay stable when sources are
 * reordered: identity must not depend on array position.
 *
 * `takenIds` maps an id that is already in use to the title holding it, so the
 * message can name the owner here rather than being rewritten by the caller
 * from a marker string. It holds the *other* titles, so a title being edited
 * never collides with itself.
 */
/**
 * Attach the smaller copy to the source it was made from.
 *
 * The rendition is an ordinary file in the same folder ("film-480.mp4" beside
 * "film.mp4"), so a title can offer it without anyone ticking a box and without
 * a second column in the manifest. Deriving it here also means an old title
 * picks it up the next time it is saved.
 */
function withRenditions(sources, availableFiles) {
  if (!RENDITION_HEIGHT) return sources;
  const seen = new Set(sources.map((s) => (s && typeof s.file === "string" ? s.file : "")));
  const out = [...sources];
  for (const s of sources) {
    const file = s && typeof s.file === "string" ? s.file : "";
    if (!isBareName(file) || !/\.mp4$/i.test(file)) continue;
    const stem = file.replace(/\.mp4$/i, "");
    if (stem.endsWith(`-${RENDITION_HEIGHT}`)) continue;      // already a rendition
    const name = `${stem}-${RENDITION_HEIGHT}.mp4`;
    if (!availableFiles.has(name) || seen.has(name)) continue;
    seen.add(name);
    // Same mirror and sound as the copy it came from: it is the same film.
    // But not the same *file*: publishing the master says nothing about the
    // rendition, so it must not inherit the master's blob URL.
    out.push({ ...s, file: name, quality: RENDITION_HEIGHT, best: false, rendition: true, remote: null });
  }
  return out;
}

function cleanTitleInput(body, { availableFiles, takenIds, probes = new Map() }) {
  const errors = [];
  const name = String(body.title || "").trim();
  if (!name) errors.push("title is required");
  if (name.length > 200) errors.push("title is too long");

  const id = slugify(String(body.id || name));
  if (!id) errors.push("id is required");
  if (takenIds.has(id)) {
    const owner = takenIds.get(id);
    errors.push(owner && owner !== id
      ? `the id "${id}" is already used by "${owner}"`
      : `the id "${id}" is already in use`);
  }

  let year = null;
  if (body.year !== "" && body.year !== null && body.year !== undefined) {
    year = Number(body.year);
    if (!Number.isInteger(year) || year < 1880 || year > 2100) errors.push("year must be a whole number between 1880 and 2100");
  }

  const poster = body.poster ? String(body.poster).trim() : "";
  if (poster && (!poster.startsWith("/") || poster.includes("..") || poster.startsWith("//"))) {
    errors.push("poster must be a path under public/, starting with a single /");
  }

  const categories = (Array.isArray(body.categories) ? body.categories : [])
    .map((c) => String(c || "").trim())
    .filter(Boolean);

  const rawSources = Array.isArray(body.sources) ? body.sources : [];
  if (!rawSources.length) errors.push("at least one source file is required");

  const usedIds = new Set();
  const usedSlugs = new Set();
  const sources = [];
  for (const [i, s] of rawSources.entries()) {
    const file = String(s.file || "");
    if (!isBareName(file)) { errors.push(`source ${i + 1}: file must be a bare file name`); continue; }
    if (!availableFiles.has(file)) { errors.push(`source ${i + 1}: "${file}" is not in storage/`); continue; }

    const quality = Number(s.quality);
    if (!Number.isFinite(quality) || quality <= 0) { errors.push(`source ${i + 1}: quality must be a positive number`); continue; }

    const cdn = clamp(Number(s.cdn) || 0, 0, CDNS.length - 1);

    // Identity comes from (quality, mirror), not from array position, so
    // reordering the rows in the form does not silently repoint a source.
    let sid = `src-${quality}-m${cdn + 1}`;
    for (let n = 2; usedIds.has(sid); n++) sid = `src-${quality}-m${cdn + 1}-${n}`;
    usedIds.add(sid);

    let slug = `q${quality}-m${cdn + 1}`;
    for (let n = 2; usedSlugs.has(slug); n++) slug = `q${quality}-m${cdn + 1}-${n}`;
    usedSlugs.add(slug);

    const probe = probes.get(file);
    sources.push({
      id: sid,
      quality,
      file,
      cdn,
      audio: String(s.audio || "Unknown").trim() || "Unknown",
      best: Boolean(s.best),
      name: String(s.name || file).trim() || file,
      container: String(s.container || extname(file).slice(1) || "mp4"),
      // What the file really is, decided at the upload boundary, so the player
      // never has to guess a codec from a file name again.
      codec: probe && probe.video ? probe.video.codec : "",
      playable: probe ? probe.playable : null,
      slug,
      unlock_id: `${id}-${sid}`,
      remote: normalizeRemote(s.remote),
    });
  }

  if (!sources.length) errors.push("no usable source survived validation");

  const clean = {
    id, title: name, year,
    categories,
    poster: poster || null,
    description: String(body.description || "").trim(),
    tags: (Array.isArray(body.tags) ? body.tags : [])
      .map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20),
    sources,
  };
  return { ok: errors.length === 0, errors, title: clean };
}

/** Everything the admin page needs, including what the public API hides. */
async function adminState() {
  const { doc, key } = await manifestDoc();
  const declaredCats = doc.categories.map(normalizeCategory);
  const index = categoryIndex([...SEED_CATS, ...declaredCats]);
  const manifestTitles = doc.titles.map((raw, i) => normalizeTitle(raw, i, index));
  const all = [...SEED, ...manifestTitles];

  const files = await storageFiles();
  const referenced = new Set(all.flatMap((t) => t.sources.map((s) => s.file)));
  const sizes = await Promise.all(files.map(async (f) => {
    try { return (await stat(join(STORAGE, f))).size; } catch { return 0; }
  }));

  const missing = [];
  const dupSlug = [];
  const seen = new Set();
  for (const t of all) {
    for (const s of t.sources) {
      if (!files.includes(s.file)) missing.push({ title_id: t.id, source: s.id, file: s.file });
      if (seen.has(s.mslug)) dupSlug.push(s.mslug);
      seen.add(s.mslug);
    }
  }

  const summary = (t, extra) => ({
    id: t.id,
    title: t.title,
    year: t.year,
    categories: t.categories,
    poster: posterUrl(t),
    source_count: t.sources.length,
    qualities: [...new Set(t.sources.map((s) => s.quality))].sort((a, b) => b - a),
    // How much of this film still lives here. One number is enough for the admin
    // to say "not on Azure yet" without listing every file twice.
    local_files: t.sources.filter((s) => !(s.remote && s.remote.url)).length,
    ...extra,
  });

  // Which files already have a published copy, so the admin can say so instead
  // of offering to send the same film twice.
  const remoteByFile = new Map();
  for (const t of all) {
    for (const s of t.sources) {
      if (s.remote && s.remote.url) remoteByFile.set(s.file, s.remote);
    }
  }

  return {
    ok: true,
    key,
    limits: { max_upload_bytes: MAX_UPLOAD_BYTES, video_ext: [...VIDEO_EXT] },
    conversion: { available: Boolean(FFMPEG), encoder: TRANSCODE_ENCODER, dir: TRANSCODE_DIR, rendition: RENDITION_HEIGHT || null },
    azure: {
      configured: AZURE_ON,
      container: AZURE_CONTAINER || null,
      scope: AZURE_SAS_INFO ? AZURE_SAS_INFO.scope : null,
      expires: AZURE_SAS_INFO ? AZURE_SAS_INFO.expires : null,
      prefix: AZURE_PREFIX,
      // Streaming is restricted to published copies: nothing here is served.
      only: AZURE_ONLY,
      // Ceiling on the upload itself, so publishing cannot saturate the line.
      uploadBytesPerSecond: AZURE_UPLOAD_BPS,
      uploading: runningUpload ? uploadView(runningUpload) : null,
    },
    cdns: CDNS.map((c) => ({ label: c.label, provider: c.provider, priority: c.priority, broken: Boolean(c.broken) })),
    categories: (await allCategories()).map((c) => ({
      ...c, count: all.filter((t) => t.categories.includes(c.id)).length,
    })),
    titles: [
      ...SEED.map((t) => summary(t, { builtin: true })),
      ...manifestTitles.map((t, i) => summary(t, { builtin: false, raw: doc.titles[i] })),
    ],
    files: files.map((name, i) => ({
      name,
      bytes: sizes[i],
      referenced: referenced.has(name),
      remote: remoteByFile.has(name) ? remoteByFile.get(name).url : null,
    })),
    orphans: files.filter((f) => !referenced.has(f)),
    diagnostics: {
      missing_files: missing,
      duplicate_slugs: dupSlug,
      manifest_present: key !== "absent",
    },
  };
}

/** "My Film" + 720 -> "my-film-720": the name a film gets on disk. */
function uploadStem(title, quality) {
  const base = slugify(title || "video");
  const q = Number(quality) || 0;
  return q > 0 ? `${base}-${q}` : base;
}

/** First name that does not collide with something already in the media folder. */
async function freeName(stem, ext) {
  let file = `${stem}${ext}`;
  for (let n = 2; await exists(join(STORAGE, file)); n++) file = `${stem}-${n}${ext}`;
  return file;
}

/**
 * Inspect a file that has just landed and tell the admin what it is.
 *
 * Shared by the one-shot upload and the chunked one so a film is described the
 * same way no matter how it arrived.
 */
async function finishUpload(res, { file, bytes, original, stem }) {
  const probe = await probeMedia(join(STORAGE, file));
  const poster = await posterFor(join(STORAGE, file), stem);
  const warnings = probe.playable === false
    ? [`${file} will not play in a browser: ${probe.reason || "the format is not supported"}`]
    : [];
  console.log(`[admin] uploaded ${file} (${bytes} bytes, ${probe.container}${probe.video ? "/" + probe.video.codec : ""}${probe.playable === false ? ", NOT browser-playable" : ""}${poster ? ", poster taken" : ""})`);
  return sendJson(res, 200, {
    ok: true, file, bytes, original: original || null, probe, warnings, poster,
    needs_conversion: probe.playable === false,
    conversion: { available: Boolean(FFMPEG), encoder: TRANSCODE_ENCODER, kind: FFMPEG ? planConversion(probe, { encoder: TRANSCODE_ENCODER })?.kind || null : null, rendition: RENDITION_HEIGHT || null },
  });
}

/** Stream one upload to storage/, then rename into place. */
async function handleUpload(req, res, url) {
  const original = String(url.searchParams.get("name") || "");
  const ext = extname(original).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    return sendJson(res, 400, { ok: false, error: "bad_extension", allowed: [...VIDEO_EXT] });
  }

  const stem = uploadStem(url.searchParams.get("title"), url.searchParams.get("quality"));
  const file = await freeName(stem, ext);

  // One request still has to fit on the disk it is streaming to, and refusing
  // before the first byte is kinder than filling the volume and failing.
  const declared = Number(req.headers["content-length"] || 0);
  if (declared) {
    const free = await freeBytes();
    if (declared + UPLOAD_RESERVE > free) {
      req.resume();
      return sendJson(res, 507, {
        ok: false, error: "no_space", free_bytes: free,
        message: `This file needs ${humanSize(declared + UPLOAD_RESERVE)} free; this PC has ${humanSize(free)}.`,
      });
    }
  }

  const tmp = join(STORAGE, `.upload-${randomBytes(6).toString("hex")}.part`);
  const out = createWriteStream(tmp);
  let bytes = 0;

  try {
    await new Promise((resolveWrite, rejectWrite) => {
      out.on("error", rejectWrite);
      (async () => {
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > MAX_UPLOAD_BYTES) {
              const e = new Error("too large");
              e.code = "TOO_LARGE";
              throw e;
            }
            if (!out.write(chunk)) await once(out, "drain");
          }
          out.end(() => resolveWrite());
        } catch (e) {
          rejectWrite(e);
        }
      })();
    });
  } catch (e) {
    out.destroy();
    await unlink(tmp).catch(() => {});
    if (e.code === "TOO_LARGE") {
      return sendJson(res, 413, { ok: false, error: "too_large", max_bytes: MAX_UPLOAD_BYTES });
    }
    throw e;
  }

  if (!bytes) {
    await unlink(tmp).catch(() => {});
    return sendJson(res, 400, { ok: false, error: "empty_body" });
  }

  await rename(tmp, join(STORAGE, file));
  return finishUpload(res, { file, bytes, original, stem });
}

// ---------------------------------------------------------------------------
// Resumable uploads, for an admin who is not sitting at this machine
//
// Cloudflare's free plan refuses a request body over 100 MB, so a film cannot
// arrive in one POST through the tunnel. The browser cuts the file into pieces
// and posts them one at a time; the server keeps them in <storage>/.incoming/
// and only joins them when the last piece is there. A dropped connection costs
// one piece, and the same upload can be resumed after a reload.
// ---------------------------------------------------------------------------
const INCOMING = join(STORAGE, ".incoming");
const CHUNK_BYTES = clamp(Number(process.env.UPLOAD_CHUNK_BYTES) || 32 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
const SESSION_ID = /^[a-f0-9]{16}$/;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const sessionPath = (id) => (SESSION_ID.test(String(id || "")) ? join(INCOMING, id) : "");

async function readSession(id) {
  const dir = sessionPath(id);
  if (!dir) return null;
  try { return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")); } catch { return null; }
}

/** Which pieces are on disk, and how big each one is. */
async function sessionParts(id) {
  const dir = sessionPath(id);
  if (!dir) return [];
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const n of names) {
    const m = /^(\d+)\.part$/.exec(n);
    if (!m) continue;
    const size = (await stat(join(dir, n)).catch(() => ({ size: 0 }))).size;
    out.push({ index: Number(m[1]), size });
  }
  return out.sort((a, b) => a.index - b.index);
}

function sessionView(meta, parts) {
  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    chunk: meta.chunk,
    received: parts.map((p) => p.index),
    bytes: parts.reduce((a, p) => a + p.size, 0),
    expected: Math.ceil(meta.size / meta.chunk),
  };
}

/** Drop sessions nobody came back for, so .incoming cannot grow forever. */
async function pruneUploadSessions() {
  const ids = (await readdir(INCOMING).catch(() => [])).filter((n) => SESSION_ID.test(n));
  const now = Date.now();
  let removed = 0;
  for (const id of ids) {
    const meta = await readSession(id);
    if (meta && now - Number(meta.created || 0) < SESSION_TTL_MS) continue;
    await rm(sessionPath(id), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  if (removed) console.log(`[admin] cleared ${removed} stale upload session(s)`);
}

/** Begin a resumable upload: the answers are the piece size and the id to keep. */
async function startSession(req, res) {
  let body;
  try { body = parseJson(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: "bad_json" }); }

  const original = String(body.name || "");
  const ext = extname(original).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    return sendJson(res, 400, { ok: false, error: "bad_extension", allowed: [...VIDEO_EXT] });
  }
  const size = Number(body.size) || 0;
  if (!size) return sendJson(res, 400, { ok: false, error: "no_size" });
  if (size > MAX_UPLOAD_BYTES) {
    return sendJson(res, 413, { ok: false, error: "too_large", max_bytes: MAX_UPLOAD_BYTES });
  }
  const free = await freeBytes();
  if (roomFor(size) > free) {
    return sendJson(res, 507, {
      ok: false, error: "no_space",
      needed_bytes: roomFor(size), free_bytes: free,
      message: `${humanSize(size)} needs about ${humanSize(roomFor(size))} free while it uploads; ` +
        `this PC has ${humanSize(free)}.`,
    });
  }

  await pruneUploadSessions();
  const id = randomBytes(8).toString("hex");
  const meta = {
    id,
    name: original,
    size,
    chunk: CHUNK_BYTES,
    title: String(body.title || "video"),
    quality: Number(body.quality) || 0,
    created: Date.now(),
  };
  await mkdir(join(INCOMING, id), { recursive: true });
  await writeFile(join(INCOMING, id, "meta.json"), JSON.stringify(meta));
  console.log(`[admin] upload session ${id}: ${original} (${size} bytes in ${Math.ceil(size / meta.chunk)} pieces)`);
  return sendJson(res, 200, { ok: true, id, chunk: meta.chunk, received: [], expected: Math.ceil(size / meta.chunk) });
}

/** One piece. Writing to a .tmp and renaming makes a retry of the same index safe. */
async function receiveChunk(req, res, url) {
  const id = String(url.searchParams.get("id") || "");
  const meta = await readSession(id);
  if (!meta) {
    return sendJson(res, 404, { ok: false, error: "session_missing", message: "That upload is no longer on disk. Start it again." });
  }

  const expected = Math.ceil(meta.size / meta.chunk);
  const index = Number(url.searchParams.get("index"));
  if (!Number.isInteger(index) || index < 0 || index >= expected) {
    return sendJson(res, 400, { ok: false, error: "bad_index", index, expected });
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > meta.chunk) {
    req.resume();
    return sendJson(res, 413, { ok: false, error: "chunk_too_large", max: meta.chunk });
  }

  const dir = sessionPath(id);
  const part = join(dir, `${index}.part`);
  const tmp = `${part}.tmp`;
  let bytes = 0;
  try {
    await new Promise((done, fail) => {
      const out = createWriteStream(tmp);
      out.on("error", fail);
      (async () => {
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > meta.chunk) {
              throw Object.assign(new Error("chunk too large"), { code: "CHUNK_TOO_LARGE" });
            }
            if (!out.write(chunk)) await once(out, "drain");
          }
          out.end(() => done());
        } catch (e) {
          out.destroy();
          fail(e);
        }
      })();
    });
  } catch (e) {
    await unlink(tmp).catch(() => {});
    if (e.code === "CHUNK_TOO_LARGE") {
      req.resume();
      return sendJson(res, 413, { ok: false, error: "chunk_too_large", max: meta.chunk });
    }
    throw e;
  }

  // Everything on disk plus this piece has to fit the size the client declared,
  // or a session could be used to fill the disk past the file it claims to be.
  const before = (await sessionParts(id)).filter((p) => p.index !== index);
  const total = before.reduce((a, p) => a + p.size, 0) + bytes;
  if (total > meta.size) {
    await unlink(tmp).catch(() => {});
    return sendJson(res, 413, { ok: false, error: "too_large", size: meta.size, sent: total });
  }

  await rename(tmp, part);
  const view = sessionView(meta, await sessionParts(id));
  return sendJson(res, 200, { ok: true, ...view });
}

/** What has arrived so far. Without an id: every session, so the page can offer to resume. */
async function sessionStatus(res, url) {
  const id = String(url.searchParams.get("id") || "");
  if (id) {
    const meta = await readSession(id);
    if (!meta) return sendJson(res, 404, { ok: false, error: "session_missing" });
    return sendJson(res, 200, { ok: true, ...sessionView(meta, await sessionParts(id)) });
  }
  const ids = (await readdir(INCOMING).catch(() => [])).filter((n) => SESSION_ID.test(n));
  const sessions = [];
  for (const one of ids) {
    const meta = await readSession(one);
    if (meta) sessions.push(sessionView(meta, await sessionParts(one)));
  }
  return sendJson(res, 200, { ok: true, sessions, chunk: CHUNK_BYTES, max_bytes: MAX_UPLOAD_BYTES });
}

async function cancelSession(res, url) {
  const id = String(url.searchParams.get("id") || "");
  const dir = sessionPath(id);
  if (!dir) return sendJson(res, 400, { ok: false, error: "bad_id" });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`[admin] upload session ${id} discarded`);
  return sendJson(res, 200, { ok: true, id });
}

/** Join the pieces into the media folder, then treat it like any other upload. */
async function finishSession(req, res, url) {
  const id = String(url.searchParams.get("id") || "");
  const meta = await readSession(id);
  if (!meta) return sendJson(res, 404, { ok: false, error: "session_missing" });

  const parts = await sessionParts(id);
  const expected = Math.ceil(meta.size / meta.chunk);
  const have = new Set(parts.map((p) => p.index));
  const missing = [];
  for (let i = 0; i < expected; i++) if (!have.has(i)) missing.push(i);
  if (missing.length) {
    return sendJson(res, 409, { ok: false, error: "incomplete", missing, ...sessionView(meta, parts) });
  }

  const ext = extname(meta.name).toLowerCase();
  const stem = uploadStem(meta.title, meta.quality);
  const file = await freeName(stem, ext);
  const tmp = join(STORAGE, `.upload-${randomBytes(6).toString("hex")}.part`);

  let bytes = 0;
  try {
    await new Promise((done, fail) => {
      const out = createWriteStream(tmp);
      out.on("error", fail);
      (async () => {
        try {
          for (let i = 0; i < expected; i++) {
            for await (const chunk of createReadStream(join(sessionPath(id), `${i}.part`))) {
              bytes += chunk.length;
              if (!out.write(chunk)) await once(out, "drain");
            }
          }
          out.end(() => done());
        } catch (e) {
          out.destroy();
          fail(e);
        }
      })();
    });
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }

  await rename(tmp, join(STORAGE, file));
  await rm(sessionPath(id), { recursive: true, force: true }).catch(() => {});
  return finishUpload(res, { file, bytes, original: meta.name, stem });
}

// ---------------------------------------------------------------------------
// Admin gate
//
// The page is reachable from the internet now that the owner asked for it, so a
// wrong token must cost something. Eight failures from one address buys a
// quarter of an hour of silence; a success clears the record.
// ---------------------------------------------------------------------------
const ADMIN_MAX_FAILS = 8;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const adminFails = new Map();      // ip -> { n, first, until }

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || String(req.socket.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";
}

function noteAdminFail(ip) {
  const now = Date.now();
  const rec = adminFails.get(ip);
  const fresh = !rec || now - rec.first > ADMIN_LOCK_MS;
  const n = fresh ? 1 : rec.n + 1;
  const first = fresh ? now : rec.first;
  const until = n >= ADMIN_MAX_FAILS ? now + ADMIN_LOCK_MS : 0;
  if (adminFails.size > 2048) adminFails.delete(adminFails.keys().next().value);
  adminFails.set(ip, { n, first, until });
  return { n, until };
}

async function handleAdmin(req, res, url) {
  const ip = clientIp(req);
  const seen = adminFails.get(ip);
  if (seen && seen.until > Date.now()) {
    res.setHeader("Retry-After", String(Math.ceil((seen.until - Date.now()) / 1000)));
    return sendJson(res, 429, {
      ok: false, error: "too_many_attempts",
      message: "Too many wrong tokens from this address. Try again later.",
    });
  }
  if (!adminTokenOk(req)) {
    const { n } = noteAdminFail(ip);
    console.warn(`[admin] refused ${ip} (${n}/${ADMIN_MAX_FAILS}) ${req.method} ${url.pathname}`);
    return adminDenied(res);
  }
  if (seen) adminFails.delete(ip);
  if (req.method !== "GET") console.log(`[admin] ${ip} ${req.method} ${url.pathname}`);
  try {
    return await adminDispatch(req, res, url);
  } catch (e) {
    if (e.code === "CONFLICT") {
      return sendJson(res, 409, {
        ok: false,
        error: "conflict",
        message:
          "storage/library.json changed on disk since this form was opened. Reload and re-apply your " +
          "change, so the other edit is not overwritten.",
      });
    }
    throw e;
  }
}

async function adminDispatch(req, res, url) {
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/admin/state") return sendJson(res, 200, await adminState());

  if (p === "/api/admin/upload/session") {
    if (req.method === "POST") return startSession(req, res);
    if (req.method === "GET") return sessionStatus(res, url);
    if (req.method === "DELETE") return cancelSession(res, url);
  }
  if (req.method === "POST" && p === "/api/admin/upload/chunk") return receiveChunk(req, res, url);
  if (req.method === "POST" && p === "/api/admin/upload/finish") return finishSession(req, res, url);

  if (req.method === "POST" && p === "/api/admin/upload") return handleUpload(req, res, url);

  if (p === "/api/admin/convert") {
    if (req.method === "POST") return startConversion(res, url);
    if (req.method === "GET") return conversionStatus(res, url);
    if (req.method === "DELETE") return cancelConversion(res, url);
  }

  if (p === "/api/admin/azure") {
    if (req.method === "POST") return startUpload(res, url);
    if (req.method === "GET") return uploadStatus(res, url);
    if (req.method === "PATCH") return adoptRemote(res, url);
    if (req.method === "DELETE") return cancelUpload(res, url);
  }

  if (req.method === "POST" && (p === "/api/admin/title" || p === "/api/admin/categories")) {
    let body;
    try { body = parseJson(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: "bad_json" }); }

    const { doc, key } = await manifestDoc();
    const availableFiles = new Set(await storageFiles());

    if (p === "/api/admin/title") {
      const originalId = body.originalId ? String(body.originalId) : null;
      if (originalId && SEED.some((t) => t.id === originalId)) {
        return sendJson(res, 400, { ok: false, error: "builtin", message: "Built-in demo titles are read-only." });
      }
      // id -> the title that owns it, so a clash can say who holds it.
      const takenIds = new Map(SEED.map((t) => [t.id, t.title]));
      for (const raw of doc.titles) {
        const otherId = String(raw.id || "");
        if (otherId && otherId !== originalId) takenIds.set(otherId, String(raw.title || ""));
      }

      // The file is the authority on its own format, so inspect every source
      // that is about to be published rather than trusting the form fields.
      // A rendition that exists on disk joins its source here, before the probe
      // map is built, so it is checked like any other file.
      body.sources = withRenditions(Array.isArray(body.sources) ? body.sources : [], availableFiles);
      const probes = new Map();
      for (const s of Array.isArray(body.sources) ? body.sources : []) {
        const file = s && typeof s.file === "string" ? s.file : "";
        if (!isBareName(file) || !availableFiles.has(file) || probes.has(file)) continue;
        probes.set(file, await probeMedia(join(STORAGE, file)));
      }

      const result = cleanTitleInput(body, { availableFiles, takenIds, probes });
      if (!result.ok) return sendJson(res, 400, { ok: false, error: "invalid", errors: result.errors });

      // No artwork given: take a frame from the title's own video, so a movie
      // added from a file that was already on disk also gets a real poster.
      if (!result.title.poster && result.title.sources.length) {
        const first = result.title.sources[0];
        const stem = String(first.file).replace(/\.[^.]+$/, "");
        const poster = await posterFor(join(STORAGE, first.file), stem);
        if (poster) result.title.poster = poster;
      }

      const index = originalId ? doc.titles.findIndex((raw) => String(raw.id) === originalId) : -1;
      if (index >= 0) doc.titles[index] = result.title;
      else if (doc.titles.some((raw) => String(raw.id) === result.title.id)) {
        return sendJson(res, 400, { ok: false, error: "duplicate_id", message: `A title with id "${result.title.id}" already exists.` });
      } else doc.titles.push(result.title);

      const newKey = await writeManifestDoc(doc, body.key);
      console.log(`[admin] saved title ${result.title.id} (${result.title.sources.length} source(s))`);
      const warnings = result.title.sources
        .filter((s) => s.playable === false)
        .map((s) => `${s.file} will not play in a browser: ${probes.get(s.file)?.reason || "the format is not supported"}`);
      return sendJson(res, 200, { ok: true, key: newKey, id: result.title.id, created: index < 0, warnings });
    }

    // categories: replace the declaration list. Titles keep their references,
    // so a category removed here simply reverts to being derived.
    const list = Array.isArray(body.categories) ? body.categories : [];
    const cleaned = [];
    const seen = new Set();
    for (const [i, raw] of list.entries()) {
      const name = String(raw && raw.name || "").trim();
      if (!name) continue;
      const c = normalizeCategory({ ...raw, name }, i);
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      cleaned.push({ id: c.id, name: c.name, order: c.order, sort: c.sort, poster: c.poster, description: c.description });
    }
    doc.categories = cleaned;
    const newKey = await writeManifestDoc(doc, body.key);
    return sendJson(res, 200, { ok: true, key: newKey, categories: cleaned.length });
  }

  if (req.method === "DELETE" && p === "/api/admin/title") {
    const id = String(url.searchParams.get("id") || "");
    if (SEED.some((t) => t.id === id)) {
      return sendJson(res, 400, { ok: false, error: "builtin", message: "Built-in demo titles are read-only." });
    }
    const { doc } = await manifestDoc();
    const before = doc.titles.length;
    doc.titles = doc.titles.filter((raw) => String(raw.id) !== id);
    if (doc.titles.length === before) return sendJson(res, 404, { ok: false, error: "unknown_title" });

    // Files are deliberately left on disk: removing a title is a catalogue edit,
    // not permission to destroy media that may not be re-downloadable. They show
    // up in the orphans list instead.
    const newKey = await writeManifestDoc(doc, url.searchParams.get("key"));
    console.log(`[admin] removed title ${id} (files kept)`);
    return sendJson(res, 200, { ok: true, key: newKey, files_kept: true });
  }

  return sendJson(res, 404, { ok: false, error: "not_found" });
}

// ---------------------------------------------------------------------------
// CDN listeners
// ---------------------------------------------------------------------------
async function handleCdn(cdn, req, res) {
  const url = new URL(req.url, "http://mirror.invalid");

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/g") {
    // Minted for anybody who asks, with no credentials - same as the original.
    // The difference is that the token is bound to the slug and really checked.
    const slug = url.searchParams.get("s") || "";
    return sendJson(res, 200, { ok: true, g: mintGateToken(cdn.label, slug), host: cdn.label });
  }

  const play = url.pathname.match(/^\/(p|d)\/([A-Za-z0-9._-]+)$/);
  if (play) {
    const slug = play[2];
    const found = await sourceBySlug(slug);
    if (!found) return sendJson(res, 404, { ok: false, error: "unknown_slug" });

    if (cdn.broken) return serveRange(req, res, join(cdn.media, found.source.file), { broken: true });

    const gate = verifyGateToken(url.searchParams.get("mg"), cdn.label, slug);
    if (!gate.ok) {
      return sendJson(res, 403, { ok: false, error: "gate", reason: gate.why }, { "WWW-Authenticate": "mg" });
    }
    if (play[1] === "d") return sendJson(res, 200, { ok: true, download: found.source.name });

    return serveRange(req, res, join(cdn.media, found.source.file));
  }

  sendJson(res, 404, { ok: false, error: "not_found", path: url.pathname });
}

// ---------------------------------------------------------------------------
// Site listener
// ---------------------------------------------------------------------------
let pageHits = 0;

const page = async (res, html, status = 200) => {
  // A page names its assets by version, so a repeat visit fetches none of them.
  const body = status === 200 ? await versionAssets(html) : html;
  return send(res, status, body, { "Content-Type": MIME[".html"] });
};

function notFoundPage(res, what) {
  return page(res, `<!doctype html><meta charset="utf-8"><title>Not found</title>
<body style="font:16px system-ui;background:#0b0b0f;color:#eee;padding:3rem">
<h1 style="font-size:1.4rem">Not found</h1><p>${escapeHtml(what)}</p>
<p><a style="color:#7cc4ff" href="/">Back to the library</a></p>`, 404);
}

async function handleSite(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${SITE_PORT}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") return send(res, 204, "");

  // Path-mounted mirrors: /cdn/<label>/â€¦ is handed to the same handler the
  // dedicated ports use, with the prefix stripped.
  if (MIRROR_MODE === "path") {
    const mirrored = p.match(/^\/cdn\/([a-z0-9-]+)(\/.*)?$/i);
    if (mirrored) {
      const cdn = CDNS.find((c) => c.label === mirrored[1]);
      if (!cdn) return sendJson(res, 404, { ok: false, error: "unknown_mirror" });
      // Keep the query string: the gate token travels in ?mg=.
      req.url = (mirrored[2] || "/") + url.search;
      return handleCdn(cdn, req, res);
    }
  }

  // ---- admin ----------------------------------------------------------------
  // The page itself is served only when admin is configured; without a token
  // every admin path 404s, so an unconfigured deployment does not advertise one.
  // ADMIN_LOCAL_ONLY=1 puts it back to "this machine only". The *link* stays
  // local either way: a visitor has no use for a login page, and it should not
  // be advertised on a public catalogue.
  const adminHidden = ADMIN_LOCAL_ONLY && !isLocalRequest(req);
  // ADMIN_LOCAL_ONLY=1 closes the door to the internet; the button follows the
  // door, not the visitor's address.
  const showAdminLink = ADMIN_ON && !adminHidden;
  if (p === "/admin" || p === "/admin/") {
    if (!ADMIN_ON || adminHidden) return notFoundPage(res, "Not found.");
    pageHits += 1;
    return page(res, await readFile(join(PUBLIC, "admin.html"), "utf8"));
  }

  if (p.startsWith("/api/admin/")) {
    if (adminHidden) return sendJson(res, 404, { ok: false, error: "not_found" });
    return handleAdmin(req, res, url);
  }

  // ---- catalogue ------------------------------------------------------------
  if (p === "/" || p === "/index.html") {
    pageHits += 1;
    // The admin link is injected rather than hard-coded so a deployment without
    // ADMIN_TOKEN does not advertise a page that 404s.
    const adminLink = showAdminLink ? ADMIN_BUTTON : "";
    // The hero is the largest thing on the page and it is chosen by script, so
    // the browser would otherwise not start fetching it until the catalogue
    // arrived. Naming it in the head starts the download during HTML parse.
    let headLinks = "";
    try {
      const first = (await catalogueJson()).titles[0];
      if (first && first.poster) {
        headLinks = `<link rel="preload" as="image" href="${escapeHtml(first.poster)}" fetchpriority="high">`;
      }
    } catch { /* the page still renders; only the hint is lost */ }
    const html = (await readFile(join(PUBLIC, "index.html"), "utf8"))
      .replace("<!--MLBD_ADMIN_LINK-->", adminLink)
      .replace("<!--MLBD_HEAD_LINKS-->", headLinks);
    return page(res, html);
  }

  // ---- one title: the player page -------------------------------------------
  const movie = p.match(/^\/movie\/([A-Za-z0-9._-]+)\/?$/);
  if (movie) {
    const t = await titleById(movie[1]);
    if (!t) return notFoundPage(res, `No title with id "${movie[1]}".`);

    pageHits += 1;
    const config = buildConfig(t, req);
    const cfg = obfuscate(JSON.stringify(config));
    const injected =
      `<script id="mlbdInlinePlayerData" type="application/json" data-s="${cfg.seed}" data-r="${cfg.rounds}">` +
      `${cfg.payload}</script>`;
    // Plain, unobfuscated: this is public listing data, the same shape the
    // catalogue API returns, so both pages agree on how a title looks.
    const meta =
      `<script id="mlbdTitleMeta" type="application/json">` +
      `${JSON.stringify(cardOf(t)).replace(/</g, "\\u003c")}</script>`;

    // What a link to this page looks like when it is shared: the poster is the
    // only thing a chat app will show, so it has to be absolute and public.
    const origin = publicBase(req).replace(/\/+$/, "");
    const poster = posterUrl(t);
    const posterAbs = /^https?:/i.test(poster) ? poster : `${origin}${poster}`;
    const label = `${t.title}${t.year ? ` (${t.year})` : ""}`;
    const blurb = (t.description
      ? String(t.description)
      : `${label} - stream it on MovieLinkBD in the quality your connection can hold.`)
      .replace(/\s+/g, " ").trim().slice(0, 200);
    // A published film lives on another origin. Opening the connection while
    // the page is still parsing means the player's first range does not wait for
    // DNS and a TLS handshake.
    const remoteOrigins = new Set();
    for (const ep of config.episodes || []) {
      for (const s of ep.sources || []) {
        if (!s.remote) continue;
        try { remoteOrigins.add(new URL(s.url).origin); } catch { /* not a URL */ }
      }
    }
    const headMeta = [
      `<meta name="description" content="${escapeHtml(blurb)}">`,
      '<meta property="og:type" content="video.movie">',
      '<meta property="og:site_name" content="MovieLinkBD">',
      `<meta property="og:title" content="${escapeHtml(label)}">`,
      `<meta property="og:description" content="${escapeHtml(blurb)}">`,
      `<meta property="og:image" content="${escapeHtml(posterAbs)}">`,
      `<meta property="og:url" content="${escapeHtml(`${origin}/movie/${t.id}`)}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<link rel="preload" as="image" href="${escapeHtml(posterAbs)}">`,
      ...[...remoteOrigins].map((o) => `<link rel="preconnect" href="${escapeHtml(o)}">`),
    ].join("\n");

    const html = (await readFile(join(PUBLIC, "movie.html"), "utf8"))
      .replace("<!--MLBD_PLAYER_CONFIG-->", injected)
      .replace("<!--MLBD_TITLE_META-->", meta)
      .replace("<!--MLBD_ADMIN_LINK-->", showAdminLink ? ADMIN_BUTTON : "")
      .replace("<!--MLBD_HEAD_META-->", headMeta)
      .replaceAll("<!--MLBD_TITLE-->", escapeHtml(t.title));
    // The developer panel ships in the file so a developer can turn it on, but a
    // production page must not carry it or its wiring.
    return page(res, DEV_PANEL ? html : html
      .replace(/<!--MLBD_DEV_PANEL_START-->[\s\S]*?<!--MLBD_DEV_PANEL_END-->/, "")
      .replace('<script src="/devtools.js"></script>', ""));
  }

  // ---- one category: every title in it --------------------------------------
  const catPage = p.match(/^\/category\/([A-Za-z0-9._-]+)\/?$/);
  if (catPage) {
    const data = await categoryJson(catPage[1]);
    if (!data) return notFoundPage(res, `No category with id "${catPage[1]}".`);

    pageHits += 1;
    const adminLink = showAdminLink ? ADMIN_BUTTON : '<a class="site-bar__link" href="/">Browse all</a>';
    const meta =
      `<script id="mlbdCategoryMeta" type="application/json">` +
      `${JSON.stringify({ id: data.category.id, name: data.category.name, count: data.count }).replace(/</g, "\\u003c")}</script>`;
    const html = (await readFile(join(PUBLIC, "category.html"), "utf8"))
      .replace("<!--MLBD_ADMIN_LINK-->", adminLink)
      .replace("<!--MLBD_CATEGORY_META-->", meta)
      .replaceAll("<!--MLBD_CATEGORY-->", escapeHtml(data.category.name));
    return page(res, html);
  }

  // ---- generated poster -----------------------------------------------------
  const poster = p.match(/^\/poster\/([A-Za-z0-9._-]+)\.svg$/);
  if (poster) {
    const t = await titleById(poster[1]);
    if (!t) return send(res, 404, "no such title", { "Content-Type": "text/plain; charset=utf-8" });
    return send(res, 200, posterSvg(t), { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
  }

  // ---- poster frame taken from the video ------------------------------------
  // The small copy first: the plain route would read "video-250" as a stem.
  const posterThumb = p.match(/^\/poster\/([A-Za-z0-9_-]+)-250\.jpg$/);
  if (posterThumb) {
    const small = await posterThumbFile(posterThumb[1]);
    if (small) return sendPoster(req, res, small);
    // No ffmpeg, or no original to shrink: the 500px file under the small name
    // still renders, which beats a broken card.
    return sendPoster(req, res, join(POSTER_DIR, `${posterThumb[1]}.jpg`));
  }

  const posterJpg = p.match(/^\/poster\/([A-Za-z0-9_-]+)\.jpg$/);
  if (posterJpg) return sendPoster(req, res, join(POSTER_DIR, `${posterJpg[1]}.jpg`));

  if (p === "/api/catalogue.json") return sendJsonCached(req, res, await catalogueJson());

  const catApi = p.match(/^\/api\/category\/([A-Za-z0-9._-]+)\.json$/);
  if (catApi) {
    const data = await categoryJson(catApi[1]);
    return data ? sendJsonCached(req, res, data) : sendJson(res, 404, { ok: false, error: "unknown_category" });
  }

  // ---- mock API surface -----------------------------------------------------
  if (p === "/api/shot-meta.php") {
    return sendJson(res, 200, { n: 1, k: 1, r: 1.7777, t: 0, c: 1 });
  }

  if (p === "/api/player-media.php") {
    const found = await sourceForToken(url.searchParams.get("t"));
    if (!found) return sendJson(res, 404, { ok: false, error: "unknown_token" });
    const { title, source } = found;
    return sendJson(res, 200, {
      ok: true,
      title: title.title,
      source: {
        id: source.id, quality: source.quality, container: source.container,
        provider: CDNS[source.cdn].provider, slug: source.mslug,
      },
      url: `${mirrorOrigin(req, CDNS[source.cdn])}/p/${source.mslug}`,
    });
  }

  if (p === "/api/player-event.php" || p === "/media/event") {
    await readBody(req).catch(() => "");
    return sendJson(res, 200, { ok: true, views: 5131 });
  }

  if (p === "/api/player-source-health.php" || p === "/media/health") {
    const raw = await readBody(req).catch(() => "");
    const q = new URLSearchParams(raw);
    const event = String(q.get("event") || "");
    const evidence = String(q.get("evidence") || "");
    const claim = verifyHealthToken(String(q.get("token") || ""));
    if (!claim || !["no_audio", "audio_ok"].includes(event)) {
      return sendJson(res, 400, { ok: false, error: "bad_token" });
    }
    // One report per (reporter, source, event). Scoping this to the source alone
    // would let the first report silence every later viewer, so the threshold
    // could never be reached.
    const reporter = String(q.get("cid") || req.socket.remoteAddress || "anon").slice(0, 64);
    const dedupe = `${reporter}|${claim.h}|${event}`;
    const now = Date.now();
    if (reportedBy.has(dedupe) && now - reportedBy.get(dedupe) < 600_000) {
      return sendJson(res, 200, { ok: true, duplicate: true, health: healthByKey.get(claim.h) || null });
    }
    reportedBy.set(dedupe, now);
    const health = applyReport(claim.h, event, evidence);
    console.log(`[health] ${event} ${evidence || "-"} q=${claim.q} -> ${health.audio_status} (reports ${health.reports}/${health.threshold})`);
    return sendJson(res, 200, { ok: true, health });
  }

  if (p === "/media/download" || p.startsWith("/media/download/")) {
    return sendJson(res, 200, { ok: true, bridge: "/media/download", note: "demo" });
  }

  // ---- dev/test affordances -------------------------------------------------
  // These mutate shared state - they can invalidate every viewer's media token
  // or break a whole mirror - so they are opt-in exactly like the panel itself:
  // a published instance answers 404 for all of them.
  if (p.startsWith("/api/dev/")) {
    if (!DEV_PANEL) return sendJson(res, 404, { ok: false, error: "not_found" });

    if (p === "/api/dev/state") {
      const titles = await catalogue();
      return sendJson(res, 200, {
        ok: true,
        gateEpoch,
        pageHits,
        cdn: CDNS.map((c) => ({ port: c.port, provider: c.provider, label: c.label, broken: Boolean(c.broken) })),
        titles: titles.map((t) => ({
          id: t.id, title: t.title, categories: t.categories, source_count: t.sources.length, url: `/movie/${t.id}`,
        })),
        sources: titles.flatMap((t) => t.sources.map((s) => ({
          gid: s.gid, id: s.id, title_id: t.id, quality: s.quality, file: s.file,
          cdn: CDNS[s.cdn].label, slug: s.mslug, health: healthFor(s),
        }))),
      });
    }
    const body = await readBody(req).catch(() => "");
    // accept parameters from the query string or a form body
    const q = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(body)) q.set(k, v);
    if (p === "/api/dev/expire-tokens") {
      gateEpoch += 1; // every previously issued mg= token is now invalid
      console.log(`[dev] gate epoch -> ${gateEpoch} (all issued tokens invalidated)`);
      return sendJson(res, 200, { ok: true, gateEpoch });
    }
    if (p === "/api/dev/rotate-back") {
      gateEpoch = 1;
      return sendJson(res, 200, { ok: true, gateEpoch });
    }
    if (p === "/api/dev/report-no-audio") {
      const all = (await catalogue()).flatMap((t) => t.sources);
      const src = resolveDevSource(all, q) || all.find((s) => s.quality === 720) || all[0];
      const times = Math.max(1, Number(q.get("times") || 2));
      let h = null;
      for (let i = 0; i < times; i++) h = applyReport(healthKey(src), "no_audio", "simulated-aggregate");
      console.log(`[dev] ${src.gid} marked no_audio x${times} -> ${h.audio_status}`);
      return sendJson(res, 200, { ok: true, gid: src.gid, health: h });
    }
    if (p === "/api/dev/heal") {
      const src = resolveDevSource((await catalogue()).flatMap((t) => t.sources), q);
      if (src) healthByKey.delete(healthKey(src));
      else { healthByKey.clear(); reportedBy.clear(); }
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/dev/set-broken") {
      const cdn = CDNS.find((c) => c.label === q.get("label"));
      if (!cdn) return sendJson(res, 404, { ok: false });
      cdn.broken = q.get("broken") !== "0";
      return sendJson(res, 200, { ok: true, label: cdn.label, broken: cdn.broken });
    }
    return sendJson(res, 404, { ok: false, error: "unknown_dev_route" });
  }

  // ---- discovery ------------------------------------------------------------
  // A library that search engines cannot list is a library nobody finds. The
  // sitemap is generated from the same catalogue the pages render.
  if (p === "/robots.txt") {
    return send(res, 200, [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /api/admin",
      "",
      `Sitemap: ${publicBase(req)}/sitemap.xml`,
      "",
    ].join("\n"), { "Content-Type": "text/plain; charset=utf-8" });
  }

  if (p === "/sitemap.xml") {
    const origin = publicBase(req);
    const titles = await catalogue();
    const cats = await allCategories();
    const locs = [
      `${origin}/`,
      ...cats.map((c) => `${origin}/category/${c.id}`),
      ...titles.map((t) => `${origin}/movie/${t.id}`),
    ];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      locs.map((loc) => `  <url><loc>${escapeXml(loc)}</loc></url>`).join("\n") +
      "\n</urlset>\n";
    return send(res, 200, xml, { "Content-Type": "application/xml; charset=utf-8" });
  }

  // ---- static ---------------------------------------------------------------
  // Serve web assets straight from public/ by extension. Video containers and
  // .html are deliberately absent: pages are routes (they need server-injected
  // config) and media must go through the CDN gate, so a file dropped in the
  // web root cannot bypass either. Path traversal is handled in serveStatic.
  if (STATIC_EXT.has(extname(p).toLowerCase())) {
    return serveStatic(req, res, PUBLIC, p);
  }

  // A browser that asked for a page gets a page, not a JSON blob: a blank white
  // 404 makes a working site look broken, and this is the one screen a visitor
  // only ever sees by accident.
  if (String(req.headers.accept || "").includes("text/html") && !p.startsWith("/api/")) {
    try {
      const html = await readFile(join(PUBLIC, "404.html"), "utf8");
      return page(res, html, 404);
    } catch { /* fall through to JSON */ }
  }

  sendJson(res, 404, { ok: false, error: "not_found", path: p });
}

// ---------------------------------------------------------------------------
const listen = (port, handler) => new Promise((ok) => http.createServer(handler).listen(port, BIND_HOST, ok));

await libraryTitles(); // warm the manifest cache once so problems show at boot

const siteHandler = (req, res) => handleSite(req, res).catch((e) => { console.error(e); send(res, 500, "error"); });

await Promise.all([
  listen(SITE_PORT, siteHandler),
  // In path mode every mirror rides the site listener, so extra ports are not
  // opened at all - which is what a single-host tunnel requires.
  ...(MIRROR_MODE === "port"
    ? CDNS.map((cdn) => listen(cdn.port, (req, res) => {
        handleCdn(cdn, req, res).catch((e) => { console.error(e); send(res, 500, "error"); });
      }))
    : []),
]);

const shownBase = PUBLIC_ORIGIN || `http://${BIND_HOST === "0.0.0.0" ? "127.0.0.1" : BIND_HOST}:${SITE_PORT}`;
console.log(`site            ${shownBase}`);
console.log(`mirrors         ${MIRROR_MODE === "path"
  ? `single origin, ${CDNS.map((c) => `/cdn/${c.label}`).join(" ")}`
  : CDNS.map((c) => `${c.label}=${BIND_HOST}:${c.port}`).join(" ")}`);
if (MIRROR_MODE === "port") {
  for (const c of CDNS) console.log(`cdn ${c.label.padEnd(6)}      port ${c.port}  (${c.provider}${c.broken ? ", broken" : ""})`);
}
console.log(`gate key id ${KEY_ID}, ttl ${TOKEN_TTL_S}s, epoch ${gateEpoch}`);
console.log(`catalogue       ${(await catalogue()).length} title(s) - add more in storage/library.json`);
console.log(ADMIN_ON
  ? `admin           ${shownBase}/admin  (needs the ADMIN_TOKEN header)`
  : "admin           disabled - set ADMIN_TOKEN to add movies from the browser");
pruneUploadSessions().catch(() => {});
