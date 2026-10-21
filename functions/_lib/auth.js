import { clientIp, fail, sha256Hex } from "./http.js";

const LOCK_ATTEMPTS = 8;          // wrong tokens before the door shuts
const LOCK_WINDOW_MS = 15 * 60 * 1000;

/**
 * Compare two secrets without an early return.
 *
 * Hashing both sides first means the loop always runs over 32 bytes, so neither
 * the length nor the position of the first differing byte is observable from
 * timing (which is what a naive `===` would leak).
 */
async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(a))),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const ipHash = (request, env) => sha256Hex(`${env.IP_SALT || "fp"}|${clientIp(request)}`);

async function locked(env, hash) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_log WHERE ip_hash = ? AND at > ?",
  ).bind(hash, Date.now() - LOCK_WINDOW_MS).first();
  return (row?.n || 0) >= LOCK_ATTEMPTS;
}

async function noteFailure(env, hash) {
  const now = Date.now();
  await env.DB.batch([
    // A day is longer than the lock window; keeping more is only noise.
    env.DB.prepare("DELETE FROM auth_log WHERE at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("INSERT INTO auth_log (ip_hash, at) VALUES (?, ?)").bind(hash, now),
  ]);
}

/**
 * Admin gate. Unset ADMIN_TOKENS disables the API entirely (404, not 401):
 * a half-configured deployment must not advertise an admin door.
 */
export async function requireAdmin(request, env) {
  const tokens = String(env.ADMIN_TOKENS || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, response: fail(404, "not_found") };

  const hash = await ipHash(request, env);
  if (await locked(env, hash)) return { ok: false, response: fail(429, "locked") };

  const header = String(request.headers.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1].trim() : "";

  let ok = false;
  // Every token is compared even after a match, so the work does not reveal
  // which entry in the list was right.
  for (const token of tokens) ok = (await sameSecret(provided, token)) || ok;

  if (!provided || !ok) {
    await noteFailure(env, hash);
    return { ok: false, response: fail(401, "unauthorized") };
  }
  return { ok: true };
}
