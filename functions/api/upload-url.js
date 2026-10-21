import { fail, json, blobSafeName, randomHex, readJson } from "../_lib/http.js";
import { ipHash } from "../_lib/auth.js";
import { publicUploadsEnabled } from "../_lib/settings.js";
import {
  MAX_UPLOAD,
  PUBLIC_UPLOAD_HOUR_LIMIT,
  PUBLIC_UPLOAD_MIN_GAP_MS,
  UPLOAD_TICKET_TTL_MS,
  isMp4Upload,
} from "../_lib/uploads.js";
import { blobSas, publicBlobUrl } from "../_lib/azure.js";

/**
 * POST /api/upload-url
 *
 * The public counterpart of the admin upload signer. It is deliberately
 * narrower: video only, MP4 only, and only under v1/ (never incoming/, because
 * the open path does not queue a transcode).
 *
 * The returned ticket is the only proof that a later draft-create request owns
 * this blob. The browser never gets to name an arbitrary Azure URL.
 */
export async function onRequestPost({ request, env }) {
  if (!(await publicUploadsEnabled(env))) return fail(403, "uploads_closed");

  let body;
  try { body = await readJson(request, 4096); }
  catch (error) { return fail(error.status || 413, error.message || "too_large"); }
  if (!body || typeof body !== "object") body = {};

  if (String(body.kind || "video") !== "video") return fail(400, "bad_kind");

  const name = blobSafeName(body.filename || "video.mp4");
  if (!isMp4Upload(name, body.content_type)) return fail(400, "mp4_only");

  const size = Number(body.size || 0);
  if (!Number.isInteger(size) || size <= 0) return fail(400, "bad_size");
  if (size > MAX_UPLOAD) return fail(413, "too_large");

  const hash = await ipHash(request, env);
  const now = Date.now();

  const last = await env.DB.prepare(
    "SELECT at FROM upload_log WHERE ip_hash = ? ORDER BY at DESC LIMIT 1",
  ).bind(hash).first();
  if (last && now - Number(last.at) < PUBLIC_UPLOAD_MIN_GAP_MS) return fail(429, "slow_down");

  const hourCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM upload_log WHERE ip_hash = ? AND at > ?",
  ).bind(hash, now - 60 * 60 * 1000).first();
  if (Number(hourCount?.n) >= PUBLIC_UPLOAD_HOUR_LIMIT) return fail(429, "too_many_uploads");

  const resume = String(body.resume_key || "").toLowerCase();
  const folder = /^[a-f0-9]{12,64}$/.test(resume) ? resume : randomHex(6);
  const blob = `v1/${folder}/${name}`;
  const uploadUrl = await blobSas(env, { blob, permissions: "cw", minutes: 240 });
  const ticket = randomHex(16);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_log WHERE at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("DELETE FROM upload_tickets WHERE expires_at < ?").bind(now - 60 * 60 * 1000),
    env.DB.prepare("INSERT INTO upload_log (ip_hash, at) VALUES (?, ?)").bind(hash, now),
    env.DB.prepare(
      `INSERT INTO upload_tickets (id, blob, name, size, ip_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(ticket, blob, name, size, hash, now + UPLOAD_TICKET_TTL_MS),
  ]);

  return json({
    ok: true,
    ticket,
    blob,
    name,
    uploadUrl,
    publicUrl: publicBlobUrl(env, blob),
    expiresIn: 4 * 60 * 60,
  });
}
