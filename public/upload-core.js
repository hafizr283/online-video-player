/**
 * Browser upload primitives shared by the admin and public upload pages.
 *
 * The Pages Function signs a single blob; these helpers send the file straight
 * to Azure in 8 MB blocks. Keeping one implementation means the public page and
 * the admin page agree about block ids, retries and resume state.
 */

const BLOCK = 8 * 1024 * 1024;
const WORKERS = 3;

/** Map a decoded frame height to the quality labels the catalogue uses. */
export function qualityForHeight(height) {
  const h = Number(height) || 0;
  if (h >= 2000) return 2160;
  if (h >= 1000) return 1080;
  if (h >= 700) return 720;
  return 480;
}

/** Read metadata (and a poster frame when the browser can decode the file). */
export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  const loaded = await new Promise((resolve) => {
    const done = (value) => resolve(value);
    video.addEventListener("loadedmetadata", () => done(true), { once: true });
    video.addEventListener("error", () => done(false), { once: true });
    setTimeout(() => done(false), 8000);
  });

  if (!loaded) {
    URL.revokeObjectURL(url);
    return { playable: false, duration: 0, posterBlob: null, width: 0, height: 0 };
  }

  const duration = Number(video.duration) || 0;
  const width = Number(video.videoWidth) || 0;
  const height = Number(video.videoHeight) || 0;
  let posterBlob = null;
  try {
    const at = Math.max(0.1, Math.min(duration * 0.1, Math.max(duration - 1, 0.1)));
    video.currentTime = at;
    await new Promise((resolve) => {
      video.addEventListener("seeked", resolve, { once: true });
      setTimeout(resolve, 2500);
    });
    // Give the decoder one painted frame before the canvas copy. The callback
    // does not fire for an off-DOM, paused video in some Chromium builds, so it
    // must race a timer. Without the timer the probe never resolves and the
    // Upload button stays disabled forever.
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      try {
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(finish);
      } catch { /* fall through to the timer */ }
      setTimeout(finish, 300);
    });

    const vw = width || 500;
    const vh = height || 750;
    const posterWidth = 500;
    const posterHeight = Math.round(posterWidth * (vh / vw)) || 750;
    const canvas = document.createElement("canvas");
    canvas.width = posterWidth;
    canvas.height = Math.min(1100, Math.max(300, posterHeight));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    posterBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  } catch { /* a missing poster is recoverable; the title keeps its generated art */ }

  URL.revokeObjectURL(url);
  return { playable: true, duration, posterBlob, width, height };
}

export async function putWithRetry(url, body, headers = {}, tries = 3) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", headers, body });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500) break; // a bad SAS will not heal
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw last || new Error("upload failed");
}

/**
 * A resumable upload needs a stable identity for "this file". Name, size and
 * mtime are enough to tell two pickings of the same file apart from a different
 * film with the same name.
 */
export async function resumeKeyFor(file) {
  const data = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const RESUME_PREFIX = "fp_upload:";

function readResume(key) {
  try { return JSON.parse(localStorage.getItem(RESUME_PREFIX + key) || "null"); }
  catch { return null; }
}

function writeResume(key, value) {
  try { localStorage.setItem(RESUME_PREFIX + key, JSON.stringify(value)); }
  catch { /* private mode: resume degrades to a plain upload */ }
}

function clearResume(key) {
  try { localStorage.removeItem(RESUME_PREFIX + key); } catch { /* ignore */ }
}

const blockId = (index) => btoa(`block-${String(index).padStart(6, "0")}`);

/**
 * Azure block upload: 8 MB blocks, three in flight, a stable block id each, then
 * one commit. Re-running a failed block is safe; the commit is the only step
 * that makes the blob visible.
 *
 * Blocks accepted in an earlier attempt (same file, same blob path) are skipped.
 * Their ids are deterministic, so the final list is identical whether a block
 * arrived now or before a reload.
 */
export async function uploadInBlocks(file, uploadUrl, onProgress, { resumeKey, blob, contentType } = {}) {
  const total = Math.ceil(file.size / BLOCK);
  // Restore every id, including blocks skipped by a resume: the commit list
  // must contain the complete file, not just the blocks sent in this attempt.
  const ids = Array.from({ length: total }, (_, index) => blockId(index));
  const saved = resumeKey ? readResume(resumeKey) : null;
  const savedDone = Array.isArray(saved?.done) && saved.blob === blob
    ? saved.done.filter((index) => Number.isInteger(index) && index >= 0 && index < total)
    : [];
  const done = new Set(savedDone);
  const queue = [...Array(total).keys()].filter((index) => !done.has(index));

  let sent = 0;
  for (const index of done) sent += Math.min(BLOCK, file.size - index * BLOCK);
  onProgress(sent / file.size);

  const worker = async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      const start = index * BLOCK;
      const chunk = file.slice(start, Math.min(file.size, start + BLOCK));
      const id = ids[index];
      await putWithRetry(`${uploadUrl}&comp=block&blockid=${encodeURIComponent(id)}`, chunk, {
        "content-type": "application/octet-stream",
      });
      done.add(index);
      if (resumeKey) writeResume(resumeKey, { blob, done: [...done] });
      sent += chunk.size;
      onProgress(sent / file.size);
    }
  };

  await Promise.all(Array.from({ length: Math.min(WORKERS, total) }, worker));

  const xml = '<?xml version="1.0" encoding="utf-8"?><BlockList>' +
    ids.map((id) => `<Latest>${id}</Latest>`).join("") + "</BlockList>";

  await putWithRetry(`${uploadUrl}&comp=blocklist`, xml, {
    "content-type": "application/xml",
    "x-ms-blob-content-type": contentType || file.type || "video/mp4",
    "x-ms-blob-cache-control": "public, max-age=31536000, immutable",
  });

  if (resumeKey) clearResume(resumeKey);
}
