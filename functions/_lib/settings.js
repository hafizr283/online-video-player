/**
 * Small key/value settings that an admin can change without a deploy.
 *
 * The public-upload switch is deliberately a D1 row rather than an environment
 * variable: the admin UI must be able to flip it immediately, and the public
 * endpoints must read the same value on the next request.
 */

export const PUBLIC_UPLOADS_KEY = "allow_public_uploads";
export const PUBLIC_UPLOAD_MODE_KEY = "public_upload_mode";
export const PUBLIC_UPLOAD_MODES = new Set(["draft", "publish"]);

/** Read both public-upload settings in one round trip. */
export async function publicUploadSettings(env) {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN (?, ?)",
  ).bind(PUBLIC_UPLOADS_KEY, PUBLIC_UPLOAD_MODE_KEY).all();
  const values = new Map((rows.results || []).map((row) => [row.key, row.value]));
  return {
    open: values.get(PUBLIC_UPLOADS_KEY) === "1",
    mode: values.get(PUBLIC_UPLOAD_MODE_KEY) === "publish" ? "publish" : "draft",
  };
}

export async function setPublicUploads(env, enabled) {
  const value = enabled ? "1" : "0";
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(PUBLIC_UPLOADS_KEY, value).run();
  return enabled;
}

export async function setPublicUploadMode(env, mode) {
  const value = PUBLIC_UPLOAD_MODES.has(mode) ? mode : "draft";
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(PUBLIC_UPLOAD_MODE_KEY, value).run();
  return value;
}
