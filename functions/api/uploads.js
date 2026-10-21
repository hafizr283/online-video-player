import { fail, int, json, randomHex, readJson, slugify } from "../_lib/http.js";
import { publicUploadSettings } from "../_lib/settings.js";
import { publicBlobUrl } from "../_lib/azure.js";
import { rowToTitle } from "../_lib/titles.js";

const QUALITIES = new Set([2160, 1080, 720, 480]);

/**
 * POST /api/uploads
 *
 * Finish a public upload. The ticket was issued by /api/upload-url; it binds
 * the title to the exact blob that was signed, and it can be used once.
 *
 * The admin chooses whether the result is a draft or is published immediately.
 * Draft is the default, so opening uploads does not silently turn the library
 * into an unreviewed public feed.
 */
export async function onRequestPost({ request, env }) {
  const settings = await publicUploadSettings(env);
  if (!settings.open) return fail(403, "uploads_closed");

  let body;
  try { body = await readJson(request, 8192); }
  catch (error) { return fail(error.status || 413, error.message || "too_large"); }
  if (!body || typeof body !== "object") body = {};

  const ticketId = String(body.ticket || "").trim().toLowerCase();
  if (!/^[a-f0-9]{24,64}$/.test(ticketId)) return fail(400, "bad_ticket");

  const ticket = await env.DB.prepare(
    "SELECT * FROM upload_tickets WHERE id = ? AND used = 0 AND expires_at > ?",
  ).bind(ticketId, Date.now()).first();
  if (!ticket) return fail(403, "bad_ticket");

  const name = String(body.name || "").trim().slice(0, 200);
  if (!name) return fail(400, "no_name");

  const description = String(body.description || "").trim().slice(0, 2000);
  const rawYear = body.year === "" || body.year === null || body.year === undefined
    ? null
    : int(body.year, null);
  if (rawYear !== null && (rawYear < 1888 || rawYear > 2100)) return fail(400, "bad_year");
  const year = rawYear;
  const requestedQuality = Number(body.quality);
  const quality = QUALITIES.has(requestedQuality) ? requestedQuality : 720;
  const duration = Math.max(0, int(body.duration, 0)) || null;
  const status = settings.mode === "publish" ? "published" : "draft";

  const publicUrl = publicBlobUrl(env, ticket.blob);

  // The bytes never passed through the Worker, so check the finished blob
  // before turning the ticket into a catalogue row.
  let head;
  try {
    head = await fetch(publicUrl, { method: "HEAD", cache: "no-store" });
  } catch {
    return fail(502, "storage_unavailable");
  }
  if (!head.ok) {
    return fail(head.status === 404 ? 409 : 502, head.status === 404 ? "upload_missing" : "storage_unavailable");
  }

  const length = Number(head.headers.get("content-length") || 0);
  if (length && length !== Number(ticket.size)) return fail(409, "size_mismatch");
  const contentType = String(head.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("video/mp4")) return fail(415, "mp4_only");

  // Conditional consume: two concurrent finish requests cannot both create a
  // title from one ticket.
  const consumed = await env.DB.prepare(
    "UPDATE upload_tickets SET used = 1 WHERE id = ? AND used = 0 AND expires_at > ?",
  ).bind(ticketId, Date.now()).run();
  if (Number(consumed.meta?.changes) !== 1) return fail(409, "ticket_used");

  const base = slugify(name);
  let id = `${base}-${randomHex(3)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await env.DB.prepare("SELECT 1 AS x FROM titles WHERE id = ?").bind(id).first();
    if (!clash) break;
    id = `${base}-${randomHex(4)}`;
  }

  const source = {
    id: randomHex(6),
    quality,
    type: "mp4",
    url: publicUrl,
    blob: ticket.blob,
    name: ticket.name,
    size: Number(ticket.size) || 0,
    best: true,
    audio: "Default",
    codec: "",
    status: "ready",
  };

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO titles
       (id, name, description, year, poster_url, subtitle_url, duration, size,
        status, views, categories, tags, sources, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', ?, ?, ?, 0, '[]', '[]', ?, ?, ?)`,
  ).bind(
    id,
    name,
    description,
    year,
    duration,
    Number(ticket.size) || null,
    status,
    JSON.stringify([source]),
    now,
    now,
  ).run();

  const row = await env.DB.prepare("SELECT * FROM titles WHERE id = ?").bind(id).first();
  return json({
    ok: true,
    title: rowToTitle(row),
    pending: status === "draft",
    message: status === "draft"
      ? "Upload received. An admin will review it before it is published."
      : "Upload received and published.",
  }, { status: 201 });
}
