import assert from "node:assert/strict";
import test from "node:test";
import { buildConfig, cardOf, obfuscate, readySources, rowToTitle } from "../functions/_lib/titles.js";
import { cleanSource } from "../functions/_lib/admin.js";
import { blobSas, publicBlobUrl } from "../functions/_lib/azure.js";

/** The player's own decoder, copied from public/style/fp-details-player.js. */
function decode(payload, seed, rounds) {
  let r = parseInt(seed, 16) >>> 0;
  for (let i = 0; i < rounds; i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    out[i] = bytes[i] ^ ((r >>> 16) & 0xff);
  }
  return new TextDecoder().decode(out);
}

const row = {
  id: "hello",
  name: "Hello",
  description: "A test title.",
  year: 2026,
  poster_url: "",
  subtitle_url: "",
  duration: 60,
  size: 100,
  status: "published",
  views: 3,
  categories: '["animation"]',
  tags: '["test"]',
  sources: JSON.stringify([
    { id: "a", quality: 720, type: "mp4", url: "https://x/y.mp4", blob: "v1/a/y.mp4", name: "y.mp4", size: 10, best: false, status: "ready" },
    { id: "b", quality: 1080, type: "mp4", url: "", blob: "incoming/z", name: "z.mkv", size: 20, best: true, status: "pending" },
  ]),
  created_at: 1,
  updated_at: 1,
};

test("obfuscate round-trips through the player's decoder", () => {
  const text = JSON.stringify({ title: "হ্যালো", nested: { n: 42, ok: true } });
  const { payload, seed, rounds } = obfuscate(text);
  assert.equal(decode(payload, seed, rounds), text);
});

test("buildConfig offers only ready sources", () => {
  const title = rowToTitle(row);
  assert.equal(readySources(title).length, 1);
  const config = buildConfig(title);
  assert.equal(config.episodes[0].sources.length, 1);
  assert.equal(config.episodes[0].sources[0].quality, 720);
  assert.equal(config.title_id, "hello");
  assert.equal(config.pending_publish, false);
});

test("cardOf sorts qualities and never advertises a pending file", () => {
  const card = cardOf(rowToTitle(row));
  assert.deepEqual(card.qualities, [720]);
  assert.equal(card.source_count, 1);
  assert.equal(card.url, "/movie/hello");
  assert.equal(card.poster, "/poster/hello.svg");
});

test("a title with nothing ready is not published by buildConfig", () => {
  const pending = rowToTitle({ ...row, sources: JSON.stringify([{ id: "b", quality: 720, url: "", status: "pending" }]) });
  assert.equal(buildConfig(pending).pending_publish, true);
});

test("cleanSource refuses a non-https url", () => {
  assert.throws(() => cleanSource({ url: "http://insecure/x.mp4" }), /source_url_not_https/);
});

test("SAS URL is a blob-scoped service SAS whose signature covers its params", async () => {
  const env = {
    AZURE_ACCOUNT: "acct",
    AZURE_CONTAINER: "movies",
    // A real account key is base64; any 32-byte value exercises the HMAC.
    AZURE_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  const url = await blobSas(env, { blob: "v1/abc/a b.mp4", permissions: "cw", minutes: 60 });
  const parsed = new URL(url);

  assert.equal(parsed.host, "acct.blob.core.windows.net");
  assert.equal(parsed.pathname, "/movies/v1/abc/a%20b.mp4");
  assert.equal(parsed.searchParams.get("sv"), "2022-11-02");
  assert.equal(parsed.searchParams.get("sr"), "b");
  assert.equal(parsed.searchParams.get("sp"), "cw");
  assert.equal(parsed.searchParams.get("spr"), "https");
  assert.equal((parsed.searchParams.get("sig") || "").length, 44);

  // Rebuild the documented string-to-sign from the URL itself and verify it.
  const fields = [
    "cw",
    parsed.searchParams.get("st"),
    parsed.searchParams.get("se"),
    "/blob/acct/movies/v1/abc/a b.mp4",
    "", "", "https", "2022-11-02", "b", "", "", "", "", "", "", "",
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw", Buffer.from(env.AZURE_KEY, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(fields))).toString("base64");
  assert.equal(parsed.searchParams.get("sig"), expected);
});

test("publicBlobUrl encodes each segment but keeps the folders", () => {
  const url = publicBlobUrl({ AZURE_ACCOUNT: "acct", AZURE_CONTAINER: "movies" }, "v1/a b/c+d.mp4");
  assert.equal(url, "https://acct.blob.core.windows.net/movies/v1/a%20b/c%2Bd.mp4");
});
