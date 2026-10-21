/**
 * Block-upload one file to a single-blob Azure SAS URL.
 *
 *   node upload.mjs <file> <sas-url>
 *
 * Azure's single-PUT ceiling is 5 GiB and a dropped connection would start the
 * whole transfer again, so every file goes up in 8 MB blocks with three in
 * flight and a retry per block. The commit at the end is the only step that
 * makes the blob visible.
 */
import { open, stat } from "node:fs/promises";

const [file, base] = process.argv.slice(2);
if (!file || !base) {
  console.error("usage: node upload.mjs <file> <sas-url>");
  process.exit(2);
}
if (!/^https:\/\/.+[?&]sig=/.test(base)) {
  console.error("the second argument is not a SAS URL");
  process.exit(2);
}

const BLOCK = 8 * 1024 * 1024;
const WORKERS = 3;
const size = (await stat(file)).size;
const total = Math.ceil(size / BLOCK);
const handle = await open(file, "r");
const ids = new Array(total);
const queue = [...Array(total).keys()];
let sent = 0;

async function put(url, body, headers = {}) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body, headers });
      if (res.ok) return;
      last = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      // A 403 is an expired or wrong SAS; retrying will not fix it.
      if (res.status >= 400 && res.status < 500) break;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw last || new Error("upload failed");
}

async function worker() {
  for (;;) {
    const index = queue.shift();
    if (index === undefined) return;
    const length = Math.min(BLOCK, size - index * BLOCK);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, index * BLOCK);
    const id = Buffer.from(`block-${String(index).padStart(6, "0")}`).toString("base64");
    ids[index] = id;
    await put(`${base}&comp=block&blockid=${encodeURIComponent(id)}`, buffer);
    sent += length;
    process.stdout.write(`\r${Math.round((sent / size) * 100)}%  ${(sent / 1024 / 1024).toFixed(1)} MiB`);
  }
}

console.log(`uploading ${(size / 1024 / 1024).toFixed(1)} MiB in ${total} block(s)`);
await Promise.all(Array.from({ length: Math.min(WORKERS, total) }, worker));
await handle.close();
process.stdout.write("\n");

const xml = '<?xml version="1.0" encoding="utf-8"?><BlockList>' +
  ids.map((id) => `<Latest>${id}</Latest>`).join("") +
  "</BlockList>";

await put(`${base}&comp=blocklist`, xml, {
  "content-type": "application/xml",
  "x-ms-blob-content-type": "video/mp4",
  "x-ms-blob-cache-control": "public, max-age=31536000, immutable",
});

console.log("committed");
