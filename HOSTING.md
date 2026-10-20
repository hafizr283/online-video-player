# Going live from this PC

This is the free, no-account path: the library keeps running on your Windows PC,
and a **Cloudflare Quick Tunnel** gives it a public `https://…trycloudflare.com`
address. The catch is that the address is new on every start; "A permanent
address on your own domain" below fixes that with a free Cloudflare account.

```
visitor ──https──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ server.mjs (this PC)
                                                          └── storage\ (videos)
```

Nothing is uploaded to a hosting company. The videos stay in `storage\`, the
admin stays on your machine, and the bill stays at zero.

| What | Address | Who can reach it |
|---|---|---|
| Public site | `https://<random>.trycloudflare.com` | anyone with the link |
| Admin | `http://127.0.0.1:8890/admin` | **only this PC** |
| Files | `storage\` on this disk | through the gate only |

---

## What is already done for you

- Single-port mode: the three mirrors are mounted at `/cdn/cdn-a`, `/cdn/cdn-b`,
  `/cdn/cdn-c` instead of ports 8891–8893, so one tunnel serves everything.
- The public URL is detected per request from the tunnel's forwarded headers, so
  a new tunnel URL needs no config change.
- Admin is local-only (`ADMIN_LOCAL_ONLY=1`) and still needs the token.
- The built-in demo titles are hidden (`HIDE_SEEDS=1`) unless you pass
  `-KeepSeeds`.
- The developer panel and its `/api/dev/*` hooks are not shipped in public pages
  (`DEV_PANEL` off). Those hooks can expire every viewer's media token or break a
  mirror, so a published instance answers 404 for all of them.
- The gate and health signing secrets are regenerated on every start instead of
  using the demo defaults that are printed in `server.mjs`.
- Content-Type follows the container, so `.mkv`/`.webm`/`.mov` are labelled
  correctly instead of always `video/mp4`.
- `go-live.ps1` does the whole start-up and prints the addresses and token.
- `go-live.ps1 -TunnelConfig` / `-TunnelToken` attaches one of your own hostnames
  through a named tunnel, so the public address stops changing.
- `setup-domain.ps1` creates that named tunnel and the DNS record for you.
- `stop-live.ps1` stops both processes if you closed the window the hard way.

---

## What you need to do

### 1. Install `cloudflared` (once)

Open PowerShell **as your normal user** and run:

```powershell
winget install --id Cloudflare.cloudflared
```

If `winget` is not available, download `cloudflared-windows-amd64.exe` from
<https://github.com/cloudflare/cloudflared/releases>, rename it to
`cloudflared.exe`, and put it in `E:\Tools\cloudflared\` (the script checks
there) or anywhere on `PATH`.

Then open a **new** PowerShell window and check:

```powershell
cloudflared --version
```

### 2. Keep the PC awake while it is live

Settings → System → Power & battery → Screen and sleep, or from PowerShell:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

A sleeping PC is an offline site. To put the old values back later, use the
Settings app.

### 3. Start it

```powershell
cd E:\job_project\movielinkbd-player
powershell -ExecutionPolicy Bypass -File .\go-live.ps1
```

The `-ExecutionPolicy Bypass` is only needed if Windows blocks local scripts.
You should see something like:

```
Starting the library on port 8890 ...
Opening the tunnel ...

============================================================
  MovieLinkBD is live
============================================================

  Public site    https://thin-lamps-share.trycloudflare.com
  Admin (local)  http://127.0.0.1:8890/admin
  Admin token    8f3c…(48 characters)

  Public URL answered the library request - it is live.

  Upload videos from the local admin address above, not the public URL.
  Cloudflare's free plan rejects request bodies over 100 MB.
  Keep this window open. Ctrl+C stops the site and the tunnel.

  Node 24.18.0 - quick tunnel (the public URL changes on every start)
```

If the reachability line instead says the URL has not answered yet, the tunnel
may still be coming up — refresh in a few seconds. If it never answers, see
Troubleshooting.

Send the **Public site** link to whoever should see the library. Open the
**Admin** link on this PC, paste the token once, and add movies.

### 4. Stop it

Press **Ctrl+C** in the window, then:

```powershell
.\stop-live.ps1
```

The public URL dies immediately. The next start produces a *different* URL.

### Two things bring it back without you

The site used to live only as long as its console window did. Now:

- **A watchdog task** (`MovieLinkBD-Watchdog`, every five minutes) asks
  `http://127.0.0.1:8890/api/catalogue.json` for an answer. If the site is
  down, it starts `run-site.cmd` again. A closed window or a crashed server
  costs at most five minutes, not a day.
- **A Startup shortcut** (`MovieLinkBD.lnk`) runs `run-site.cmd` when you log
  in, so a reboot no longer means the library stays offline.

`stop-live.ps1` pauses the watchdog as part of stopping - otherwise it would
simply start the site again. `go-live.ps1` turns it back on. The watchdog
records each decision in `.run\watchdog.log`. To keep the site down across a
logoff, delete the Startup shortcut as well.

The watchdog only ever starts a site that is *not* listening; if something holds
port 8890 without answering, it says so in the log instead of racing a second
copy for the port.

### The weekly look-over

`MovieLinkBD-Maintenance` (Sundays, 09:30) runs `maintenance.ps1`. It changes
nothing: it checks the local site, the public address, the tunnel process, every
title's source against the files on disk, free space on each drive, the age of
the last backup and the Blob token's expiry, then writes a report to
`<storage>\.run\maintenance\<date>.md` whose last section is the list of what
deserves attention.

Run it by hand whenever something feels off:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File maintenance.ps1
```

Add `-Backup` to let it call `backup.ps1` when the last backup is more than a
week old. It does not do that by default: a backup copies five gigabytes of
media to another disk, which is not something to start silently at 09:30.

The report is also the schedule the library runs on: if the site stops during
the week, the watchdog restarts it within five minutes; if it stays broken, the
Sunday report says so and says why.

---

## Adding movies (the normal workflow)

1. On this PC, open <http://127.0.0.1:8890/admin>.
2. Paste the admin token from `.admin-token` **in the storage folder** (the
   launcher prints both the folder and the token).
3. **Add movie** → title, year, description, categories.
4. Drop the video file on the upload area, or add a source row for a file you
   copied into the storage folder yourself.
5. Save. The public site picks it up on the next page load — no restart.

**Upload from the local address, not the public one.** Cloudflare's free plan
caps a proxied request body at 100 MB (Business 200 MB, Enterprise 500 MB). A
2 GB film will fail with `413` long before it reaches the server. Over localhost
the file goes straight to disk, which is also far faster.

### Formats

| Container | Plays in browsers | Notes |
|---|---|---|
| `.mp4` (H.264 + AAC) | yes, everywhere | the safe choice |
| `.webm` | Chrome/Firefox/Edge | not Safari on older iOS |
| `.mov` (H.264) | usually | large; remux to mp4 when possible |
| `.mkv` | **no** | browsers do not play Matroska |
| HEVC / H.265 in any container | **no** | Chrome and Firefox need an OS codec pack |

You do not have to remember this: the upload is inspected as it lands, and the
admin says plainly when a file no browser can play.

**With ffmpeg installed, the admin converts it for you.** On this PC ffmpeg sits
in `tools\ffmpeg` (a junction to `H:\Tools\ffmpeg\ffmpeg-9.0.2-essentials_build`),
and the launcher finds it automatically:

- H.264/AAC inside Matroska → **remuxed** to MP4, streams copied, seconds, no
  quality loss.
- HEVC, VP9, AC-3, DTS, TrueHD → **re-encoded** to H.264/AAC. Progress, speed and
  an ETA show in the upload panel, with a Cancel button. Measured on this laptop:
  a 104-minute 1080p HEVC film with `TRANSCODE_ENCODER=h264_amf` took
  **19.5 minutes** (5.3× realtime) and came out at **2.9 GB**. Software x264
  (`veryfast`, CRF 23) on the same film was stopped part-way, so budget several
  times longer; it aims at a constant quality, so expect a smaller file than the
  hardware encoder's fixed bitrate.

When it finishes, the source row points at the new `.mp4`; the original stays in
the storage folder as an unused file, because conversion never deletes anything
either.

The conversion also writes a **480p copy** (`film-480.mp4`) next to the result —
that is what a viewer on a slow connection is switched to instead of watching the
spinner. It adds roughly a quarter of the encode time and about a third of the
file size. If you would rather not spend either, start the launcher with
`TRANSCODE_RENDITIONS=none`; a file that already plays can also be given a copy
later with the **+480p** button in the admin's file list.

Without ffmpeg nothing breaks — the upload still succeeds and the form just
tells you the file will not play.

### Where the files are kept on this PC

`H:\movielinkbd-storage` — video files, `library.json`, the admin token and the
run records. The launcher remembers this in `.storage-path`, so
`stop-live.ps1` finds the same run with no arguments. Start a run with
`-StorageDir <folder>` to use another disk; the site's code stays where it is.

The conversion scratch folder is separate: `-TranscodeDir H:\movielinkbd-transcode`.
It needs room for a full copy of the output, and the media folder has to have
room for the finished file too.

### Limits

- The server accepts `.mp4 .mkv .webm .m4v .mov` and caps one file at
  **8 GiB** (`MAX_UPLOAD_BYTES`). That cap is a sanity bound, not the real
  limit: a film is briefly on disk twice, so an upload that would not fit
  twice is refused before the first piece with the numbers it needs.
- File names are generated from the title and quality; the name you upload is
  not used on disk.
- Deleting a movie **keeps** its video files and lists them as unused. Nothing
  is auto-deleted.
- **One conversion at a time.** A second request is refused with the running
  job's status instead of queueing a second hour-long encode.

---

## Admin from another machine (and files over 100 MB)

The admin answers on the public hostname — `https://movies.hafizr283.me/admin` —
so a film can be added from a phone, a laptop or someone else's machine. The
token is the only door:

- Every admin route needs `X-Admin-Token`; without the right value it is a 401,
  and an unset `ADMIN_TOKEN` makes all of them 404.
- **Eight wrong tokens from one address lock that address out for fifteen
  minutes** (HTTP 429 with `Retry-After`). A correct token clears the record.
- The token travels in a header, never in a URL, so it does not land in proxy or
  server logs.
- The public catalogue does not advertise the page: the *link* is still only
  rendered for a request that came from this PC. Bookmark the URL.

Treat the token as a password now that it is the only thing between the internet
and your library. To close the door again, set `ADMIN_LOCAL_ONLY = "1"` in
`go-live.ps1`: the page and the API then 404 for anything arriving through the
tunnel.

### Why uploads arrive in pieces

Cloudflare's free plan refuses a **request body over 100 MB**, at the edge,
before the request reaches this PC. That is not a setting on our side — the
server accepts up to 2 GiB — so a single POST of a film was never going to work
through the tunnel.

The browser therefore cuts the file into **32 MB pieces** (`UPLOAD_CHUNK_BYTES`,
1–64 MB). Each piece is its own request, comfortably under the edge limit. The
server writes them to `<storage>/.incoming/<id>/` and joins them only when the
last one has arrived, then probes the result exactly like a one-request upload.

What that buys:

- **Resume.** Pieces already on the server are listed by `GET
  /api/admin/upload/session?id=…`, and the page remembers an unfinished upload,
  so choosing the same file again sends only what is missing.
- **A dropped connection costs one piece**, retried twice before giving up.
- **No half-files in the library.** The joined file appears only after the last
  piece; abandoned sessions are swept after 24 hours.
- A piece that is too big, or pieces that add up past the declared size, are
  refused — a session cannot be used to fill the disk.

A film needs room for its pieces **and** the joined file at the same time, so
budget roughly twice the film's size in free space while it uploads; the pieces
are deleted the moment the file is joined.

The one-request path still exists for files under 4 MB, where it is simpler.

---

## Blob storage: taking the films off this PC's uplink

A viewer on the tunnel downloads from **this machine**. On a domestic line the
upload is the bottleneck, and two people watching a 2.7 GiB film at once is
already asking a lot. Publishing a film to Azure Blob storage moves those bytes
to Microsoft's edge: the file is sent up **once**, from the admin, and every
playback after that never touches this PC.

The local file is kept. This is a second home for the bytes, not a move: the
manifest gains a `remote` record, the admin shows an **AZURE** chip, and **use
local** puts the site back on the local copy without deleting anything.

### One-time: give the site a key to write

The container must already allow **public read** (that is what makes streaming
possible without a credential per viewer).

1. Portal → **Storage accounts** → your account → **Containers** → the
   container → **Shared access tokens** (older portals: *Generate SAS*).
2. **Signing method**: account key. **Permissions**: Read, Add, Create, Write.
   Leave Delete off unless you want the admin to be able to remove blobs later —
   this build never deletes one.
3. **Start** now (or a day early, for clock skew), **Expiry** as long as you are
   comfortable with — a year is reasonable, because the token only signs
   uploads.
4. **Allowed protocols**: HTTPS only.
5. **Starts from / scope**: this must be a *container* token. If the portal offers
   "Blob" and "Container", pick **Container**. A single-blob token is refused by
   the admin with a clear message, because it cannot create the next film.
6. Copy the **Blob SAS URL** and keep the part from `?` onwards.

Then, on this PC, edit `H:\movielinkbd-storage\.azure.env`:

```
AZURE_CONTAINER_URL=https://<account>.blob.core.windows.net/<container>
AZURE_SAS=?sv=...&sr=c&sp=racw&sig=...
# AZURE_ONLY=1      # later: never stream a film from this PC
```

The file is read by `run-site.cmd` → `go-live.ps1` at start-up, so restart with
`stop-live.ps1` and `run-site.cmd`. The launcher prints either
`Blob storage: <url> - the admin can publish films there.` or
`Blob storage: not configured`. It never prints the signature, and the signature
never reaches a browser.

### Publishing a film

**Saving a film that still has local files starts the upload on its own.** The
editor has a switch — *Send to Azure after saving* — on by default; with it on,
the transfer begins as soon as the movie is saved and a fixed panel shows the
file, percent, speed and time left. Films saved while another transfer runs wait
their turn and go one after the other.

The manual path is still there: Admin → the film's row → **Send film to Azure**.
That sends **every file the title lists** — the master and its 480p rendition — in
one job, because publishing half a film leaves the quality switch pointing back
at this PC. An automatic send is smarter: it uploads only what is not published
yet, so editing an old film never re-sends gigabytes that are already in Blob
storage. A single file can still be sent on its own from **Media files**.

Progress is shown in the panel; the upload can be cancelled, and it retries once
if the connection drops. A 2.7 GiB film on a domestic uplink takes as long as
your upload takes — start it and leave it. When it lands, the film's row shows
**on Azure** and every movie that uses the file starts streaming from Azure on
the next page load. No restart, no re-save of the title.

Measured on this line (2026-10-20): **0.86–0.96 MB/s**, i.e. 25 MB in 26 s and
130 MB in 152 s. Plan on roughly 100 minutes for a 3.5 GiB master plus rendition.

The blob goes to `v1/<12 random hex>/<name>`. The container is public-read, so
the URL is the handle: the random folder is what keeps a published film from
being trivially discoverable, and publishing the same file twice does not
overwrite a copy someone may be watching.

### Keep the site up while it uploads

An upload at full speed is a denial of service you inflict on yourself. Measured
here: with the 3.5 GiB film going up flat out, blob `HEAD`s went from 0.4 s to
4.5–15.6 s and `https://movies.hafizr283.me` **timed out**. The site was down
because it was being migrated.

So uploads are capped, in bytes per second:

```
AZURE_UPLOAD_BPS=600000
```

That is about 60% of the measured uplink. With it set, the same upload ran with
tunnel responses at 0.45–0.76 s and blob `HEAD`s at 0.18–0.45 s. Set `0` to
remove the cap (fine when nobody is watching), or raise it if your line is
faster than this one.

### Streaming only from Blob storage

Until every file is published, an unpublished film still plays from this PC. To
make that impossible, add one line to `.azure.env` and restart:

```
AZURE_ONLY=1
```

In that mode the player config **never contains a local media URL**. A film whose
files are all published plays from Azure; one that is not published yet shows
"this film is being moved to Blob storage" instead of quietly using the uplink.
The admin marks each row **on Azure** or with the number of files still local, so
the two states are visible before a viewer finds them.

Turn it on when the reports say what you expect: every title at `0` local files.
Turning it on early is safe — nothing breaks — but those films will not play
until they are published.

### A blob that is already in the container

Writing needs the key, but *adopting* an existing blob does not: the container is
public-read, so one `HEAD` is enough to confirm the file is there. That covers a
film uploaded through the Azure portal (or from another machine, or with a token
that has since expired). Give the server the local file and the blob's path:

```powershell
$t = (Get-Content 'H:\movielinkbd-storage\.admin-token' -Raw).Trim()
Invoke-RestMethod -Method Patch `
  -Uri "http://127.0.0.1:8890/api/admin/azure?file=This_Means_War.mp4&blob=v1/abc123/This_Means_War.mp4" `
  -Headers @{ "X-Admin-Token" = $t }
```

The response names the blob it found, its size, and how many source rows now
point at it. A wrong path answers `404 blob_missing` and changes nothing.

### When the token expires

Uploads fail with Azure's own message (`403 AuthenticationFailed`) — nothing
else changes. Playback is public read and does not use the token, so a film that
was already published keeps playing for as long as it is in the container. To
carry on publishing, generate a new container SAS, paste it into
`.azure.env`, and restart.

### What it costs

Blob storage is billed per GB stored and per GB downloaded; account tiers and
regional prices change, so read the portal's own estimate rather than a number
in this file. The library is about 5 GB, which is a few cents a month at the Hot
tier; **egress is the line to watch**, and it grows with viewers, not with the
library. Two habits keep it small: publish the **480p** copy rather than the
master for anything that is mostly watched on phones, and keep the films
unlisted (the random path is the only access control on a public container).

### Checking it without an Azure account

```powershell
node test-azure.mjs
```

Runs the whole path against a mock container on `127.0.0.1:8899` and a throwaway
library on `:8898`: real PUT bytes and headers, progress, a `HEAD` verification,
the manifest round-trip, the player's config, and the switch back to local. No
network, no credentials, and it leaves the live library untouched.

---

## View counts

Each film counts **one anonymous view per browser**, and only after **five
seconds of real playback** — opening a card in passing is not a view, and a
refresh is not another one. The number appears on the card, on the watch page
(`720p · 1 source · 12 views`) and in the admin, both per film and as a total.

How it stays honest without accounts or a third party:

- The player sends one ~90-byte beacon when playback passes five seconds.
- The browser remembers the title for six hours; the server also refuses a
  repeat from the same address within 30 minutes.
- Crawlers, link previewers and requests with no user agent are ignored.
- The owner's own previews do not count while the admin token is in the tab.

The numbers live in `<storage>/stats.json`, never in `library.json`: a view must
not rewrite the catalogue. Saves are batched (about 5 s) and atomic, so a crash
loses at most the last few seconds of counts.

This is a small, honest counter, not analytics: it stores no cookies, no
fingerprint, no comment history, and it cannot tell a curious visitor from a
determined faker. There is a test for the rules:

```
node test-views.mjs
```

## What this setup is good for - and what it is not

Quick Tunnels are documented by Cloudflare as **for testing and development**,
with no uptime guarantee. They are perfect for showing the site to a handful of
people, a private group, or a demo. They are not a production CDN.

| Limit | What it means for you |
|---|---|
| The URL changes on every start | no permanent link; a bookmark stops working |
| No uptime guarantee | if Cloudflare has a bad day, the site is down |
| 200 in-flight requests per tunnel | fine for a small audience, not a launch |
| 100 MB request bodies | upload locally, as described above |
| Your home upload speed | every viewer streams from *your* connection |
| Cloudflare's free plan | not built for sustained video delivery; heavy traffic may be throttled |
| PC must stay on | sleep, shutdown, or a power cut takes the site offline |

As a rule of thumb: a 1080p file is ~2–3 GB and a typical home upload is
10–40 Mbit/s, so **one or two simultaneous 1080p viewers** can saturate the
line. Offer 480p/720p sources as well and most viewers will be fine.

### When you outgrow this

Nothing in the app has to change for any of these:

1. **Stable address, still free** — attach your own domain with a named tunnel:
   see "A permanent address on your own domain" below.
2. **Better storage economics** — move `storage\` to Cloudflare R2 (10 GB free,
   zero egress fees) and add a mirror URL to the manifest. The app already
   treats sources as URLs.
3. **Always-on machine** — move the same `node server.mjs` to a cloud VM that
   stays up without your PC: see "Always-on" below.

Only publish files you have the right to distribute.

---

## A permanent address on your own domain (free)

A Quick Tunnel's address is new on every start, so no bookmark survives a
restart. A **named tunnel** attaches one of your own hostnames to this PC
instead, permanently:

```
visitor ──https──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ server.mjs (this PC)
   https://movies.hafizr283.me                                    └── storage\ (videos)
```

Still your PC, still free, still nothing uploaded to a hosting company. The
domain in the example is the free `.me` from the GitHub Student Pack's Namecheap
offer, but any domain you own works.

### Step 1 — put the domain on Cloudflare (once)

1. Sign in at <https://dash.cloudflare.com> → **Add a site** → your domain →
   the **Free** plan.
2. Cloudflare shows you two nameservers. Copy them into your registrar — for a
   `.me` domain from Namecheap that is **Domain List → Manage → Nameservers →
   Custom DNS**: delete the old entries, paste Cloudflare's, save.
3. Wait until the dashboard shows the zone as **Active**. Usually minutes; up to
   a day is possible. Your registrar stays your registrar; only DNS moves.

### Step 2 — create the tunnel (once)

```powershell
cd E:\job_project\movielinkbd-player
powershell -ExecutionPolicy Bypass -File .\setup-domain.ps1 -Hostname movies.hafizr283.me
```

It signs you in to Cloudflare in a browser (one time), creates a tunnel named
after the first label of the hostname, routes the hostname to it, and writes
`tunnel.yml` next to the scripts. `-Name` picks a different tunnel name; `-Port`
must match the site port you start with later.

### Step 3 — start it

```powershell
powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelConfig .\tunnel.yml
```

The banner then reads `https://movies.hafizr283.me` and *named tunnel (the
address stays the same on every start)*. Everything else is unchanged: same
local admin, same token, same upload rules.

### Or configure the hostname in the dashboard

If you prefer the Cloudflare dashboard (Zero Trust → Networks → Tunnels →
Create a tunnel), copy the connector token it gives you, add the public hostname
there, and start with:

```powershell
powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -TunnelToken <token> -PublicUrl https://movies.hafizr283.me
```

`-PublicUrl` is only used to verify the address before the script claims it is
live; the hostname itself lives in Cloudflare in this route.

### What is still true afterwards

| | |
|---|---|
| Address | permanent, and yours |
| Uptime | only while this PC is on and `go-live.ps1` keeps running |
| PC switched off | your domain answers Cloudflare **error 1033** — expected, not a misconfiguration |
| Uploads | still from `http://127.0.0.1:<port>/admin`, still limited to 100 MB over the tunnel |
| The free email gate | `-AllowedMail` is a Quick Tunnel feature; on a named tunnel use **Cloudflare Access** on the hostname instead |
| Cost | nothing: Cloudflare's free plan covers tunnels, DNS and the TLS certificate |

---

## Always-on: hosting that does not need this PC

Everything above starts and stops with this PC. If the library should answer at
3 a.m. with the PC asleep, move the same `server.mjs` to a small Linux VM — no
code changes:

```bash
# on the VM (Ubuntu 24.04), as the login user
sudo apt-get update && sudo apt-get install -y nodejs npm
mkdir -p ~/movielinkbd/storage
# copy this folder there, minus node_modules and the videos you do not want yet:
#   scp -r .\*.mjs .\*.json .\*.md public storage\library.json ubuntu@<ip>:~/movielinkbd/
```

Run it as a service — `/etc/systemd/system/movielinkbd.service`:

```ini
[Unit]
Description=MovieLinkBD library
After=network-online.target

[Service]
WorkingDirectory=/home/ubuntu/movielinkbd
Environment=HOST=127.0.0.1
Environment=PORT=8890
Environment=MIRROR_MODE=path
Environment=HIDE_SEEDS=1
Environment=ADMIN_LOCAL_ONLY=1
Environment=GATE_SECRET=replace-with-a-long-random-string
Environment=HEALTH_SECRET=replace-with-another-long-random-string
EnvironmentFile=/home/ubuntu/movielinkbd/storage/admin.env
ExecStart=/usr/bin/node server.mjs
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
```

`storage/admin.env` holds one line, `ADMIN_TOKEN=<long random string>`, and should
be `chmod 600`. Then:

```bash
sudo systemctl enable --now movielinkbd
systemctl status movielinkbd
```

**Reach it without opening a port** — install `cloudflared` on the VM and attach
the same named tunnel you already created:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb
cloudflared tunnel login                                 # prints a URL: open it in your browser
cloudflared tunnel create movies                         # or reuse the existing tunnel's credentials
cloudflared tunnel route dns movies movies.hafizr283.me
cloudflared tunnel --url http://127.0.0.1:8890 run movies # test it in the foreground first
sudo cloudflared service install                         # then make it permanent
```

Running the same tunnel from the PC *and* the VM is fine — Cloudflare balances
between the connectors, so the domain answers while either is up.

### What is actually free, and for how long

| Option | What you get | The catch |
|---|---|---|
| **Oracle Cloud Always Free** | ARM VM (about 2 OCPU / 12 GB usable), 200 GB block storage, 10 TB egress/month | needs a card for identity checks (a temporary ~$1 hold); ARM capacity is often unavailable in busy regions; an idle instance can be reclaimed |
| **Azure for Students** (Student Pack) | $100 credit + 750 h/month of a B1s Linux VM | both last **12 months**, then it bills; 1 GB RAM runs this app comfortably, but egress is thin |
| **DigitalOcean** (Student Pack credit) | $200 credit | roughly a year of a small droplet, then $6–12/month |
| **Cloudflare R2** | 10 GB storage, zero egress fees | storage only, not a server; pairs with any of the above |
| **GitHub Pages** | genuinely always-on, free TLS | static files only: no Node server, no admin, and it is not a video host |

Oracle's Always Free ARM VM is the only option in that list that is still free in
year two, which is why it is the recommendation for "host it all the time". The
deployment above is the same `server.mjs`, unchanged.

Disk is not the binding limit — bandwidth is. 10 TB/month is roughly 3,000 hours
of a 3 Mbit/s stream; a 200 GB disk holds about 45 two-hour 1080p files, or about
120 at 720p.

---

## GitHub, GitHub Pages and the Student Pack

Worth being blunt about, because "host the videos on GitHub" comes up a lot:

| Idea | Verdict |
|---|---|
| A private repo for this project's code | **Yes** — free, and the videos stay out of it because `storage\` lives on your disk |
| GitHub Pages for the site | Only if the site were static. This one is a Node server with an admin, a gate and ranged media, none of which Pages can run |
| GitHub Pages or Releases as the video host | **No.** Pages caps a site at 1 GB, its files at 100 MB and its bandwidth at 100 GB/month (soft), and GitHub's terms rule out using it as a CDN or a streaming host |
| GitHub Actions | Fine for builds and checks; not a file server |
| GitHub Codespaces | Not a hosting service — it stops when you close it |

So the split is: GitHub keeps the code, Cloudflare keeps the address, and the
videos live on the machine that serves them.

---

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Public URL: **502** / **1033** | `cloudflared` is up but `server.mjs` is not | the go-live window shows the server log; restart it |
| Public URL does not load at all | tunnel process died | check `storage\.run\tunnel.err.log`, start again |
| `/admin` is **404** on the public URL | by design | use `http://127.0.0.1:8890/admin` |
| `/admin` is 404 locally | no `ADMIN_TOKEN` in that process | start through `go-live.ps1`, not bare `node server.mjs` |
| Token rejected | wrong/old token | read `storage\.admin-token`; delete the file to rotate it |
| Upload fails around 100 MB | you used the public URL | use the local admin address |
| Upload refused: extension | not on the allowlist | convert to `.mp4` |
| Player is black on an MKV | browsers cannot demux Matroska | remux to `.mp4` |
| Video buffers forever for one viewer | home upload saturated | add a 480p/720p source; fewer simultaneous viewers |
| "Port 8890 is already in use" | an earlier copy is still running | `.\stop-live.ps1`, or `-Port 8900` |
| The site vanished after a reboot | the tunnel is not a service | log in again - the Startup shortcut starts it; or run `run-site.cmd` |
| Your domain shows Cloudflare **1033** | the tunnel is not running — PC off, or the launcher stopped | start `go-live.ps1 -TunnelConfig .\tunnel.yml` again |
| `go-live.ps1` says the config points at another port | `tunnel.yml` was written for a different `-Port` | start with that port, or re-run `setup-domain.ps1 -Port <port>` |
| `setup-domain.ps1` reports a refused DNS record | the domain is not a zone in the Cloudflare account you just signed in to | add the site and switch the nameservers first, then run it again |
| A code change is not visible on the site | the running process started before the edit | `.\stop-live.ps1`, then start again |
| `selftest.mjs` exits with "test hooks are disabled" | that instance is published, so `/api/dev/*` is 404 | start the server with `DEV_PANEL=1` when running the suite |

Logs from the last run:

```
storage\.run\server.log        normal server output
storage\.run\server.err.log    crashes and stack traces
storage\.run\tunnel.log        cloudflared output
storage\.run\tunnel.err.log    cloudflared's URL and errors
```

---

## Optional: require an email before anyone can look

Quick Tunnels can gate the whole site behind a one-time PIN:

```powershell
powershell -ExecutionPolicy Bypass -File .\go-live.ps1 -AllowedMail you@example.com
```

Every visitor enters that email, receives a PIN, and gets in. You can repeat
`-AllowedMail` for several addresses. This is Cloudflare's check, not the app's.

---

## How the pieces connect (for later)

| Env | Value set by the script | Effect |
|---|---|---|
| `MIRROR_MODE` | `path` | mirrors under `/cdn/<label>` on the one port |
| `HOST` | `127.0.0.1` | only the local tunnel may connect |
| `PORT` | `8890` | site port |
| `ADMIN_TOKEN` | random, stored | required header for admin routes |
| `ADMIN_LOCAL_ONLY` | `1` | admin routes 404 for proxied requests |
| `HIDE_SEEDS` | `1` | demo titles removed from the public site |
| `GATE_SECRET` | random, new every run | signs the `?mg=` media-gate tokens; the built-in default is printed in the source, so a public site replaces it |
| `HEALTH_SECRET` | random, new every run | signs the audio-health report tokens |
| `DEV_PANEL` | *removed* | without it neither the panel nor `/api/dev/*` is served |
| `PUBLIC_ORIGIN` | *unset* | origin derived from `X-Forwarded-Proto`/`Host` |

Bare `node server.mjs` still works exactly as before: four listeners, demo
titles, and the developer panel plus its `/api/dev/*` hooks when `DEV_PANEL=1`.
Without that flag the hooks answer 404 — they can invalidate every viewer's media
token or break a mirror, so they are opt-in like the panel itself.
