# Fast Player — Cloudflare edition

The site with no PC in the loop: Cloudflare Pages serves the pages, Pages
Functions serve the API, D1 stores the catalogue, comments and view counts, and
Azure Blob stores the films.

**Live:** <https://next.hafizr283.me>

The site runs entirely on Cloudflare and Azure: there is no local server, no
tunnel, and no PC in the request path. `https://next.hafizr283.me` is the live
host; [step 8](docs/SETUP.md#8-custom-domain-and-cutover) covers moving another
hostname onto Pages.

## Quick start

Read [`docs/SETUP.md`](docs/SETUP.md). It is the ordered checklist: D1, secrets,
Azure CORS, deploy, migrate, optional transcoder, custom domain.

## What runs where

| Piece | Runs on | Notes |
| --- | --- | --- |
| Pages, player, admin | Cloudflare Pages | static files in `public/` |
| `/api/*`, `/movie/:id`, `/category/:id`, `/poster/:id.svg` | Pages Functions | `functions/` |
| Titles, comments, views, queue | D1 | `schema.sql` |
| Video, posters, incoming originals | Azure Blob | browser uploads with a 4-hour, single-blob SAS |
| MKV/HEVC → MP4 | GitHub Actions (optional) | `.github/workflows/transcode.yml` |

## Layout

```
functions/
  _lib/            http, auth, Azure SAS, title/config mapping
  api/             library, category, view, comments
  api/admin/       state, titles, upload-url, transcode, comment
  movie/[id].js    watch page (injects the player config)
  category/[id].js category page
  poster/[id].js   generated poster for a title with no frame
public/            static site + admin + comments
migration/         one-time library.json -> seed.sql
tests/             unit + in-memory D1 integration tests
```

## Rules the code enforces

- **Admin:** `Authorization: Bearer <token>` only, never a query string. No
  `ADMIN_TOKENS` configured means every admin route is 404. Eight wrong tokens
  from one address lock it for 15 minutes.
- **Delete a title:** deletes the row **and its blobs**. Every failed delete is
  reported; nothing is silently claimed.
- **Publish:** refused when no source is playable, so a dead card never reaches
  the home page.
- **Views:** five seconds of playback, one per browser per 6 h, one per address
  per title per 30 min, bots ignored, admin previews skipped.
- **Comments:** one reply level, 1,000 chars, two links, 15 s between posts,
  20/hour, honeypot. Hidden, not destroyed.
- **Uploads:** the browser talks to Azure directly; Functions never carry video
  bytes. 8 MB blocks, three in flight, retry per block, and a reload resumes
  from the last accepted block. A file the browser can play publishes as-is;
  anything else waits for the transcoder.
- **Seeking:** every watch-page source URL carries a read-only SAS for the day.
  Azure only sends `Accept-Ranges: bytes` for a modern API version and a browser
  never sends one; the SAS supplies it, which is what makes the progress bar
  seekable. It is not access control - the container is public-read.

## Local checks

```powershell
node --test tests/lib.test.mjs tests/api.test.mjs
```

The second file runs the real handlers against `schema.sql` in an in-memory
SQLite database (Node's built-in `node:sqlite`).

## Local development

```powershell
copy .dev.vars.example .dev.vars
npx --yes wrangler@latest d1 execute fast-player --local --file=schema.sql
npx --yes wrangler@latest pages dev public
```

`.dev.vars` is ignored by git. The dev server serves `public/` and runs the same
Functions.
