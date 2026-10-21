/**
 * One-time migration: local library.json + stats.json -> D1 seed.sql.
 *
 *   node migration/export.mjs --library "library.json" \
 *                             --stats   "stats.json" \
 *                             --posters "posters" \
 *                             --env     ".azure.env" \
 *                             --out     migration/seed.sql
 *
 * Posters are uploaded to the public container with the container SAS in
 * `.azure.env`. Video files are **not** moved:
 * every source that already has an Azure `remote.url` keeps that exact URL, and
 * a source that only exists on this PC is skipped, because the new site has no
 * way to serve it.
 *
 * The output is idempotent: titles are `INSERT OR REPLACE` and the two built-in
 * categories are recreated, so re-running after fixing a poster is safe. It
 * never deletes a title or a blob, and titles added later in the admin are
 * untouched.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const LIBRARY = resolve(args.get("library") || "library.json");
const STATS = resolve(args.get("stats") || "stats.json");
const POSTERS = resolve(args.get("posters") || "posters");
const ENVFILE = resolve(args.get("env") || ".azure.env");
const OUT = resolve(args.get("out") || "migration/seed.sql");
const UPLOAD_POSTERS = args.get("upload-posters") !== "false";

const CATEGORIES = [
  { id: "featured", name: "Featured", sort: 1 },
  { id: "animation", name: "Animation", sort: 2 },
];

const quote = (value) => (value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);
const json = (value) => quote(JSON.stringify(value));

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = { ...readEnvFile(ENVFILE), ...process.env };
const containerUrl = (env.AZURE_CONTAINER_URL || "").replace(/\/+$/, "");
const sas = (env.AZURE_SAS || "").replace(/^\?/, "");

const library = JSON.parse(readFileSync(LIBRARY, "utf8"));
const titles = Array.isArray(library) ? library : library.titles || [];
const stats = existsSync(STATS) ? JSON.parse(readFileSync(STATS, "utf8")) : { titles: {} };

const knownCategories = new Set(CATEGORIES.map((c) => c.id));

async function uploadPoster(title) {
  if (!UPLOAD_POSTERS || !containerUrl || !sas) return "";

  const local = String(title.poster || "");
  if (/^https?:/i.test(local)) return local; // already hosted
  const file = join(POSTERS, basename(local));
  if (!local || !existsSync(file)) return "";

  const blob = `posters/${title.id}.jpg`;
  const url = `${containerUrl}/${blob}?${sas}`;
  try {
    const bytes = await readFile(file);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "x-ms-blob-content-type": "image/jpeg",
        "x-ms-blob-cache-control": "public, max-age=31536000, immutable",
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    if (!res.ok) {
      console.warn(`  poster ${title.id}: HTTP ${res.status} (keeping generated art)`);
      return "";
    }
    return `${containerUrl}/${blob}`;
  } catch (error) {
    console.warn(`  poster ${title.id}: ${error.message} (keeping generated art)`);
    return "";
  }
}

const rows = [];
const report = { published: 0, draft: 0, sources: 0, skippedSources: 0, views: 0, posters: 0 };

// Newest first, so the array order the local site shows survives an
// ORDER BY created_at DESC on the new site.
const base = Date.now();
for (let index = 0; index < titles.length; index++) {
  const title = titles[index] || {};
  const id = String(title.id || "").trim();
  if (!id) continue;

  const sources = [];
  for (const source of title.sources || []) {
    const remote = source.remote;
    if (!remote || !remote.url) { report.skippedSources++; continue; }
    sources.push({
      id: String(source.id || `src-${source.quality || 0}`),
      quality: Number(source.quality) || 0,
      type: String(source.container || "mp4"),
      url: String(remote.url),
      blob: String(remote.blob || ""),
      name: String(source.name || ""),
      size: Number(remote.bytes) || 0,
      best: Boolean(source.best),
      audio: String(source.audio || "Default"),
      codec: String(source.codec || ""),
      status: "ready",
    });
  }

  const categories = (title.categories || []).filter((c) => knownCategories.has(c));
  const poster = await uploadPoster(title);
  if (poster) report.posters++;

  const views = Number(stats.titles?.[id]?.views) || 0;
  report.views += views;

  const status = sources.length ? "published" : "draft";
  report[status]++;
  report.sources += sources.length;

  const size = sources.reduce((n, s) => n + (s.size || 0), 0);
  const createdAt = base - index * 1000;

  rows.push(
    `INSERT OR REPLACE INTO titles (id, name, description, year, poster_url, subtitle_url, duration, size, status, views, categories, tags, sources, created_at, updated_at)\n` +
    `VALUES (${quote(id)}, ${quote(String(title.title || id))}, ${quote(String(title.description || ""))}, ` +
    `${title.year ? Number(title.year) : "NULL"}, ${quote(poster || null)}, NULL, NULL, ${size || "NULL"}, ` +
    `${quote(status)}, ${views}, ${json(categories)}, ${json(title.tags || [])}, ${json(sources)}, ${createdAt}, ${createdAt});`,
  );
}

const sql = [
  "-- Generated by migration/export.mjs — do not edit by hand.",
  `-- Titles: ${rows.length} (${report.published} published, ${report.draft} draft)`,
  `-- Sources: ${report.sources} moved, ${report.skippedSources} skipped (no Azure copy)`,
  `-- Views: ${report.views} · posters uploaded: ${report.posters}`,
  "",
  "DELETE FROM categories;",
  ...CATEGORIES.map((c) => `INSERT INTO categories (id, name, sort) VALUES (${quote(c.id)}, ${quote(c.name)}, ${c.sort});`),
  "",
  ...rows,
  "",
].join("\n");

writeFileSync(OUT, sql, "utf8");

console.log(`wrote ${OUT}`);
console.log(`${rows.length} titles · ${report.sources} sources · ${report.views} views · ${report.posters} posters`);
if (report.skippedSources) {
  console.log(`${report.skippedSources} local-only source(s) were skipped: the Pages site cannot serve this PC.`);
}
if (!containerUrl || !sas) {
  console.log("No container URL/SAS found, so posters were not uploaded; titles will use generated art.");
}
