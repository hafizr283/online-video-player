/**
 * Azure Blob storage, without an SDK and without a dependency.
 *
 * The library keeps `library.json` as its catalogue; this module is only the
 * transport for the bytes. It speaks the three calls the site needs — PUT a
 * whole file, HEAD a blob, DELETE a blob — over plain HTTPS with a Shared
 * Access Signature, so nothing but Node's own modules is required.
 *
 * The SAS never reaches a browser: the server signs its own requests, and the
 * player is given the public blob URL (the container is public-read). Keep the
 * signature in the environment, not in library.json.
 */
import http from "node:http";
import https from "node:https";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";

// New enough for a single PUT of up to 5 GiB, which is the whole point: a film
// is one request, not a block dance.
const API_VERSION = "2021-08-06";

/** Normalise "?sv=...&sig=..." / "sv=...&sig=..." into a query string. */
export function parseSas(input) {
  const raw = String(input || "").trim().replace(/^[?&]+/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  if (!params.get("sig") || !params.get("sv")) return null;
  // A blob-scoped signature only ever authorises that one blob, which is not
  // enough to publish a library; say so instead of failing later with a 403.
  return {
    query: params.toString(),
    scope: params.get("sr") === "c" ? "container" : "blob",
    expires: params.get("se") || null,
  };
}

/** Strip any query so a pasted container URL can never carry a key around. */
export function containerBase(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return ""; }
}

/**
 * Where a file goes inside the container.
 *
 * The name is unguessable by design: the container is public-read, so the URL
 * is the only thing standing between a film and a stranger. A directory per
 * upload also keeps two files with the same name from overwriting each other
 * when a title is replaced.
 *
 * The visible part stays readable, because somebody will eventually look at the
 * container's file list and need to recognise a film: runs of punctuation
 * collapse to one underscore, and the extension is kept.
 */
export function blobNameFor(file, prefix = "v1") {
  const raw = String(file || "");
  const ext = (raw.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0];
  const stem = raw
    .slice(0, raw.length - ext.length)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(-120);
  const safeExt = ext.replace(/[^A-Za-z0-9.]/g, "");
  const bucket = randomBytes(6).toString("hex");
  return `${prefix}/${bucket}/${stem || "file"}${safeExt}`;
}

const pickHttp = (url) => (url.protocol === "http:" ? http : https);

/**
 * PUT one file as a block blob, reporting progress as it goes.
 *
 * Resolves { ok, url, bytes, etag }, rejects with a message that names what
 * Azure said. `signal` cancels; an aborted upload leaves no visible blob.
 */
/**
 * A pass-through that keeps the average below `bytesPerSecond`.
 *
 * Publishing a three-gigabyte film at full speed saturates a domestic uplink:
 * measured on this line, blob HEADs went from 0.4 s to 15 s and the public
 * tunnel timed out, so the site was down *because* it was being migrated. A
 * little headroom costs minutes; a dark site costs viewers.
 *
 * The first second is free, so a small file is not slowed down at all.
 */
function throttle(bytesPerSecond) {
  const started = Date.now();
  let bytes = 0;
  const slack = 1000;
  return new Transform({
    transform(chunk, _enc, done) {
      bytes += chunk.length;
      const due = started + (bytes / bytesPerSecond) * 1000 - slack;
      const wait = due - Date.now();
      if (wait > 20) setTimeout(() => done(null, chunk), wait);
      else done(null, chunk);
    },
  });
}

export async function putBlob({
  container, sas, name, file, contentType = "application/octet-stream",
  onProgress, signal, timeoutMs = 6 * 60 * 60 * 1000, bytesPerSecond = 0,
} = {}) {
  const base = containerBase(container);
  const auth = parseSas(sas);
  if (!base) throw new Error("no container URL");
  if (!auth) throw new Error("no SAS token");
  const size = (await stat(file)).size;
  const url = new URL(`${base}/${name.split("/").map(encodeURIComponent).join("/")}`);
  url.search = auth.query;

  const attempt = () => new Promise((resolve, reject) => {
    const req = pickHttp(url).request(url, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": API_VERSION,
        "x-ms-blob-content-type": contentType,
        "Content-Type": contentType,
        "Content-Length": String(size),
      },
    });
    let sent = 0;
    let last = 0;
    const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });

    const stop = (err) => {
      stream.destroy();
      req.destroy();
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return stop(new Error("cancelled"));
      signal.addEventListener("abort", () => stop(new Error("cancelled")), { once: true });
    }
    const timer = setTimeout(() => stop(new Error("upload timed out")), timeoutMs);
    timer.unref?.();

    stream.on("data", (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (onProgress && (now - last > 400 || sent === size)) {
        last = now;
        onProgress({ sent, total: size, percent: size ? (sent / size) * 100 : 100 });
      }
    });
    stream.on("error", stop);
    req.on("error", (e) => { clearTimeout(timer); stop(e); });
    req.on("response", async (res) => {
      clearTimeout(timer);
      const body = await readAll(res, 4096);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return resolve({
          ok: true,
          url: `${base}/${name.split("/").map(encodeURIComponent).join("/")}`,
          bytes: size,
          etag: res.headers.etag || "",
        });
      }
      const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || "";
      const message = (body.match(/<Message>([^<]+)<\/Message>/) || [])[1] || body.slice(0, 200);
      const error = new Error(`Azure answered ${res.statusCode}${code ? ` ${code}` : ""}: ${message}`);
      error.status = res.statusCode;
      error.code = code;
      reject(error);
    });
    if (bytesPerSecond > 0) stream.pipe(throttle(bytesPerSecond)).pipe(req);
    else stream.pipe(req);
  });

  // Two attempts: a dropped connection 40 minutes into a film should not mean
  // starting the whole conversion pipeline again by hand.
  let lastError = null;
  for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
    try {
      return await attempt();
    } catch (e) {
      if (e.message === "cancelled" || e.status === 403 || e.status === 404 || e.status === 409) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

/** Is this blob there, and how big is it? Public read, no SAS needed. */
export function headBlob({ url, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { return resolve({ ok: false, reason: "bad url" }); }
    const req = pickHttp(target).request(target, { method: "HEAD", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({
        ok: res.statusCode === 200,
        status: res.statusCode,
        bytes: Number(res.headers["content-length"] || 0),
        contentType: res.headers["content-type"] || "",
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

/** Remove a blob (the admin's explicit choice, never automatic). */
export function deleteBlob({ container, sas, name, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const base = containerBase(container);
    const auth = parseSas(sas);
    if (!base || !auth) return resolve({ ok: false, reason: "not configured" });
    const url = new URL(`${base}/${name.split("/").map(encodeURIComponent).join("/")}`);
    url.search = auth.query;
    const req = pickHttp(url).request(url, {
      method: "DELETE",
      timeout: timeoutMs,
      headers: { "x-ms-version": API_VERSION, "x-ms-delete-snapshots": "include" },
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 202 || res.statusCode === 204, status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

function readAll(stream, limit) {
  return new Promise((resolve) => {
    let out = "";
    stream.on("data", (d) => { if (out.length < limit) out += d.toString().slice(0, limit); });
    stream.on("end", () => resolve(out));
    stream.on("error", () => resolve(out));
  });
}
