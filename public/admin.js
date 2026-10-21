/**
 * Cloudflare admin.
 *
 * The token lives in sessionStorage for this tab. Every request carries it in an
 * Authorization header (never a query string), and the same presence tells the
 * player not to count the owner's own previews as views.
 *
 * Uploads go from this browser straight to Azure Blob with a short-lived SAS:
 * the Pages Function only signs, it never carries the bytes. A file a browser
 * can play is published as-is; anything else goes to the private incoming/ area
 * and the GitHub Actions transcoder turns it into an MP4.
 */

import { probeVideo, putWithRetry, resumeKeyFor, uploadInBlocks } from "./upload-core.js?v=1";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "fp_admin_token";

let token = "";
try { token = sessionStorage.getItem(TOKEN_KEY) || ""; } catch { /* storage blocked */ }

let state = { titles: [], categories: [], comments: [], jobs: [], totals: {}, transcode: false, public_uploads: false };
let picked = null; // { file, playable, duration, posterBlob, width, height }
let customPoster = null; // Blob from the poster picker; it wins over the frame grab

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const count = (n) => {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
};

const bytes = (n) => {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

const hhmm = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

const note = (el, message, kind = "") => {
  el.textContent = message || "";
  el.className = "note" + (kind ? ` is-${kind}` : "");
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 429) {
    lock(res.status === 429 ? "Too many wrong attempts. Wait 15 minutes." : "That token was not accepted.");
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------
function lock(message = "") {
  token = "";
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  $("app").hidden = true;
  $("login").hidden = false;
  if (message) note($("login-note"), message, "error");
  $("token").focus();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = $("token").value.trim();
  if (!candidate) return;
  token = candidate;
  note($("login-note"), "Checking…");
  try {
    await loadState();
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
    $("login").hidden = true;
    $("app").hidden = false;
    note($("login-note"), "");
  } catch (error) {
    lock("That token was not accepted.");
  }
});

$("logout").addEventListener("click", () => lock());

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
async function loadState() {
  state = await api("/api/admin/state");
  $("app-sub").textContent = `${state.totals.titles} titles · ${state.totals.published} published · ` +
    `${count(state.totals.views)} views · ${state.totals.pending_jobs} converting`;
  renderTitles();
  renderComments();
  renderJobs();
  renderCategories();
  renderTargets();
  renderPublicUploads();
}

function renderTitles() {
  const host = $("titles");
  if (!state.titles.length) {
    host.innerHTML = '<p class="note">No titles yet. Add one from the Upload tab.</p>';
    return;
  }
  host.innerHTML = state.titles.map((t) => {
    const poster = t.poster || `/poster/${encodeURIComponent(t.id)}.svg`;
    const pending = (t.sources || []).some((s) => s.status === "pending");
    const qualities = (t.qualities || []).map((q) => `${q}p`).join(" · ");
    const meta = [
      t.year,
      qualities,
      `${t.ready_sources} file${t.ready_sources === 1 ? "" : "s"}`,
      `${count(t.views)} view${Number(t.views) === 1 ? "" : "s"}`,
    ].filter(Boolean).join(" · ");
    return `<div class="title-row">
      <img src="${esc(poster)}" alt="" loading="lazy">
      <div>
        <h3>${esc(t.title)}
          <span class="badge badge--${t.status === "published" ? "pub" : "draft"}">${t.status}</span>
          ${pending ? '<span class="badge badge--job">converting</span>' : ""}
        </h3>
        <div class="meta">${esc(meta)}</div>
      </div>
      <div class="row-actions">
        <button class="btn" type="button" data-act="toggle" data-id="${esc(t.id)}">
          ${t.status === "published" ? "Unpublish" : "Publish"}
        </button>
        <button class="btn btn--danger" type="button" data-act="delete" data-id="${esc(t.id)}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

function renderComments() {
  const host = $("comments");
  if (!state.comments.length) {
    host.innerHTML = '<p class="note">No comments yet.</p>';
    return;
  }
  host.innerHTML = state.comments.map((c) => `
    <div class="comment-row${c.hidden ? " is-hidden" : ""}">
      <div class="who">${esc(c.name)} · ${esc(c.title_name || c.title_id)} · ${new Date(c.at).toLocaleString()}</div>
      <div>${esc(c.text)}</div>
      ${c.hidden ? '<span class="note">hidden</span>' :
        `<button class="btn" type="button" data-hide="${esc(c.id)}">Hide</button>`}
    </div>`).join("");
}

function renderJobs() {
  const host = $("jobs");
  if (!state.jobs.length) {
    host.innerHTML = '<p class="note">Nothing in the queue.</p>';
    return;
  }
  host.innerHTML = state.jobs.map((j) => `
    <div class="comment-row">
      <div class="who">${esc(j.status)} · ${esc(j.name)} · ${esc(String(j.quality))}p · attempt ${j.attempts}
        ${j.error ? ` · <span class="note is-error">${esc(j.error)}</span>` : ""}</div>
    </div>`).join("");
}

function renderTargets() {
  const select = $("target");
  const current = select.value;
  select.innerHTML = '<option value="">— a new title —</option>' +
    state.titles.map((t) => `<option value="${esc(t.id)}">${esc(t.title)} (${t.status})</option>`).join("");
  // Re-rendering the list must not silently change what the admin picked.
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function renderCategories() {
  const host = $("categories");
  if (!state.categories.length) { host.innerHTML = ""; return; }
  host.innerHTML = `<span>Categories</span><div class="row-actions">` + state.categories.map((c) => `
    <label class="note"><input type="checkbox" name="cat" value="${esc(c.id)}"> ${esc(c.name)}</label>
  `).join("") + "</div>";
}

function renderPublicUploads() {
  const status = $("public-upload-status");
  const button = $("public-upload-toggle");
  if (!status || !button) return;
  const open = Boolean(state.public_uploads);
  status.textContent = open
    ? "On — anyone with the link can upload an MP4. New uploads arrive as drafts for you to review and publish."
    : "Off — only an admin can upload. Turn this on to let anyone with the link upload an MP4.";
  status.className = "note" + (open ? " is-ok" : "");
  button.textContent = open ? "Turn off public uploads" : "Turn on public uploads";
  button.className = "btn" + (open ? " btn--danger" : " btn--primary");
  button.disabled = false;
  button.setAttribute("aria-pressed", String(open));
}

$("public-upload-toggle").addEventListener("click", async () => {
  const button = $("public-upload-toggle");
  button.disabled = true;
  try {
    const data = await api("/api/admin/settings", {
      method: "POST",
      body: { allow_public_uploads: !state.public_uploads },
    });
    state.public_uploads = Boolean(data.allow_public_uploads);
    renderPublicUploads();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

$("titles").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  const id = button.dataset.id;
  const title = state.titles.find((t) => t.id === id);
  if (!title) return;

  button.disabled = true;
  try {
    if (button.dataset.act === "toggle") {
      const next = title.status === "published" ? "draft" : "published";
      await api(`/api/admin/titles/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: next } });
    } else {
      if (!confirm(`Delete "${title.title}" and its video files? This cannot be undone.`)) {
        button.disabled = false;
        return;
      }
      const result = await api(`/api/admin/titles/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (result.failed_blobs?.length) {
        alert(`Title deleted, but ${result.failed_blobs.length} blob(s) could not be removed:\n` +
          result.failed_blobs.map((b) => `${b.blob}: ${b.error}`).join("\n"));
      }
    }
    await loadState();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

$("comments").addEventListener("click", async (event) => {
  const id = event.target.dataset.hide;
  if (!id) return;
  event.target.disabled = true;
  try {
    await api(`/api/admin/comment?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState();
  } catch (error) {
    alert(error.message);
    event.target.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll("[role=tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `tab-${tab.dataset.tab}`));
  });
});

// ---------------------------------------------------------------------------
// Upload: probe, poster frame, blocks, title
// ---------------------------------------------------------------------------
const fileInput = $("file");
const posterInput = $("poster-file");
const uploadBtn = $("upload");
const bar = $("bar");
const progress = $("progress");
const uploadNote = $("upload-note");

/**
 * Read a chosen image and re-encode it as a JPEG no larger than 1000 px on the
 * long side. The admin may hand us a 12 MP phone photo; the poster slot does not
 * need it, and a smaller file uploads faster.
 */
async function preparePoster(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("unreadable image"));
      img.src = url;
    });
    const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("encode failed")), "image/jpeg", 0.86);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

posterInput.addEventListener("change", async () => {
  const file = posterInput.files?.[0];
  if (!file) return;
  try {
    customPoster = await preparePoster(file);
    $("poster-preview").src = URL.createObjectURL(customPoster);
    note(uploadNote, "Poster image ready. It will replace the captured frame.", "ok");
  } catch {
    customPoster = null;
    posterInput.value = "";
    note(uploadNote, "That image could not be read. Use a JPG or PNG.", "error");
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  picked = null;
  uploadBtn.disabled = true;
  if (customPoster) $("poster-preview").src = URL.createObjectURL(customPoster);
  else $("poster-preview").removeAttribute("src");
  note(uploadNote, "");
  if (!file) return;

  if (!file.size) { note(uploadNote, "That file is empty.", "error"); return; }

  if (!$("name").value.trim()) {
    $("name").value = file.name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").trim();
  }

  note(uploadNote, "Reading the file…");
  const probe = await probeVideo(file);
  picked = { file, ...probe };

  if (probe.posterBlob && !customPoster) {
    $("poster-preview").src = URL.createObjectURL(probe.posterBlob);
  }

  if (probe.playable) {
    note(uploadNote, `Ready · ${hhmm(probe.duration)} · this file plays in a browser, so it uploads as-is.`, "ok");
  } else {
    note(uploadNote, "This file does not play in a browser (MKV/HEVC is the usual reason). " +
      "It will be uploaded and converted to MP4 in the background; that can take a while.", "");
  }
  uploadBtn.disabled = false;
});

async function uploadPoster(blob) {
  const slot = await api("/api/admin/upload-url", {
    method: "POST",
    body: { kind: "poster", filename: "poster.jpg", size: blob.size },
  });
  await putWithRetry(slot.uploadUrl, blob, {
    "x-ms-blob-type": "BlockBlob",
    "x-ms-blob-content-type": "image/jpeg",
    "x-ms-blob-cache-control": "public, max-age=31536000, immutable",
  });
  return slot.publicUrl;
}

/**
 * A file a browser can play is published as-is. Anything else lands in
 * incoming/ and joins the transcode queue; it stays a draft until the MP4
 * exists, so a viewer never opens a title with nothing to play.
 */
uploadBtn.addEventListener("click", async () => {
  if (!picked) return;
  const targetId = $("target").value;
  const target = targetId ? state.titles.find((t) => t.id === targetId) : null;
  const name = $("name").value.trim();
  if (!target && !name) { note(uploadNote, "Choose a title to add to, or name a new one.", "error"); return; }

  uploadBtn.disabled = true;
  progress.hidden = false;
  bar.style.width = "0%";
  const started = Date.now();
  let lastShown = 0;

  try {
    const { file, playable, duration } = picked;
    const posterBlob = customPoster || picked.posterBlob;
    const quality = Number($("quality").value) || 720;
    const best = $("best").checked;

    let posterUrl = "";
    // A new quality for an existing film keeps that film's poster unless the
    // admin explicitly chose an image, which must win over the captured frame.
    if (posterBlob && (customPoster || !target || !target.poster)) {
      note(uploadNote, "Uploading the poster…");
      posterUrl = await uploadPoster(posterBlob);
    }

    const stage = playable ? "movies" : "incoming";
    note(uploadNote, playable ? "Uploading the video…" : "Uploading the original for conversion…");
    const resumeKey = await resumeKeyFor(file);
    const slot = await api("/api/admin/upload-url", {
      method: "POST",
      body: { kind: "video", filename: file.name, size: file.size, stage, resume_key: resumeKey },
    });

    await uploadInBlocks(file, slot.uploadUrl, (ratio) => {
      bar.style.width = `${Math.round(ratio * 100)}%`;
      const now = Date.now();
      if (now - lastShown > 500) {
        lastShown = now;
        const mbps = (file.size * ratio) / 1024 / 1024 / Math.max(1, (now - started) / 1000);
        note(uploadNote, `${Math.round(ratio * 100)}% · ${mbps.toFixed(1)} MB/s · ${bytes(file.size)}`);
      }
    }, { resumeKey, blob: slot.blob });
    bar.style.width = "100%";

    const source = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      quality,
      type: playable ? (file.type.includes("webm") ? "webm" : "mp4") : "mp4",
      url: playable ? slot.publicUrl : "",
      blob: slot.blob,
      name: file.name,
      size: file.size,
      best,
      status: playable ? "ready" : "pending",
    };

    const categories = [...document.querySelectorAll('input[name="cat"]:checked')].map((el) => el.value);

    if (target) {
      // Append this file to the existing title. A second "best" would label two
      // qualities as best, so the new choice wins and the old one is cleared.
      const sources = [
        ...(target.sources || []).map((s) => (best ? { ...s, best: false } : s)),
        source,
      ];
      const body = { sources };
      if (posterUrl) body.poster_url = posterUrl;
      if (playable && target.status === "draft" && $("publish").checked) body.status = "published";

      await api(`/api/admin/titles/${encodeURIComponent(target.id)}`, { method: "PATCH", body });

      if (!playable) {
        note(uploadNote, "Added as a pending quality. It appears when conversion finishes.");
        await api("/api/admin/transcode", {
          method: "POST",
          body: { title_id: target.id, source_id: source.id },
        });
      } else {
        note(uploadNote, "Added. The quality menu now offers it.", "ok");
      }
    } else {
      const created = await api("/api/admin/titles", {
        method: "POST",
        body: {
          name,
          year: $("year").value ? Number($("year").value) : null,
          description: $("description").value,
          poster_url: posterUrl,
          duration: duration || null,
          size: file.size,
          categories,
          sources: [source],
        },
      });

      if (playable && $("publish").checked) {
        await api(`/api/admin/titles/${encodeURIComponent(created.title.id)}`, {
          method: "PATCH",
          body: { status: "published" },
        });
      }

      if (!playable) {
        note(uploadNote, state.transcode
          ? "Queued for conversion. You can publish it from the Library tab when it is ready."
          : "Saved as a draft: this file is not browser-playable and the GitHub Actions transcoder is not configured. Upload an MP4 (H.264/AAC) to publish immediately.",
        state.transcode ? "" : "error");
        await api("/api/admin/transcode", {
          method: "POST",
          body: { title_id: created.title.id, source_id: source.id },
        });
      } else {
        note(uploadNote, "Published.", "ok");
      }
    }

    picked = null;
    customPoster = null;
    posterInput.value = "";
    fileInput.value = "";
    $("name").value = "";
    $("year").value = "";
    $("description").value = "";
    $("poster-preview").removeAttribute("src");
    $("target").value = "";
    await loadState();
  } catch (error) {
    note(uploadNote, error.message, "error");
  } finally {
    uploadBtn.disabled = false;
    progress.hidden = true;
    bar.style.width = "0%";
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  if (!token) { lock(); return; }
  try {
    await loadState();
    $("login").hidden = true;
    $("app").hidden = false;
  } catch (error) {
    if (String(error.message) !== "unauthorized") lock("Could not reach the admin API.");
  }
})();
