/**
 * Reports whether each media file has a video track and an audio track, by
 * walking the ISO-BMFF box tree (moov > trak > mdia > hdlr).
 *
 *   node check-media.mjs                 # local files in storage/
 *   node check-media.mjs <url> [url...]  # remote files, downloaded first
 *
 * Useful because the audio-health demo needs a source that genuinely has audio,
 * and several public "test clip" downloads are video-only.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

function walk(buf, start, end, depth = 0, found = { video: 0, audio: 0, others: [] }) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let head = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); head = 16; }
    if (size === 0) size = end - off;
    if (size < head || off + size > end) break;
    const body = off + head;

    if (type === "hdlr") {
      // version+flags(4) predefined(4) handler_type(4)
      const handler = buf.toString("latin1", body + 8, body + 12);
      if (handler === "vide") found.video++;
      else if (handler === "soun") found.audio++;
      else found.others.push(handler);
    } else if (CONTAINERS.has(type) && depth < 6) {
      walk(buf, body, off + size, depth + 1, found);
    }
    off += size;
  }
  return found;
}

function inspect(buf) {
  const f = walk(buf, 0, buf.length);
  const hasFtyp = buf.toString("latin1", 4, 8) === "ftyp";
  return { kind: hasFtyp ? "mp4" : "unknown", videoTracks: f.video, audioTracks: f.audio, other: f.others };
}

const report = (label, buf, bytes) => {
  const r = inspect(buf);
  const verdict = r.audioTracks > 0 ? "HAS AUDIO" : "SILENT";
  console.log(`  ${verdict.padEnd(9)} video=${r.videoTracks} audio=${r.audioTracks} ${Math.round(bytes / 1024)}KB  ${label}`);
  return r;
};

const args = process.argv.slice(2);
if (args.length) {
  for (const url of args) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      const buf = Buffer.from(await res.arrayBuffer());
      report(url.replace(/^https?:\/\/[^/]+/, ""), buf, buf.length);
    } catch (e) {
      console.log(`  ERROR     ${url}  ${e.message}`);
    }
  }
} else {
  const dir = process.env.STORAGE_DIR || join(HERE, "storage");
  for (const name of (await readdir(dir)).filter((n) => /\.(mp4|m4v|mkv|webm)$/i.test(n))) {
    const abs = join(dir, name);
    const { size } = await stat(abs);
    report(name, await readFile(abs), size);
  }
}
