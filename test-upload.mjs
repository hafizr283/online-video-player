/**
 * Integration check for resumable uploads, against a throwaway library.
 *
 * The point of the feature is a film that is too big for one HTTP request, so
 * these checks send one in pieces: out of order, with a gap, then completed —
 * and confirm the joined file is byte-identical and the pieces are gone.
 *
 * Nothing here touches the live storage or the network beyond 127.0.0.1.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "server.mjs");
const NODE = process.execPath;
const SITE = "http://127.0.0.1:8896";
const TOKEN = "upload-test-token";
const CHUNK = 1024 * 1024;

const pass = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const auth = { "X-Admin-Token": TOKEN };

const dir = await mkdtemp(join(process.env.TEMP || ".", "mlbd-upload-"));
const storage = join(dir, "storage");
await mkdir(storage, { recursive: true });

let log = "";
const app = spawn(NODE, [APP], {
  env: {
    ...process.env,
    PORT: "8896",
    HOST: "127.0.0.1",
    MIRROR_MODE: "path",
    STORAGE_DIR: storage,
    ADMIN_TOKEN: TOKEN,
    UPLOAD_CHUNK_BYTES: String(CHUNK),
    RENDITION_HEIGHT: "0",
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

  const json = async (path, opts = {}) => {
    const res = await fetch(`${SITE}${path}`, opts);
    let body = {};
    try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, ok: res.ok, body };
  };
  const start = (name, size, title = "Piece Test") => json("/api/admin/upload/session", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name, size, title, quality: 0 }),
  });
  const piece = (id, index, buf) => fetch(`${SITE}/api/admin/upload/chunk?id=${id}&index=${index}`, {
    method: "POST", headers: auth, body: buf,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

  // ---- a film that does not fit in one request -----------------------------
  const whole = randomBytes(3 * CHUNK + 4242);          // three pieces and a stub
  const size = whole.length;
  const pieceOf = (i) => whole.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, size));
  const expected = Math.ceil(size / CHUNK);

  const opened = await start("piece-test.mp4", size);
  pass(opened.ok, "a session opens for a file of any size", `status ${opened.status}`);
  pass(opened.body.chunk === CHUNK, "the server dictates the piece size", `${opened.body.chunk} bytes`);
  pass(opened.body.expected === expected, "and says how many pieces it expects", `${opened.body.expected} of ${expected}`);

  const id = opened.body.id;
  pass(/^[a-f0-9]{16}$/.test(id), "the id is unguessable", id.slice(0, 6) + "…");

  // Out of order, on purpose: a real connection retries whatever it likes.
  const middle = await piece(id, 1, pieceOf(1));
  pass(middle.status === 200, "a piece can arrive first", `status ${middle.status}`);
  const first = await piece(id, 0, pieceOf(0));
  pass(first.status === 200 && first.body.received.join(",") === "0,1", "pieces are tracked by index", first.body.received.join(","));

  const stillMissing = [];
  for (let i = 2; i < expected; i++) stillMissing.push(i);
  const early = await json(`/api/admin/upload/finish?id=${id}`, { method: "POST", headers: auth });
  pass(early.status === 409 && early.body.missing.join(",") === stillMissing.join(","),
    "finishing early names every missing piece", `missing ${JSON.stringify(early.body.missing)}`);

  const status = await json(`/api/admin/upload/session?id=${id}`, { headers: auth });
  pass(status.ok && status.body.received.length === 2, "the session can be asked what it has",
    `${status.body.received.length} piece(s), ${status.body.bytes} bytes`);

  let allLanded = true;
  for (let i = 2; i < expected; i++) {
    const r = await piece(id, i, pieceOf(i));
    if (r.status !== 200) allLanded = false;
  }
  pass(allLanded, "the remaining pieces land", `${expected - 2} piece(s)`);

  const done = await json(`/api/admin/upload/finish?id=${id}`, { method: "POST", headers: auth });
  pass(done.ok, "the pieces are joined", `${done.status} ${done.body.error || ""}`);
  pass(done.body.file === "piece-test.mp4", "under the name the title asked for", done.body.file);
  pass(done.body.bytes === size, "with every byte", `${done.body.bytes} of ${size}`);

  const stored = await readFile(join(storage, "piece-test.mp4"));
  pass(sha(stored) === sha(whole), "and the file is byte-identical to what was sent",
    sha(stored).slice(0, 16) + "…");

  const left = await readdir(join(storage, ".incoming")).catch(() => []);
  pass(left.length === 0, "no pieces are left behind", left.join(" ") || "empty");

  // ---- refusals -------------------------------------------------------------
  const fat = await piece(id, 0, Buffer.alloc(CHUNK + 512));
  pass(fat.status === 404 || fat.status === 413, "a piece over the size is refused", `status ${fat.status}`);

  const tight = await start("tight.mp4", CHUNK + 1000);
  const a = await piece(tight.body.id, 0, Buffer.alloc(CHUNK));
  const b = await piece(tight.body.id, 1, Buffer.alloc(CHUNK));
  pass(b.status === 413 && b.body.error === "too_large",
    "pieces cannot add up past the declared size", `status ${b.status} ${b.body.error || ""} (first ${a.status})`);

  const unknown = await piece("0123456789abcdef", 0, Buffer.from("x"));
  pass(unknown.status === 404, "a made-up session id is not found", `status ${unknown.status}`);

  const big = await start("huge.mp4", 3 * 1024 * 1024 * 1024);
  pass(big.status === 413 && big.body.error === "too_large", "a file past the library limit is refused up front",
    `status ${big.status}`);

  const wrongExt = await start("film.txt", 1024);
  pass(wrongExt.status === 400, "only video containers are accepted", `status ${wrongExt.status}`);

  // ---- the old one-request path still works --------------------------------
  const oneShot = await fetch(`${SITE}/api/admin/upload?name=quick.mp4&title=Quick%20One`, {
    method: "POST", headers: auth, body: Buffer.alloc(64 * 1024),
  });
  pass(oneShot.status === 200, "a small file still goes in one request", `status ${oneShot.status}`);

  // ---- the door -------------------------------------------------------------
  const noToken = await fetch(`${SITE}/api/admin/state`);
  pass(noToken.status === 401, "no token is no admin", `status ${noToken.status}`);

  const listed = await json("/api/admin/upload/session", { headers: auth });
  pass(listed.ok && Array.isArray(listed.body.sessions) && listed.body.sessions.length >= 1,
    "the page can list unfinished uploads", `${listed.body.sessions.length} session(s)`);

  // Eight wrong tokens, then the ninth attempt is locked out — not merely wrong.
  let lastStatus = 0;
  for (let i = 0; i < 9; i++) {
    const res = await fetch(`${SITE}/api/admin/state`, { headers: { "X-Admin-Token": `wrong-${i}` } });
    lastStatus = res.status;
  }
  pass(lastStatus === 429, "repeated wrong tokens are locked out", `status ${lastStatus}`);
  const withRightToken = await fetch(`${SITE}/api/admin/state`, { headers: auth });
  pass(withRightToken.status === 429, "and the lockout holds even for the right token",
    `status ${withRightToken.status}`);
} finally {
  app.kill();
  await sleep(400);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(process.exitCode ? "\nfailed" : "\nall checks passed");
}
