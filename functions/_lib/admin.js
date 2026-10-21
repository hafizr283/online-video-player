import { blobSafeName, int, randomHex } from "./http.js";
import { blobSas } from "./azure.js";

/** One file of one title, normalised. The client is never trusted with shapes. */
export function cleanSource(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const url = String(s.url || "").trim();
  if (url && !/^https:\/\//i.test(url)) throw Object.assign(new Error("source_url_not_https"), { status: 400 });

  const status = ["ready", "pending", "failed"].includes(s.status)
    ? s.status
    : (url ? "ready" : "pending");

  return {
    id: String(s.id || randomHex(6)).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || randomHex(6),
    quality: int(s.quality, 0),
    type: String(s.type || "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp4",
    url,
    blob: String(s.blob || "").replace(/[^A-Za-z0-9/._-]/g, "").slice(0, 300),
    name: String(s.name || "").slice(0, 200),
    size: int(s.size, 0),
    best: Boolean(s.best),
    audio: String(s.audio || "Default").slice(0, 40),
    codec: String(s.codec || "").slice(0, 20),
    status,
  };
}

export function cleanStringList(value, limit = 40) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v).trim().slice(0, limit)).filter(Boolean))].slice(0, 20);
}

/**
 * Delete one blob. Used when a title is deleted, and when the transcoder has
 * finished with an incoming file. Failure is reported, never silently swallowed:
 * the caller decides whether the job is still complete.
 */
export async function deleteBlob(env, blob) {
  if (!blob) return { ok: true, skipped: true };
  try {
    const url = await blobSas(env, { blob, permissions: "d", minutes: 10 });
    const res = await fetch(url, { method: "DELETE" });
    // 404 means it is already gone, which is the outcome we wanted.
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/**
 * Wake the GitHub Actions transcoder. The D1 queue is the source of truth; this
 * only removes the up-to-5-minute wait for the next scheduled sweep. A failure
 * here is not a failure of the job.
 */
export async function dispatchTranscode(env) {
  if (!env.GH_REPO || !env.GH_TOKEN) return { ok: false, skipped: true };
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "fast-player-pages",
      },
      body: JSON.stringify({ event_type: "transcode" }),
    });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/** The output blob of a job is derived from the job id, so every step agrees. */
export const outputBlobFor = (job) =>
  `v1/${String(job.id).slice(0, 12)}/${blobSafeName(job.name).replace(/\.[^.]+$/, "")}.mp4`;
