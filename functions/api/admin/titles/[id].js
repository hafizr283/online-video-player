import { cleanStringList, cleanSource, deleteBlob } from "../../../_lib/admin.js";
import { requireAdmin } from "../../../_lib/auth.js";
import { fail, int, json, readJson } from "../../../_lib/http.js";
import { readySources, rowToTitle } from "../../../_lib/titles.js";

const blobFromUrl = (env, value) => {
  try {
    const url = new URL(value);
    const prefix = `/${env.AZURE_CONTAINER || "movies"}/`;
    if (url.host === `${env.AZURE_ACCOUNT}.blob.core.windows.net` && url.pathname.startsWith(prefix)) {
      return decodeURIComponent(url.pathname.slice(prefix.length));
    }
  } catch { /* not a blob URL */ }
  return "";
};

/** PATCH /api/admin/titles/:id — edit, publish or unpublish. */
export async function onRequestPatch({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const row = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(params.id).first();
  if (!row) return fail(404, "unknown_title");

  let body;
  try { body = await readJson(request, 64 * 1024); }
  catch { return fail(413, "too_large"); }

  const current = rowToTitle(row);
  const sets = [];
  const values = [];

  const put = (column, value) => { sets.push(`${column} = ?`); values.push(value); };

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 200);
    if (!name) return fail(400, "no_name");
    put("name", name);
  }
  if (body.description !== undefined) put("description", String(body.description).slice(0, 2000));
  if (body.year !== undefined) put("year", body.year ? int(body.year, null) : null);
  if (body.poster_url !== undefined) put("poster_url", String(body.poster_url).slice(0, 500));
  if (body.subtitle_url !== undefined) put("subtitle_url", String(body.subtitle_url).slice(0, 500));
  if (body.duration !== undefined) put("duration", int(body.duration, 0) || null);
  if (body.size !== undefined) put("size", int(body.size, 0) || null);

  if (body.categories !== undefined) {
    const known = new Set((await env.DB.prepare("SELECT id FROM categories").all()).results.map((c) => c.id));
    put("categories", JSON.stringify(cleanStringList(body.categories).filter((id) => known.has(id))));
  }
  if (body.tags !== undefined) put("tags", JSON.stringify(cleanStringList(body.tags)));

  let cleanedSources = null;
  if (body.sources !== undefined) {
    try { cleanedSources = (Array.isArray(body.sources) ? body.sources : []).slice(0, 20).map(cleanSource); }
    catch (e) { return fail(e.status || 400, e.message); }
    put("sources", JSON.stringify(cleanedSources));
  }

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!["draft", "published"].includes(status)) return fail(400, "bad_status");
    if (status === "published") {
      // Publishing a title with nothing playable would put a dead card on the
      // home page, so the request is refused rather than half-honoured.
      const sources = cleanedSources ?? current.sources;
      if (!readySources({ sources }).length) return fail(400, "no_playable_source");
    }
    put("status", status);
  }

  if (!sets.length) return json({ ok: true, title: current });

  put("updated_at", Date.now());
  await env.DB.prepare(`UPDATE titles SET ${sets.join(", ")} WHERE id = ?`).bind(...values, params.id).run();

  const updated = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(params.id).first();
  return json({ ok: true, title: rowToTitle(updated) });
}

/**
 * DELETE /api/admin/titles/:id
 *
 * Deletes the catalogue row **and** its blobs — the opposite of the local
 * server's "keep the bytes" rule, chosen deliberately here because nobody can
 * clean up an orphan from a browser later. Every failure is reported.
 */
export async function onRequestDelete({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const row = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(params.id).first();
  if (!row) return fail(404, "unknown_title");

  const title = rowToTitle(row);
  const blobs = new Set();
  for (const source of title.sources) {
    const blob = source.blob || blobFromUrl(env, source.url);
    if (blob) blobs.add(blob);
  }
  const posterBlob = blobFromUrl(env, title.poster);
  if (posterBlob) blobs.add(posterBlob);

  const results = await Promise.all([...blobs].map(async (blob) => ({ blob, ...(await deleteBlob(env, blob)) })));
  const failed = results.filter((r) => !r.ok);

  await env.DB.prepare("DELETE FROM titles WHERE id = ?").bind(params.id).run();

  return json({
    ok: true,
    deleted_blobs: results.filter((r) => r.ok).map((r) => r.blob),
    failed_blobs: failed.map((r) => ({ blob: r.blob, error: r.error || r.status })),
    warning: failed.length ? "The title is gone but some blobs could not be deleted; they are listed above." : undefined,
  });
}
