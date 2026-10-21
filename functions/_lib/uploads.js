/**
 * Public-upload limits shared by the browser contract and the Worker.
 *
 * The browser is allowed to pre-check these values, but the Worker is the
 * authority. Public files are MP4 only: the open path never queues a transcode.
 */

export const MAX_UPLOAD = 8 * 1024 * 1024 * 1024;
export const UPLOAD_TICKET_TTL_MS = 6 * 60 * 60 * 1000;
export const PUBLIC_UPLOAD_MIN_GAP_MS = 30 * 1000;
export const PUBLIC_UPLOAD_HOUR_LIMIT = 3;

const MP4_TYPES = new Set(["video/mp4", "application/mp4"]);

/** A name alone is not proof of a container, but it is the boundary we control. */
export function isMp4Upload(name, contentType = "") {
  if (!/\.mp4$/i.test(String(name || ""))) return false;
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  return !type || MP4_TYPES.has(type);
}

/** Map a decoded frame height to the quality labels the catalogue uses. */
export function qualityForHeight(height) {
  const h = Number(height) || 0;
  if (h >= 2000) return 2160;
  if (h >= 1000) return 1080;
  if (h >= 700) return 720;
  return 480;
}
