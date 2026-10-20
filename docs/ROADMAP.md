# Roadmap

Written after the Blob-storage work went in. Each item says what it buys and
what it costs, so the next one can be picked without re-deriving the reasoning.

## Publishing the library (in progress)

The credential arrived on 2026-10-20 (container SAS, `sr=c`, expires 2027-07-01)
and real uploads now work. Recorded as it happened:

| film | files | bytes | time | result |
|---|---|---|---|---|
| This is dangerous | 1 | 25.0 MB | 26 s | public `HEAD` 200, 26,208,060 bytes |
| Check | 2 | 130.3 MB | 152 s | master and 480p on separate blobs |
| This means war | 2 | 3.5 GiB | ~100 min | running, capped |

Effective uplink: **0.86–0.96 MB/s**.

**The lesson worth keeping:** at full speed the upload saturated the line and the
public site timed out (blob `HEAD` 4.5–15.6 s, tunnel dead). A migration can take
the service down by itself. Uploads are now capped (`AZURE_UPLOAD_BPS`, 600000),
and with the cap the same upload left tunnel responses at 0.45–0.76 s. Any future
bulk transfer against this line needs the same treatment.

**Next step after the last film lands:** check that every title reports `0` local
files, then `AZURE_ONLY=1`, restart, and confirm no player config contains a
`/p/` URL and that a real browser session plays from `blob.core.windows.net`.

Then the obvious follow-up: **resumable block uploads**. The 3.5 GiB film lost
9% of its progress to one cancel, because a single PUT starts over. `Put Block` +
`Put Block List` would make an interrupted publish resume instead of restart,
which matters at this uplink speed.

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
