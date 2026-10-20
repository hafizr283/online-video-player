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
const TOKEN = "test-token";

const pass = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
let headBytes = 0;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seen.push({
      method: req.method,
      url: req.url,
      bytes: body.length,
      headers: req.headers,
    });
    if (req.method === "PUT") {
      headBytes = body.length;
      res.writeHead(201, { ETag: "0x1" });
      return res.end();
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Length": String(headBytes), "Content-Type": "video/mp4" });
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
    AZURE_SAS: "?sv=2021-08-06&sr=c&sig=dGVzdA%3D%3D&se=2030-01-01T00%3A00%3A00Z",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => { appLog += d; });
app.stderr.on("data", (d) => { appLog += d; });

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

  const movie = await (await fetch(`${SITE}/movie/azure-test`)).text();
  const m = movie.match(/<script id="mlbdInlinePlayerData"[^>]*data-s="([0-9a-f]+)"[^>]*data-r="(\d+)"[^>]*>([\s\S]*?)<\/script>/);
  const bytes = Buffer.from(m[3].trim(), "base64");
  let r = parseInt(m[1], 16) >>> 0;
  for (let i = 0; i < Number(m[2]); i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bytes[i] ^ ((r >>> 16) & 0xff);
  }
  const cfg = JSON.parse(out.toString("utf8"));
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
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  app.kill();
  await new Promise((r) => mock.close(r));
  await sleep(300);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(process.exitCode ? "\nfailed" : "\nall checks passed");
}
