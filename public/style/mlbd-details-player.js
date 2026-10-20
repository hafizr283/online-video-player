/**
 * MovieLinkBD-style inline player — reference implementation.
 *
 * This is a clean-room re-implementation of the architecture observed on
 * movielinkbd (see REPORT.md). It is deliberately readable: the shipped bundle
 * is minified and the original sources were not available.
 *
 * Sections:
 *   1  bootstrap   decode the obfuscated config, mint/reuse the watch-gate token
 *   2  model       source scoring, identity, usability, preference keys
 *   3  pick        default source, same-file continuity, quality lookup
 *   4  health      crowdsourced audio-health reporting (signed token, TTL cache)
 *   5  probe       staged audio-presence probing
 *   6  mount       ArtPlayer lifecycle
 *   7  failover    tier 1/2 audio failover, tier 3 error -> downgrade-first mirror switch
 *   8  recovery    watch-gate expiry recovery (state-preserving, reload only as last resort)
 *   9  api         window.MLBD_PLAYER / window.MLBD_DEV
 */

const GATE_KEY = "mlbd_wg_v1";
const PREF_KEY = "mlbd_v78_quality_pref";
const HEALTH_TTL_MS = { rate_limited: 36e5, no_audio: 216e5, audio_ok: 864e5 };
const PROBE_SCHEDULE_MS = [3000, 9000, 20000];
const DEFAULT_QUALITY = 720;

const $ = (sel, root = document) => root.querySelector(sel);
const inRange = (v, lo, hi) => v >= lo && v <= hi;

// ---------------------------------------------------------------------------
// 1. bootstrap
// ---------------------------------------------------------------------------
const section = document.getElementById("mlbdInlinePlayer");
const dataEl = document.getElementById("mlbdInlinePlayerData");
if (!section || !dataEl) {
  console.warn("[mlbd] player markup or config element missing; not starting");
}

/** atob-style base64 -> bytes, tolerant of whitespace. */
function b64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** base64 payload XOR keystream(LCG seeded by data-s, warmed up data-r rounds). */
function decodeConfig(el) {
  const payload = el.textContent || "{}";
  const seed = el.getAttribute("data-s");
  if (!seed) return { text: payload, seed: null, rounds: 0, encoded: false };

  let r = parseInt(seed, 16) >>> 0;
  const rounds = parseInt(el.getAttribute("data-r") || "0", 10) || 0;
  for (let i = 0; i < rounds; i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;

  const bytes = b64ToBytes(payload);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bytes[i] ^ ((r >>> 16) & 0xff);
  }
  return { text: new TextDecoder("utf-8").decode(out), seed, rounds, encoded: true };
}

const configSource = decodeConfig(dataEl);
let configText = configSource.text;

/**
 * Matches "<host>/p/" where host is an origin plus any path prefix the mirror is
 * mounted under. Group 1 is the host.
 */
const MEDIA_HOST_RE = /(https?:\/\/[^\s"']+?)\/p\//gi;

/**
 * Media hosts are read straight out of the config, as the original does.
 *
 * A host here is everything before "/p/", not a bare origin: when the mirrors
 * are mounted under a path (one port, one tunnel) the prefix is part of the
 * identifier the gate token is signed for, so it must survive.
 */
const MEDIA_HOST = (() => {
  const m = String(configText).match(MEDIA_HOST_RE);
  return m ? m[0].replace(/\/p\/$/, "") : "";
})();

/** Every distinct "<host>/p/" base the config points at. */
function distinctMediaHosts(text) {
  const set = new Set();
  for (const m of String(text).matchAll(MEDIA_HOST_RE)) set.add(m[1]);
  return [...set];
}

/**
 * One token per host. A token is signed for the host that issued it, so a single
 * token can no longer be replayed across the fleet. (The original keeps one
 * {h,g} pair, which only works because its token binds neither host nor asset.)
 */
const gateTokens = new Map();
const gateInflight = new Map();

function readCachedGates() {
  const out = new Map();
  try {
    const raw = JSON.parse(sessionStorage.getItem(GATE_KEY) || "null");
    if (!raw || typeof raw !== "object") return out;
    for (const [host, g] of Object.entries(raw)) {
      if (typeof g !== "string") continue;
      // same validity rule as the original: must outlive the next 10 minutes
      if (1000 * (parseInt(g, 10) || 0) > Date.now() + 6e5) out.set(host, g);
    }
  } catch { /* ignore */ }
  return out;
}

function writeCachedGate(host, g) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(GATE_KEY) || "{}");
    raw[host] = g;
    sessionStorage.setItem(GATE_KEY, JSON.stringify(raw));
  } catch { /* ignore */ }
}

/** Seed from cache; only hosts we have no live token for are minted. */
async function ensureGateTokens() {
  for (const [host, g] of readCachedGates()) gateTokens.set(host, g);
  const missing = distinctMediaHosts(configText).filter((h) => !gateTokens.has(h));
  if (missing.length) await Promise.all(missing.map((h) => mintGateToken(h)));
  state.gateToken = gateTokens.get(MEDIA_HOST) || "";
  return gateTokens.size > 0;
}

/** Force a fresh token for every host, e.g. after the server rotated its key. */
async function renewAllGates() {
  const hosts = distinctMediaHosts(configText);
  const fresh = await Promise.all(hosts.map((h) => mintGateToken(h)));
  state.gateToken = gateTokens.get(MEDIA_HOST) || "";
  return fresh.some(Boolean);
}

const state = {
  config: null,
  source: null,
  sources: [],
  art: null,
  playbackToken: 0,
  failedSources: new Set(),
  audioFailedSources: new Set(),
  healthBusy: new Set(),
  hevcBlocked: false,
  gateToken: "",
  gateMintCount: 0,
  reloadAvoided: 0,
  recoveryInFlight: false,
  mountedAt: 0,
  lastHealthEvidence: null,
  autoQuality: true,     // adaptive resolution until the viewer picks one
  stalls: [],            // recent buffering events, for the adaptive switch
  lastPositionSave: 0,
};

const noticeEl = () => $(".mlbd-inline-player__notice", section);
const statusEl = () => $(".mlbd-inline-player__status", section);

let noticeTimer = null;
function notice(message, { type = "warning", timeout = 5200 } = {}) {
  const el = noticeEl();
  if (!el || !message) return;
  clearTimeout(noticeTimer);
  el.textContent = String(message);
  el.className = "mlbd-inline-player__notice is-visible " + (type === "error" ? "is-error" : "is-warning");
  noticeTimer = setTimeout(() => { el.className = "mlbd-inline-player__notice"; el.textContent = ""; }, timeout);
}
// The pill is for something happening or something wrong. "Ready" and
// "Playing" describe a player that is simply working, so they say nothing.
const QUIET_STATUS = new Set(["Ready", "Playing"]);
const setStatus = (text) => {
  const el = statusEl();
  if (!el) return;
  el.textContent = String(text);
  el.hidden = QUIET_STATUS.has(String(text));
};

/**
 * GET https://<host>/g — no credentials, exactly like the original. Concurrent
 * calls for the same host share a single request.
 *
 * On failure the previously cached token is left in place. The original deleted
 * it here, which is what left a session with no token and recovery disabled.
 */
function mintGateToken(host) {
  if (!host || !("fetch" in window)) return Promise.resolve("");
  if (gateInflight.has(host)) return gateInflight.get(host);

  const pending = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; gateInflight.delete(host); resolve(v || ""); } };
    setTimeout(() => done(""), 4000);
    fetch(`${host}/g`, { credentials: "omit", cache: "no-store", mode: "cors" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const g = j && j.ok && typeof j.g === "string" ? j.g : "";
        if (g) { gateTokens.set(host, g); writeCachedGate(host, g); }
        state.gateMintCount += 1;
        done(g);
      })
      .catch(() => done(""));
  });

  gateInflight.set(host, pending);
  return pending;
}

/**
 * Append ?mg=<token> to every playback URL, using the token for that URL's host.
 * The host is matched the same way as everywhere else: everything before "/p/",
 * so a mirror mounted under a path gets its own token.
 */
function injectGate(text) {
  return String(text).replace(/(https?:\/\/[^\s"']+?)(\/p\/[A-Za-z0-9._%-]+)/gi, (match, host, path) => {
    const token = gateTokens.get(host);
    return token ? `${host}${path}?mg=${encodeURIComponent(token)}` : match;
  });
}

function applyConfig() {
  state.config = JSON.parse(injectGate(configText) || "{}");
  const ep = (state.config.episodes || [])[0] || null;
  state.sources = (ep && ep.sources) || [];
  return state.config;
}

// ---------------------------------------------------------------------------
// 2. model
// ---------------------------------------------------------------------------
const hasUrl = (s) => Boolean(s && s.url);

function formatOf(source) {
  const t = String((source && source.type) || "").toLowerCase().replace(/^\./, "");
  if (["m3u8", "mpd", "mp4", "webm", "mkv"].includes(t)) return t;
  const n = String((source && (source.name || source.url)) || "").split("?")[0].toLowerCase();
  if (/\.m3u8$/i.test(n)) return "m3u8";
  if (/\.mpd$/i.test(n)) return "mpd";
  if (/\.webm$/i.test(n)) return "webm";
  if (/\.mkv$/i.test(n)) return "mkv";
  if (/\.mp4$/i.test(n)) return "mp4";
  return "auto";
}

const nativeHls = (() => {
  try {
    const v = document.createElement("video");
    return Boolean(v.canPlayType("application/vnd.apple.mpegurl") || v.canPlayType("application/x-mpegURL"));
  } catch { return false; }
})();

/** Format weight. Dominates quality in the score, as observed. */
function formatWeight(source) {
  switch (formatOf(source)) {
    case "mp4": case "auto": return 11e5;
    case "mkv": return 108e4;
    case "webm": return 106e4;
    case "m3u8": return nativeHls ? 104e4 : 45e4;
    case "mpd": return 35e4;
    default: return 5e5;
  }
}
const formatBonus = (s) => ({ m3u8: 55, mp4: 50, auto: 50, mpd: 45, webm: 25 }[formatOf(s)] ?? 10);

const blockerRegex = /(?:^|[^a-z0-9])(?:hevc|h[ ._-]?265|x265|hvc1|hev1)(?:[^a-z0-9]|$)/i;
const isHevc = (s) => Boolean(s && (s.hevc || String(s.codec || "").toLowerCase() === "hevc" ||
  blockerRegex.test([s.url, s.label, s.provider, s.codec, s.name].join(" "))));

/**
 * Why this source cannot play here, when the server already knows. The facts
 * (container, codec) come from the file itself; the wording belongs here.
 */
function unsupportedReason(s) {
  if (!s) return "";
  const container = String(s.type || "").toLowerCase();
  const codec = String(s.codec || "").toLowerCase();
  if (container === "mkv") return "This copy is Matroska (.mkv). Browsers cannot play that format — it needs an MP4 (H.264) copy.";
  if (codec === "hevc") return "This copy is HEVC (H.265). Browsers cannot decode it — it needs an H.264 copy.";
  return "";
}

const healthOf = (s) => (s && s.health) || {};
const audioStatus = (s) => String(healthOf(s).audio_status || "unknown");
const isVerified = (s) => Boolean(healthOf(s).verified);
const hasExternalAudio = (s) => Array.isArray(s && s.external_audio) && s.external_audio.some((a) => a && a.url);
const isArchive = (s) => /\/api\/player-stream\.php(?:[?]|$)/i.test(String((s && s.url) || ""));

/** "known bad audio" -> skip it, like the original's ut(). */
const isUnusable = (s) => Boolean(s) && !isArchive(s) && !isHevc(s) && !hasExternalAudio(s) &&
  audioStatus(s) === "no_audio" && isVerified(s);

const identity = (s) => (s ? `${String(s.health_key || s.id || "").trim()}|${String(s.quality || 0)}|${isHevc(s) ? "hevc" : "h264"}` : "");

/**
 * The observed score has a provider term whose rule is unknown. Here it is an
 * explicit declared priority (lower wins) instead of a guess at the hostname:
 * a tie-break between two otherwise identical sources has to be deterministic.
 */
function providerBonus(s) {
  const p = Number(s && s.provider_priority);
  return Number.isFinite(p) && p > 0 ? Math.max(0, 10 - p) : 0;
}

const score = (s) =>
  formatWeight(s) + 100 * Math.max(0, Number(s.quality) || 0) + formatBonus(s) +
  providerBonus(s) + 20 + (isUnusable(s) ? -900000 : 0);

const byScore = (a, b) => score(b) - score(a);
const playable = (list) => (list || []).filter(hasUrl).filter((s) => formatWeight(s) > -1e6);

/** Prefer non-HEVC when HEVC decode has already failed for this viewer. */
function usableList(list = state.sources) {
  let out = playable(list);
  if (state.hevcBlocked) {
    const noHevc = out.filter((s) => !isHevc(s));
    if (noHevc.length) out = noHevc;
  }
  return out;
}
/** Drop known-bad-audio sources, but never return empty. */
function withoutBadAudio(list) {
  const ok = list.filter((s) => !isUnusable(s));
  return ok.length ? ok : list;
}

// ---------------------------------------------------------------------------
// 3. pick
// ---------------------------------------------------------------------------
const parsePref = (raw) => {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "best") return { key: "best", quality: 0, hevc: null };
  const m = t.match(/^(\d{3,4})(?:-(hevc))?$/);
  return m ? { key: t, quality: Number(m[1]), hevc: m[2] === "hevc" } : null;
};
const readPref = () => { try { return parsePref(localStorage.getItem(PREF_KEY)); } catch { return null; } };
const writePref = (s) => {
  try { localStorage.setItem(PREF_KEY, `${s.quality}${isHevc(s) ? "-hevc" : ""}`); } catch { /* ignore */ }
};

/** Pick the best source matching a preference key ("best" or "<quality>[-hevc]"). */
function findByQuality(list, key, audio) {
  const pref = parsePref(key);
  if (!pref) return null;
  const ranked = withoutBadAudio(usableList(list).sort(byScore));
  let pool;
  if (pref.key === "best") pool = ranked.filter((s) => s.is_best);
  else {
    const same = ranked.filter((s) => !isHevc(s) && Number(s.quality) === pref.quality);
    pool = pref.hevc ? ranked.filter((s) => isHevc(s) && Number(s.quality) === pref.quality) : same;
    if (!pool.length) pool = same;
  }
  if (audio) {
    const match = pool.find((s) => String(s.audio || "") === String(audio));
    if (match) return match;
  }
  return pool[0] || null;
}

const sameVariant = (a, b) => Number(a.quality) === Number(b.quality) && isHevc(a) === isHevc(b);
const closestLower = (list, q) => list
  .filter((s) => Number(s.quality) > 0 && Number(s.quality) < q)
  .sort((a, b) => Number(b.quality) - Number(a.quality))[0] || null;

/**
 * Default source for an episode. Mirrors the observed chain:
 * same file -> same variant+audio -> saved preference -> 720p -> below 720 -> first.
 */
function defaultSource(episode, current) {
  const ranked = withoutBadAudio(usableList((episode && episode.sources) || []).sort(byScore));
  if (!ranked.length) return null;

  if (current) {
    const match = ranked.find((s) => s.id === current.id || (s.file_fid && s.file_fid === current.file_fid && sameVariant(s, current)));
    if (match) return match;
    const byVariant = findByQuality(ranked, `${current.quality}${isHevc(current) ? "-hevc" : ""}`, current.audio);
    if (byVariant) return byVariant;
  }
  const saved = readPref();
  if (saved) { const s = findByQuality(ranked, saved.key, null); if (s) return s; }
  const dflt = findByQuality(ranked, String(DEFAULT_QUALITY), null);
  if (dflt) return dflt;
  const low = closestLower(ranked, DEFAULT_QUALITY);
  return low || ranked[0];
}

// ---------------------------------------------------------------------------
// 4. health (crowdsourced)
// ---------------------------------------------------------------------------
/** Stable anonymous viewer id: the server counts one report per viewer per source. */
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem("mlbd_cid");
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("mlbd_cid", id);
    }
    return id;
  } catch { return "anon"; }
})();

const healthCacheKey = (s, event) =>
  `mlbd_v78_health:${event}:${String(s.health_key || s.id || s.url).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120)}`;

async function reportHealth(source, event, evidence) {
  const token = String((source && source.health_token) || "").trim();
  if (!source || isArchive(source) || !token) return null;
  if (!["no_audio", "audio_ok"].includes(event)) return null;

  const busyKey = `${source.health_key || source.id}:${source.quality}:${event}`;
  if (state.healthBusy.has(busyKey)) return null;
  const cacheKey = healthCacheKey(source, event);
  try { if (Number(localStorage.getItem(cacheKey) || 0) > Date.now()) return source.health || null; } catch { /* ignore */ }

  state.healthBusy.add(busyKey);
  try {
    const res = await fetch("/media/health", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json" },
      body: new URLSearchParams({ event, evidence, token, cid: CLIENT_ID }).toString(),
    });
    const body = await res.json().catch(() => null);
    const ttl = res.status === 429 ? HEALTH_TTL_MS.rate_limited
      : event === "no_audio" ? HEALTH_TTL_MS.no_audio : HEALTH_TTL_MS.audio_ok;
    if (body && body.ok && body.health) {
      source.health = { ...(source.health || {}), ...body.health };
      try { localStorage.setItem(cacheKey, String(Date.now() + ttl)); } catch { /* ignore */ }
      state.lastHealthEvidence = { id: source.id, event, evidence, health: source.health };
      refreshQualityMenu();
      return source.health;
    }
    if (body && body.ok && body.duplicate) {
      try { localStorage.setItem(cacheKey, String(Date.now() + ttl)); } catch { /* ignore */ }
      return source.health || null;
    }
    if (res.status === 429) { try { localStorage.setItem(cacheKey, String(Date.now() + ttl)); } catch { /* ignore */ } }
    return null;
  } catch { return null; }
  finally { state.healthBusy.delete(busyKey); }
}

// ---------------------------------------------------------------------------
// 5. audio probing
// ---------------------------------------------------------------------------
/**
 * Optional Web Audio tap. It is only attached when the context can actually run,
 * because a suspended context would silence playback. Connecting the analyser to
 * the destination is what keeps the sound audible.
 */
async function attachAudioTap(video) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  let ctx = null;
  try {
    ctx = new Ctx();
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* ignore */ } }
    if (ctx.state !== "running") { try { ctx.close(); } catch { /* ignore */ } return null; }

    const node = ctx.createMediaElementSource(video);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    node.connect(analyser);
    analyser.connect(ctx.destination);

    const buf = new Uint8Array(analyser.fftSize);
    return {
      peak() {
        try {
          analyser.getByteTimeDomainData(buf);
          let p = 0;
          for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i] - 128));
          return p;
        } catch { return 0; }
      },
      close() { try { node.disconnect(); analyser.disconnect(); ctx.close(); } catch { /* ignore */ } },
    };
  } catch {
    try { if (ctx) ctx.close(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Evidence for "this source has audio" versus "this source is silent".
 *
 * One signal is never enough. Chrome exposes neither audioTracks nor mozHasAudio,
 * so `decoded-bytes-zero` on its own would flag every healthy source as broken —
 * which is exactly what an unsafe single-signal check did in testing. Silence is
 * only claimed when at least two independent signals agree and nothing contradicts
 * them; otherwise the result stays unknown.
 */
function audioVerdict(video, tap, heardAudio) {
  const t = Number(video.currentTime || 0);
  const audible = !video.muted && Number(video.volume || 0) > 0;
  const positives = [];
  const negatives = [];

  try { if (video.mozHasAudio === true) positives.push("mozhasaudio-positive"); } catch { /* ignore */ }
  try { if (video.audioTracks && Number(video.audioTracks.length) > 0) positives.push("audiotracks-positive"); } catch { /* ignore */ }
  try { if (Number(video.webkitAudioDecodedByteCount || 0) > 0) positives.push("decoded-bytes-positive"); } catch { /* ignore */ }
  if (heardAudio) positives.push("waveform-positive");

  if (audible && t >= 8) {
    try { if (Number(video.webkitAudioDecodedByteCount || 0) === 0) negatives.push("decoded-bytes-zero"); } catch { /* ignore */ }
    try { if (video.mozHasAudio === false) negatives.push("mozhasaudio-false"); } catch { /* ignore */ }
    try { if (video.audioTracks && Number(video.audioTracks.length) === 0) negatives.push("audiotracks-empty"); } catch { /* ignore */ }
    if (tap && !heardAudio) negatives.push("waveform-silent");
  }

  if (positives.length) return { known: true, hasAudio: true, evidence: positives[0] };
  if (negatives.length >= 2) return { known: true, hasAudio: false, evidence: `multi-signal:${negatives.join("+")}` };
  return { known: false, hasAudio: null, evidence: "" };
}

function startAudioProbe(video, source, token) {
  let tap = null;
  let heardAudio = false;
  let sampling = null;
  let disposed = false;

  attachAudioTap(video).then((t) => {
    if (!t) return;
    if (disposed || token !== state.playbackToken) return t.close();
    tap = t;
    sampling = setInterval(() => { if (tap && tap.peak() >= 2) heardAudio = true; }, 200);
  });

  const timers = PROBE_SCHEDULE_MS.map((ms) => setTimeout(() => {
    if (token !== state.playbackToken || !video.isConnected) return;
    const v = audioVerdict(video, tap, heardAudio);
    if (!v.known) return;
    reportHealth(source, v.hasAudio ? "audio_ok" : "no_audio", v.evidence);
  }, ms));

  return () => {
    disposed = true;
    clearInterval(sampling);
    timers.forEach(clearTimeout);
    if (tap) tap.close();
  };
}

// ---------------------------------------------------------------------------
// 6. mount
// ---------------------------------------------------------------------------
let disposeProbe = null;

/** Alternate source for the same content: same audio language, then <= quality. */
function audioAlternate(source) {
  const id = identity(source);
  const q = Math.max(0, Number(source.quality) || 0);
  const lang = String(source.audio || "").trim().toLowerCase();
  return usableList(state.sources)
    .filter((s) => identity(s) !== id)
    .filter((s) => !state.failedSources.has(identity(s)))
    .filter((s) => !state.audioFailedSources.has(identity(s)))
    .filter((s) => !isUnusable(s))
    .sort((a, b) => {
      const al = String(a.audio || "").trim().toLowerCase();
      const bl = String(b.audio || "").trim().toLowerCase();
      const aLang = lang && al === lang ? 0 : 1;
      const bLang = lang && bl === lang ? 0 : 1;
      if (aLang !== bLang) return aLang - bLang;
      const aQ = Number(a.quality) || 0;
      const bQ = Number(b.quality) || 0;
      const aDown = q > 0 && aQ <= q ? 0 : 1;
      const bDown = q > 0 && bQ <= q ? 0 : 1;
      if (aDown !== bDown) return aDown - bDown;
      return Math.abs(q - aQ) - Math.abs(q - bQ);
    })[0] || null;
}

/** Tier-3: pick the next mirror, preferring a downgrade. */
function nextMirror() {
  const id = identity(state.source);
  const ranked = usableList(state.sources)
    .filter((s) => identity(s) !== id)
    .filter((s) => !state.failedSources.has(identity(s)))
    .filter((s) => !state.audioFailedSources.has(identity(s)))
    .sort(byScore);
  if (!ranked.length) return null;
  const q = Number((state.source && state.source.quality) || 0);
  return ranked.find((s) => Number(s.quality) < q) || ranked[0];
}

/**
 * Mount a source. Tier-2 audio failover happens here: a source the server has
 * already verified as silent is swapped out before it ever plays.
 */
function mountSource(source, opts = {}) {
  if (!source || !hasUrl(source)) return false;
  if (isUnusable(source) && !opts.allowReportedAudioSource) {
    const alt = audioAlternate(source);
    if (alt) {
      notice(`This quality has no audio. Switching to ${alt.quality}p.`, { type: "warning", timeout: 4200 });
      return mountSource(alt, { ...opts, fallback: true });
    }
    notice("No other quality has audio. Download the file to play it with sound.", { type: "warning", timeout: 6000 });
  }
  if (!opts.fallback) {
    state.failedSources.delete(identity(source));
    state.audioFailedSources.delete(identity(source));
  }

  const previousTime = opts.restore && state.art ? Number(state.art.currentTime || 0) : 0;
  const resumeAt = previousTime > 0.5 ? previousTime : savedPosition();
  const poster = (state.config && state.config.poster) || "";

  state.playbackToken += 1;
  const token = state.playbackToken;
  if (disposeProbe) { disposeProbe(); disposeProbe = null; }
  if (state.art) { try { state.art.destroy(); } catch { /* ignore */ } state.art = null; }

  // Warm DNS + TLS to the media host before the player asks for the first
  // range, which matters most for a published copy on another origin.
  preconnectTo(source.url);

  state.source = source;
  state.mountedAt = Date.now();
  applyUrl(source);

  const stage = $(".mlbd-inline-player__stage", section);
  if (!stage) return false;
  stage.innerHTML = "<div class=\"mlbd-inline-player__art\"></div>";

  setStatus("Loading");

  const art = new window.Artplayer({
    container: $(".mlbd-inline-player__art", stage),
    url: source.url,
    type: formatOf(source) === "mkv" ? "mp4" : formatOf(source),
    poster,
    volume: 0.6,
    autoplay: false,
    muted: false,
    theme: "#38bdf8",
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    fullscreen: true,
    fullscreenWeb: true,
    pip: true,
    miniProgressBar: true,
    hotkey: true,
    autoOrientation: true,
    airplay: true,
    lang: "en",
    moreVideoAttr: { crossorigin: "anonymous", playsInline: true, preload: "auto" },
    customType: {
      mp4: (video, url) => { tuneCrossOrigin(video, url); video.src = url; video.load(); },
    },
  });
  state.art = art;

  art.on("ready", () => { if (token === state.playbackToken) setStatus("Ready"); });
  art.on("video:loadedmetadata", () => {
    if (token !== state.playbackToken) return;
    if (resumeAt > 0.5) {
      const dur = Number(art.duration || 0);
      // keep clear of the final second so a short clip does not end instantly
      const lastSafe = dur > 2 ? dur - 1.5 : dur;
      const seekTo = dur > 0 ? Math.min(resumeAt, Math.max(0, lastSafe)) : resumeAt;
      try { art.currentTime = seekTo; } catch { /* ignore */ }
      if (previousTime <= 0.5) notice(`Resuming from ${clockText(seekTo)}`, { type: "warning", timeout: 4000 });
    }
    if (opts.autoplay !== false) { art.play().catch(() => { /* autoplay blocked */ }); }
  });
  art.on("video:playing", () => {
    if (token !== state.playbackToken) return;
    setStatus("Playing");
    // successful playback restores the one-shot gate-recovery budget
    try { sessionStorage.removeItem(`${GATE_KEY}_r`); } catch { /* ignore */ }
  });
  art.on("video:timeupdate", () => {
    if (token !== state.playbackToken) return;
    if (Number(art.currentTime || 0) > 5) { try { writePref(source); } catch { /* ignore */ } }
    if (Date.now() - state.lastPositionSave > 5000) {
      state.lastPositionSave = Date.now();
      savePosition(art);
    }
  });
  art.on("video:ended", () => { if (token === state.playbackToken) forgetPosition(); });
  art.on("video:waiting", () => { if (token === state.playbackToken) { setStatus("Buffering"); noteStall(source); } });
  art.on("video:error", () => { if (token === state.playbackToken) handleMediaFailure(source, "error"); });
  art.on("error", () => { if (token === state.playbackToken) handleMediaFailure(source, "error"); });

  setupSubtitles(art);
  setupHoldSpeed(art);
  setupShortcutHelp(art);
  buildMenus(art, source);
  disposeProbe = startAudioProbe(art.video, source, token);
  return true;
}

/**
 * What is on screen, and nothing else. The old line ended in "1 hour access",
 * which read like a sales pitch and was never quite true.
 */
function applyUrl(source) {
  const el = $(".mlbd-inline-player__gate-note", section);
  if (el) el.textContent = `${source.quality}p \u00b7 ${source.provider || "CDN"}`;
}

/**
 * Same-origin media keeps `crossorigin="anonymous"`, which the audio probe and
 * subtitle tracks rely on. A published copy on Blob storage is cross-origin and
 * sends no CORS headers, so asking for anonymous CORS would make the request
 * fail before a single byte plays. Drop the attribute for those and only those.
 */
function tuneCrossOrigin(video, url) {
  if (!video) return;
  let sameOrigin = true;
  try { sameOrigin = new URL(url, location.href).origin === location.origin; } catch { /* treat as same */ }
  if (sameOrigin) video.setAttribute("crossorigin", "anonymous");
  else video.removeAttribute("crossorigin");
}

/**
 * Open the connection to a media host while the player is still being built.
 * A film published to Blob storage is on another origin; without this the first
 * frame waits for DNS and a TLS handshake that could have happened during setup.
 * No `crossorigin` here: the video element fetches without CORS, and a preconnect
 * in the wrong mode warms a pool the element cannot use.
 */
function preconnectTo(url) {
  let origin;
  try { origin = new URL(url, location.href).origin; } catch { return; }
  if (origin === location.origin) return;
  if (document.head.querySelector(`link[rel="preconnect"][data-origin="${CSS.escape(origin)}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.dataset.origin = origin;
  document.head.appendChild(link);
}

function setupSubtitles(art) {
  const ep = (state.config.episodes || [])[0];
  const tracks = (ep && ep.subtitles) || [];
  if (!tracks.length) return;
  const first = tracks[0];
  try {
    art.subtitle.switch(first.url, { name: first.label || "Subtitle", type: "vtt" });
    art.subtitle.show = true;
  } catch { /* ignore */ }
}

function qualityOptions() {
  return usableList(state.sources)
    .slice()
    .sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0) || score(b) - score(a));
}

/**
 * The quality list, with the one that is playing marked.
 *
 * The bundled build fails its own option check for `active` on selector items,
 * so that flag rendered nothing at all. The mark is part of each item's html
 * instead: a tick that keeps its column when hidden, in a class this skin
 * colours. One builder for both callers, so the open panel and a later refresh
 * cannot disagree.
 */
function qualitySelectorFor(current, auto) {
  const tick = (on) => `<span class="mlbd-q-tick${on ? "" : " is-off"}" aria-hidden="true">&#10003;</span>`;
  // With Auto on, the useful fact is not "Auto" but the resolution Auto settled
  // on; with it off, the tick on the playing row says it already.
  const now = Number(current && current.quality) > 0 ? `(${Number(current.quality)}p)` : "";
  return [
    { html: `${tick(auto)}Auto <small>${auto && now ? now : "adaptive"}</small>`, value: "auto" },
    ...qualityOptions().map((s) => {
      const playing = Boolean(current) && !auto && s.id === current.id;
      return {
        html: `${tick(playing)}${s.quality}p${s.is_best ? " <small>Best</small>" : ""}` +
          `${isUnusable(s) ? " <small>no audio</small>" : ""}` +
          `${s.id.endsWith("-c") ? " <small>broken mirror</small>" : ""}`,
        value: s.id,
      };
    }),
  ];
}

/** The closed row says which quality is on, so the panel is not the only place to look. */
const qualityLabel = (current) => (Number(current && current.quality) > 0
  ? `Quality <small>${Number(current.quality)}p</small>`
  : "Quality");

let menusBuilt = null;
function buildMenus(art, current) {
  const qualitySelector = qualitySelectorFor(current, state.autoQuality);

  const audioLangs = [...new Set(state.sources.map((s) => String(s.audio || "").trim()).filter(Boolean))];
  const audioSelector = audioLangs.map((lang) => ({
    html: lang,
    value: lang,
    active: lang === current.audio,
  }));

  try {
    art.setting.add({
      name: "quality",
      html: qualityLabel(current),
      width: 220,
      selector: qualitySelector,
      onSelect(item) {
        if (item.value === "auto") {
          state.autoQuality = true;
          state.stalls = [];
          const best = qualityOptions()[0];
          if (best) mountSource(best, { restore: true });
          return item.html;
        }
        const picked = state.sources.find((s) => s.id === item.value);
        if (!picked) return item.html;
        state.autoQuality = false;
        writePref(picked);
        mountSource(picked, { restore: true });
        return item.html;
      },
    });
    if (audioLangs.length > 1) {
      art.setting.add({
        name: "audio",
        html: "Audio",
        width: 200,
        selector: audioSelector,
        onSelect(item) {
          const picked = state.sources.find((s) => String(s.audio || "") === String(item.value) && Number(s.quality) === Number(state.source.quality))
            || state.sources.find((s) => String(s.audio || "") === String(item.value));
          if (picked) mountSource(picked, { restore: true });
          return item.html;
        },
      });
    }
  } catch (e) {
    console.warn("[mlbd] setting menu unavailable", e);
  }
  menusBuilt = { qualitySelector, audioSelector };
}

function refreshQualityMenu() {
  const art = state.art;
  if (!art || !menusBuilt || !state.source) return;
  try {
    art.setting.update({
      name: "quality",
      html: qualityLabel(state.source),
      selector: qualitySelectorFor(state.source, state.autoQuality),
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 6b. viewing comfort: resume, hold-to-speed, adaptive resolution
//
// Three small things that make the difference between "a video tag" and a
// player: it starts where the viewer stopped, a press held on the picture plays
// it at double speed, and a link that cannot keep up steps down a quality
// instead of spinning. Positions stay in this browser; nothing is sent anywhere.
// ---------------------------------------------------------------------------
const positionKey = () => `mlbd_pos:${location.pathname}`;

function clockText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function savePosition(art) {
  try {
    const t = Number(art.currentTime || 0);
    const d = Number(art.duration || 0);
    if (!(t > 5) || !(d > 30)) return;   // trailers and clips are not worth resuming
    localStorage.setItem(positionKey(), JSON.stringify({ t, d, at: Date.now() }));
  } catch { /* private mode or full storage: watching still works */ }
}

/** Where to start, or 0. A finished or stale position is not a resume point. */
function savedPosition() {
  try {
    const raw = localStorage.getItem(positionKey());
    if (!raw) return 0;
    const p = JSON.parse(raw);
    const t = Number(p && p.t);
    const d = Number(p && p.d);
    if (!(t > 20) || !(d > 0)) return 0;
    if (t > d - 25) return 0;                                   // watched to the end
    if (Date.now() - Number((p && p.at) || 0) > 30 * 24 * 3600 * 1000) return 0;
    return t;
  } catch { return 0; }
}

function forgetPosition() {
  try { localStorage.removeItem(positionKey()); } catch { /* ignore */ }
}

const HOLD_MS = 320;

/** Press ? for the keys, because nobody reads a README to watch a film. */
function setupShortcutHelp(art) {
  const stage = $(".mlbd-inline-player__stage", section);
  if (!stage) return;
  const panel = document.createElement("div");
  panel.className = "mlbd-keys";
  panel.hidden = true;
  panel.innerHTML = `<h3>Keyboard</h3>
    <dl>
      <dt>Space</dt><dd>Play / pause</dd>
      <dt>&larr; &rarr;</dt><dd>Back / forward 5 s</dd>
      <dt>&uarr; &darr;</dt><dd>Volume</dd>
      <dt>F</dt><dd>Full screen</dd>
      <dt>M</dt><dd>Mute</dd>
      <dt>Hold</dt><dd>2&times; speed while the picture is held</dd>
      <dt>?</dt><dd>This panel</dd>
    </dl>`;
  stage.appendChild(panel);

  const show = (on) => { panel.hidden = !on; };
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    const tag = (el && el.tagName ? el.tagName : "").toLowerCase();
    if (tag === "input" || tag === "textarea" || (el && el.isContentEditable)) return;
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      show(panel.hidden);
    } else if (e.key === "Escape" && !panel.hidden) {
      show(false);
    }
  });
  panel.addEventListener("click", () => show(false));
  art.on("video:play", () => show(false));
}

/** Press and hold the picture: 2x while held, the chosen rate again on release. */
function setupHoldSpeed(art) {
  const video = art && art.video;
  const stage = $(".mlbd-inline-player__stage", section);
  if (!video || !stage) return;

  const badge = document.createElement("div");
  badge.className = "mlbd-hold-speed";
  badge.textContent = "2× ▶▶";
  badge.hidden = true;
  stage.appendChild(badge);

  let timer = null;
  let restoreRate = 1;

  const engage = () => {
    timer = null;
    const v = art.video;
    if (!v || v.paused) return;          // holding a paused frame is just a tap
    restoreRate = Number(v.playbackRate) || 1;
    if (restoreRate >= 1.99) return;     // already fast: nothing to add
    try { art.playbackRate = 2; } catch { /* ignore */ }
    badge.hidden = false;
  };

  const release = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (badge.hidden) return;
    try { art.playbackRate = restoreRate; } catch { /* ignore */ }
    badge.hidden = true;
  };

  video.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(engage, HOLD_MS);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) video.addEventListener(ev, release);
  window.addEventListener("blur", release);
  // A long press is a hold, not a request for the context menu.
  video.addEventListener("contextmenu", (e) => e.preventDefault());
}

/**
 * Adaptive resolution: three stalls inside 45 seconds is a link that is not
 * keeping up, so step one quality down rather than let the viewer stare at a
 * spinner. It only steps down: climbing back on a flaky line causes exactly the
 * stall it is trying to avoid.
 */
function noteStall(source) {
  if (!state.autoQuality) return;
  const now = Date.now();
  state.stalls = state.stalls.filter((t) => now - t < 45000);
  state.stalls.push(now);
  if (state.stalls.length < 3) return;
  state.stalls = [];
  const lower = closestLower(qualityOptions(), Number(source && source.quality) || 0);
  if (!lower) return;
  notice(`Slow connection — switching to ${lower.quality}p for smooth playback.`, { type: "warning", timeout: 5000 });
  mountSource(lower, { restore: true });
}

// ---------------------------------------------------------------------------
// 7. failover
// ---------------------------------------------------------------------------
const failureInFlight = new Set();

const mediaUrlOf = (el) => String((el && (el.currentSrc || el.src)) || "");

/**
 * A media element error never reports an HTTP status, so ask the CDN directly.
 * Only a 403 means "the token is the problem"; everything else is a mirror issue.
 */
async function gateLooksExpired(url) {
  if (!/[?&]mg=/.test(String(url || ""))) return false;
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-1" }, credentials: "omit", cache: "no-store" });
    return res.status === 403;
  } catch { return false; }
}

/**
 * The single owner of a media failure.
 *
 * The original had two independent handlers racing on the same event: a
 * capture-phase listener that reloaded the whole document, and the player's own
 * mirror failover. Which recovery applies is decided here, once, by first asking
 * whether the token is actually the problem.
 */
async function handleMediaFailure(source, reason) {
  const id = identity(source);
  if (id !== identity(state.source) || failureInFlight.has(id)) return;
  failureInFlight.add(id);
  setStatus(reason === "stalled" ? "Stream stalled" : "Source error");
  try {
    if (await gateLooksExpired(source.url)) {
      if (await recoverWatchGate(reason)) return;
      // Last resort, at most once per session, and only when there is no player
      // left to interact with. A full bootstrap can re-mint everything.
      let reloadedOnce = false;
      try { reloadedOnce = sessionStorage.getItem(`${GATE_KEY}_rl`) === "1"; } catch { /* ignore */ }
      if (!state.art && !reloadedOnce) {
        try { sessionStorage.setItem(`${GATE_KEY}_rl`, "1"); } catch { /* ignore */ }
        location.reload();
        return;
      }
      notice("The stream token could not be renewed.", { type: "error", timeout: 8000 });
      return;
    }
    state.failedSources.add(id);
    switchMirror(reason);
  } finally {
    failureInFlight.delete(id);
  }
}

/** Mirror switch: downgrade first, then give up with a message. */
function switchMirror(reason) {
  const next = nextMirror();
  if (next) {
    notice(`${state.source.quality}p from ${state.source.provider} did not respond. Trying ${next.quality}p from ${next.provider}.`);
    setTimeout(() => {
      if (identity(state.source) !== identity(next)) mountSource(next, { restore: true, fallback: true });
    }, 450);
    return true;
  }
  if (reason === "audio") {
    notice("No source has audio. Download the file and play it locally.", { type: "error", timeout: 8000 });
  } else {
    // Every mirror has failed. If the server already told us the format is the
    // problem, say which one — "no working source" sends people looking for a
    // network fault that is not there.
    const stuck = state.sources.length > 0 && state.sources.every((s) => s.playable === false);
    notice((stuck && unsupportedReason(state.source)) || "Playback is unavailable. No working source remains.",
      { type: "error", timeout: 9000 });
    setStatus("Unavailable");
  }
  return false;
}

/** A source reported as silent by the crowd: mark it and move on. */
function audioFailureHop(source) {
  const id = identity(source);
  if (id !== identity(state.source) || isUnusable(source)) return;
  state.audioFailedSources.add(id);
  const alt = audioAlternate(source);
  if (!alt) {
    notice("No other quality has audio.", { type: "warning", timeout: 6000 });
    return;
  }
  notice(`No audio on ${source.quality}p. Trying ${alt.quality}p.`, { type: "warning", timeout: 5200 });
  setTimeout(() => {
    if (identity(state.source) === id) mountSource(alt, { restore: true, fallback: true });
  }, 350);
}

// ---------------------------------------------------------------------------
// 8. watch-gate recovery (the fix)
// ---------------------------------------------------------------------------
/**
 * Original behaviour: any media error on an mg= URL burned a session flag,
 * deleted the cached token and reloaded the whole document - losing position,
 * buffer, subtitles and DOM, and disabling recovery for the rest of the session.
 *
 * This version re-mints, rebuilds the config and re-mounts the same source,
 * keeping the player instance, the position and the DOM. It is bounded to one
 * attempt per healthy playback and never clears the tokens when the re-mint
 * fails. Any full reload lives in handleMediaFailure, not here.
 */
async function recoverWatchGate(reason) {
  if (state.recoveryInFlight) return false;
  try { if (sessionStorage.getItem(`${GATE_KEY}_r`) === "1") return false; } catch { /* ignore */ }
  state.recoveryInFlight = true;
  try {
    const renewed = await renewAllGates();
    if (!renewed) {
      // tokens are left in place: a later attempt may still succeed. The original
      // deleted them here, which is what made the failure permanent.
      notice("The stream token could not be renewed.", { type: "error", timeout: 6000 });
      return false;
    }
    try { sessionStorage.setItem(`${GATE_KEY}_r`, "1"); } catch { /* ignore */ }

    const current = state.source;
    const position = state.art ? Number(state.art.currentTime || 0) : 0;
    applyConfig();
    const rebuilt = state.sources.find((s) => s.id === (current && current.id)) || defaultSource({ sources: state.sources }, null);
    if (!rebuilt) return false;

    notice("Stream token renewed. Resuming.", { type: "warning", timeout: 4000 });
    state.reloadAvoided += 1;
    mountSource(rebuilt, { restore: true, autoplay: true });
    // restore is handled by mountSource via state.art.currentTime, which we had
    if (position > 0.5 && state.art) {
      const art = state.art;
      const once = () => { try { art.currentTime = position; } catch { /* ignore */ } };
      try { art.video.addEventListener("loadedmetadata", once, { once: true }); } catch { /* ignore */ }
    }
    return true;
  } finally {
    state.recoveryInFlight = false;
  }
}

// ArtPlayer's own error events are the single entry point for media failures
// (see handleMediaFailure). A capture-phase DOM listener on the player subtree
// used to race it and reload the document; that competing path is gone.

/** Pre-warm on the first gesture (as the original does) and use the status as a token smoke test. */
let prewarmed = false;
const prewarm = async () => {
  if (prewarmed) return;
  prewarmed = true;
  const src = state.source || defaultSource({ sources: state.sources }, null);
  if (!src) return;
  try {
    const res = await fetch(src.url, { headers: { Range: "bytes=0-1" }, credentials: "omit", cache: "no-store" });
    if (res.status === 403) {
      notice("The stream token expired before playback. Renewing.", { type: "warning", timeout: 4000 });
      await recoverWatchGate("prewarm-403");
    }
  } catch { /* ignore */ }
};
document.addEventListener("pointerdown", prewarm, { capture: true, once: true, passive: true });
document.addEventListener("touchstart", prewarm, { capture: true, once: true, passive: true });

// ---------------------------------------------------------------------------
// 9. api
// ---------------------------------------------------------------------------
window.MLBD_PLAYER = {
  togglePlayback: () => { const a = state.art; if (!a) return false; a.playing ? a.pause() : a.play().catch(() => {}); return true; },
  seekBy: (d) => { const a = state.art; if (!a) return false; a.currentTime = Math.max(0, Number(a.currentTime || 0) + Number(d || 0)); return true; },
  playSource: (id) => { const s = state.sources.find((x) => x.id === id || x.file_fid === id); return s ? mountSource(s, { restore: true }) : false; },
};

/** Everything the dev panel needs, plus a few deliberate fault injectors. */
window.MLBD_DEV = {
  state,
  config: () => state.config,
  configMeta: () => ({
    seed: configSource.seed, rounds: configSource.rounds, encoded: configSource.encoded,
    decodedChars: configText.length,
    mediaHosts: distinctMediaHosts(configText),
    hostsWithToken: [...gateTokens.keys()],
  }),
  sources: () => state.sources.map((s) => ({
    id: s.id, quality: s.quality, provider: s.provider, score: score(s), usable: !isUnusable(s),
    health: audioStatus(s), reports: healthOf(s).reports, urlHasToken: /[?&]mg=/.test(s.url),
  })),
  current: () => (state.source ? { id: state.source.id, quality: state.source.quality, provider: state.source.provider } : null),
  counters: () => ({ gateMintCount: state.gateMintCount, reloadAvoided: state.reloadAvoided, playbackToken: state.playbackToken, failed: [...state.failedSources] }),
  /** Corrupt the token on the live URL: the CDN answers 403 and the gate path runs. */
  forceMediaError: () => {
    const v = state.art && state.art.video;
    if (!v || !state.source) return false;
    const broken = state.source.url.replace(/([?&]mg=)[^&]*/i, "$1stale.152306.invalid");
    v.src = broken;
    try { v.load(); } catch { /* ignore */ }
    return true;
  },
  recoverWatchGate,
  mountSource: (id) => window.MLBD_PLAYER.playSource(id),
};

// ---------------------------------------------------------------------------
// go
// ---------------------------------------------------------------------------
if (section && dataEl) {
  setStatus("Preparing");
  ensureGateTokens().then(() => {
    applyConfig();
    const first = defaultSource({ sources: state.sources }, null);
    if (!first) {
      const pending = state.config && state.config.pending_publish;
      notice(
        pending
          ? "This film is being moved to Blob storage. It will play here as soon as its files are published."
          : "No playable source is configured.",
        { type: pending ? "warning" : "error", timeout: pending ? 12000 : 8000 },
      );
      return;
    }
    mountSource(first, { autoplay: false });
    // fire-and-forget view telemetry, like the original
    fetch("/media/event", {
      method: "POST", credentials: "same-origin", keepalive: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ event: "view", token: String((first && first.id) || "") }).toString(),
    }).catch(() => {});
  });
}
