import { fail, json, randomHex, readJson, blobSafeName } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { blobSas, publicBlobUrl } from "../../_lib/azure.js";

const MAX_UPLOAD = 8 * 1024 * 1024 * 1024;
const KINDS = new Set(["video", "poster", "subtitle"]);

/**
 * POST /api/admin/upload-url
 *
 * Returns a single-blob, create+write SAS: four hours for video, one for a
 * poster or subtitle. The browser uploads
 * straight to Blob storage, so neither the Worker's body limit nor its CPU time
 * has anything to do with a 2 GB film.
 *
 * `stage: "movies"` is for a file the browser has already proven it can play.
 * Anything else goes under the `incoming/` prefix and waits for the transcoder;
 * nothing is published from there. The path is unguessable, not private — the
 * container is public-read — so it is never linked from the site.
 */
export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  let body;
  try { body = await readJson(request, 4096); }
  catch { return fail(413, "too_large"); }

  const kind = String(body.kind || "video");
  if (!KINDS.has(kind)) return fail(400, "bad_kind");

  const size = Number(body.size || 0);
  if (size > MAX_UPLOAD) return fail(413, "too_large");

  const name = blobSafeName(body.filename || (kind === "poster" ? "poster.jpg" : "video.mp4"));
  // A resumable upload keeps the same blob path between attempts, so blocks
  // already accepted by Azure can be skipped instead of re-sent. The key is
  // client-derived from name/size/mtime and is only a folder name, never a
  // credential.
  const resume = String(body.resume_key || "").toLowerCase();
  const folder = /^[a-f0-9]{12,64}$/.test(resume) ? resume : randomHex(6);
  let blob;

  if (kind === "poster") {
    blob = `posters/${folder}.jpg`;
  } else if (kind === "subtitle") {
    blob = `subs/${folder}.vtt`;
  } else if (String(body.stage || "movies") === "incoming") {
    blob = `incoming/${folder}/${name}`;
  } else {
    // Published files live under a random folder (v1/<hex>/name): the URL is
    // the handle, not a catalogue listing.
    blob = `v1/${folder}/${name}`;
  }

  const minutes = kind === "video" ? 240 : 60;
  const uploadUrl = await blobSas(env, { blob, permissions: "cw", minutes });

  return json({
    ok: true,
    blob,
    kind,
    name,
    uploadUrl,
    publicUrl: publicBlobUrl(env, blob),
    expiresIn: minutes * 60,
  });
}
