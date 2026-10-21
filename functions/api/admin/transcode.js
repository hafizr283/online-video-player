import { deleteBlob, dispatchTranscode, outputBlobFor } from "../../_lib/admin.js";
import { requireAdmin } from "../../_lib/auth.js";
import { blobSas, publicBlobUrl } from "../../_lib/azure.js";
import { fail, json, randomHex, readJson } from "../../_lib/http.js";
import { rowToTitle } from "../../_lib/titles.js";

/**
 * The transcode queue.
 *
 *   POST   { title_id, source_id }   enqueue a file that is sitting in incoming/
 *   GET    ?next=1                   claim the oldest queued job (the runner)
 *   PATCH  { id, status, ... }       report a result and attach the new blob
 *
 * D1 is the queue; the GitHub dispatch below only shortens the wait. A missed
 * dispatch is picked up by the workflow's five-minute schedule.
 */

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  let body;
  try { body = await readJson(request, 4096); }
  catch { return fail(413, "too_large"); }

  const titleId = String(body.title_id || "");
  const sourceId = String(body.source_id || "");
  if (!titleId || !sourceId) return fail(400, "missing_ids");

  const row = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(titleId).first();
  if (!row) return fail(404, "unknown_title");

  const title = rowToTitle(row);
  const source = title.sources.find((s) => s.id === sourceId);
  if (!source) return fail(404, "unknown_source");
  if (!String(source.blob || "").startsWith("incoming/")) return fail(400, "not_in_incoming");

  const active = await env.DB.prepare(
    "SELECT id FROM transcode_jobs WHERE source_id = ? AND status IN ('queued', 'running') LIMIT 1",
  ).bind(sourceId).first();
  if (active) return json({ ok: true, job: { id: active.id }, already: true });

  const id = randomHex(12);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO transcode_jobs (id, title_id, source_id, blob, name, quality, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).bind(id, titleId, sourceId, source.blob, source.name || source.blob.split("/").pop(), Number(source.quality) || 720, now, now).run();

  const dispatched = await dispatchTranscode(env);
  return json({ ok: true, job: { id, status: "queued" }, dispatched }, { status: 202 });
}

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  if (url.searchParams.get("next") !== "1") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM transcode_jobs ORDER BY created_at DESC LIMIT 20",
    ).all();
    return json({ ok: true, jobs: results || [] });
  }

  // A runner that dies after claiming leaves a job "running" forever. Four
  // hours is longer than the workflow's own timeout, so anything still marked
  // running then is stale; retry it twice, then give up with a visible reason.
  const now = Date.now();
  const stale = now - 4 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE transcode_jobs SET status = 'failed', error = 'runner did not report back', updated_at = ? WHERE status = 'running' AND updated_at < ? AND attempts >= 3",
    ).bind(now, stale),
    env.DB.prepare(
      "UPDATE transcode_jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ? AND attempts < 3",
    ).bind(now, stale),
  ]);

  const next = await env.DB.prepare(
    "SELECT * FROM transcode_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
  ).first();
  if (!next) return json({ ok: true, empty: true });

  const claimed = await env.DB.prepare(
    "UPDATE transcode_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
  ).bind(now, next.id).run();
  if (!claimed.meta?.changes) return json({ ok: true, empty: true });

  const outputBlob = outputBlobFor(next);
  const [inputUrl, outputUrl] = await Promise.all([
    blobSas(env, { blob: next.blob, permissions: "r", minutes: 30 }),
    blobSas(env, { blob: outputBlob, permissions: "cw", minutes: 240 }),
  ]);

  return json({
    ok: true,
    job: {
      id: next.id,
      title_id: next.title_id,
      source_id: next.source_id,
      name: next.name,
      quality: next.quality,
      blob: next.blob,
    },
    inputUrl,
    outputUrl,
    outputBlob,
    outputUrlPublic: publicBlobUrl(env, outputBlob),
  });
}

export async function onRequestPatch({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  let body;
  try { body = await readJson(request, 8192); }
  catch { return fail(413, "too_large"); }

  const id = String(body.id || "");
  const status = String(body.status || "");
  if (!id || !["done", "failed"].includes(status)) return fail(400, "bad_request");

  const job = await env.DB.prepare("SELECT * FROM transcode_jobs WHERE id = ?").bind(id).first();
  if (!job) return fail(404, "unknown_job");

  const now = Date.now();

  if (status === "failed") {
    await env.DB.prepare(
      "UPDATE transcode_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
    ).bind(String(body.error || "transcode failed").slice(0, 1000), now, id).run();
    return json({ ok: true, status: "failed" });
  }

  const row = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(job.title_id).first();
  if (!row) {
    await env.DB.prepare(
      "UPDATE transcode_jobs SET status = 'failed', error = 'title deleted while transcoding', updated_at = ? WHERE id = ?",
    ).bind(now, id).run();
    return json({ ok: true, status: "failed", reason: "title_deleted" });
  }

  const outputBlob = outputBlobFor(job);
  const url = publicBlobUrl(env, outputBlob);
  const title = rowToTitle(row);

  let found = false;
  const sources = title.sources.map((s) => {
    if (s.id !== job.source_id) return s;
    found = true;
    return {
      ...s,
      url,
      blob: outputBlob,
      type: "mp4",
      status: "ready",
      size: Number(body.size) || s.size || 0,
      duration: Number(body.duration) || s.duration || null,
    };
  });

  if (!found) {
    await env.DB.prepare(
      "UPDATE transcode_jobs SET status = 'failed', error = 'source removed while transcoding', updated_at = ? WHERE id = ?",
    ).bind(now, id).run();
    return json({ ok: true, status: "failed", reason: "source_missing" });
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE titles SET sources = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(sources), now, job.title_id),
    env.DB.prepare("UPDATE transcode_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?")
      .bind(now, id),
  ]);

  // The raw file is no longer needed once its MP4 exists. A failed delete is
  // reported, not hidden: it leaves a blob the admin can still see in Azure.
  const removed = await deleteBlob(env, job.blob);

  return json({ ok: true, status: "done", url, blob: outputBlob, incoming_deleted: removed.ok, incoming_error: removed.error });
}
