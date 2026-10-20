/**
 * Browser test for the demo player. Drives a real page over CDP so the parts
 * that only exist at runtime (media element, token injection, failover, gate
 * recovery) are actually exercised.
 *
 *   node cdp-demo.mjs
 *
 * Also covers the browse/category pages and, when ADMIN_TOKEN is set in this
 * process's environment, the admin page end to end: unlock, add a movie by
 * picking a real file, watch it, then remove it and check the file was kept.
 *
 * Requires Node 22+ (global WebSocket) and a Chrome started with
 * --remote-debugging-port=9222.
 */
if (!globalThis.WebSocket) {
  console.error(
    `Node ${process.version} has no global WebSocket - this test needs Node 22+.\n` +
    `If an older Node shadows the new one on PATH, run it explicitly:\n` +
    `  node -v                                  # check which one you are running\n` +
    `  & "E:\\Tools\\node-v24.18.0-win-x64\\node.exe" cdp-demo.mjs`,
  );
  process.exit(2);
}

const BROWSER = process.env.BROWSER_CDP || "http://127.0.0.1:9222";
const SITE = `http://127.0.0.1:${process.env.SITE_PORT || 8890}`;
const PAGE = process.env.PAGE || `${SITE}/movie/demo-feature`;

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STORAGE = process.env.STORAGE_DIR || join(HERE, "storage");
const MANIFEST = join(STORAGE, "library.json");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  cond ? pass++ : fail++;
};

class CDP {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      setTimeout(() => rej(new Error("ws timeout")), 8000);
    });
    return new CDP(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        for (const h of this.listeners.get(msg.method) || []) h(msg.params);
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method} timed out`)); }, 15000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cdp, expr, { timeout = 15000, label = expr, poll = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await cdp.eval(expr); if (last) return last; } catch (e) { last = `eval error: ${e.message}`; }
    await sleep(poll);
  }
  return { timedOut: true, last };
}

// ---------------------------------------------------------------------------
const target = await (await fetch(`${BROWSER}/json/new`, { method: "PUT" })).json();
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
const consoleErrors = [];
const badResponses = [];
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Network.enable");
cdp.on("Runtime.exceptionThrown", (p) => consoleErrors.push("exception: " + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
cdp.on("Runtime.consoleAPICalled", (p) => {
  if (p.type === "error" || p.type === "warning") consoleErrors.push(`${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? "").join(" "));
});
// A 404 on our own asset would otherwise be swallowed by the console filter
// below, which is exactly how a never-loading script stayed invisible.
cdp.on("Network.responseReceived", (p) => {
  if (p.response?.status >= 400 && /\.(js|mjs|css|svg|vtt|json|webmanifest)(\?|$)/.test(p.response.url)) {
    badResponses.push(`${p.response.status} ${p.response.url}`);
  }
});

try {
  // ---- catalogue (browse page) ---------------------------------------------
  await cdp.send("Page.navigate", { url: `${SITE}/` });
  const cards = await waitFor(cdp, "document.querySelectorAll('.card').length", { label: "cards", timeout: 15000 });
  ok("browse page renders a card per title", cards >= 4, `${cards} cards`);

  const rowNames = await cdp.eval("[...document.querySelectorAll('.row__head h2')].map((h) => h.textContent)");
  ok("titles are grouped into named rows", rowNames.length >= 2, rowNames.join(" | "));
  ok("the hero features a title", Boolean(await cdp.eval("document.querySelector('.hero h1') && document.querySelector('.hero h1').textContent.trim()")),
    await cdp.eval("document.querySelector('.hero h1') && document.querySelector('.hero h1').textContent"));

  const posters = await waitFor(cdp,
    "(() => { const im = [...document.querySelectorAll('.card__art img')]; return im.length && im.every((i) => i.naturalWidth > 0) ? im.length : 0; })()",
    { label: "posters decoded", timeout: 15000 });
  ok("every poster actually loads", posters >= 4, `${posters} images decoded`);

  const heroHref = await cdp.eval("document.querySelector('.hero .btn--primary').getAttribute('href')");
  ok("the hero play button links to the first title", /^\/movie\//.test(heroHref), heroHref);

  const firstHref = await cdp.eval("document.querySelector('.card').getAttribute('href')");
  ok("cards link to a per-title page", /^\/movie\//.test(firstHref), firstHref);

  await cdp.eval("document.querySelector('.card').click()");
  const navigated = await waitFor(cdp, "location.pathname.startsWith('/movie/')", { label: "navigate", timeout: 15000 });
  ok("clicking a card opens that title", navigated === true, await cdp.eval("location.pathname"));
  ok("and it is the title the card pointed at", (await cdp.eval("location.pathname")) === firstHref,
    `${firstHref} -> ${await cdp.eval("location.pathname")}`);

  const moreRow = await waitFor(cdp, "document.querySelectorAll('#more-titles .card').length", { label: "more titles", timeout: 15000 });
  ok("the watch page offers the other titles", moreRow >= 3, `${moreRow} cards`);

  const about = await cdp.eval("document.querySelector('#title-meta-root') ? document.querySelector('#title-meta-root').textContent.trim().length : 0");
  ok("the watch page shows this title's metadata", about > 20, `${about} chars`);
  ok("the player heading names the title",
    (await cdp.eval("document.querySelector('.mlbd-inline-player__heading').textContent.trim()")) === "Demo Feature");

  const watchChips = await waitFor(cdp,
    "[...document.querySelectorAll('#title-meta-root .chip--cat')].map((a) => a.tagName + ':' + a.getAttribute('href'))",
    { label: "category chips", timeout: 15000 });
  ok("the watch page chips link to the categories this title is in",
    Array.isArray(watchChips) && watchChips.length === 1 && watchChips[0] === "A:/category/featured",
    JSON.stringify(watchChips));

  // ---- categories ----------------------------------------------------------
  await cdp.send("Page.navigate", { url: `${SITE}/` });
  await waitFor(cdp, "document.querySelectorAll('#catalogue-root .chipbar .chip').length", { label: "chip bar", timeout: 15000 });

  const chip = await cdp.eval(
    "(() => { const a = document.querySelector('.chipbar a[href^=\"/category/\"]');" +
    " if (!a) return null;" +
    " return { href: a.getAttribute('href'), name: a.childNodes[0].textContent.trim()," +
    " n: Number(a.querySelector('.chip__n').textContent) }; })()");
  ok("a category chip carries its name and count",
    Boolean(chip) && /^\/category\//.test(chip.href) && chip.n >= 1 && chip.name.length > 0,
    JSON.stringify(chip));

  await cdp.eval("document.querySelector('.chipbar a[href^=\"/category/\"]').click()");
  const onCategory = await waitFor(cdp, "location.pathname.startsWith('/category/')", { label: "category nav", timeout: 15000 });
  ok("clicking a chip opens that category's page", onCategory === true, await cdp.eval("location.pathname"));
  ok("the page shows the category the chip pointed at",
    (await cdp.eval("location.pathname")) === chip.href,
    `${chip.href} -> ${await cdp.eval("location.pathname")}`);

  const gridCards = await waitFor(cdp, "document.querySelectorAll('#category-root .grid .card').length", { label: "category grid", timeout: 15000 });
  ok("the category page renders a grid of exactly its titles",
    gridCards === chip.n, `grid=${gridCards} chip said ${chip.n}`);
  ok("the category page names the category",
    (await cdp.eval("document.querySelector('.cat-head h1').textContent.trim()")) === chip.name,
    await cdp.eval("document.querySelector('.cat-head h1').textContent"));

  const gridPosters = await waitFor(cdp,
    "(() => { const im = [...document.querySelectorAll('#category-root .card img')]; return im.length && im.every((i) => i.naturalWidth > 0) ? im.length : 0; })()",
    { label: "grid posters", timeout: 15000 });
  ok("every poster on the category page loads", gridPosters === gridCards, `${gridPosters}/${gridCards}`);

  await cdp.eval("document.querySelector('#category-root .card').click()");
  const cardNav = await waitFor(cdp, "location.pathname.startsWith('/movie/')", { label: "card -> movie", timeout: 15000 });
  ok("a card on the category page opens that title", cardNav === true, await cdp.eval("location.pathname"));

  await cdp.send("Page.navigate", { url: PAGE });

  const mounted = await waitFor(cdp, "Boolean(window.MLBD_DEV && window.MLBD_DEV.state && window.MLBD_DEV.state.art)", { label: "player mounted" });
  ok("player mounts without a page error", mounted === true, mounted.timedOut ? `timeout, last=${JSON.stringify(mounted.last)}` : "");

  // The rest of this script drives the developer panel, which production pages
  // no longer ship. Fail with the fix rather than timing out on every query.
  if (!(await cdp.eval("Boolean(window.MLBD_DEV)"))) {
    console.error("\nThe developer panel is disabled on this build.");
    console.error("Start the server with DEV_PANEL=1 and run this demo again.\n");
    process.exit(1);
  }

  const devRows = await waitFor(cdp, "document.querySelectorAll('#dev-sources .dev-src').length", { label: "dev source rows", timeout: 15000 });
  ok("the test panel builds one row per source of this title", devRows === 5, `${devRows} rows`);

  // deterministic start: drop any saved quality preference and load once more
  await cdp.eval("(() => { localStorage.clear(); sessionStorage.clear(); location.reload(); return true; })()");
  await waitFor(cdp, "Boolean(window.MLBD_DEV && window.MLBD_DEV.state.art)", { label: "remounted" });
  await cdp.eval("window.__probeMark = 'alive-' + Math.random()");
  const mark = await cdp.eval("window.__probeMark");

  // ---- config + token ------------------------------------------------------
  const meta = await cdp.eval("MLBD_DEV.configMeta()");
  ok("config was decoded from an obfuscated payload",
    Boolean(meta.encoded && meta.seed && meta.rounds > 0 && meta.decodedChars > 500),
    `seed=${meta.seed} rounds=${meta.rounds} chars=${meta.decodedChars}`);
  ok("all three CDN hosts found in the config", (meta.mediaHosts || []).length === 3, (meta.mediaHosts || []).join(" "));
  ok("a gate token was minted for every host", (meta.hostsWithToken || []).length === 3, (meta.hostsWithToken || []).join(" "));

  const sources = await cdp.eval("MLBD_DEV.sources()");
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  ok("all playable sources carry mg= tokens", sources.length === 5 && sources.every((s) => s.urlHasToken),
    sources.map((s) => `${s.quality}p/${s.id.endsWith("-c") ? "broken" : "ok"}`).join(" "));
  ok("quality dominates the score",
    byId["src-1080-a"].score > byId["src-720-a"].score && byId["src-720-a"].score > byId["src-360-a"].score,
    `1080=${Math.round(byId["src-1080-a"].score)} 720=${Math.round(byId["src-720-a"].score)} 360=${Math.round(byId["src-360-a"].score)}`);
  ok("provider priority breaks a quality tie",
    byId["src-720-a"].score > byId["src-720-b"].score,
    `mlbd=${Math.round(byId["src-720-a"].score)} fastcloud=${Math.round(byId["src-720-b"].score)}`);

  const first = await cdp.eval("MLBD_DEV.current()");
  const topScore = sources.reduce((a, b) => (a.score > b.score ? a : b));
  ok("default pick is 720p, not the highest-scoring source",
    first.quality === 720 && topScore.quality !== 720, `picked ${first.id}; best score is ${topScore.id}`);
  ok("the default 720p is the primary CDN's own mirror", first.id === "src-720-a", first.id);

  const mountedUrl = await cdp.eval("MLBD_DEV.state.art.video.currentSrc");
  const configuredUrl = await cdp.eval("MLBD_DEV.state.source.url");
  ok("the mounted URL is exactly the configured URL, token included", mountedUrl === configuredUrl, mountedUrl);
  ok("that token was minted by the host serving the media", /:8891\/p\/demo-feature--q720-m1\?mg=/.test(mountedUrl), mountedUrl);

  // ---- playback ------------------------------------------------------------
  await cdp.eval("MLBD_PLAYER.togglePlayback()");
  const playing = await waitFor(cdp, "(() => { const v = MLBD_DEV.state.art.video; return !v.paused && v.currentTime > 0.6 && v.readyState >= 3; })()", { label: "playing", timeout: 20000 });
  ok("video actually plays", playing === true, playing.timedOut ? `stuck: ${JSON.stringify(playing.last)}` : "");
  const dur = await cdp.eval("MLBD_DEV.state.art.video.duration");
  ok("duration is reported by the media element", dur > 5, `duration=${dur}s`);

  // ---- audio health (positive path) ---------------------------------------
  const health = await waitFor(cdp, "MLBD_DEV.state.lastHealthEvidence", { label: "audio_ok report", timeout: 25000 });
  ok("viewer reports audio_ok for a source with audio", health && health.event === "audio_ok",
    health ? `event=${health.event} evidence=${health.evidence}` : JSON.stringify(health));

  // ---- quality + mirror switch --------------------------------------------
  await cdp.eval("(() => { const a = MLBD_DEV.state.art; a.currentTime = 4; if (a.video.paused) a.play().catch(() => {}); return true; })()");
  await sleep(700);
  const beforeSwitch = await cdp.eval("MLBD_DEV.state.art.currentTime");
  await cdp.eval("MLBD_DEV.mountSource('src-720-b')");
  const switched = await waitFor(cdp, "/:8892\\/p\\/demo-feature--q720-m2/.test(MLBD_DEV.state.art.video.currentSrc) && MLBD_DEV.state.art.video.currentTime > 0.5", { label: "mirror B", timeout: 20000 });
  ok("switching to the second mirror works and resumes", switched === true, switched.timedOut ? JSON.stringify(switched.last) : "");
  await sleep(500);
  const afterSwitch = await cdp.eval("MLBD_DEV.state.art.currentTime");
  ok("mirror switch preserves the position", Math.abs(afterSwitch - beforeSwitch) < 2.5,
    `${beforeSwitch.toFixed(1)}s -> ${afterSwitch.toFixed(1)}s`);
  ok("the second mirror URL carries its own token from its own host",
    /:8892\/p\/demo-feature--q720-m2\?mg=/.test(await cdp.eval("MLBD_DEV.state.art.video.currentSrc")),
    await cdp.eval("MLBD_DEV.state.art.video.currentSrc"));

  // ---- genuine silence detection -------------------------------------------
  // src-1080-a is a real video-only file, so this assert covers the probe itself
  // rather than a simulated report.
  await cdp.eval("MLBD_DEV.mountSource('src-1080-a')");
  const silent = await waitFor(cdp,
    "(() => { const e = MLBD_DEV.state.lastHealthEvidence; return e && e.id === 'src-1080-a' && e.event === 'no_audio' ? e : false; })()",
    { label: "silence detection", timeout: 30000 });
  ok("a genuinely silent rendition is detected as no_audio",
    Boolean(silent) && !silent.timedOut,
    silent && !silent.timedOut ? `evidence=${silent.evidence}` : JSON.stringify(silent));
  ok("and the verdict needs more than one signal",
    /multi-signal/.test((silent && silent.evidence) || ""), (silent && silent.evidence) || "");
  await fetch(`${SITE}/api/dev/heal`, { method: "POST" });

  // ---- broken mirror: failover, not a reload -------------------------------
  const countersBefore503 = await cdp.eval("MLBD_DEV.counters()");
  await cdp.eval("MLBD_DEV.mountSource('src-1080-c')");
  const failedOver = await waitFor(cdp, "MLBD_DEV.current().id !== 'src-1080-c'", { label: "failover", timeout: 20000 });
  ok("a dead mirror fails over to another source", failedOver === true,
    failedOver.timedOut ? JSON.stringify(failedOver.last) : `now on ${(await cdp.eval("MLBD_DEV.current()")).id}`);
  const after503 = await cdp.eval("MLBD_DEV.counters()");
  ok("a plain mirror failure does not trigger gate recovery (no over-firing)",
    after503.reloadAvoided === countersBefore503.reloadAvoided && after503.gateMintCount === countersBefore503.gateMintCount,
    `reloadAvoided ${countersBefore503.reloadAvoided}->${after503.reloadAvoided}, mints ${countersBefore503.gateMintCount}->${after503.gateMintCount}`);
  const recovered503 = await waitFor(cdp, "(() => { const v = MLBD_DEV.state.art.video; return !v.paused && v.currentTime > 0.5; })()", { label: "playing after failover", timeout: 20000 });
  ok("playback resumes on the healthy mirror", recovered503 === true, recovered503.timedOut ? JSON.stringify(recovered503.last) : "");

  // ---- gate expiry: the fix -------------------------------------------------
  const countersBefore = await cdp.eval("MLBD_DEV.counters()");
  const sourceBefore = await cdp.eval("MLBD_DEV.current().id");
  const tokenBefore = await cdp.eval("JSON.parse(sessionStorage.getItem('mlbd_wg_v1'))[''] || JSON.stringify(JSON.parse(sessionStorage.getItem('mlbd_wg_v1')))");

  await fetch(`${SITE}/api/dev/expire-tokens`, { method: "POST" });   // every issued token is now void
  const forced = await cdp.eval("MLBD_DEV.forceMediaError()");
  ok("fault injected: the live URL now carries a stale token", forced === true);
  ok("the CDN really refuses the stale token", (await fetch(await cdp.eval("MLBD_DEV.state.source.url"), { headers: { Range: "bytes=0-1" } })).status === 403);

  const recovered = await waitFor(cdp, "MLBD_DEV.counters().reloadAvoided > 0", { label: "gate recovery", timeout: 30000 });
  ok("the expired token is recovered from", recovered === true, recovered.timedOut ? JSON.stringify(recovered.last) : "renewed and remounted");

  const after = await cdp.eval("MLBD_DEV.counters()");
  ok("recovery re-minted tokens instead of giving up", after.gateMintCount > countersBefore.gateMintCount,
    `mints ${countersBefore.gateMintCount} -> ${after.gateMintCount}`);
  ok("NO PAGE RELOAD happened", (await cdp.eval("window.__probeMark")) === mark,
    `mark ${mark} vs ${await cdp.eval("window.__probeMark")}`);

  const resumed = await waitFor(cdp, "(() => { const v = MLBD_DEV.state.art.video; return !v.paused && v.currentTime > 0.5 && MLBD_DEV.state.art.video.error === null; })()", { label: "resumed", timeout: 25000 });
  ok("playback resumes after recovery", resumed === true, resumed.timedOut ? JSON.stringify(resumed.last) : "");
  const sourceAfter = await cdp.eval("MLBD_DEV.current().id");
  ok("recovery keeps the same source instead of drifting to another mirror",
    sourceAfter === sourceBefore, `${sourceBefore} -> ${sourceAfter}`);
  // Position restore is asserted on the mirror-switch path above: the injected
  // fault replaces the element's src, which already resets currentTime to 0.
  const tokenAfter = await cdp.eval("JSON.stringify(JSON.parse(sessionStorage.getItem('mlbd_wg_v1')))");
  ok("the cached token was replaced with a fresh one", tokenAfter !== tokenBefore,
    `${String(tokenBefore).slice(0, 46)} -> ${String(tokenAfter).slice(0, 46)}`);

  // the guard must also clear: a later expiry may recover again
  const guardCleared = await cdp.eval("sessionStorage.getItem('mlbd_wg_v1_r')");
  ok("recovery flag is cleared once playback succeeds again", guardCleared === null, `flag=${guardCleared}`);

  // ---- tier-2 health skip ---------------------------------------------------
  await fetch(`${SITE}/api/dev/report-no-audio?title=demo-feature&id=src-720-a&times=2`, { method: "POST" });
  await fetch(`${SITE}/api/dev/report-no-audio?title=demo-feature&id=src-720-b&times=2`, { method: "POST" });
  const st = await (await fetch(`${SITE}/api/dev/state`)).json();
  const healthNow = Object.fromEntries(st.sources.map((s) => [s.gid, s.health.audio_status]));
  ok("the server now holds both 720p mirrors as no_audio",
    healthNow["demo-feature:src-720-a"] === "no_audio" && healthNow["demo-feature:src-720-b"] === "no_audio",
    JSON.stringify(healthNow));
  await cdp.eval("(() => { localStorage.removeItem('mlbd_v78_quality_pref'); sessionStorage.clear(); location.reload(); return true; })()");
  await waitFor(cdp, "Boolean(window.MLBD_DEV && window.MLBD_DEV.state.art)", { label: "reload for health", timeout: 15000 });
  const picked = await cdp.eval("MLBD_DEV.current()");
  const listed = await cdp.eval("MLBD_DEV.sources()");
  ok("720p is now flagged no_audio in the shipped config",
    listed.filter((s) => s.quality === 720 && s.health === "no_audio" && !s.usable).length === 2,
    listed.filter((s) => s.quality === 720).map((s) => `${s.id}=${s.health}`).join(" "));
  ok("player avoids both verified-bad-audio sources", picked.id !== "src-720-a" && picked.id !== "src-720-b",
    `picked ${picked.id} (${picked.quality}p)`);
  ok("and falls back downward to 360p rather than upward to 1080p", picked.id === "src-360-a", picked.id);

  await fetch(`${SITE}/api/dev/heal`, { method: "POST" });

  // ---- admin page: add a movie, then remove it ------------------------------
  // Same switch as selftest.mjs: with no ADMIN_TOKEN the page must not exist.
  const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
  if (!ADMIN_TOKEN) {
    await cdp.send("Page.navigate", { url: `${SITE}/admin` });
    await sleep(600);
    ok("with no ADMIN_TOKEN the browser gets the 404 page, with no gate",
      (await cdp.eval("document.title")) === "Not found" &&
      (await cdp.eval("Boolean(document.getElementById('gate'))")) === false,
      await cdp.eval("document.title"));
    ok("and the browse page does not advertise an admin",
      (await cdp.eval(`fetch('/').then((r) => r.text()).then((t) => t.includes('href="/admin"'))`)) === false);
    console.log("SKIP  admin browser test - start the server with ADMIN_TOKEN set and pass the same value here");
  } else {
    let hadManifest = false;
    let beforeManifest = null;
    try { beforeManifest = await readFile(MANIFEST, "utf8"); hadManifest = true; } catch { /* none yet */ }

    let uploadedFile = null;
    try {
      // The page asks for the token rather than taking it from the URL, so the
      // real unlock path is exercised here.
      await cdp.send("Page.navigate", { url: `${SITE}/admin` });
      ok("the admin page shows the token gate",
        (await waitFor(cdp, "!document.getElementById('gate').hidden", { label: "gate", timeout: 15000 })) === true);

      await cdp.eval(`(() => { document.getElementById('gate-token').value = ${JSON.stringify(ADMIN_TOKEN)}; ` +
        "document.getElementById('gate-form').requestSubmit(); return true; })()");
      ok("the token unlocks the library",
        (await waitFor(cdp, "!document.getElementById('app').hidden", { label: "unlocked", timeout: 15000 })) === true);

      const listed = await cdp.eval("document.querySelectorAll('#titles .admin-title').length");
      ok("the admin lists every movie, built-ins included", listed >= 4, `${listed} rows`);
      ok("built-in demo movies are marked read-only",
        (await cdp.eval("document.querySelectorAll('#titles .admin-title.is-builtin').length")) >= 4);
      ok("storage files are listed with their used/unused state",
        (await cdp.eval("document.querySelectorAll('#files .file-row').length")) >= 3);

      await cdp.eval("document.getElementById('new').click()");
      ok("the editor opens",
        (await waitFor(cdp, "!document.getElementById('editor').hidden", { label: "editor", timeout: 10000 })) === true);

      await cdp.eval(`(() => {
        document.getElementById('f-title').value = 'Browser Movie';
        document.getElementById('f-year').value = '2026';
        document.getElementById('f-description').value = 'Added through the admin page by cdp-demo.mjs.';
        document.querySelector('#src-rows .src-row input[data-f="quality"]').value = '360';
        document.getElementById('f-new-cat').value = 'Browser Picks';
        document.getElementById('add-cat').click();
        return true;
      })()`);
      ok("a brand-new category can be created from the editor",
        (await cdp.eval("document.querySelectorAll('#cat-picker input:checked').length")) === 1,
        await cdp.eval("[...document.querySelectorAll('#cat-picker input:checked')].map((i) => i.value).join(',')"));

      // A real file into a real file input, so the upload path is the browser's.
      await cdp.send("DOM.enable");
      const dom = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: dom.root.nodeId, selector: "#upload-file" });
      await cdp.send("DOM.setFileInputFiles", { files: [join(STORAGE, "audio-360.mp4")], nodeId });

      uploadedFile = await waitFor(cdp,
        "(() => { const s = document.querySelector('#src-rows .src-row select[data-f=\"file\"]'); return s && s.value ? s.value : false; })()",
        { label: "upload", timeout: 90000 });
      ok("picking a file uploads it and fills the source row",
        typeof uploadedFile === "string" && uploadedFile === "browser-movie-360.mp4", String(uploadedFile));
      ok("it is uploaded under a name derived from the title, not the file's own name",
        typeof uploadedFile === "string" && !uploadedFile.includes("audio-360"), String(uploadedFile));

      await cdp.eval("document.querySelector('#src-rows .src-row input[data-f=\"audio\"]').value = 'Hindi'");
      await cdp.eval("document.getElementById('movie-form').requestSubmit()");
      ok("saving closes the editor",
        (await waitFor(cdp, "document.getElementById('editor').hidden", { label: "saved", timeout: 30000 })) === true);

      const listedNow = await waitFor(cdp,
        "[...document.querySelectorAll('#titles .admin-title__name')].some((n) => n.textContent.includes('Browser Movie'))",
        { label: "new movie listed", timeout: 15000 });
      ok("the new movie appears in the admin list", listedNow === true);

      // ... and it is a real title on the public site, not just a row in the form
      const catRes = await fetch(`${SITE}/category/browser-picks`);
      ok("the category created in the editor has a public page", catRes.status === 200, `status ${catRes.status}`);
      ok("and it lists the new movie",
        (await catRes.text()).includes('"id":"browser-movie"') ||
        (await (await fetch(`${SITE}/api/category/browser-picks.json`)).json()).titles.some((t) => t.id === "browser-movie"));

      await cdp.send("Page.navigate", { url: `${SITE}/movie/browser-movie` });
      ok("the movie added in the browser has a watch page that mounts",
        (await waitFor(cdp, "Boolean(window.MLBD_DEV && window.MLBD_DEV.state.art)", { label: "new title player", timeout: 25000 })) === true);
      await cdp.eval("MLBD_PLAYER.togglePlayback()");
      ok("and it actually plays",
        (await waitFor(cdp, "(() => { const v = MLBD_DEV.state.art.video; return !v.paused && v.currentTime > 0.4; })()",
          { label: "new title plays", timeout: 25000 })) === true);

      // removing it must keep the bytes and report them as unused
      cdp.on("Page.javascriptDialogOpening", () => cdp.send("Page.handleJavaScriptDialog", { accept: true }));
      await cdp.send("Page.navigate", { url: `${SITE}/admin` });
      await waitFor(cdp, "!document.getElementById('app').hidden", { label: "admin again", timeout: 15000 });
      const clickedRemove = await cdp.eval(
        "(() => { const b = document.querySelector('#titles [data-del=\"browser-movie\"]'); if (!b) return false; b.click(); return true; })()");
      ok("the remove button is offered for an added movie", clickedRemove === true);
      ok("removing it takes it out of the list",
        (await waitFor(cdp, "![...document.querySelectorAll('#titles .admin-title__name')].some((n) => n.textContent.includes('Browser Movie'))",
          { label: "removed", timeout: 20000 })) === true);

      const afterDelete = await (await fetch(`${SITE}/api/admin/state`, { headers: { "X-Admin-Token": ADMIN_TOKEN } })).json();
      ok("its file is still on disk, reported as unused",
        afterDelete.orphans.includes(uploadedFile),
        `orphans=${JSON.stringify(afterDelete.orphans)}`);
      ok("the movie is gone from the public catalogue",
        !(await (await fetch(`${SITE}/api/catalogue.json`)).json()).titles.some((t) => t.id === "browser-movie"));
    } finally {
      if (uploadedFile) await unlink(join(STORAGE, uploadedFile)).catch(() => {});
      if (hadManifest) await writeFile(MANIFEST, beforeManifest, "utf8");
      else await unlink(MANIFEST).catch(() => {});
    }
  }

  // ---- console hygiene -----------------------------------------------------
  const realErrors = consoleErrors.filter((m) => !/favicon|net::ERR_ABORTED|net::ERR_FAILED|Failed to load resource/.test(m));
  ok("no unexpected console errors", realErrors.length === 0, realErrors.slice(0, 6).join(" | "));
  ok("every page asset the browser asked for was served", badResponses.length === 0,
    badResponses.slice(0, 6).join(" | ") || "no 4xx/5xx on js/css/svg/json");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (consoleErrors.length) console.log(`\nconsole/warnings (${consoleErrors.length}):\n` + consoleErrors.slice(0, 12).map((m) => "  " + m).join("\n"));
} catch (e) {
  console.error("\nTEST HARNESS ERROR:", e && e.stack ? e.stack : e);
  fail++;
} finally {
  cdp.close();
  await fetch(`${BROWSER}/json/close/${target.id}`).catch(() => {});
  process.exit(fail ? 1 : 0);
}
