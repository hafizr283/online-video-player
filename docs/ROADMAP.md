# Roadmap

Written after the Blob-storage work went in. Each item says what it buys and
what it costs, so the next one can be picked without re-deriving the reasoning.

## Waiting on one credential

**Publish the three films and measure it.** The code path is complete and tested
against a mock container (`test-azure.mjs`, 31 checks), and playback from a real
public blob has been verified in a browser. What has *not* run yet is a real
upload, because writing needs a **container** SAS (`sr=c`, Read/Add/Create/
Write). A blob SAS (`sr=b`) is refused on purpose.

Two ways in, and the second needs no key at all:

1. Generate a container SAS and put it in `<storage>/.azure.env`. Then **Send
   film to Azure** from the admin publishes a film's master and rendition in one
   job.
2. Upload the files through the Azure portal and let the server adopt them:
   `PATCH /api/admin/azure?file=<local>&blob=v1/...` verifies the blob with a
   public `HEAD` and points the title at it (see HOSTING.md).

Once every title reports `0` local files, `AZURE_ONLY=1` makes "streaming from
this PC" impossible rather than merely unlikely.

When it runs, record: upload seconds and MB/s from this PC's uplink, first-byte
time from the player local vs. remote, and whether Chrome ever needs the CORS
rule (it does not today, because the player drops `crossorigin` for remote
sources).

## Next

1. **Ask only for what is on screen.** The catalogue hands the browser every
   title; at a few hundred films that is fine, at a few thousand the first paint
   pays for rows nobody scrolls to. Paginate per row (`?limit=&cursor=`) and let
   the browser ask for the rest.
2. **Search and filter.** A `/`-to-focus box filtering on title, year and
   category, entirely client-side while the catalogue fits in memory. Cheap, and
   it is the first thing a visitor looks for once rows stop fitting on a screen.
3. **Server-side resume.** Progress lives in `localStorage`, so a film started on
   a phone starts from zero on a TV. A `PUT /api/progress/<id>` keyed by a
   random per-browser id would fix it with one small endpoint.
4. **Resumable uploads.** A single `PUT` is capped at 5 GiB and has no retry from
   a browser; block uploads (`Put Block` + `Put Block List`) would let a 30 GB
   remux survive a dropped connection.
5. **Adaptive bitrate.** The "Auto" switch steps down to the 480p rendition after
   stalls. Two renditions as separate files is not ABR; an HLS playlist per film
   would be, at the cost of segmenting every film once.
6. **Player start time.** Measure `navigationStart → first frame` on a cold cache
   before touching anything else; the poster preload and the media preconnect are
   guesses until that number exists.

## Later

- Per-title download links with an expiry, so a file can be shared without the
  player.
- A second storage root, so a film can be archived to a slow disk and still be
  listed.
- A cost line for Blob storage in the maintenance report (egress is free within
  Azure, but storage is not).
- Subtitle search across the library, not just per film.

## Deliberately not doing

- Auto-deleting unreferenced files. Deleting a title keeps its bytes, and the
  admin reports them; a cleanup job that guesses would eventually delete the
  wrong film.
- A database. `library.json` is one file the admin rewrites atomically, it is
  human-readable in a backup, and the whole catalogue is smaller than the
  smallest film.
- A build step or npm dependencies. The server is a file you can read.
