import { fail, int, json, randomHex, readJson, slugify } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { cleanSource, cleanStringList } from "../../_lib/admin.js";
import { rowToTitle } from "../../_lib/titles.js";

/** POST /api/admin/titles — create a title (always as a draft). */
export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  let body;
  try { body = await readJson(request, 32 * 1024); }
  catch { return fail(413, "too_large"); }

  const name = String(body.name || "").trim().slice(0, 200);
  if (!name) return fail(400, "no_name");

  let sources;
  try { sources = (Array.isArray(body.sources) ? body.sources : []).slice(0, 20).map(cleanSource); }
  catch (e) { return fail(e.status || 400, e.message); }

  const known = new Set((await env.DB.prepare("SELECT id FROM categories").all()).results.map((c) => c.id));
  const categories = cleanStringList(body.categories).filter((id) => known.has(id));
  const tags = cleanStringList(body.tags);

  const base = slugify(name);
  let id = `${base}-${randomHex(3)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await env.DB.prepare("SELECT 1 AS x FROM titles WHERE id = ?").bind(id).first();
    if (!clash) break;
    id = `${base}-${randomHex(4)}`;
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO titles
       (id, name, description, year, poster_url, subtitle_url, duration, size,
        status, views, categories, tags, sources, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    name,
    String(body.description || "").slice(0, 2000),
    body.year ? int(body.year, null) : null,
    String(body.poster_url || "").slice(0, 500),
    String(body.subtitle_url || "").slice(0, 500),
    int(body.duration, 0) || null,
    int(body.size, 0) || null,
    JSON.stringify(categories),
    JSON.stringify(tags),
    JSON.stringify(sources),
    now,
    now,
  ).run();

  const row = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(id).first();
  return json({ ok: true, title: rowToTitle(row) }, { status: 201 });
}
