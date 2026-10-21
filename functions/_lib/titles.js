import { parseJson } from "./http.js";

/**
 * The bridge between D1 rows and the shapes the existing front-end already
 * understands: a "card" for the catalogue, and a player config for the watch
 * page. Keeping these two functions in one place is what stops the catalogue and
 * the player from disagreeing about a title.
 */

export const rowToTitle = (row) => ({
  id: row.id,
  title: row.name,
  description: row.description || "",
  year: row.year ?? null,
  poster: row.poster_url || "",
  subtitle_url: row.subtitle_url || "",
  duration: row.duration ?? null,
  size: row.size ?? null,
  status: row.status,
  views: Number(row.views) || 0,
  categories: parseJson(row.categories, []),
  tags: parseJson(row.tags, []),
  sources: parseJson(row.sources, []),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const posterFor = (t) => t.poster || `/poster/${encodeURIComponent(t.id)}.svg`;

/** Only files that finished transcoding are offered to a viewer. */
export const readySources = (t) => (t.sources || []).filter((s) => s.status !== "pending" && s.status !== "failed" && s.url);

export const cardOf = (t) => {
  const sources = readySources(t);
  return {
    id: t.id,
    title: t.title,
    year: t.year,
    poster: posterFor(t),
    tags: t.tags || [],
    categories: t.categories || [],
    qualities: [...new Set(sources.map((s) => Number(s.quality)).filter(Boolean))].sort((a, b) => b - a),
    source_count: sources.length,
    description: t.description || "",
    views: Number(t.views) || 0,
    url: `/movie/${t.id}`,
  };
};

/**
 * The config the player reads. Shape and field names are the player's contract,
 * not this project's invention — the same names the original bundle expects.
 */
export function buildConfig(t) {
  const sources = readySources(t).map((s) => ({
    id: s.id,
    health_key: s.id,
    file_fid: String(s.id).replace(/-/g, "_"),
    quality: Number(s.quality) || 0,
    audio: s.audio || "Default",
    audio_languages: [s.audio || "Default"],
    provider: s.provider || "Fast Player",
    provider_priority: 1,
    url: s.url,
    download_url: s.url,
    // Kept so the watch page can replace the public URL with a signed read URL.
    // The player ignores unknown fields.
    blob: s.blob || "",
    remote: true,
    external_audio: [],
    external_subtitles: [],
    screenshot: posterFor(t),
    type: s.type || "mp4",
    is_best: Boolean(s.best),
    quality_label: s.best ? "Best Quality" : "",
    codec: s.codec || "",
    hevc: (s.codec || "") === "hevc",
    playable: true,
    name: s.name || "",
    unlock_id: null,
    health: {},
    health_token: null,
  }));

  return {
    version: "78.01",
    screenshots: [{ url: posterFor(t), label: "Movie" }],
    title: t.title,
    title_id: t.id,
    poster: posterFor(t),
    content_type: "movie",
    completed: true,
    episodes: [{
      id: "movie",
      label: "Movie",
      number: null,
      season: null,
      range_start: null,
      range_end: null,
      kind: "movie",
      added_order: 0,
      sources,
      subtitles: [],
    }],
    background_loaders: [],
    has_r2: false,
    origin_fid: null,
    adult: false,
    download_bridge: "/media/download",
    view_event: "/media/event",
    source_health_event: "/media/health",
    requested_file: "",
    poster_kind: "portrait",
    post_shot: posterFor(t),
    pending_publish: sources.length === 0,
  };
}

/**
 * The player's config is XOR-obfuscated, not encrypted: the seed and round count
 * travel in data attributes. Ported byte-for-byte from the server version so the
 * existing player can decode it unchanged.
 */
export function obfuscate(text) {
  const buf = crypto.getRandomValues(new Uint8Array(4));
  const seed = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rounds = 600;
  let r = parseInt(seed, 16) >>> 0;
  for (let i = 0; i < rounds; i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;

  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bytes[i] ^ ((r >>> 16) & 0xff);
  }
  let binary = "";
  for (const b of out) binary += String.fromCharCode(b);
  return { payload: btoa(binary), seed, rounds };
}

/** Rows ordered the way the home page wants them: newest first. */
export async function publishedTitles(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM titles WHERE status = 'published' ORDER BY created_at DESC",
  ).all();
  return (results || []).map(rowToTitle);
}

export async function categoriesWithCounts(env) {
  const [cats, titles] = await Promise.all([
    env.DB.prepare("SELECT * FROM categories ORDER BY sort, name").all(),
    publishedTitles(env),
  ]);
  const counts = new Map();
  for (const t of titles) for (const id of t.categories) counts.set(id, (counts.get(id) || 0) + 1);
  return {
    titles,
    categories: (cats.results || []).map((c) => ({
      id: c.id, name: c.name, sort: c.sort, count: counts.get(c.id) || 0,
      url: `/category/${c.id}`,
    })),
  };
}
