import { fail, json, readJson } from "../_lib/http.js";
import { ipHash } from "../_lib/auth.js";

const WINDOW_MS = 30 * 60 * 1000;
const BOT = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python-requests|axios/i;

/**
 * POST /api/view — { title } (also accepts { id })
 *
 * The player sends this once, after five seconds of playback. Anonymous by
 * design: the page decides when a view happened, and the server only refuses a
 * repeat from the same address within 30 minutes and obvious automation. That
 * makes the number honest for people, not proof against a determined faker.
 */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await readJson(request, 1024); }
  catch { return fail(413, "too_large"); }

  const id = String(body.title || body.id || "").trim();
  if (!id) return fail(400, "no_title");

  const row = await env.DB.prepare(
    "SELECT id, views FROM titles WHERE id = ? AND status = 'published'",
  ).bind(id).first();
  if (!row) return fail(404, "unknown_title");

  const agent = String(request.headers.get("user-agent") || "");
  if (!agent || BOT.test(agent)) {
    return json({ ok: true, counted: false, views: Number(row.views) || 0 });
  }

  const hash = await ipHash(request, env);
  const now = Date.now();
  const seen = await env.DB.prepare(
    "SELECT 1 AS seen FROM view_log WHERE ip_hash = ? AND title_id = ? AND at > ? LIMIT 1",
  ).bind(hash, id, now - WINDOW_MS).first();

  if (seen) {
    return json({ ok: true, counted: false, views: Number(row.views) || 0 });
  }

  await env.DB.batch([
    // A day is enough history for a 30-minute window; the log must not grow forever.
    env.DB.prepare("DELETE FROM view_log WHERE at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("INSERT INTO view_log (ip_hash, title_id, at) VALUES (?, ?, ?)").bind(hash, id, now),
    env.DB.prepare("UPDATE titles SET views = views + 1 WHERE id = ?").bind(id),
  ]);

  return json({ ok: true, counted: true, views: (Number(row.views) || 0) + 1 });
}

/** GET is not a view. */
export const onRequestGet = () => fail(405, "method");
