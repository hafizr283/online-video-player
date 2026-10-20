/**
 * Integration check for the Blob publish path, against a mock container.
 *
 * Both sides are local: a fake Azure endpoint that records what arrives, and a
 * throwaway library on port 8898. Nothing touches the live storage or the real
 * container, and no network is used.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const NODE = process.execPath;
const APP = join(HERE, "server.mjs");
const FFMPEG = join(HERE, "tools", "ffmpeg", "bin", "ffmpeg.exe");
const LIVE = process.env.STORAGE_DIR || "H:\\movielinkbd-storage";
const SITE = "http://127.0.0.1:8898";
const SITE_ONLY = "http://127.0.0.1:8897";
const TOKEN = "test-token";
const SAS = "?sv=2021-08-06&sr=c&sig=dGVzdA%3D%3D&se=2030-01-01T00%3A00%3A00Z";

const pass = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode the obfuscated player config out of a movie page. */
async function configFor(id, site = SITE) {
  const html = await (await fetch(`${site}/movie/${id}`)).text();
  const m = html.match(/<script id="mlbdInlinePlayerData"[^>]*data-s="([0-9a-f]+)"[^>]*data-r="(\d+)"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no player data on /movie/${id}`);
  const bytes = Buffer.from(m[3].trim(), "base64");
  let r = parseInt(m[1], 16) >>> 0;
  for (let i = 0; i < Number(m[2]); i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bytes[i] ^ ((r >>> 16) & 0xff);
  }
  return JSON.parse(out.toString("utf8"));
}

const SCRATCH = process.env.TRANSCODE_DIR || "H:\\movielinkbd-transcode";
await (await import("node:fs/promises")).mkdir(SCRATCH, { recursive: true });
const dir = await mkdtemp(join(SCRATCH, "azure-test-"));
const storage = join(dir, "storage");
await (await import("node:fs/promises")).mkdir(storage, { recursive: true });
await copyFile(join(LIVE, "silent-1080.mp4"), join(storage, "demo.mp4"));
const size = (await stat(join(storage, "demo.mp4"))).size;
await writeFile(join(storage, "library.json"), JSON.stringify({
  titles: [{
    id: "azure-test", title: "Azure Test", categories: ["featured"], poster: "/media/poster.svg",
    sources: [{ file: "demo.mp4", quality: 1080, cdn: 0, name: "demo.mp4", container: "mp4", audio: "Unknown" }],
  }],
  categories: [],
}, null, 2));

// ---- the fake container ----------------------------------------------------
const seen = [];
const blobs = new Map();       // pathname -> bytes
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const path = new URL(req.url, "http://mock").pathname;
    seen.push({
      method: req.method,
      url: req.url,
      path,
      bytes: body.length,
      headers: req.headers,
    });
    if (req.method === "PUT") {
      blobs.set(path, body.length);
      res.writeHead(201, { ETag: "0x1" });
      return res.end();
    }
    if (req.method === "HEAD") {
      if (!blobs.has(path)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Length": String(blobs.get(path)), "Content-Type": "video/mp4" });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => mock.listen(8899, "127.0.0.1", r));

// ---- the app, on a throwaway library --------------------------------------
const app = spawn(NODE, [APP], {
  env: {
    ...process.env,
    PORT: "8898",
    HOST: "127.0.0.1",
    MIRROR_MODE: "path",
    STORAGE_DIR: storage,
    ADMIN_TOKEN: TOKEN,
    DEV_PANEL: "1",
    FFMPEG_PATH: FFMPEG,
    AZURE_CONTAINER_URL: "http://127.0.0.1:8899/movies",
    AZURE_SAS: SAS,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => { appLog += d; });
app.stderr.on("data", (d) => { appLog += d; });
let appOnly = null;   // the second run, with AZURE_ONLY=1

try {
  let up = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${SITE}/api/catalogue.json`);
      if (r.ok) { up = true; break; }
    } catch { /* starting */ }
    await sleep(250);
  }
  if (!up) throw new Error(`server did not start\n${appLog}`);

  const AUTH = { "X-Admin-Token": TOKEN, "Content-Type": "application/json" };
  const state = await (await fetch(`${SITE}/api/admin/state`, { headers: AUTH })).json();
  pass(state.azure && state.azure.configured === true, "the admin sees Blob storage as configured",
    `${state.azure && state.azure.container} scope=${state.azure && state.azure.scope}`);
  pass(state.azure.scope === "container", "a container SAS is accepted");

  const started = await fetch(`${SITE}/api/admin/azure?file=demo.mp4`, { method: "POST", headers: AUTH });
  pass(started.status === 202, "an upload starts", `status ${started.status}`);
  let job = (await started.json()).job;
  for (let i = 0; i < 120 && job.status === "running"; i++) {
    await sleep(200);
    job = (await (await fetch(`${SITE}/api/admin/azure?id=${job.id}`, { headers: AUTH })).json()).job;
  }
  pass(job.status === "done", "the job finishes", `${job.status} ${job.error || ""}`);
  pass(job.percent === 100, "progress reaches 100", `${job.percent}%`);
  pass(job.bytes === size, "every byte was sent", `${job.bytes} of ${size}`);
  pass(job.titles === 1, "the title that uses the file is pointed at the copy", `${job.titles} title(s)`);

  const put = seen.find((s) => s.method === "PUT");
  pass(Boolean(put), "the container received one PUT");
  if (put) {
    pass(put.bytes === size, "the body is the whole file", `${put.bytes} bytes`);
    pass(put.headers["x-ms-blob-type"] === "BlockBlob", "it is sent as a block blob", put.headers["x-ms-blob-type"]);
    pass(put.headers["content-type"] === "video/mp4", "with a media content type", put.headers["content-type"]);
    pass(/^\/movies\/v1\/[a-f0-9]{12}\/demo\.mp4\?sv=/.test(put.url), "under an unguessable path, signed", put.url.slice(0, 70));
    pass(String(put.headers["content-length"]) === String(size), "content-length matches", put.headers["content-length"]);
  }

  const head = seen.find((s) => s.method === "HEAD");
  pass(Boolean(head), "the upload is verified with a HEAD afterwards");

  const cfg = await configFor("azure-test");
  const src = cfg.episodes[0].sources[0];
  pass(/^http:\/\/127\.0\.0\.1:8899\/movies\/v1\//.test(src.url), "the player is given the published URL", src.url.slice(0, 70));
  pass(src.remote === true, "and knows it is remote", String(src.remote));

  const lib = JSON.parse(await readFile(join(storage, "library.json"), "utf8"));
  pass(Boolean(lib.titles[0].sources[0].remote), "the manifest remembers it", lib.titles[0].sources[0].remote?.blob);

  // Switch back to the local copy without touching the blob.
  const off = await fetch(`${SITE}/api/admin/azure?file=demo.mp4`, { method: "DELETE", headers: AUTH });
  const offBody = await off.json();
  pass(off.ok && offBody.titles === 1, "the admin can serve it from this PC again", JSON.stringify(offBody));
  const lib2 = JSON.parse(await readFile(join(storage, "library.json"), "utf8"));
  pass(!lib2.titles[0].sources[0].remote, "the manifest forgets the published copy");
  pass(seen.filter((s) => s.method === "DELETE").length === 0, "and no blob was deleted");

  // ---- publishing a film, not a file --------------------------------------
  // The point of publishing is that none of the film is left here: the master
  // and its 480p rendition have to travel together, or the quality switch falls
  // back to this PC.
  await copyFile(join(storage, "demo.mp4"), join(storage, "copy.mp4"));
  await writeFile(join(storage, "library.json"), JSON.stringify({
    titles: [{
      id: "two-files", title: "Two Files", categories: ["featured"], poster: "/media/poster.svg",
      sources: [
        { file: "demo.mp4", quality: 720, cdn: 0, name: "demo.mp4", container: "mp4", audio: "Unknown", best: true },
        { file: "copy.mp4", quality: 480, cdn: 0, name: "copy.mp4", container: "mp4", audio: "Unknown" },
      ],
    }],
    categories: [],
  }, null, 2));

  const putsBefore = seen.filter((s) => s.method === "PUT").length;
  const bulkRes = await fetch(`${SITE}/api/admin/azure?title=two-files`, { method: "POST", headers: AUTH });
  pass(bulkRes.status === 202, "one request publishes a whole film", `status ${bulkRes.status}`);
  let bulk = (await bulkRes.json()).job;
  pass(bulk.count === 2, "the job covers every file of the title", `${bulk.count} file(s)`);
  for (let i = 0; i < 300 && bulk.status === "running"; i++) {
    await sleep(150);
    bulk = (await (await fetch(`${SITE}/api/admin/azure?id=${bulk.id}`, { headers: AUTH })).json()).job;
  }
  pass(bulk.status === "done", "both files are published", `${bulk.status} ${bulk.error || ""}`);
  pass(bulk.files.every((f) => f.status === "done"), "each file reports done",
    bulk.files.map((f) => `${f.name}:${f.status}`).join(" "));
  pass(bulk.titles === 2, "both sources are pointed at their own copy", `${bulk.titles} source row(s)`);
  pass(seen.filter((s) => s.method === "PUT").length - putsBefore === 2, "the container received two PUTs",
    String(seen.filter((s) => s.method === "PUT").length - putsBefore));

  const libBulk = JSON.parse(await readFile(join(storage, "library.json"), "utf8"));
  const [master, small] = libBulk.titles[0].sources;
  pass(Boolean(master.remote && small.remote) && master.remote.blob !== small.remote.blob,
    "the rendition gets its own blob, not its master's",
    `${master.remote && master.remote.blob} | ${small.remote && small.remote.blob}`);

  // ---- adopting a blob that is already in the container -------------------
  const existing = libBulk.titles[0].sources[0].remote;
  const adopt = await fetch(
    `${SITE}/api/admin/azure?file=copy.mp4&blob=${encodeURIComponent(existing.blob)}`,
    { method: "PATCH", headers: AUTH },
  );
  const adoptBody = await adopt.json();
  pass(adopt.ok && adoptBody.remote && adoptBody.remote.blob === existing.blob,
    "a blob uploaded elsewhere can be adopted without a write key",
    adopt.ok ? `${adoptBody.remote.bytes} bytes` : `${adopt.status} ${adoptBody.message}`);

  const notThere = await fetch(
    `${SITE}/api/admin/azure?file=copy.mp4&blob=${encodeURIComponent("v1/nope/nothing.mp4")}`,
    { method: "PATCH", headers: AUTH },
  );
  pass(notThere.status === 404, "adopting a blob that is not there says so", `status ${notThere.status}`);

  // ---- a rendition does not inherit its master's blob ---------------------
  // Publishing the master says nothing about the 480p file; if the rendition
  // copied the master's URL, picking 480p would play the 720p blob.
  await copyFile(join(storage, "demo.mp4"), join(storage, "demo-480.mp4"));
  const stateKey = (await (await fetch(`${SITE}/api/admin/state`, { headers: AUTH })).json()).key;
  const save = await fetch(`${SITE}/api/admin/title`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      key: stateKey,
      id: "with-rendition",
      title: "With Rendition",
      categories: ["featured"],
      sources: [{ file: "demo.mp4", quality: 720, remote: existing }],
    }),
  });
  pass(save.ok, "a title can be saved with a published source", `status ${save.status}`);
  const libR = JSON.parse(await readFile(join(storage, "library.json"), "utf8"));
  const saved = libR.titles.find((t) => t.id === "with-rendition");
  const rend = saved && saved.sources.find((s) => s.file === "demo-480.mp4");
  pass(Boolean(rend), "the rendition joins the title on save",
    saved ? saved.sources.map((s) => s.file).join(" ") : "no title");
  pass(rend && !rend.remote, "and does not inherit the master's blob",
    rend ? String(rend.remote && rend.remote.url) : "missing");

  // ---- Azure-only: nothing streams from this PC ---------------------------
  app.kill();
  await sleep(500);
  await copyFile(join(storage, "demo.mp4"), join(storage, "local.mp4"));
  // copy.mp4 keeps the remote the adopt just attached: this is the state of a
  // film that was published, next to one that was not.
  const adoptedRemote = adoptBody.ok ? adoptBody.remote : existing;
  await writeFile(join(storage, "library.json"), JSON.stringify({
    titles: [
      {
        id: "published", title: "Published", categories: ["featured"], poster: "/media/poster.svg",
        sources: [{
          file: "copy.mp4", quality: 720, cdn: 0, name: "copy.mp4",
          container: "mp4", audio: "Unknown", remote: adoptedRemote,
        }],
      },
      {
        id: "still-local", title: "Still Local", categories: ["featured"], poster: "/media/poster.svg",
        sources: [{ file: "local.mp4", quality: 720, cdn: 0, name: "local.mp4", container: "mp4", audio: "Unknown" }],
      },
    ],
    categories: [],
  }, null, 2));

  appOnly = spawn(NODE, [APP], {
    env: {
      ...process.env,
      PORT: "8897",
      HOST: "127.0.0.1",
      MIRROR_MODE: "path",
      STORAGE_DIR: storage,
      ADMIN_TOKEN: TOKEN,
      AZURE_CONTAINER_URL: "http://127.0.0.1:8899/movies",
      AZURE_SAS: SAS,
      AZURE_ONLY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appOnly.stdout.on("data", (d) => { appLog += d; });
  appOnly.stderr.on("data", (d) => { appLog += d; });
  let upOnly = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${SITE_ONLY}/api/catalogue.json`)).ok) { upOnly = true; break; }
    } catch { /* starting */ }
    await sleep(250);
  }
  if (!upOnly) throw new Error(`the Azure-only server did not start\n${appLog}`);

  const publishedCfg = await configFor("published", SITE_ONLY);
  const publishedSources = publishedCfg.episodes[0].sources;
  pass(publishedSources.length === 1 && publishedSources[0].remote === true &&
    /^http:\/\/127\.0\.0\.1:8899\//.test(publishedSources[0].url),
    "a published film is offered from Blob storage",
    publishedSources[0] && publishedSources[0].url.slice(0, 60));

  const localCfg = await configFor("still-local", SITE_ONLY);
  pass(localCfg.episodes[0].sources.length === 0, "an unpublished film offers no source at all",
    `${localCfg.episodes[0].sources.length} source(s)`);
  pass(localCfg.pending_publish === true, "and says it is still being moved",
    String(localCfg.pending_publish));

  const onlyState = await (await fetch(`${SITE_ONLY}/api/admin/state`, { headers: AUTH })).json();
  pass(onlyState.azure.only === true, "the admin knows playback is Azure-only", String(onlyState.azure.only));
  const publishedRow = onlyState.titles.find((t) => t.id === "published");
  const localRow = onlyState.titles.find((t) => t.id === "still-local");
  pass(publishedRow && publishedRow.local_files === 0, "a published film has nothing left here",
    `${publishedRow && publishedRow.local_files}`);
  pass(localRow && localRow.local_files === 1, "an unpublished one still counts its local file",
    `${localRow && localRow.local_files}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (appOnly) appOnly.kill();
  app.kill();
  await new Promise((r) => mock.close(r));
  await sleep(500);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(process.exitCode ? "\nfailed" : "\nall checks passed");
}
