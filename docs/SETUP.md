# Fast Player on Cloudflare — setup

This folder is the PC-free version of the site: Cloudflare Pages serves the
pages and the API, D1 holds titles/comments/views, and Azure Blob holds the
video bytes. Nothing here needs this PC to stay on.

```
viewer ──► Cloudflare Pages (static + Functions) ──► D1 (titles, comments, views)
   │                    │
   │                    └── signs a single-blob SAS (4 h for video, 1 h for posters)
   └──────────► Azure Blob (movies, public-read) ◄── browser upload (block PUT)
                                   ▲
                                   │ MP4
                        GitHub Actions (only for MKV/HEVC)
```

There is no local server or tunnel to keep alive: Pages, Functions, D1 and Blob
are the whole deployment. The previous PC-side setup was retired on 2026-10-21.

---

## 0. What you need before starting

| Thing | Where | Why |
| --- | --- | --- |
| Cloudflare account | dash.cloudflare.com | Pages, Functions, D1 |
| Storage **account key** | Azure portal → storage account → Access keys → key1 | the Function signs SAS URLs with it |
| Existing container SAS | `H:\fast-player-storage\.azure.env` | one-time poster upload during migration |
| GitHub account | github.com | the optional transcoder |

Keep `npm`'s cache off `C:` — wrangler is a few hundred MB:

```powershell
$env:npm_config_cache = "H:\npm-cache"
```

Use Node 20 or newer (`node -v`).

---

## 0.1 Which hostname goes where

`https://next.hafizr283.me/` is the live site. One DNS record can only have one
target, so a new hostname cannot point at Pages while an old record still points
elsewhere. Plan the switch; [step 8](#8-custom-domain-and-cutover) lists it.

| Name | Points at | Purpose |
| --- | --- | --- |
| `https://next.hafizr283.me/` | Pages | the live site |
| `https://<project>.pages.dev` | Pages | Wrangler prints it; it depends on the project name |

The Azure CORS row below must list **every** origin that will upload — the
`next` host, the `pages.dev` host, and `movies` after the switch. Azure compares
the `Origin` header exactly: scheme included, no trailing slash.

---

## 1. Create the D1 database

```powershell
cd E:\job_project\fast-player
npx --yes wrangler@latest login
npx --yes wrangler@latest d1 create fast-player
```

Copy the printed `database_id` into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_ID`, then create the tables:

```powershell
npx --yes wrangler@latest d1 execute fast-player --remote --file=schema.sql
```

Expected: `Executed 20 queries` (or similar). If it says the file cannot be
found, you are not in `E:\job_project\fast-player`. Re-running `schema.sql` is
safe; it adds the settings and public-upload tables with `IF NOT EXISTS`.

---

## 2. Create the Pages project

```powershell
npx --yes wrangler@latest pages project create fast-player --production-branch main
```

## 3. Set the secrets

Generate a fresh admin token and salt. Do not reuse the old token.

```powershell
$admin = -join (1..64 | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
$salt  = -join (1..64 | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
"ADMIN TOKEN (save this now): $admin"
"SALT (save this too):        $salt"
```

Then set each secret (each command prompts, paste the value):

```powershell
npx --yes wrangler@latest pages secret put ADMIN_TOKENS --project-name fast-player
npx --yes wrangler@latest pages secret put IP_SALT      --project-name fast-player
npx --yes wrangler@latest pages secret put AZURE_KEY    --project-name fast-player
```

`AZURE_KEY` is the **base64 account key**, not the SAS. `ADMIN_TOKENS` may hold
several comma-separated tokens (`tokenA,tokenB`) so an old one can be retired
without locking yourself out.

> If `ADMIN_TOKENS` is unset, every `/api/admin/*` route returns 404. That is
> deliberate: a half-configured deployment must not advertise an admin door.

---

## 4. Allow the browser to upload to Azure

Azure portal → your storage account → **Resource sharing (CORS)** → **Blob
service** → add one row:

| Field | Value |
| --- | --- |
| Allowed origins | `https://next.hafizr283.me, https://movies.hafizr283.me, https://<project>.pages.dev` |
| Allowed methods | `GET, PUT, HEAD, OPTIONS` |
| Allowed headers | `content-type, x-ms-blob-type, x-ms-blob-content-type, x-ms-blob-cache-control, x-ms-blob-content-length, x-ms-version` |
| Exposed headers | `etag, x-ms-request-id` |
| Max age | `3600` |

The portal accepts the origins as one comma-separated line. Replace
`<project>.pages.dev` with the hostname Wrangler prints. If the Azure screen
only takes one origin per row, add one row per host.

Without this, uploads fail in the browser with a CORS error even though the SAS
is valid. Viewing is unaffected (playback is a plain `GET` on a public
container).

Verify the preflight from this PC (it currently returns 403 because no CORS rule
exists yet):

```powershell
$u = "https://hafizrmovies283.blob.core.windows.net/movies/v1/bbc3aba5e254/hello-720.mp4"
curl.exe -s -D - -o NUL -X OPTIONS $u `
  -H "Origin: https://next.hafizr283.me" `
  -H "Access-Control-Request-Method: PUT" `
  -H "Access-Control-Request-Headers: x-ms-blob-type,content-type"
```

Expected after the rule is saved: an `Access-Control-Allow-Origin` header equal
to the origin you sent. A 403 with no such header means the rule is missing or
the origin does not match exactly (scheme, host, no trailing slash).

---

## 5. Deploy

```powershell
npx --yes wrangler@latest pages deploy public --project-name fast-player
```

The deploy prints the deployment URL — usually `https://<project>.pages.dev`.
Use that exact host below. Functions in `functions/` are uploaded with the same
command.

Check the D1 binding: Pages → your project → **Settings → Functions → D1
bindings**. It should show `DB → fast-player`. If it is missing, add it there
and redeploy.

Smoke test (use the host Wrangler printed, or the `next` custom domain):

```powershell
$site = "https://next.hafizr283.me"
Invoke-WebRequest "$site/api/library" | Select-Object -Expand Content
```

Expected right now: `{"ok":true,"count":0,...}` — nothing has been migrated yet.

Open `$site/admin`, paste the token, and confirm the dashboard loads. Upload a
small MP4 with "Publish immediately" ticked, then open the home page on that
host: the title, poster and playback should all work with the PC off.

### Public uploads

Public uploads are **off by default**, so the existing admin-only flow is
unchanged. To let visitors upload:

1. Open `$site/admin` → **Upload**.
2. In **Public uploads**, choose **Save as a draft for review** or
   **Publish immediately**.
3. Press **Turn on public uploads**, then share `$site/upload`.

Visitors can upload only MP4 files that their browser can play. Each upload
gets a single-use ticket and is rate-limited per address. In **draft** mode,
review the new title in **Library** and press **Publish** when you want it to
appear; in **publish immediately** mode, it appears as soon as the upload
finishes. Turning the switch off closes both public endpoints immediately; an
admin can still upload from the admin page.

The switch and mode live in the D1 `settings` table
(`allow_public_uploads`, `public_upload_mode`). They need no new secret and no
redeploy. If you deployed an earlier schema, re-run step 1 once to create
`settings`, `upload_tickets`, and `upload_log`, and to add the default mode.

---

## 6. Migrate the current library

This is the only step that uses the PC. It copies **posters** to Azure and
writes SQL for the titles, sources and view counts; it does not move video
files, because every published source already lives in Blob.

```powershell
node migration/export.mjs `
  --library "H:/fast-player-storage/library.json" `
  --stats   "H:/fast-player-storage/stats.json" `
  --posters "H:/fast-player-storage/posters" `
  --env     "H:/fast-player-storage/.azure.env" `
  --out     "migration/seed.sql"

npx --yes wrangler@latest d1 execute fast-player --remote --file=migration/seed.sql
```

The script prints a summary. A source with no `remote.url` is skipped and
counted — the Pages site cannot serve files from this PC. Re-running replaces
the migrated title rows and the two built-in categories; titles added later in
the admin are untouched.

Then reload the home page. The four current titles should appear with their
view counts; posters appear if the container SAS was still valid.

---

## 7. Optional: the GitHub Actions transcoder

Needed only when you upload something a browser cannot play (MKV, HEVC, 10-bit
H.264). MP4/H.264 files upload and publish directly and never touch GitHub.

1. Create a **private** GitHub repository and push this folder to it.
2. Repo → **Settings → Variables → Actions → New variable**
   `FP_API = https://next.hafizr283.me` (the exact Pages host, no trailing
   slash; use `https://movies.hafizr283.me` after the cutover).
3. Repo → **Settings → Secrets → Actions → New secret**
   `FP_ADMIN_TOKEN = <one of your admin tokens>`.
4. Create a fine-grained PAT for that repository with **Contents: Read and
   write** (needed to send `repository_dispatch`). Add it to Pages:

```powershell
npx --yes wrangler@latest pages secret put GH_REPO  --project-name fast-player
npx --yes wrangler@latest pages secret put GH_TOKEN --project-name fast-player
```

5. Repo → **Actions → transcode → Run workflow** to test one job.

How it works: the browser uploads the original to
`movies/incoming/<hex>/<file>` — an unguessable path in the same public
container, not listed anywhere, so treat it as unlisted rather than secret. The
admin page queues a row in `transcode_jobs`, the workflow claims one job,
downloads with a 30-minute read SAS, remuxes (H.264/AAC → copy) or encodes
(everything else → libx264 CRF 22), uploads with a block PUT, and patches the
title. The incoming file is deleted after success.

Limits to keep in mind:

- The runner has 14 GB of disk and a 6-hour job cap; the workflow refuses an
  input over 5.8 GB.
- Private repos get 2,000 free minutes/month (Pro: 3,000). A two-hour encode
  costs 120 of them.
- GitHub's Acceptable Use Policy limits Actions to work related to the
  repository's software project. Using it as a general media transcoder is a
  policy risk; keep volume low and keep the workflow in this repo.
- If a job fails, its row says `failed` with the reason; the source stays
  `pending`, so nothing half-converted is ever offered to a viewer.

---

## 8. Custom domain and cutover

`next.hafizr283.me` is attached to Pages and working. To move another hostname
(for example `movies.hafizr283.me`) onto Pages:

1. Cloudflare **DNS → Records**: delete (or retarget) the old CNAME for that
   hostname. Do not touch `next`.
2. Pages → **Custom domains** → add `movies.hafizr283.me`. Because the zone is on
   the same account, Cloudflare creates the new CNAME to your project's
   `<project>.pages.dev` host. If it stays **pending**, add it yourself: type
   `CNAME`, name `movies`, target `<project>.pages.dev`, proxy **on**.
3. Azure → the storage account → **Resource sharing (CORS)** → add
   `https://movies.hafizr283.me` to the allowed origins (scheme included, no
   trailing slash). Keep `https://next.hafizr283.me` and the `pages.dev` host.
4. Wait for the certificate, then check `https://movies.hafizr283.me/api/library`
   returns JSON and a film plays.
5. Keep `next.` as a staging host, or remove it later.

Rollback for a DNS change is simply pointing the hostname back at the old
target; no code or data lives on a PC.

---

## 9. Day-to-day

**Add a film (MP4/H.264):** Admin → Upload → choose file → the browser reads the
duration and captures a poster at 10% → set quality → Upload. It publishes
immediately unless you untick the box. The file goes up in 8 MB blocks with
three in flight; if the tab is reloaded, choosing the same file again resumes
from the last accepted block.

**Add another quality to an existing film:** the same tab, but pick the title in
**Add to** first. The new file joins that title's source list and appears in the
player's quality menu; the film's poster is kept.

**Add a film (MKV/HEVC):** the same flow, but the page says the file does not
play in a browser. It uploads to `incoming/`, joins the queue, and stays a
draft. When the Transcoder tab shows `done`, open Library → Publish.

**Delete a title:** Library → Delete. This deletes the catalogue row **and its
blobs** — deliberate, because a browser-only admin has no way to clean up
orphans later. Any blob that could not be deleted is listed; nothing is silently
claimed.

**Views:** one per browser per 6 hours (client) and one per address per title per
30 minutes (server), bots ignored, admin previews skipped. Stored on
`titles.views` with a 24-hour dedupe log.

**Comments:** one level of replies, 1,000 characters, at most two links, 15
seconds between posts, 20 per hour, honeypot field. Admin → Comments → Hide
soft-deletes (the row stays for the record).

---

## 10. Costs

| Service | Free allowance | What this site uses |
| --- | --- | --- |
| Pages | unlimited requests, 500 builds/month | direct uploads, no builds |
| Functions | 100k requests/day | a handful per page view |
| D1 | 5 GB, 5M row reads/day, 100k row writes/day | tiny |
| Azure Blob | 5 GB hot for 12 months, 100 GB egress/month | video egress is the real cost |

After the free egress, Azure charges roughly $0.087/GB. A 1 GB film watched 100
times is ~100 GB. Cloudflare's own R2 has zero egress and is the natural next
step if that becomes the dominant bill; the code keeps all blob URLs in one
column, so switching is a migration, not a rewrite.

---

## 11. Verification status

**Checked against the live deployment (2026-10-20):**

- D1 database `fast-player` created in APAC (`0a009dc7-73c4-4759-8bc9-e00781472944`);
  `schema.sql` executed remotely: 13 queries, 7 tables, 0.08 MB;
- the Pages project is deployed; production host
  `https://next.hafizr283.me` serves the home page (200) and
  `/api/library` returns `{"ok":true,"count":0,...}` with the D1 binding active;
- `/api/admin/state` returns 401 without a token and 200 with the generated
  token, so `ADMIN_TOKENS` reached the Function;
- `AZURE_KEY` is correct: `/api/admin/upload-url` produced a `sv=2022-11-02`
  single-blob `sp=cw` SAS, Azure accepted a test `PUT` (201), and the test blob
  was deleted with the container SAS (202);
- the migration ran with posters: 4 titles, 5 sources, 2 views, 4 posters
  uploaded and each poster returns `200 image/jpeg`; `migration/seed.sql`
  applied to real D1 (7 statements), and `/api/library` now returns
  `count: 4` with both categories;
- `/movie/check` returns 200 with the obfuscated player payload, `/category/featured`
  200, `/poster/check.svg` 200, `/movie/nope` 404;
- playback works with no server in the request path: a real browser on
  `https://next.hafizr283.me/movie/check` played `check-720.mp4` from Blob
  (1280x720, duration 120.2 s, readyState 4, 120 s buffered) and a `Range`
  request returned 206;
- Azure CORS preflight from `https://next.hafizr283.me` returns 200 with
  `Access-Control-Allow-Origin`, confirmed in the portal.

**Checked on this PC (2026-10-20):**

- all JavaScript files pass `node --check`;
- `tests/lib.test.mjs` (7 tests): config obfuscation round-trips through the
  player's decoder, only ready sources are offered, cards sort qualities,
  `cleanSource` rejects plain HTTP, the SAS URL carries the documented
  parameters and its signature verifies over the documented string-to-sign,
  blob URLs encode each path segment;
- `tests/api.test.mjs` (11 tests): every handler runs against the real
  `schema.sql` in an in-memory SQLite database — library rows and caching,
  category API and page, watch-page config injection and dev-panel removal,
  generated posters, view dedupe and bot filtering, comment post/reply/rate
  limit/honeypot/moderation, admin auth (401, 429, 404-when-unset), create and
  publish guard, upload SAS paths, and the full transcode claim → attach →
  incoming-delete cycle;
- the migration script produced SQL from the real `library.json`/`stats.json`:
  4 titles, 5 sources, 2 views, 0 skipped.

**Not verified - needs your accounts:**

- actual playback on a phone with this PC and the tunnel switched off;
- the GitHub Actions workflow end to end.

## Post-launch fixes (2026-10-21)

Four reports came back after the first deploy: high buffering, the admin could
not upload, no way to choose a thumbnail, and seeking with the progress bar did
nothing. Each had a separate cause.

### Seeking: Azure only sends `Accept-Ranges` for a modern request version

A plain `GET` to Blob storage is answered as `x-ms-version: 2009-09-19` and has
**no** `Accept-Ranges` header, even though range requests really do return 206.
Chrome then reports `video.seekable` as `[0, 0]` and refuses to seek. A request
that carries a SAS (`sv=2022-11-02`) is answered with `Accept-Ranges: bytes`.

The watch page now replaces every source URL with a read-only, single-blob SAS
before inlining the config (`signSources` in `functions/movie/[id].js`, using
`blobSas` with an explicit `startMs`/`expiryMs`). The expiry is rounded to the
UTC day, so all viewers on the same day get the same URL and the browser can
cache the bytes. This is not access control - the container is public-read - it
exists only to make the service use a modern API version. If signing fails the
plain URL is kept, so playback still works (seeking may not).

`buildConfig` now carries `blob` through to the config so the watch page knows
which file to sign; the player ignores the extra field.

### Admin upload: the probe could never finish

`probeVideo` waited for `video.requestVideoFrameCallback` to grab a poster
frame. In current Chromium that callback never fires for an off-DOM, paused
video, so `probeVideo` never resolved: the note stayed on "Reading the file..."
and the Upload button stayed disabled forever. The frame callback now races a
300 ms timer.

### Thumbnail: you can choose your own image

The upload form has a **Poster image** file input. The chosen image is drawn to
a canvas, capped at 1000 px on the long side, re-encoded as JPEG (quality 0.86)
and uploaded to the same `posters/` prefix. It wins over the captured frame and
also replaces the poster when adding a quality to an existing title. The frame
grab is still the default when no image is chosen.

### Buffering: one 8.8 Mbps file and a 720p default

`check-720.mp4` was 126 MB for 120 s (8.8 Mbps) and had its `moov` atom at the
end. It was re-encoded to 13.6 MB (about 0.9 Mbps, CRF 23, `+faststart`) and
uploaded as `v1/69b7ea26b2ca/check-720-lite.mp4`; the title's 720p source now
points at it. The old blob is no longer referenced and was left in place as a
backup.

`hello-720.mp4` was 14.2 MB for 10 s (10.9 Mbps, 1080p); it was re-encoded to
2.0 MB and uploaded as `v1/0fa9305aadb9/hello-lite.mp4`. `this-is-dangerous` is
about 0.8 Mbps and `srabon-sumiya-wedding-01` about 3.7 Mbps, so both were left
alone. The replaced originals also remain in the container as backups.

The player also picks 480p (or 360p on 2G) instead of 720p when the browser
reports `saveData` or a `3g`/`2g` connection.

### Static asset caching

Pages served `admin.js` and `style/*` with `max-age=14400`, so a browser that
had loaded the page kept running the broken upload code for hours. `_headers`
now sets `Cache-Control: no-cache` for `/admin.js` and `/style/*`, and
`no-store` for `/admin` and `/admin.html`. The script URLs also carry `?v=2`,
which busts the copy that was already cached.

**Verified after the fixes (2026-10-21):**

- `/movie/check` config carries a `sv=2022-11-02&sp=r` SAS for both sources;
  in a real browser `seekable` is `[0, 120.2]`, a seek to 40 s fires `seeked`
  in 150 ms and playback continues at readyState 4;
- the non-faststart `hello-720.mp4` also reports its full seekable range and
  seeks correctly, so existing files do not need remuxing;
- the admin UI uploaded a real 536 KB MP4 with a chosen 800x1200 JPEG poster:
  the probe finished in about a second (previously it never finished), the
  button enabled, the title published, the stored poster was the resized
  667x1000 image (`200 image/jpeg`), and deleting the title removed both the
  video and the poster blob (`404` afterwards);
- the full test suite passes (18 tests), including the updated watch-page test
  that asserts the signed source URL.

**Still to check:** phone playback on mobile data (the PC-side browser is not a
substitute), and the GitHub Actions transcoder.
