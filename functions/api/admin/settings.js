import { fail, json, readJson } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { publicUploadsEnabled, setPublicUploads } from "../../_lib/settings.js";

/** GET /api/admin/settings — the switches shown on the admin Upload tab. */
export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  return json({ ok: true, allow_public_uploads: await publicUploadsEnabled(env) });
}

/** POST /api/admin/settings — flip the public-upload switch. */
export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  let body;
  try { body = await readJson(request, 4096); }
  catch (error) { return fail(error.status || 413, error.message || "too_large"); }

  if (typeof body?.allow_public_uploads !== "boolean") return fail(400, "bad_setting");

  await setPublicUploads(env, body.allow_public_uploads);
  return json({ ok: true, allow_public_uploads: body.allow_public_uploads });
}
