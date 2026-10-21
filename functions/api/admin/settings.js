import { fail, json, readJson } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import {
  PUBLIC_UPLOAD_MODES,
  publicUploadSettings,
  setPublicUploadMode,
  setPublicUploads,
} from "../../_lib/settings.js";

/** GET /api/admin/settings — the switches shown on the admin Upload tab. */
export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const settings = await publicUploadSettings(env);
  return json({
    ok: true,
    allow_public_uploads: settings.open,
    public_upload_mode: settings.mode,
  });
}

/** POST /api/admin/settings — update the public-upload switch or its mode. */
export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  let body;
  try { body = await readJson(request, 4096); }
  catch (error) { return fail(error.status || 413, error.message || "too_large"); }

  const hasOpen = typeof body?.allow_public_uploads === "boolean";
  const hasMode = body?.public_upload_mode !== undefined;
  if (!hasOpen && !hasMode) return fail(400, "bad_setting");
  if (hasMode && !PUBLIC_UPLOAD_MODES.has(body.public_upload_mode)) return fail(400, "bad_mode");

  if (hasOpen) await setPublicUploads(env, body.allow_public_uploads);
  if (hasMode) await setPublicUploadMode(env, body.public_upload_mode);

  const settings = await publicUploadSettings(env);
  return json({
    ok: true,
    allow_public_uploads: settings.open,
    public_upload_mode: settings.mode,
  });
}
