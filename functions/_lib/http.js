/**
 * Small HTTP helpers shared by every Function.
 *
 * Nothing here touches Node APIs: the Workers runtime has fetch, WebCrypto,
 * TextEncoder and atob/btoa, and that is all this project uses.
 */

const encoder = new TextEncoder();

export const json = (data, { status = 200, headers = {}, cache = "no-store" } = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      ...headers,
    },
  });

export const fail = (status, code, extra = {}) =>
  json({ ok: false, error: code, ...extra }, { status });

/** Read a JSON body with a real byte ceiling — never buffer an unbounded POST. */
export async function readJson(request, limit = 16 * 1024) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw Object.assign(new Error("too_large"), { status: 413 });
  const text = await request.text();
  if (text.length > limit) throw Object.assign(new Error("too_large"), { status: 413 });
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("bad_json"), { status: 400 }); }
}

/** Cloudflare sets CF-Connecting-IP; anything else is a local test or a proxy. */
export function clientIp(request) {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return fwd || "unknown";
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const randomHex = (bytes = 12) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A slug that is safe in a URL, a blob name and a SQL parameter. */
export function slugify(text, fallback = "title") {
  const slug = String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/** Blob names: readable, but never a path traversal and never a surprise slash. */
export function blobSafeName(name) {
  const base = String(name || "video.mp4").split(/[\\/]/).pop();
  const clean = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 90);
  return clean || "video.mp4";
}

export const int = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

/** Parse a JSON column without letting one bad row break a listing. */
export function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch { return fallback; }
}
