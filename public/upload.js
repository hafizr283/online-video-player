/**
 * Public upload page.
 *
 * The visitor never gets an admin token. The Worker checks the D1 switch on
 * both calls, signs one MP4 blob, and turns the finished upload into a draft
 * for an admin to review.
 */

import { probeVideo, qualityForHeight, uploadInBlocks } from "./upload-core.js?v=2";

const $ = (id) => document.getElementById(id);
const DEFAULT_MAX = 8 * 1024 * 1024 * 1024;

let maxBytes = DEFAULT_MAX;
let uploadMode = "draft";
let picked = null;
let busy = false;
let probeSerial = 0;

const note = (el, message, kind = "") => {
  el.textContent = message || "";
  el.className = "note" + (kind ? ` is-${kind}` : "");
};

const formatBytes = (n) => {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

const formatDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

const CLOSED_TEXT = "An admin has not opened uploads right now. You can still browse the library.";

function showClosed(message = "") {
  $("closed").hidden = false;
  $("panel").hidden = true;
  $("done").hidden = true;
  $("closed-note").textContent = message || CLOSED_TEXT;
}

function showPanel() {
  $("closed").hidden = true;
  $("done").hidden = true;
  $("panel").hidden = false;
}

function renderPolicy() {
  $("policy-note").textContent = uploadMode === "publish"
    ? "This upload will be published as soon as it finishes. Use an MP4 that plays in your browser (H.264/AAC is the safest choice)."
    : "Uploads are reviewed by an admin before they appear in the library. Use an MP4 that plays in your browser (H.264/AAC is the safest choice).";
}

function showDone(title, status) {
  const published = status === "published";
  $("done-note").textContent = published
    ? `"${title}" was uploaded and is now published.`
    : `"${title}" was uploaded and saved as a draft. An admin will review it before it appears in the library.`;
  $("closed").hidden = true;
  $("panel").hidden = true;
  $("done").hidden = false;
}

function setBusy(value) {
  busy = value;
  $("upload").disabled = value || !picked;
}

function resetForm() {
  probeSerial++;
  picked = null;
  $("upload-form").reset();
  $("detected").textContent = "";
  note($("file-note"), "Choose a file to check its duration and quality.");
  note($("upload-note"), "");
  $("progress").hidden = true;
  $("bar").style.width = "0%";
  setBusy(false);
}

const errorText = (error) => {
  const messages = {
    uploads_closed: "Public uploads are closed right now.",
    mp4_only: "Only MP4 video files are accepted.",
    too_large: `That file is larger than the ${formatBytes(maxBytes)} limit.`,
    bad_size: "The browser did not report a valid file size.",
    slow_down: "Please wait a moment before starting another upload.",
    too_many_uploads: "Too many uploads from this connection. Try again later.",
    bad_ticket: "This upload expired. Choose the file again and retry.",
    ticket_used: "This upload was already saved.",
    upload_missing: "The video did not finish uploading. Please retry.",
    size_mismatch: "The uploaded file size did not match. Please retry.",
    storage_unavailable: "Storage is temporarily unavailable. Please retry.",
  };
  return messages[error.message] || error.message || "Upload failed. Please retry.";
};

$("file").addEventListener("change", async () => {
  const file = $("file").files?.[0];
  const serial = ++probeSerial;
  picked = null;
  $("detected").textContent = "";
  note($("file-note"), "");
  note($("upload-note"), "");
  $("upload").disabled = true;
  if (!file) return;

  const type = String(file.type || "").toLowerCase();
  if (!/\.mp4$/i.test(file.name) || (type && type !== "video/mp4" && type !== "application/mp4")) {
    note($("file-note"), "Choose an MP4 video file.", "error");
    $("file").value = "";
    return;
  }
  if (!file.size) {
    note($("file-note"), "That file is empty.", "error");
    return;
  }
  if (file.size > maxBytes) {
    note($("file-note"), `That file is larger than the ${formatBytes(maxBytes)} limit.`, "error");
    return;
  }

  if (!$("name").value.trim()) {
    $("name").value = file.name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").trim();
  }

  note($("file-note"), "Reading the file…");
  const probe = await probeVideo(file);
  if (serial !== probeSerial) return;

  if (!probe.playable) {
    note($("file-note"), "This MP4 does not play in a browser (HEVC is the usual reason). Re-encode it as H.264/AAC.", "error");
    return;
  }
  if (!probe.width || !probe.height) {
    note($("file-note"), "That MP4 has no video track.", "error");
    return;
  }

  const quality = qualityForHeight(probe.height);
  picked = { file, duration: probe.duration, quality };
  $("detected").textContent =
    `Detected: ${quality}p · ${formatDuration(probe.duration)} · ${formatBytes(file.size)}`;
  note($("file-note"), "Ready. This file plays in a browser and can be uploaded as-is.", "ok");
  setBusy(false);
});

$("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !picked) return;

  const title = $("name").value.trim();
  if (!title) {
    note($("upload-note"), "Enter a title for the film.", "error");
    $("name").focus();
    return;
  }

  setBusy(true);
  $("progress").hidden = false;
  $("bar").style.width = "0%";
  note($("upload-note"), "Preparing the upload…");

  try {
    const file = picked.file;
    const slot = await api("/api/upload-url", {
      kind: "video",
      filename: file.name,
      size: file.size,
      content_type: "video/mp4",
    });
    if (slot.upload_mode === "publish" || slot.upload_mode === "draft") {
      uploadMode = slot.upload_mode;
      renderPolicy();
    }

    const started = Date.now();
    let lastShown = 0;
    note($("upload-note"), "Uploading the video…");
    await uploadInBlocks(file, slot.uploadUrl, (ratio) => {
      $("bar").style.width = `${Math.round(ratio * 100)}%`;
      const now = Date.now();
      if (now - lastShown > 500) {
        lastShown = now;
        const mbps = (file.size * ratio) / 1024 / 1024 / Math.max(1, (now - started) / 1000);
        note($("upload-note"), `${Math.round(ratio * 100)}% · ${mbps.toFixed(1)} MB/s · ${formatBytes(file.size)}`);
      }
    }, { blob: slot.blob, contentType: "video/mp4" });
    $("bar").style.width = "100%";
    note($("upload-note"), "Saving the draft…");

    const payload = {
      ticket: slot.ticket,
      name: title,
      description: $("description").value,
      quality: picked.quality,
      duration: picked.duration,
    };
    if ($("year").value) payload.year = Number($("year").value);
    const created = await api("/api/uploads", payload);

    const savedTitle = created.title?.title || title;
    resetForm();
    showDone(savedTitle, created.title?.status);
  } catch (error) {
    if (error.status === 403 && error.message === "uploads_closed") {
      showClosed("Public uploads were closed while you were uploading. The file was not saved. An admin can reopen uploads.");
    } else {
      note($("upload-note"), errorText(error), "error");
    }
  } finally {
    $("progress").hidden = true;
    $("bar").style.width = "0%";
    setBusy(false);
  }
});

$("another").addEventListener("click", () => {
  resetForm();
  showPanel();
  $("file").focus();
});

async function loadConfig() {
  try {
    const res = await fetch("/api/upload-config", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    maxBytes = Number(data.max_bytes) || DEFAULT_MAX;
    uploadMode = data.upload_mode === "publish" ? "publish" : "draft";
    renderPolicy();
    if (!data.uploads_open) {
      showClosed();
      return;
    }
    showPanel();
  } catch {
    showClosed("Could not check upload availability. Try again in a moment.");
  }
}

$("recheck").addEventListener("click", async () => {
  const button = $("recheck");
  button.disabled = true;
  $("closed-note").textContent = "Checking…";
  await loadConfig();
  button.disabled = false;
});

window.addEventListener("focus", () => {
  if (!$("closed").hidden && !busy) loadConfig();
});

loadConfig();
