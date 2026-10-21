/**
 * Integration tests for the Pages Functions against an in-memory SQLite database
 * using the real schema.sql. This is not the Workers runtime, but it exercises
 * every SQL statement and every handler contract the site depends on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as library from "../functions/api/library.js";
import * as movie from "../functions/movie/[id].js";
import * as categoryApi from "../functions/api/category/[id].js";
import * as categoryPage from "../functions/category/[id].js";
import * as view from "../functions/api/view.js";
import * as comments from "../functions/api/comments.js";
import * as poster from "../functions/poster/[id].js";
import * as state from "../functions/api/admin/state.js";
import * as createTitle from "../functions/api/admin/titles.js";
import * as editTitle from "../functions/api/admin/titles/[id].js";
import * as uploadUrl from "../functions/api/admin/upload-url.js";
import * as transcode from "../functions/api/admin/transcode.js";
import * as commentAdmin from "../functions/api/admin/comment.js";

// ---------------------------------------------------------------------------
// A D1-shaped façade over node:sqlite
// ---------------------------------------------------------------------------
class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(info.changes) } };
  }
}

class D1 {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
  exec(sql) { this.db.exec(sql); }
  close() { this.db.close(); }
}

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

const env = {
  DB: null,
  ADMIN_TOKENS: "token-a,token-b",
  IP_SALT: "test-salt",
  AZURE_ACCOUNT: "acct",
  AZURE_CONTAINER: "movies",
  AZURE_KEY: Buffer.alloc(32, 9).toString("base64"),
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(readFileSync(new URL(`../public${path}`, import.meta.url)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
};

const db = new D1(":memory:");
db.exec(schema);
env.DB = db;

const now = Date.now();
db.exec(`
  INSERT INTO categories (id, name, sort) VALUES ('featured', 'Featured', 1), ('animation', 'Animation', 2);
  INSERT INTO titles (id, name, description, year, poster_url, duration, size, status, views, categories, tags, sources, created_at, updated_at)
  VALUES
    ('hello', 'Hello', 'A test film.', 2026, '', 30, 1000, 'published', 2, '["animation"]', '["test"]',
     '[{"id":"s1","quality":720,"type":"mp4","url":"https://acct.blob.core.windows.net/movies/v1/a/hello.mp4","blob":"v1/a/hello.mp4","name":"hello.mp4","size":1000,"best":false,"audio":"Default","codec":"h264","status":"ready"}]',
     ${now}, ${now}),
    ('draft-one', 'Draft One', '', NULL, '', NULL, NULL, 'draft', 0, '[]', '[]', '[]', ${now - 1000}, ${now - 1000});
`);

const req = (url, options = {}) => new Request(`https://site.test${url}`, options);
const admin = (url, options = {}) => req(url, {
  ...options,
  headers: { authorization: "Bearer token-a", ...(options.headers || {}) },
});

test("GET /api/library returns published titles only, with rows", async () => {
  const res = await library.onRequestGet({ env });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.count, 1);
  assert.equal(data.titles[0].id, "hello");
  assert.deepEqual(data.titles[0].qualities, [720]);
  assert.equal(data.rows[0].id, "animation");
  assert.equal(data.categories.length, 1);
  assert.match(res.headers.get("cache-control"), /max-age=30/);
});

test("GET /api/category/:id returns cards for a real category", async () => {
  const res = await categoryApi.onRequestGet({ env, params: { id: "animation" } });
  const data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.titles[0].url, "/movie/hello");

  const missing = await categoryApi.onRequestGet({ env, params: { id: "nope" } });
  assert.equal(missing.status, 404);
});

test("GET /category/:id renders the shell with its meta", async () => {
  const res = await categoryPage.onRequestGet({
    env,
    request: req("/category/animation"),
    params: { id: "animation" },
  });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /id="fpCategoryMeta"/);
  assert.match(html, /Animation/);
  assert.doesNotMatch(html, /FP_CATEGORY_META/);

  const missing = await categoryPage.onRequestGet({
    env,
    request: req("/category/nope"),
    params: { id: "nope" },
  });
  assert.equal(missing.status, 404);
});

test("GET /movie/:id injects a decodable player config", async () => {
  const res = await movie.onRequestGet({ env, request: req("/movie/hello"), params: { id: "hello" } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /id="fpInlinePlayerData"/);
  assert.doesNotMatch(html, /devtools\.js/);
  assert.doesNotMatch(html, /FP_DEV_PANEL_START/);

  const match = html.match(/data-s="([0-9a-f]+)" data-r="(\d+)">([^<]+)</);
  assert.ok(match, "config script is present");
  const [, seed, rounds, payload] = match;

  let r = parseInt(seed, 16) >>> 0;
  for (let i = 0; i < Number(rounds); i++) r = (Math.imul(r, 1103515245) + 12345) >>> 0;
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  for (let i = 0; i < bytes.length; i++) {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    bytes[i] ^= (r >>> 16) & 0xff;
  }
  const config = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(config.title_id, "hello");
  assert.equal(config.episodes[0].sources.length, 1);
  const source = config.episodes[0].sources[0];
  // The watch page replaces the public URL with a daily read SAS; the SAS is
  // what makes Azure answer with Accept-Ranges, which is what seeking needs.
  const signed = new URL(source.url);
  assert.equal(`${signed.origin}${signed.pathname}`, "https://acct.blob.core.windows.net/movies/v1/a/hello.mp4");
  assert.equal(signed.searchParams.get("sv"), "2022-11-02");
  assert.equal(signed.searchParams.get("sp"), "r");
  assert.equal(signed.searchParams.get("sr"), "b");
  assert.ok(signed.searchParams.get("sig"), "the source URL carries a signature");
  assert.equal(source.download_url, source.url);

  const draft = await movie.onRequestGet({ env, request: req("/movie/draft-one"), params: { id: "draft-one" } });
  assert.equal(draft.status, 404);
});

test("GET /poster/:id.svg renders generated art", async () => {
  const res = await poster.onRequestGet({ env, params: { id: "hello.svg" } });
  const svg = await res.text();
  assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(svg, /Hello/);
});

test("POST /api/view counts once per address per window, and ignores bots", async () => {
  const first = await view.onRequestPost({
    env,
    request: req("/api/view", {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0", "cf-connecting-ip": "10.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ id: "hello" }),
    }),
  });
  const firstData = await first.json();
  assert.equal(firstData.counted, true);
  assert.equal(firstData.views, 3);

  const again = await view.onRequestPost({
    env,
    request: req("/api/view", {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0", "cf-connecting-ip": "10.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    }),
  });
  assert.equal((await again.json()).counted, false);

  const bot = await view.onRequestPost({
    env,
    request: req("/api/view", {
      method: "POST",
      headers: { "user-agent": "Googlebot", "cf-connecting-ip": "10.0.0.2", "content-type": "application/json" },
      body: JSON.stringify({ id: "hello" }),
    }),
  });
  assert.equal((await bot.json()).counted, false);

  const unknown = await view.onRequestPost({
    env,
    request: req("/api/view", {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0", "cf-connecting-ip": "10.0.0.3", "content-type": "application/json" },
      body: JSON.stringify({ id: "draft-one" }),
    }),
  });
  assert.equal(unknown.status, 404);
});

test("comments post, list, reply and rate-limit", async () => {
  const posted = await comments.onRequestPost({
    env,
    request: req("/api/comments", {
      method: "POST",
      headers: { "cf-connecting-ip": "10.1.0.1", "content-type": "application/json" },
      body: JSON.stringify({ title: "hello", name: "Ada", text: "First!" }),
    }),
  });
  assert.equal(posted.status, 201);
  const created = (await posted.json()).comment;

  const reply = await comments.onRequestPost({
    env,
    request: req("/api/comments", {
      method: "POST",
      headers: { "cf-connecting-ip": "10.1.0.2", "content-type": "application/json" },
      body: JSON.stringify({ title: "hello", parent: created.id, text: "A reply" }),
    }),
  });
  assert.equal(reply.status, 201);
  assert.equal((await reply.json()).comment.parent_id, created.id);

  const listed = await comments.onRequestGet({ env, request: req("/api/comments?title=hello") });
  const data = await listed.json();
  assert.equal(data.comments.length, 1);
  assert.equal(data.comments[0].replies.length, 1);
  assert.equal(data.comments[0].name, "Ada");

  const tooSoon = await comments.onRequestPost({
    env,
    request: req("/api/comments", {
      method: "POST",
      headers: { "cf-connecting-ip": "10.1.0.1", "content-type": "application/json" },
      body: JSON.stringify({ title: "hello", text: "again" }),
    }),
  });
  assert.equal(tooSoon.status, 429);

  const trap = await comments.onRequestPost({
    env,
    request: req("/api/comments", {
      method: "POST",
      headers: { "cf-connecting-ip": "10.1.0.3", "content-type": "application/json" },
      body: JSON.stringify({ title: "hello", text: "spam", website: "http://spam.example" }),
    }),
  });
  assert.equal(trap.status, 200);
  assert.equal((await trap.json()).ignored, true);

  const hidden = await commentAdmin.onRequestDelete({
    env,
    request: admin(`/api/admin/comment?id=${created.id}`),
  });
  assert.equal(hidden.status, 200);

  const after = await comments.onRequestGet({ env, request: req("/api/comments?title=hello") });
  assert.equal((await after.json()).comments.length, 0);
});

test("admin state requires a bearer token; unset token config is a 404", async () => {
  assert.equal((await state.onRequestGet({ env, request: req("/api/admin/state") })).status, 401);
  assert.equal((await state.onRequestGet({
    env,
    request: req("/api/admin/state", { headers: { authorization: "Bearer wrong" } }),
  })).status, 401);

  const ok = await state.onRequestGet({ env, request: admin("/api/admin/state") });
  const data = await ok.json();
  assert.equal(data.titles.length, 2);
  assert.equal(data.totals.published, 1);

  const unset = await state.onRequestGet({
    env: { ...env, ADMIN_TOKENS: "" },
    request: admin("/api/admin/state"),
  });
  assert.equal(unset.status, 404);
});

test("admin create, publish guard, edit and source validation", async () => {
  const created = await createTitle.onRequestPost({
    env,
    request: admin("/api/admin/titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A New Film",
        description: "desc",
        categories: ["featured", "unknown"],
        sources: [{ id: "new-1", quality: 1080, name: "new.mp4", blob: "incoming/x/new.mp4", status: "pending" }],
      }),
    }),
  });
  assert.equal(created.status, 201);
  const title = (await created.json()).title;
  assert.match(title.id, /^a-new-film-[0-9a-f]{6}$/);
  assert.deepEqual(title.categories, ["featured"]);

  const refused = await editTitle.onRequestPatch({
    env,
    request: admin(`/api/admin/titles/${title.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    }),
    params: { id: title.id },
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "no_playable_source");

  const patched = await editTitle.onRequestPatch({
    env,
    request: admin(`/api/admin/titles/${title.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "published",
        sources: [{ id: "new-1", quality: 1080, url: "https://acct.blob.core.windows.net/movies/v1/b/new.mp4", name: "new.mp4", status: "ready" }],
      }),
    }),
    params: { id: title.id },
  });
  assert.equal(patched.status, 200);

  const bad = await createTitle.onRequestPost({
    env,
    request: admin("/api/admin/titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad", sources: [{ url: "http://plain.test/x.mp4" }] }),
    }),
  });
  assert.equal(bad.status, 400);
});

test("upload-url signs a blob under the right prefix", async () => {
  const res = await uploadUrl.onRequestPost({
    env,
    request: admin("/api/admin/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "video", filename: "My Film.mkv", size: 1234, stage: "incoming" }),
    }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.match(data.blob, /^incoming\/[0-9a-f]{12}\/My-Film\.mkv$/);
  const url = new URL(data.uploadUrl);
  assert.equal(url.searchParams.get("sp"), "cw");
  assert.equal(url.searchParams.get("sr"), "b");
  assert.ok(url.searchParams.get("sig"));

  const posterSlot = await uploadUrl.onRequestPost({
    env,
    request: admin("/api/admin/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "poster", filename: "poster.jpg", size: 10 }),
    }),
  });
  assert.match((await posterSlot.json()).blob, /^posters\/[0-9a-f]{12}\.jpg$/);

  // A resumable attempt must land on the same blob path.
  const resumed = await uploadUrl.onRequestPost({
    env,
    request: admin("/api/admin/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "video", filename: "My Film.mkv", size: 1234,
        stage: "incoming", resume_key: "abcdef1234567890",
      }),
    }),
  });
  assert.equal((await resumed.json()).blob, "incoming/abcdef1234567890/My-Film.mkv");
});

test("transcode queue claims a job, then attaches the finished MP4", async () => {
  // A queued source must point at incoming/.
  const created = await createTitle.onRequestPost({
    env,
    request: admin("/api/admin/titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Queued Film",
        sources: [{ id: "q1", quality: 720, name: "queued.mkv", blob: "incoming/abc/queued.mkv", status: "pending" }],
      }),
    }),
  });
  const title = (await created.json()).title;

  const enqueued = await transcode.onRequestPost({
    env,
    request: admin("/api/admin/transcode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title_id: title.id, source_id: "q1" }),
    }),
  });
  assert.equal(enqueued.status, 202);

  const claimed = await transcode.onRequestGet({ env, request: admin("/api/admin/transcode?next=1") });
  const job = await claimed.json();
  assert.equal(job.ok, true);
  assert.equal(job.job.title_id, title.id);
  assert.match(job.outputBlob, /^v1\/[0-9a-f]{12}\/queued\.mp4$/);
  assert.match(job.inputUrl, /incoming\/abc\/queued\.mkv/);
  assert.match(job.outputUrl, /comp|sig=/);

  // The completion path deletes the incoming blob; stub that one request.
  const realFetch = globalThis.fetch;
  const deleted = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("incoming/abc/queued.mkv") && init?.method === "DELETE") {
      deleted.push(String(url));
      return new Response(null, { status: 202 });
    }
    return realFetch(url, init);
  };
  try {
    const done = await transcode.onRequestPatch({
      env,
      request: admin("/api/admin/transcode", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: job.job.id, status: "done", duration: 42, size: 999 }),
      }),
    });
    const result = await done.json();
    assert.equal(result.status, "done");
    assert.equal(result.incoming_deleted, true);
    assert.equal(deleted.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  const row = db.db.prepare("SELECT sources FROM titles WHERE id = ?").get(title.id);
  const sources = JSON.parse(row.sources);
  assert.equal(sources[0].status, "ready");
  assert.match(sources[0].url, /^https:\/\/acct\.blob\.core\.windows\.net\/movies\/v1\//);
  assert.equal(sources[0].duration, 42);
});
