import { fail, json, readJson, randomHex } from "../_lib/http.js";
import { ipHash } from "../_lib/auth.js";

const MAX_TEXT = 1000;
const MAX_NAME = 40;
const MAX_LINKS = 2;
const PAGE = 30;
const MIN_GAP_MS = 15 * 1000;
const HOUR_LIMIT = 20;

/**
 * GET /api/comments?title=<id>&before=<ms>
 *
 * 30 newest top-level comments, each with its replies. One reply level only:
 * a reply to a reply is attached to the same root, so the thread cannot turn
 * into an unbounded tree.
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const title = String(url.searchParams.get("title") || "").trim();
  if (!title) return fail(400, "no_title");

  const before = Number(url.searchParams.get("before") || 0) || Date.now() + 1;

  const roots = await env.DB.prepare(
    `SELECT id, parent_id, name, text, at
       FROM comments
      WHERE title_id = ? AND hidden = 0 AND parent_id IS NULL AND at < ?
      ORDER BY at DESC LIMIT ${PAGE}`,
  ).bind(title, before).all();

  const rows = roots.results || [];
  let replies = [];
  if (rows.length) {
    const marks = rows.map(() => "?").join(",");
    const found = await env.DB.prepare(
      `SELECT id, parent_id, name, text, at
         FROM comments
        WHERE hidden = 0 AND parent_id IN (${marks})
        ORDER BY at ASC`,
    ).bind(...rows.map((r) => r.id)).all();
    replies = found.results || [];
  }

  const byParent = new Map();
  for (const reply of replies) {
    const list = byParent.get(reply.parent_id) || [];
    list.push(reply);
    byParent.set(reply.parent_id, list);
  }

  return json({
    ok: true,
    comments: rows.map((r) => ({ ...r, replies: byParent.get(r.id) || [] })),
    next: rows.length === PAGE ? rows[rows.length - 1].at : null,
  });
}

/** POST /api/comments — { title, parent?, name?, text, website? } */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await readJson(request, 4096); }
  catch { return fail(413, "too_large"); }

  // Honeypot: a real browser never fills a field it cannot see. Say "ok" so the
  // script does not learn that it was caught, and store nothing.
  if (String(body.website || "").trim()) return json({ ok: true, ignored: true });

  const title = String(body.title || "").trim();
  const text = String(body.text || "").trim();
  if (!title) return fail(400, "no_title");
  if (!text) return fail(400, "empty");
  if (text.length > MAX_TEXT) return fail(400, "too_long");
  if ((text.match(/https?:\/\//gi) || []).length > MAX_LINKS) return fail(400, "too_many_links");

  const exists = await env.DB.prepare(
    "SELECT id FROM titles WHERE id = ? AND status = 'published'",
  ).bind(title).first();
  if (!exists) return fail(404, "unknown_title");

  const name = (String(body.name || "").trim() || "Guest")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_NAME);

  const hash = await ipHash(request, env);
  const now = Date.now();

  const last = await env.DB.prepare(
    "SELECT at FROM post_log WHERE ip_hash = ? ORDER BY at DESC LIMIT 1",
  ).bind(hash).first();
  if (last && now - last.at < MIN_GAP_MS) return fail(429, "slow_down");

  const hour = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM post_log WHERE ip_hash = ? AND at > ?",
  ).bind(hash, now - 60 * 60 * 1000).first();
  if ((hour?.n || 0) >= HOUR_LIMIT) return fail(429, "too_many");

  let parentId = body.parent ? String(body.parent) : null;
  if (parentId) {
    const parent = await env.DB.prepare(
      "SELECT id, parent_id FROM comments WHERE id = ? AND title_id = ? AND hidden = 0",
    ).bind(parentId, title).first();
    if (!parent) return fail(404, "unknown_parent");
    // Replies attach to the root of the thread, never to another reply.
    parentId = parent.parent_id || parent.id;
  }

  const id = randomHex(8);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM post_log WHERE at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("INSERT INTO post_log (ip_hash, at) VALUES (?, ?)").bind(hash, now),
    env.DB.prepare(
      "INSERT INTO comments (id, title_id, parent_id, name, text, at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, title, parentId, name, text, now),
  ]);

  return json({ ok: true, comment: { id, parent_id: parentId, name, text, at: now, replies: [] } }, { status: 201 });
}
