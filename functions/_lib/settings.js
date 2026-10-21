/**
 * Small key/value settings that an admin can change without a deploy.
 *
 * The public-upload switch is deliberately a D1 row rather than an environment
 * variable: the admin UI must be able to flip it immediately, and the public
 * endpoints must read the same value on the next request.
 */

export const PUBLIC_UPLOADS_KEY = "allow_public_uploads";

export async function publicUploadsEnabled(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?",
  ).bind(PUBLIC_UPLOADS_KEY).first();
  return row?.value === "1";
}

export async function setPublicUploads(env, enabled) {
  const value = enabled ? "1" : "0";
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(PUBLIC_UPLOADS_KEY, value).run();
  return enabled;
}
