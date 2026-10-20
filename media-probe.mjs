/**
 * What is actually inside an uploaded file, and will a browser play it?
 *
 * A browser can only use what its own demuxer and decoders accept, and no
 * server-side trick changes that: an HEVC track inside Matroska is unplayable
 * however it is served. So the file is inspected once, at the upload boundary,
 * and the answer travels with the source — the admin form warns immediately and
 * the player receives the real codec instead of inferring one from the file name.
 *
 * Only a bounded slice is read (prefix + tail), so a multi-gigabyte upload costs
 * a few milliseconds and no extra memory worth mentioning.
 *
 * Codec names are the normalised vocabulary used by the player and the API
 * ("h264", "hevc", "aac", ...). `playable` is a tri-state: true, false, or null
 * when the file could not be identified — an unknown file is never called broken.
 */
import { open } from "node:fs/promises";
import { extname } from "node:path";

const READ_BYTES = 8 * 1024 * 1024;

const str = (b, from, to) => b.toString("latin1", from, to);
const uint = (b, at, len) => {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[at + i];
  return v;
};

/** EBML variable-length integer. keepMarker=true keeps the marker bit (element IDs). */
function readVint(b, at, keepMarker) {
  if (at >= b.length) return null;
  const first = b[at];
  let len = 1;
  for (let mask = 0x80; mask > 0 && !(first & mask); mask >>= 1) len++;
  if (len > 8 || at + len > b.length) return null;

  // Accumulate as BigInt: an 8-byte vint is 2^56 + size, which a double cannot
  // hold exactly, and a muxer is free to write a small size in eight bytes.
  let raw = 0n;
  for (let i = 0; i < len; i++) raw = (raw << 8n) | BigInt(b[at + i]);
  if (keepMarker) return { value: Number(raw), length: len, unknown: false };

  const marker = 1n << BigInt(7 * len);
  const value = raw - marker;
  return {
    value: value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value),
    length: len,
    unknown: value === marker - 1n,
  };
}

// --------------------------------------------------------------------------
// Matroska / WebM
// --------------------------------------------------------------------------
const EBML = 0x1a45dfa3, DOC_TYPE = 0x4282, SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b, TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7, TRACK_TYPE = 0x83, CODEC_ID = 0x86;
const VIDEO = 0xe0, AUDIO = 0xe1;
const PIXEL_WIDTH = 0xb0, PIXEL_HEIGHT = 0xba, CHANNELS = 0x9f;

const MATROSKA_CONTAINERS = new Set([
  EBML, SEGMENT, TRACKS, TRACK_ENTRY, VIDEO, AUDIO,
  0x1549a966, // Info
  0x1f43b675, // Cluster (walked only to stay in bounds; its children are skipped)
]);

const V_CODEC = {
  "V_MPEG4/ISO/AVC": "h264",
  "V_MPEGH/ISO/HEVC": "hevc",
  "V_AV1": "av1",
  "V_VP9": "vp9",
  "V_VP8": "vp8",
  "V_MPEG4/ISO/ASP": "mpeg4",
  "V_MPEG2": "mpeg2",
  "V_THEORA": "theora",
  "V_MS/VFW/FOURCC": "vfw",
};
const A_CODEC = {
  "A_AAC": "aac",
  "A_OPUS": "opus",
  "A_VORBIS": "vorbis",
  "A_AC3": "ac3",
  "A_EAC3": "eac3",
  "A_DTS": "dts",
  "A_TRUEHD": "truehd",
  "A_FLAC": "flac",
  "A_MPEG/L3": "mp3",
  "A_PCM/INT/LIT": "pcm",
  "A_PCM/INT/BIG": "pcm",
  "A_PCM/FLOAT/IEEE": "pcm",
};

const codecName = (id, table, fallback) => {
  const key = Object.keys(table).find((k) => id === k || id.startsWith(k + "/"));
  if (key) return table[key];
  return fallback;
};

function parseMatroska(b) {
  const tracks = [];
  let current = null;
  let visited = 0;

  const walk = (start, end, depth) => {
    let at = start;
    while (at < end && at < b.length) {
      // Bound the work: a malformed file must not spin.
      if (++visited > 200000 || depth > 6) return;
      const id = readVint(b, at, true);
      if (!id) return;
      const size = readVint(b, at + id.length, false);
      if (!size) return;
      const contentStart = at + id.length + size.length;
      const contentEnd = size.unknown ? Math.min(end, b.length) : Math.min(contentStart + size.value, b.length);
      if (contentEnd < contentStart) return;

      if (id.value === TRACK_ENTRY) {
        current = { number: null, kind: null, codec: null, width: null, height: null, channels: null };
        tracks.push(current);
      }
      if (current) {
        const len = contentEnd - contentStart;
        if (id.value === TRACK_NUMBER) current.number = uint(b, contentStart, len);
        else if (id.value === TRACK_TYPE) current.kind = uint(b, contentStart, len);
        else if (id.value === CODEC_ID) current.codec = str(b, contentStart, contentEnd);
        else if (id.value === PIXEL_WIDTH) current.width = uint(b, contentStart, len);
        else if (id.value === PIXEL_HEIGHT) current.height = uint(b, contentStart, len);
        else if (id.value === CHANNELS) current.channels = uint(b, contentStart, len);
      }
      if (MATROSKA_CONTAINERS.has(id.value)) walk(contentStart, contentEnd, depth + 1);
      if (size.unknown) return;
      at = contentEnd;
    }
  };

  walk(0, b.length, 0);

  const video = tracks.find((t) => t.kind === 1);
  const audio = tracks.filter((t) => t.kind === 2);
  if (!video && !audio.length) return null;

  return {
    video: video
      ? {
        codec: codecName(video.codec || "", V_CODEC, video.codec ? "unknown" : "unknown"),
        width: video.width, height: video.height,
      }
      : null,
    audio: audio.map((a) => ({
      codec: codecName(a.codec || "", A_CODEC, a.codec ? "unknown" : "unknown"),
      channels: a.channels,
    })),
  };
}

function readMatroskaDocType(b) {
  const id = readVint(b, 0, true);
  if (!id || id.value !== EBML) return null;
  const size = readVint(b, id.length, false);
  if (!size) return null;
  const end = Math.min(id.length + size.length + size.value, b.length);
  let at = id.length + size.length;
  while (at < end) {
    const child = readVint(b, at, true);
    if (!child) break;
    const childSize = readVint(b, at + child.length, false);
    if (!childSize) break;
    const from = at + child.length + childSize.length;
    const to = Math.min(from + childSize.value, b.length);
    if (child.value === DOC_TYPE) return str(b, from, to);
    at = to;
  }
  return null;
}

// --------------------------------------------------------------------------
// MP4 / MOV
// --------------------------------------------------------------------------
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function* boxes(b, start, end) {
  let at = start;
  let guard = 0;
  while (at + 8 <= end && ++guard < 100000) {
    let size = b.readUInt32BE(at);
    const type = str(b, at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(b.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return;
    yield { type, contentStart: at + header, end: at + size };
    at += size;
  }
}

function findChild(b, parent, type) {
  for (const box of boxes(b, parent.contentStart, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

function findPath(b, parent, path) {
  let node = parent;
  for (const type of path) {
    node = findChild(b, node, type);
    if (!node) return null;
  }
  return node;
}

/**
 * moov normally leads the file (faststart); otherwise it sits at the end. The
 * offsets are only meaningful inside the buffer they came from, so both are
 * returned together.
 */
function findMoov(prefix, tail) {
  for (const box of boxes(prefix, 0, prefix.length)) {
    if (box.type === "moov") return { buffer: prefix, box };
  }
  if (!tail) return null;
  // The tail slice can start mid-box, so anchor on the "moov" type field.
  for (let at = tail.indexOf("moov", 0, "latin1"); at >= 4; at = tail.indexOf("moov", at + 4, "latin1")) {
    const start = at - 4;
    const size = tail.readUInt32BE(start);
    if (size >= 8 && start + size <= tail.length) {
      return { buffer: tail, box: { type: "moov", contentStart: start + 8, end: start + size } };
    }
  }
  return null;
}

const MP4_VIDEO = {
  avc1: "h264", avc2: "h264", avc3: "h264", avc4: "h264", dvav: "h264", dvh1: "hevc",
  hvc1: "hevc", hev1: "hevc",
  av01: "av1", vp09: "vp9", vp08: "vp8",
  mp4v: "mpeg4", ap4h: "prores", apch: "prores",
};
const MP4_AUDIO = {
  mp4a: "aac", "ac-3": "ac3", "ec-3": "eac3", "dtsc": "dts", "dtsh": "dts", "dtsl": "dts",
  Opus: "opus", fLaC: "flac", alac: "alac", ".mp3": "mp3", "mp3 ": "mp3",
  samr: "amr", sawb: "amr",
};

function parseMp4(prefix, tail) {
  const found = findMoov(prefix, tail);
  if (!found) return null;
  const { buffer, box: moov } = found;
  const root = { contentStart: moov.contentStart, end: moov.end };
  const result = { video: null, audio: [] };

  for (const box of boxes(buffer, root.contentStart, root.end)) {
    if (box.type !== "trak") continue;
    const trak = box;
    const hdlr = findPath(buffer, trak, ["mdia", "hdlr"]);
    if (!hdlr) continue;
    const handler = str(buffer, hdlr.contentStart + 8, hdlr.contentStart + 12);
    const stsd = findPath(buffer, trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) continue;

    // stsd content is version/flags (4) + entry_count (4), then sample entries.
    for (const entry of boxes(buffer, stsd.contentStart + 8, stsd.end)) {
      if (handler === "vide" && !result.video) {
        result.video = {
          codec: MP4_VIDEO[entry.type] || "unknown",
          width: uint(buffer, entry.contentStart + 24, 2),
          height: uint(buffer, entry.contentStart + 26, 2),
        };
      } else if (handler === "soun") {
        result.audio.push({
          codec: MP4_AUDIO[entry.type] || "unknown",
          channels: uint(buffer, entry.contentStart + 16, 2),
        });
      }
    }
  }

  return result.video || result.audio.length ? result : null;
}

// --------------------------------------------------------------------------
// Verdict
// --------------------------------------------------------------------------
const EXT_CONTAINER = {
  ".mkv": "mkv", ".mka": "mkv", ".webm": "webm",
  ".mp4": "mp4", ".m4v": "mp4", ".mov": "mov",
  ".avi": "avi", ".wmv": "wmv", ".flv": "flv", ".ts": "ts", ".m2ts": "ts",
};

const containerFromExt = (ext) => EXT_CONTAINER[String(ext || "").toLowerCase()] || "unknown";

const BAD_AUDIO = {
  ac3: "AC-3", eac3: "E-AC-3", dts: "DTS", truehd: "TrueHD", pcm: "uncompressed PCM",
};

function verdict(container, media) {
  const problems = [];
  const notes = [];
  let playable = true;

  if (container === "mkv") {
    playable = false;
    problems.push("it is a Matroska (.mkv) file, and Chrome, Edge, Safari and Opera cannot open Matroska at all");
  }
  if (container === "avi" || container === "wmv" || container === "flv" || container === "ts") {
    playable = false;
    problems.push(`it is a .${container} file, which browsers do not play`);
  }

  if (!media) {
    // The container alone can already condemn a file. Otherwise say nothing.
    return {
      playable: problems.length ? false : null,
      reason: problems.length ? problems.join("; ") + "." : null,
      note: null,
    };
  }

  const v = media.video && media.video.codec;
  if (!media.video) {
    playable = false;
    problems.push("it has no video track");
  } else if (v === "hevc") {
    playable = false;
    problems.push("the video is HEVC (H.265), which browsers only decode with an extra OS codec pack installed");
  } else if (v && v !== "h264" && v !== "av1" && v !== "vp9" && v !== "vp8" && v !== "unknown") {
    playable = false;
    problems.push(`the video codec is ${v}, which browsers do not decode`);
  } else if (v === "av1" || v === "vp9") {
    notes.push(`${v.toUpperCase()} plays in Chrome, Edge and Firefox, but not in older Safari`);
  } else if (v === "unknown") {
    notes.push("the video codec could not be identified");
  }

  const bad = [...new Set(media.audio.map((a) => a.codec).filter((c) => BAD_AUDIO[c]))];
  if (bad.length) {
    playable = false;
    problems.push(`the audio is ${bad.map((c) => BAD_AUDIO[c]).join("/")}, which browsers cannot decode`);
  } else if (media.audio.length === 0) {
    notes.push("it has no audio track");
  }

  if (container === "webm" && v && v !== "vp8" && v !== "vp9" && v !== "av1" && v !== "unknown") {
    playable = false;
    problems.push(`a .webm file cannot carry ${v} video`);
  }

  return {
    playable,
    reason: problems.length ? problems.join("; ") + "." : null,
    note: notes.length ? notes.join("; ") + "." : null,
  };
}

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------
function detectContainer(prefix, ext) {
  if (prefix.length >= 4 && prefix.readUInt32BE(0) === EBML) {
    return readMatroskaDocType(prefix) === "webm" ? "webm" : "mkv";
  }
  if (prefix.length >= 12 && str(prefix, 4, 8) === "ftyp") {
    const brand = str(prefix, 8, 12).trim();
    return brand.startsWith("qt") ? "mov" : "mp4";
  }
  if (prefix.length >= 12 && str(prefix, 0, 4) === "RIFF" && str(prefix, 8, 12) === "AVI ") return "avi";
  return containerFromExt(ext);
}

/** Pure version, for tests: give it the bytes you already have. */
export function probeSlices({ prefix, tail = null, ext = "" }) {
  const container = detectContainer(prefix, ext);
  let media = null;
  try {
    if (container === "mkv" || container === "webm") media = parseMatroska(prefix);
    else if (container === "mp4" || container === "mov") media = parseMp4(prefix, tail);
  } catch {
    media = null;
  }
  const judged = verdict(container, media);
  return {
    container,
    video: media ? media.video : null,
    audio: media ? media.audio : [],
    ...judged,
  };
}

/** Inspect a real file. Never throws: a probe failure must not fail an upload. */
export async function probeMedia(path) {
  const ext = extname(path);
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const prefixLen = Math.min(size, READ_BYTES);
    const prefix = Buffer.alloc(prefixLen);
    if (prefixLen) await handle.read(prefix, 0, prefixLen, 0);

    let tail = null;
    if (size > prefixLen) {
      const tailLen = Math.min(size, READ_BYTES);
      tail = Buffer.alloc(tailLen);
      await handle.read(tail, 0, tailLen, size - tailLen);
    }
    return probeSlices({ prefix, tail, ext });
  } catch {
    return { container: containerFromExt(ext), video: null, audio: [], playable: null, reason: null, note: null };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
