/**
 * Integration check for view counts, against a throwaway library.
 *
 * A view is one anonymous number, so the checks are about the rules that keep
 * it honest rather than about the counter itself: five seconds is the client's
 * job, then one view per address per film, no bots, and the number reaching the
 * catalogue, the watch page, the admin and stats.json.
 *
 * Nothing here touches the live storage or the network beyond 127.0.0.1.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "server.mjs");
const NODE = process.execPath;
const SITE = "http://127.0.0.1:8897";
const TOKEN = "views-test-token";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

const pass = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(process.env.TEMP || ".", "mlbd-views-"));
const storage = join(dir, "storage");
await mkdir(storage, { recursive: true });
await writeFile(join(storage, "library.json"), JSON.stringify({
  titles: [{
    id: "probe",
    title: "Probe",
    description: "A title that exists only for this test.",
    sources: [{
      id: "src-720-m1",
      file: "probe.mp4",
      quality: 720,
      remote: { url: "https://example.invalid/probe.mp4" },
    }],
  }],
}, null, 2));

let log = "";
const app = spawn(NODE, [APP], {
  env: {
    ...process.env,
    PORT: "8897",
    HOST: "127.0.0.1",
    MIRROR_MODE: "path",
    STORAGE_DIR: storage,
    ADMIN_TOKEN: TOKEN,
    HIDE_SEEDS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.on("data", (d) => { log += d; });
app.stderr.on("data", (d) => { log += d; });

try {
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${SITE}/api/catalogue.json`)).ok) { up = true; break; } } catch { /* starting */ }
    await sleep(250);
  }
  if (!up) throw new Error(`server did not start\n${log}`);

  const view = (body, { ua = UA, ip = "198.51.100.7" } = {}) =>
    fetch(`${SITE}/api/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ua, "X-Forwarded-For": ip },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

  const viewsInCatalogue = async () => {
    const data = await (await fetch(`${SITE}/api/catalogue.json`)).json();
    return (data.titles.find((t) => t.id === "probe") || {}).views;
  };

  // ---- what is refused ------------------------------------------------------
  const unknown = await view({ id: "no-such-film" });
  pass(unknown.status === 404 && unknown.body.error === "unknown_title",
    "a view for a film that does not exist is refused", `status ${unknown.status}`);

  const wrongMethod = await fetch(`${SITE}/api/view?id=probe`);
  pass(wrongMethod.status === 405, "only POST reports a view", `status ${wrongMethod.status}`);

  const empty = await view({});
  pass(empty.status === 400, "a view needs a title id", `status ${empty.status}`);

  // ---- one view, then the rule ---------------------------------------------
  const first = await view({ id: "probe" });
  pass(first.status === 200 && first.body.counted === true && first.body.views === 1,
    "the first view counts", JSON.stringify(first.body));

  const again = await view({ id: "probe" });
  pass(again.body.counted === false && again.body.views === 1,
    "a second view from the same address does not", JSON.stringify(again.body));

  const elsewhere = await view({ id: "probe" }, { ip: "203.0.113.9" });
  pass(elsewhere.body.counted === true && elsewhere.body.views === 2,
    "another address counts", JSON.stringify(elsewhere.body));

  const bot = await view({ id: "probe" }, { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)", ip: "203.0.113.44" });
  pass(bot.body.counted === false && bot.body.views === 2,
    "a crawler is not a viewer", JSON.stringify(bot.body));

  const anonymous = await view({ id: "probe" }, { ua: "", ip: "203.0.113.55" });
  pass(anonymous.body.counted === false, "a request with no user agent is not a viewer either");

  // ---- the number where people see it ---------------------------------------
  pass((await viewsInCatalogue()) === 2, "the catalogue carries the count", String(await viewsInCatalogue()));

  const page = await (await fetch(`${SITE}/movie/probe`)).text();
  const meta = JSON.parse(page.match(/<script id="mlbdTitleMeta" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  pass(meta.views === 2, "the watch page carries it too", String(meta.views));

  const state = await (await fetch(`${SITE}/api/admin/state`, { headers: { "X-Admin-Token": TOKEN } })).json();
  const card = state.titles.find((t) => t.id === "probe");
  pass(card && card.views === 2, "the admin lists it per film", JSON.stringify(card && card.views));
  pass(state.views && state.views.total === 2, "and totals it", JSON.stringify(state.views));

  // ---- it survives the process ---------------------------------------------
  await sleep(6500); // the save is batched
  const saved = JSON.parse(await readFile(join(storage, "stats.json"), "utf8"));
  pass(saved.titles.probe && saved.titles.probe.views === 2,
    "stats.json holds the count beside the media", JSON.stringify(saved.titles.probe));
  pass(JSON.parse(await readFile(join(storage, "library.json"), "utf8")).titles[0].views === undefined,
    "the catalogue file is not rewritten by a view");
} finally {
  app.kill();
  await sleep(400);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(process.exitCode ? "\nfailed" : "\nall checks passed");
}
