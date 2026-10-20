/**
 * Turn an unplayable upload into something a browser can play.
 *
 * Two different jobs hide behind "make it an MP4", and conflating them is what
 * makes people think a container swap fixes an HEVC rip:
 *
 *   remux      the codecs are already safe (H.264/AAC inside Matroska), so only
 *              the container changes. Seconds, no quality loss.
 *   transcode  the codecs are not safe (HEVC, AC-3, DTS, ...), so the picture or
 *              the sound is re-encoded. Minutes to hours, and lossy.
 *
 * The choice belongs here, next to the ffmpeg command it produces. Everything is
 * spawned with an argument array, never a shell string, so paths with spaces and
 * non-ASCII characters need no quoting rules of their own.
 */
import { spawn, spawnSync } from "node:child_process";

const SAFE_VIDEO = new Set(["h264"]);
const SAFE_AUDIO = new Set(["aac", "mp3", "opus"]);

/** HDR (PQ/HLG, bt2020) to 8-bit SDR bt709, in the order ffmpeg needs it. */
const HDR_FILTERS = [
  "zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p",
];

/** ffmpeg from an explicit path, FFMPEG_PATH, or PATH. null when absent. */
export function findFfmpeg(explicit) {
  const candidates = [explicit, process.env.FFMPEG_PATH, "ffmpeg"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const run = spawnSync(candidate, ["-hide_banner", "-version"], { stdio: "ignore", windowsHide: true });
      if (!run.error && run.status === 0) return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

/** ffprobe lives next to ffmpeg in every build worth using. */
export function findFfprobe(ffmpegPath) {
  if (!ffmpegPath) return null;
  const probe = /ffmpeg(\.exe)?$/i.test(ffmpegPath)
    ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"))
    : null;
  if (!probe) return null;
  try {
    const run = spawnSync(probe, ["-version"], { stdio: "ignore", windowsHide: true });
    return !run.error && run.status === 0 ? probe : null;
  } catch {
    return null;
  }
}

/**
 * Decide what has to happen to this file, if anything.
 * Returns null when the file is already browser-playable.
 */
export function planConversion(probe, {
  encoder = "libx264",
  crf = 23,
  bitrate = "2500k",
  maxHeight = 0,
  tonemap = false,
} = {}) {
  if (!probe) return null;

  const video = probe.video ? probe.video.codec : "unknown";
  const audio = (probe.audio || []).map((a) => a.codec);
  const videoOk = SAFE_VIDEO.has(video);
  const audioOk = audio.length > 0 && audio.every((c) => SAFE_AUDIO.has(c));
  const containerOk = probe.container === "mp4" || probe.container === "mov";

  if (containerOk && videoOk && (audioOk || audio.length === 0)) return null;

  const filters = [];
  if (maxHeight && probe.video && probe.video.height > maxHeight) filters.push(`scale=-2:${maxHeight}`);
  // A 10-bit HDR master squeezed into 8-bit SDR without this looks grey and flat.
  if (tonemap) filters.push(...HDR_FILTERS);

  // Nothing to re-encode: the tracks are already H.264/AAC, only the wrapper is wrong.
  if (videoOk && (audioOk || audio.length === 0)) {
    const args = ["-map", "0:v:0"];
    if (audio.length) args.push("-map", "0:a:0");
    args.push("-c", "copy", "-sn", "-dn", "-movflags", "+faststart");
    if (filters.length) {
      // A filter means re-encoding after all: remuxing cannot change pixels.
      return transcodePlan({ encoder, crf, bitrate, filters, hasAudio: audio.length > 0 });
    }
    return { kind: "remux", args, note: "container only - no quality loss" };
  }

  return transcodePlan({ encoder, crf, bitrate, filters, hasAudio: audio.length > 0 });
}

function transcodePlan({ encoder, crf, bitrate, filters, hasAudio }) {
  // Hardware encoders take a bitrate; x264 takes a quality target. Mixing the
  // two up produces either mush or a tenfold file.
  const kbps = parseInt(bitrate, 10) || 2500;
  const qualityArgs = encoder === "libx264"
    ? ["-preset", "veryfast", "-crf", String(crf)]
    : ["-b:v", bitrate, "-maxrate", `${Math.round(kbps * 1.4)}k`, "-bufsize", `${kbps * 2}k`, ...hwOptions(encoder)];

  const args = ["-map", "0:v:0"];
  if (hasAudio) args.push("-map", "0:a:0");
  args.push("-c:v", encoder, ...qualityArgs);
  if (filters.length) args.push("-vf", filters.join(","));
  // H.264 is 8-bit by definition; a 10-bit source has to be brought down here.
  args.push("-pix_fmt", "yuv420p");
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  args.push("-sn", "-dn", "-movflags", "+faststart");
  return { kind: "transcode", args, encoder };
}

/** Encoder-specific knobs, kept apart so an unknown encoder still runs. */
function hwOptions(encoder) {
  if (encoder === "h264_amf") return ["-quality", "balanced", "-rc", "vbr_peak"];
  if (encoder === "h264_nvenc") return ["-preset", "p5", "-rc", "vbr"];
  if (encoder === "h264_qsv") return ["-preset", "medium"];
  return [];
}

/**
 * A second, smaller copy for the same film.
 *
 * Without one the player has nothing to step down to: a viewer on a slow link
 * can only be told "buffering" while the 720p stream keeps outrunning the line.
 * A 480p copy is roughly a quarter of the pixels, so it encodes in a fraction of
 * the time and fits a phone on mobile data.
 */
export function planRendition({
  encoder = "libx264",
  height = 480,
  hasAudio = true,
  tonemap = false,
  crf = 24,
  bitrate = "900k",
} = {}) {
  const filters = [];
  if (tonemap) filters.push(...HDR_FILTERS);
  filters.push(`scale=-2:${height}`);
  return transcodePlan({ encoder, crf, bitrate, filters, hasAudio });
}

/** Duration, colour metadata and codecs from ffprobe. null when unavailable. */
export function ffprobeDetails(ffprobe, input) {
  return new Promise((resolve) => {
    if (!ffprobe) return resolve(null);
    const child = spawn(ffprobe, [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", input,
    ], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

/**
 * One frame, composed into a 2:3 poster.
 *
 * A film frame is wide (2.39:1 is normal) and a card is tall, so cropping the
 * middle out of a wide shot throws most of the picture away and loves cutting
 * heads off. Instead the whole frame sits centred over a blurred, darkened copy
 * of itself: the shape streaming services use, and every shot stays visible.
 *
 * The seek goes before -i so ffmpeg starts at the nearest keyframe instead of
 * decoding up to that point - under a second even on a two hour film.
 */
export function capturePoster({ ffmpeg, input, output, at = 60, width = 500, height = 750 }) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    const graph = [
      "[0:v]split=2[bg][fg]",
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},gblur=sigma=32,eq=brightness=-0.22:saturation=0.9[back]`,
      `[fg]scale=${width}:-2:flags=lanczos,` +
        "drawbox=x=0:y=0:w=iw:h=ih:color=white@0.12:t=1[front]",
      "[back][front]overlay=(W-w)/2:(H-h)/2,format=yuvj420p[out]",
    ].join(";");
    const child = spawn(ffmpeg, [
      "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
      "-ss", String(Math.max(0, Number(at) || 0)), "-i", input,
      "-filter_complex", graph, "-map", "[out]",
      "-frames:v", "1", "-q:v", "3", output,
    ], { windowsHide: true });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? output : null));
  });
}

/**
 * One still, resized, for the card grid.
 *
 * The card is 172px wide and the poster is 500px, so every grid view was
 * downloading twice the pixels it could use. This makes a narrower copy once,
 * beside the original, and the browser picks it with srcset.
 */
export function shrinkImage({ ffmpeg, input, output, width = 250, quality = 4 }) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    const child = spawn(ffmpeg, [
      "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
      "-i", input,
      "-vf", `scale=${width}:-2:flags=lanczos`,
      "-frames:v", "1", "-q:v", String(quality), output,
    ], { windowsHide: true });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? output : null));
  });
}

/** HDR transfers that need tonemapping before an 8-bit SDR H.264 encode. */
export function isHdr(details) {
  const video = details && (details.streams || []).find((s) => s.codec_type === "video");
  if (!video) return false;
  return video.color_transfer === "smpte2084" || video.color_transfer === "arib-std-b67" ||
    video.color_primaries === "bt2020";
}

export function durationOf(details) {
  const value = Number(details && details.format && details.format.duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Run ffmpeg. Returns the child (so it can be killed) and a promise for the
 * outcome; progress is reported as { percent, speed, eta }.
 */
export function runConversion({ ffmpeg, input, output, plan, duration, onProgress }) {
  const args = [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    "-i", input, ...plan.args,
    "-progress", "pipe:1", "-nostats",
    output,
  ];
  const child = spawn(ffmpeg, args, { windowsHide: true });
  let cancelled = false;

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });

  let buffered = "";
  let last = { percent: null, speed: null, eta: null };
  child.stdout.on("data", (d) => {
    buffered += d.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      // ffmpeg reports both keys in microseconds, despite the name of the second.
      if (key === "out_time_us" || key === "out_time_ms") {
        const seconds = Number(value) / 1e6;
        if (duration > 0 && Number.isFinite(seconds)) {
          last.percent = Math.max(0, Math.min(99.9, (seconds / duration) * 100));
          const speed = parseFloat(String(last.speed || ""));
          if (speed > 0) last.eta = Math.max(0, Math.round((duration - seconds) / speed));
        }
      } else if (key === "speed") {
        last.speed = value;
      } else if (key === "progress" && value === "end") {
        last.percent = 100;
        last.eta = 0;
      }
    }
    if (onProgress) onProgress(last);
  });

  const done = new Promise((resolve) => {
    child.on("error", (e) => resolve({ ok: false, cancelled: false, error: e.message }));
    child.on("close", (code, signal) => {
      // Windows reports a killed child as exit code 1 with no signal, so the
      // flag set by cancel() is the only reliable way to tell the two apart.
      if (cancelled || signal) return resolve({ ok: false, cancelled: true, error: "cancelled" });
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `ffmpeg exited with ${code}`;
        return resolve({ ok: false, cancelled: false, error: tail });
      }
      resolve({ ok: true, cancelled: false, error: null });
    });
  });

  return {
    child,
    done,
    cancel: () => {
      cancelled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    },
  };
}
