/**
 * Answers "will this host actually stream well?" for a media URL, by measuring
 * the three things a <video> player needs from an origin - none of which is
 * raw bandwidth:
 *
 *   1. Range support - seeking, resuming and byte-accurate failover need
 *      `206 Partial Content` plus `Accept-Ranges: bytes`. An origin that answers
 *      `200` to a Range request forces the player to re-download from byte zero
 *      on every seek.
 *   2. CORS - subtitles, the audio-health POST and canvas work are cross-origin
 *      fetches, so they need `Access-Control-Allow-Origin`. Plain playback does
 *      not, which is why a CORS-less host can look fine until you seek.
 *   3. Throughput - measured over a bounded window, so a multi-GB file is never
 *      pulled down.
 *
 *   node check-origin.mjs <url> [url...]
 *
 * Example - compare a real media origin with your own candidate host:
 *   node check-origin.mjs https://media.w3.org/2010/05/sintel/trailer.mp4
 */
const PROBE_BYTES = 1024;              // how much the range check asks for
const SPEED_CAP_BYTES = 4 * 1024 * 1024; // stop the speed sample here
const SPEED_DEADLINE_MS = 6000;          // ...or here, whichever comes first

const fmtBytes = (n) =>
  n == null ? "-" : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;

/** Read at most `limit` bytes, giving up after `deadlineMs`. Never buffers it all. */
async function readUpTo(res, limit, deadlineMs) {
  const reader = res.body.getReader();
  const t0 = Date.now();
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (deadlineMs && Date.now() - t0 >= deadlineMs) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { bytes, ms: Math.max(1, Date.now() - t0) };
}

/** Headers we care about, as a small object so the summary stays readable. */
function interesting(h, names) {
  const out = {};
  for (const n of names) {
    const v = h.get(n);
    if (v != null) out[n] = v;
  }
  return out;
}

async function probe(url) {
  const out = { url, notes: [] };
  const t0 = Date.now();

  // ---- request 1: does it honour a byte range? ------------------------------
  let r;
  try {
    r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
  } catch (e) {
    return { ...out, error: e.message };
  }
  const ttfbMs = Date.now() - t0;
  const first = await readUpTo(r, PROBE_BYTES, 3000);

  out.status = r.status;
  out.finalUrl = r.url && r.url !== url ? r.url : null;
  out.contentType = r.headers.get("content-type") || "-";
  out.totalBytes = Number(r.headers.get("content-length")) || null;
  out.acceptRanges = r.headers.get("accept-ranges") || null;
  out.contentRange = r.headers.get("content-range") || null;
  out.cors = r.headers.get("access-control-allow-origin") || null;
  out.bytesReceived = first.bytes;
  out.ttfbMs = ttfbMs;

  const partial = /^bytes \d+-\d+\//.test(out.contentRange || "");
  const fullBody = r.status === 200 && (out.totalBytes == null || out.totalBytes > PROBE_BYTES);

  if (r.status === 403 || r.status === 401) out.notes.push("origin refused the request outright");
  if (partial) out.notes.push("range honoured -> seeking works");
  else if (fullBody) out.notes.push("Range IGNORED (got 200 + whole file) -> seeking re-downloads from byte 0");
  if (/text\/html/i.test(out.contentType)) out.notes.push("answered with HTML, not video -> interstitial/login/consent page");
  if (!out.cors) out.notes.push("no CORS header -> cross-origin subtitles / health POST will fail");

  // ---- request 2: bounded throughput ----------------------------------------
  try {
    const r2 = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: `bytes=0-${SPEED_CAP_BYTES - 1}` },
    });
    const got = await readUpTo(r2, SPEED_CAP_BYTES, SPEED_DEADLINE_MS);
    out.speedMbps = (got.bytes * 8) / (got.ms / 1000) / 1e6;
    out.speedSample = got.bytes;
    out.speedPartial = /^bytes \d+-\d+\//.test(r2.headers.get("content-range") || "");
  } catch (e) {
    out.notes.push(`speed sample failed: ${e.message}`);
  }
  return out;
}

const urls = process.argv.slice(2);
if (!urls.length) {
  console.log("usage: node check-origin.mjs <media-url> [more-urls...]");
  process.exitCode = 2;
} else {
  for (const url of urls) {
    const p = await probe(url);
    console.log(`\n${p.url}`);
    if (p.error) { console.log(`  ERROR        ${p.error}`); continue; }
    if (p.finalUrl) console.log(`  redirect     -> ${p.finalUrl}`);
    console.log(`  status       ${p.status}${p.contentRange ? `  (${p.contentRange})` : ""}`);
    console.log(`  type         ${p.contentType}   size ${fmtBytes(p.totalBytes)}`);
    console.log(`  accept-range ${p.acceptRanges || "(absent)"}   cors ${p.cors || "(absent)"}`);
    console.log(`  ttfb         ${p.ttfbMs}ms   first ${fmtBytes(p.bytesReceived)}`);
    if (p.speedMbps != null) {
      console.log(`  throughput   ~${p.speedMbps.toFixed(1)} Mbit/s over ${fmtBytes(p.speedSample)}` +
        (p.speedPartial ? "" : "  (unranged sample)"));
    }
    for (const n of p.notes) console.log(`  ! ${n}`);
  }
  console.log("");
}
