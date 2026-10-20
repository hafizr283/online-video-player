/**
 * Admin UI: add, edit and remove movies, manage categories, upload files.
 *
 * The server owns every decision that matters - ids, slugs, validation,
 * atomicity - so this file is deliberately thin: it collects input, calls the
 * API, and renders what came back. Anything the server rejected is shown as
 * returned rather than re-guessed here.
 */
const TOKEN_KEY = "mlbd_admin_token";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let token = sessionStorage.getItem(TOKEN_KEY) || "";
let state = null;          // last /api/admin/state
let draftCategories = [];  // ids currently ticked in the editor

// ---- transport --------------------------------------------------------------
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: { "X-Admin-Token": token, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) {
    lock("That token was not accepted.");
    throw new Error("unauthorised");
  }
  return { status: res.status, ok: res.ok, data: data || {} };
}

const toast = (msg, kind = "ok") => {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast is-visible ${kind === "err" ? "is-err" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = "toast"; }, 4200);
};

const showError = (el, errors) => {
  const list = Array.isArray(errors) ? errors : [errors];
  el.innerHTML = list.map((e) => `<span>${esc(e)}</span>`).join("");
  el.hidden = false;
};

const bytes = (n) => {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

// ---- gate -------------------------------------------------------------------
function lock(message) {
  sessionStorage.removeItem(TOKEN_KEY);
  token = "";
  $("app").hidden = true;
  $("gate").hidden = false;
  const err = $("gate-err");
  if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
  $("gate-token").focus();
}

$("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("gate-token").value.trim();
  if (!token) return;
  const r = await api("/api/admin/state").catch(() => null);
  if (!r || !r.ok) return; // api() already locked on 401
  sessionStorage.setItem(TOKEN_KEY, token);
  $("gate").hidden = true;
  $("app").hidden = false;
  state = r.data;
  renderAll();
});

// ---- rendering --------------------------------------------------------------
function renderAll() {
  if (!state) return;
  const manifest = state.titles.filter((t) => !t.builtin);
  $("app-sub").textContent =
    `${state.titles.length} title${state.titles.length === 1 ? "" : "s"} · ${manifest.length} managed here · ` +
    `${state.files.length} media file${state.files.length === 1 ? "" : "s"}`;
  $("count-hint").textContent = `${state.titles.length} total`;
  $("orphan-hint").textContent = state.orphans.length
    ? `${state.orphans.length} not used by any movie`
    : "every file is used";
  renderTitles();
  renderFiles();
  renderAzure();
  renderDiagnostics();
  renderCategoryPicker();
}

function renderTitles() {
  const host = $("titles");
  host.innerHTML = state.titles.map((t) => {
    const catChips = t.categories.map((id) => {
      const c = state.categories.find((x) => x.id === id);
      return `<span class="chip chip--cat">${esc(c ? c.name : id)}</span>`;
    }).join("");
    return `<article class="admin-title${t.builtin ? " is-builtin" : ""}">
      <img class="admin-title__art" src="${esc(t.poster)}" alt="" width="80" height="120" loading="lazy">
      <div class="admin-title__body">
        <div class="admin-title__name">
          ${esc(t.title)}
          ${t.builtin ? '<span class="badge">built-in</span>' : ""}
        </div>
        <div class="admin-title__meta">
          ${[t.year, (t.qualities || []).map((q) => `${q}p`).join(" · "), `${t.source_count} source${t.source_count === 1 ? "" : "s"}`]
            .filter(Boolean).map(esc).join(" · ")}
        </div>
        <div class="chips">${catChips}</div>
        <div class="admin-title__links">
          <a href="/movie/${esc(t.id)}" target="_blank" rel="noopener">Open</a>
          <span class="mono">/movie/${esc(t.id)}</span>
        </div>
      </div>
      <div class="admin-title__actions">
        ${t.builtin
          ? '<span class="hint">read-only</span>'
          : `<button class="btn btn--ghost" type="button" data-edit="${esc(t.id)}">Edit</button>
             <button class="btn btn--danger" type="button" data-del="${esc(t.id)}">Remove</button>`}
      </div>
    </article>`;
  }).join("");
}

function renditionOf(name) {
  const height = state.conversion && state.conversion.rendition;
  if (!height || !/\.mp4$/i.test(name)) return null;
  const stem = name.replace(/\.mp4$/i, "");
  if (stem.endsWith(`-${height}`)) return null;          // already the small copy
  const target = `${stem}-${height}.mp4`;
  return state.files.some((f) => f.name === target) ? null : { height, target };
}

function renderFiles() {
  const host = $("files");
  const azure = state.azure || {};
  const canPublish = azure.configured && azure.scope === "container";
  host.innerHTML = state.files.length
    ? state.files.map((f) => {
        const make = renditionOf(f.name);
        const publishable = canPublish && !f.remote && /\.(mp4|m4v|mov|webm)$/i.test(f.name);
        const remote = f.remote
          ? `<a class="file-row__cloud" href="${esc(f.remote)}" target="_blank" rel="noreferrer"
               title="Viewers stream this copy from Blob storage">Azure</a>
             <button class="btn btn--ghost file-row__act" type="button" data-azure-off="${esc(f.name)}"
               title="Serve this film from this PC again; the published blob is left in place">use local</button>`
          : "";
        return `<div class="file-row${f.referenced ? "" : " is-orphan"}">
        <span class="file-row__name mono">${esc(f.name)}</span>
        <span class="file-row__size">${bytes(f.bytes)}</span>
        <span class="file-row__state">${f.referenced ? "used" : "unused"}</span>
        ${remote}
        ${publishable ? `<button class="btn btn--ghost file-row__act" type="button" data-azure="${esc(f.name)}"
          title="Upload to Blob storage and stream it from Azure">Send to Azure</button>` : ""}
        ${make ? `<button class="btn btn--ghost file-row__act" type="button" data-rendition="${esc(f.name)}"
          title="Make a ${make.height}p copy for slow connections">+${make.height}p</button>` : ""}
      </div>`;
      }).join("")
    : '<p class="empty">No media files yet.</p>';
}

/** What Blob storage is, and whether this run can actually write to it. */
function renderAzure() {
  const a = state.azure || {};
  const hint = $("azure-hint");
  if (!a.configured) {
    hint.hidden = false;
    hint.textContent = a.container
      ? `Blob storage is set up at ${a.container} but has no key yet. Paste a container SAS into AZURE_SAS and restart; films stay on this PC meanwhile.`
      : "Blob storage is not configured. Set AZURE_CONTAINER_URL and AZURE_SAS, then restart; films stay on this PC meanwhile.";
    return;
  }
  hint.hidden = false;
  const scope = a.scope === "container"
    ? ""
    : " This SAS is signed for a single blob, so uploads are refused — generate a container SAS.";
  const exp = a.expires ? ` Token expires ${a.expires}.` : "";
  hint.textContent =
    `Publishing to ${a.container}.${scope}${exp} A published film streams straight from Azure; the local copy stays.`;
}

function renderDiagnostics() {
  const d = state.diagnostics;
  const problems = [];
  if (!d.manifest_present) problems.push("The library file does not exist yet — the first save creates it.");
  for (const m of d.missing_files) problems.push(`Missing file: ${m.file} (source ${m.source} of ${m.title_id})`);
  for (const s of d.duplicate_slugs) problems.push(`Duplicate media slug: ${s}`);
  if (state.orphans.length) problems.push(`${state.orphans.length} media file(s) are not used by any title.`);

  $("diag").hidden = problems.length === 0;
  $("diag-body").innerHTML = problems.map((p) => `<p>${esc(p)}</p>`).join("");
}

function renderCategoryPicker() {
  const host = $("cat-picker");
  host.innerHTML = state.categories.map((c) => `
    <label class="cat-tick">
      <input type="checkbox" value="${esc(c.id)}"${draftCategories.includes(c.id) ? " checked" : ""}>
      <span>${esc(c.name)}</span>
      <em>${c.count}</em>
    </label>`).join("");
}

// ---- editor -----------------------------------------------------------------
const SOURCE_TEMPLATE = () => ({ file: "", quality: 720, cdn: 0, audio: "", best: false, name: "" });

function sourceRow(src, i) {
  const options = (selected) => state.files.map((f) =>
    `<option value="${esc(f.name)}"${f.name === selected ? " selected" : ""}>${esc(f.name)}</option>`).join("");
  const cdns = state.cdns.map((c) =>
    `<option value="${state.cdns.indexOf(c)}"${state.cdns.indexOf(c) === Number(src.cdn) ? " selected" : ""}>${esc(c.provider)}${c.broken ? " (broken)" : ""}</option>`).join("");

  return `<div class="src-row" data-i="${i}">
    <label class="src-row__file">
      <span>File</span>
      <select data-f="file">
        <option value="">— pick a file —</option>
        ${options(src.file)}
      </select>
    </label>
    <label><span>Quality</span><input data-f="quality" type="number" min="144" max="4320" step="1" value="${esc(src.quality)}"></label>
    <label><span>Mirror</span><select data-f="cdn">${cdns}</select></label>
    <label><span>Audio</span><input data-f="audio" type="text" maxlength="40" value="${esc(src.audio || "")}" placeholder="Hindi"></label>
    <label class="src-row__best"><span>Best</span><input data-f="best" type="checkbox"${src.best ? " checked" : ""}></label>
    <button class="btn btn--ghost" type="button" data-remove-src="${i}" aria-label="Remove this source">✕</button>
  </div>`;
}

function renderSources(sources) {
  $("src-rows").innerHTML = sources.map(sourceRow).join("");
}

const readSources = () => [...document.querySelectorAll("#src-rows .src-row")].map((row) => {
  const get = (f) => row.querySelector(`[data-f="${f}"]`);
  return {
    file: get("file").value,
    quality: Number(get("quality").value) || 0,
    cdn: Number(get("cdn").value) || 0,
    audio: get("audio").value.trim(),
    best: get("best").checked,
  };
});

/** The poster field is a path; showing it makes a typo or a missing file obvious. */
function refreshPosterPreview() {
  const img = $("poster-preview");
  if (!img) return;
  const value = $("f-poster").value.trim();
  if (!value) { img.hidden = true; img.removeAttribute("src"); return; }
  img.src = value;
  img.hidden = false;
}

function openEditor(title) {
  const editing = Boolean(title);
  $("editor").hidden = false;
  $("editor-title").textContent = editing ? `Edit ${title.title}` : "Add movie";
  $("f-original-id").value = editing ? title.id : "";
  $("f-key").value = state.key;
  $("f-title").value = editing ? title.title : "";
  $("f-id").value = editing ? title.id : "";
  $("f-year").value = editing && title.year ? title.year : "";
  $("f-poster").value = editing && title.raw && title.raw.poster ? title.raw.poster : "";
  refreshPosterPreview();
  $("f-description").value = editing && title.raw ? title.raw.description || "" : "";
  $("f-tags").value = editing && title.raw ? (title.raw.tags || []).join(", ") : "";

  draftCategories = editing ? [...title.categories] : [];
  renderCategoryPicker();

  const sources = editing && title.raw && Array.isArray(title.raw.sources)
    ? title.raw.sources.map((s) => ({
        file: s.file, quality: s.quality || 720, cdn: s.cdn || 0,
        audio: s.audio || "", best: Boolean(s.best),
      }))
    : [SOURCE_TEMPLATE()];
  renderSources(sources);

  $("form-err").hidden = true;
  $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEditor() {
  $("editor").hidden = true;
  $("upload-progress").hidden = true;
  $("upload-progress").value = 0;
}

$("new").addEventListener("click", () => openEditor(null));
$("cancel").addEventListener("click", closeEditor);

$("titles").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) {
    const t = state.titles.find((x) => x.id === editBtn.dataset.edit);
    if (t) openEditor(t);
    return;
  }

  const delBtn = e.target.closest("[data-del]");
  if (!delBtn) return;
  const id = delBtn.dataset.del;
  const t = state.titles.find((x) => x.id === id);
  // Files are kept on purpose, so say so rather than implying a full delete.
  if (!confirm(`Remove "${t ? t.title : id}" from the library?\n\nIts video files are kept and will be listed as unused.`)) return;

  const r = await api(`/api/admin/title?id=${encodeURIComponent(id)}&key=${encodeURIComponent(state.key)}`, { method: "DELETE" });
  if (!r.ok) return toast(r.data.message || r.data.error || "Could not remove the movie", "err");
  toast(`Removed ${id}. Files kept.`);
  await refresh();
});

$("add-src").addEventListener("click", () => {
  const sources = readSources();
  sources.push(SOURCE_TEMPLATE());
  renderSources(sources);
});

$("src-rows").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-src]");
  if (!btn) return;
  const sources = readSources();
  sources.splice(Number(btn.dataset.removeSrc), 1);
  renderSources(sources.length ? sources : [SOURCE_TEMPLATE()]);
});

$("cat-picker").addEventListener("change", () => {
  draftCategories = [...document.querySelectorAll("#cat-picker input:checked")].map((i) => i.value);
});

$("add-cat").addEventListener("click", async () => {
  const name = $("f-new-cat").value.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category";
  if (!draftCategories.includes(id)) draftCategories.push(id);
  if (!state.categories.some((c) => c.id === id)) {
    state.categories.push({ id, name, count: 0, derived: true, order: 9999, url: `/category/${id}` });
  }
  $("f-new-cat").value = "";
  renderCategoryPicker();
  toast(`"${name}" will be created when you save.`);
});

// ---- upload -----------------------------------------------------------------
const zone = $("upload-zone");
const fileInput = $("upload-file");

$("browse-file").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { if (fileInput.files[0]) upload(fileInput.files[0]); });

for (const ev of ["dragenter", "dragover"]) {
  zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("is-over"); });
}
for (const ev of ["dragleave", "drop"]) {
  zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("is-over"); });
}
zone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) upload(file);
});

async function upload(file) {  const title = $("f-title").value.trim();
  const progress = $("upload-progress");
  const hint = $("upload-hint");
  progress.hidden = false;
  progress.value = 0;
  hint.textContent = `Uploading ${file.name} (${bytes(file.size)})…`;

  const quality = readSources().map((s) => Number(s.quality)).find((q) => q > 0) || 0;
  const qs = new URLSearchParams({ name: file.name, title: title || "video", quality: String(quality) });

  try {
    // XHR rather than fetch: it reports upload progress, which matters for a
    // multi-gigabyte file and a silent-looking form.
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/admin/upload?${qs}`);
      xhr.setRequestHeader("X-Admin-Token", token);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100);
      });
      xhr.addEventListener("load", () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status === 200) resolve(data);
        else if (xhr.status === 401) { lock("That token was not accepted."); reject(new Error("unauthorised")); }
        else reject(new Error(data.error === "too_large"
          ? `File is larger than the ${bytes(state.limits.max_upload_bytes)} limit.`
          : data.error || `HTTP ${xhr.status}`));
      });
      xhr.addEventListener("error", () => reject(new Error("network error")));
      xhr.send(file);
    });

    state.files.push({ name: result.file, bytes: result.bytes, referenced: false });
    state.files.sort((a, b) => a.name.localeCompare(b.name));

    const sources = readSources();
    const empty = sources.find((s) => !s.file);
    if (empty) empty.file = result.file;
    else sources.push({ ...SOURCE_TEMPLATE(), file: result.file, quality });
    renderSources(sources);
    renderFiles();

    // A frame from this upload, if the server could take one. Only fills a
    // field the person left blank: a chosen poster is never replaced.
    if (result.poster && !$("f-poster").value.trim()) {
      $("f-poster").value = result.poster;
      $("f-poster").dispatchEvent(new Event("input", { bubbles: true }));
    }

    // A stored file is not the same as a playable one.
    const warning = Array.isArray(result.warnings) && result.warnings[0];
    if (!warning) {
      hint.textContent = `Stored as ${result.file}.`;
      toast(`Uploaded ${result.file}`);
      return;
    }

    // Stored, but no browser can play it. Convert it here instead of sending
    // the user off to find a different copy of the same film every time.
    const conversion = result.conversion || {};
    if (!conversion.available) {
      hint.textContent = `${warning} Conversion needs ffmpeg on this PC (FFMPEG_PATH).`;
      toast("Stored — but it will not play in a browser", "err");
      return;
    }

    hint.textContent = conversion.kind === "remux"
      ? `Stored as ${result.file}. Fixing the container now — this is quick.`
      : `Stored as ${result.file}. Converting to H.264 now — this can take a while.`;
    toast(conversion.kind === "remux" ? "Remuxing to MP4…" : "Converting to MP4…");

    try {
      const job = await runConversion(result.file);
      const rows = readSources();
      for (const row of rows) if (row.file === result.file) row.file = job.output;
      // The 480p copy made alongside the conversion is the same film, so it
      // becomes a second quality without anyone having to find the file.
      if (job.extra && job.extra.file && !rows.some((r) => r.file === job.extra.file)) {
        rows.push({ ...SOURCE_TEMPLATE(), file: job.extra.file, quality: job.extra.quality, audio: rows[0] ? rows[0].audio : "", best: false });
      }
      renderSources(rows);

      for (const f of [{ name: job.output, bytes: job.bytes }, job.extra]) {
        if (f && f.name && !state.files.some((x) => x.name === f.name)) {
          state.files.push({ name: f.name, bytes: f.bytes || 0, referenced: false });
        }
      }
      state.files.sort((a, b) => a.name.localeCompare(b.name));
      renderFiles();
      hint.textContent = `Converted to ${job.output} (${bytes(job.bytes)})` +
        (job.extra ? `, plus a ${job.extra.quality}p copy for slow connections` : "") +
        `. ${result.file} is kept as an unused file.`;
      toast(job.extra ? `Converted → ${job.output} + ${job.extra.quality}p` : `Converted → ${job.output}`);
    } catch (e) {
      hint.textContent = `${warning} ${e.message}`;
      toast(e.message, "err");
    }
  } catch (e) {
    hint.textContent = e.message;
    toast(e.message, "err");
  } finally {
    fileInput.value = "";
  }
}

// ---- conversion -------------------------------------------------------------
// A long encode happens on the server, so this only follows the job: start it,
// poll for percent/speed/ETA, and keep the panel honest until it ends.
let activeJob = null;

async function runConversion(file, { rendition = false } = {}) {
  const progress = $("upload-progress");
  const hint = $("upload-hint");
  const cancel = $("cancel-convert");

  const query = `file=${encodeURIComponent(file)}${rendition ? "&rendition=1" : ""}`;
  const started = await api(`/api/admin/convert?${query}`, { method: "POST" });
  if (!started.ok) throw new Error(started.data.message || started.data.error || "conversion could not start");

  let job = started.data.job;
  activeJob = job.id;
  cancel.hidden = false;
  progress.hidden = false;
  progress.value = 0;

  try {
    while (job.status === "running" || job.status === "queued") {
      const percent = Math.round(Number(job.percent) || 0);
      const speed = job.speed ? ` (${job.speed})` : "";
      const eta = job.eta ? `, about ${Math.max(1, Math.ceil(job.eta / 60))} min left` : "";
      progress.value = percent;
      hint.textContent = job.phase
        ? `Making the ${String(job.phase).replace("rendition ", "")} copy — ${percent}%${speed}${eta}`
        : `Converting to MP4 — ${percent}%${speed}${eta}`;
      await new Promise((r) => setTimeout(r, 1500));
      const r = await api(`/api/admin/convert?id=${encodeURIComponent(job.id)}`);
      if (!r.ok) throw new Error("lost track of the conversion");
      job = r.data.job;
    }
  } finally {
    activeJob = null;
    cancel.hidden = true;
  }

  if (job.status !== "done") throw new Error(job.error || `conversion ${job.status}`);
  progress.hidden = true;
  progress.value = 0;
  return job;
}

$("cancel-convert").addEventListener("click", async () => {
  if (!activeJob) return;
  const r = await api(`/api/admin/convert?id=${encodeURIComponent(activeJob)}`, { method: "DELETE" });
  if (!r.ok) toast(r.data.message || "Could not cancel the conversion", "err");
});

// A file that already plays can still be given the small copy the player steps
// down to. One click, the same job runner, the same progress bar.
$("files").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rendition]");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    const job = await runConversion(btn.dataset.rendition, { rendition: true });
    const rows = readSources();
    if (job.extra && job.extra.file && !rows.some((r) => r.file === job.extra.file)) {
      rows.push({ ...SOURCE_TEMPLATE(), file: job.extra.file, quality: job.extra.quality, audio: rows[0] ? rows[0].audio : "", best: false });
      renderSources(rows);
    }
    if (job.extra && job.extra.file && !state.files.some((f) => f.name === job.extra.file)) {
      state.files.push({ name: job.extra.file, bytes: job.extra.bytes || 0, referenced: true });
      state.files.sort((a, b) => a.name.localeCompare(b.name));
    }
    renderFiles();
    $("upload-hint").textContent = `Made ${job.output}. Save the title to publish it as a second quality.`;
    toast(`Made ${job.output}`);
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

for (const ev of ["input", "change"]) $("f-poster").addEventListener(ev, refreshPosterPreview);

// ---- publishing to Blob storage ---------------------------------------------
/**
 * Send one file to Azure and follow it until it lands.
 *
 * The upload is a job on the server (a film can take an hour), so this is the
 * same poll-and-draw loop the conversion uses. The local file is untouched:
 * when it finishes, every title that uses the file is pointed at the published
 * copy in the same step, so the catalogue is never ahead of the bytes.
 */
async function sendToAzure(name, btn) {
  const progress = $("azure-progress");
  const text = $("azure-progress-text");
  btn.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  text.hidden = false;
  text.textContent = `Sending ${name} to Azure…`;
  try {
    const started = await api(`/api/admin/azure?file=${encodeURIComponent(name)}`, { method: "POST" });
    if (!started.ok) throw new Error(started.data.message || started.data.error || "the upload could not start");
    let job = started.data.job;
    while (job.status === "running") {
      progress.value = job.percent || 0;
      text.textContent = `Sending ${name} — ${job.percent || 0}% of ${bytes(job.total)}`;
      await new Promise((r) => setTimeout(r, 1200));
      const r = await api(`/api/admin/azure?id=${encodeURIComponent(job.id)}`);
      if (!r.ok) throw new Error("lost track of the upload");
      job = r.data.job;
    }
    if (job.status !== "done") throw new Error(job.error || "the upload did not finish");
    text.textContent =
      `${name} is published (${bytes(job.bytes)}). ${job.titles} title${job.titles === 1 ? "" : "s"} now stream it from Azure.`;
    toast(`Published ${name} to Azure`);
    await refresh();
  } catch (err) {
    text.hidden = true;
    toast(err.message, "err");
  } finally {
    progress.hidden = true;
    btn.disabled = false;
  }
}

$("files").addEventListener("click", async (e) => {
  const publish = e.target.closest("[data-azure]");
  if (publish && !publish.disabled) return sendToAzure(publish.dataset.azure, publish);

  const local = e.target.closest("[data-azure-off]");
  if (!local || local.disabled) return;
  local.disabled = true;
  try {
    const r = await api(`/api/admin/azure?file=${encodeURIComponent(local.dataset.azureOff)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(r.data.message || "could not switch back");
    toast(`Serving ${local.dataset.azureOff} from this PC again`);
    await refresh();
  } catch (err) {
    toast(err.message, "err");
    local.disabled = false;
  }
});

// ---- save -------------------------------------------------------------------
$("movie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("form-err");
  errEl.hidden = true;
  $("save-hint").textContent = "Saving…";

  const body = {
    key: $("f-key").value || state.key,
    originalId: $("f-original-id").value || null,
    id: $("f-id").value.trim(),
    title: $("f-title").value.trim(),
    year: $("f-year").value,
    poster: $("f-poster").value.trim(),
    description: $("f-description").value.trim(),
    tags: $("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    categories: draftCategories,
    sources: readSources().filter((s) => s.file),
  };

  const r = await api("/api/admin/title", { method: "POST", body });
  $("save-hint").textContent = "";

  if (!r.ok) {
    showError(errEl, r.data.errors || r.data.message || r.data.error || "Save failed");
    return;
  }

  const warnings = Array.isArray(r.data.warnings) ? r.data.warnings : [];
  if (warnings.length) toast(warnings[0], "err");
  else toast(r.data.created ? `Added ${r.data.id}` : `Saved ${r.data.id}`);
  closeEditor();
  await refresh();
});

// ---- refresh ----------------------------------------------------------------
async function refresh() {
  const r = await api("/api/admin/state");
  if (!r.ok) return;
  state = r.data;
  renderAll();
}

$("refresh").addEventListener("click", async () => {
  await refresh();
  toast("Library refreshed.");
});

// ---- boot -------------------------------------------------------------------
if (!token) {
  lock();
} else {
  const r = await api("/api/admin/state").catch(() => null);
  if (r && r.ok) {
    state = r.data;
    $("gate").hidden = true;
    $("app").hidden = false;
    renderAll();
  }
}
