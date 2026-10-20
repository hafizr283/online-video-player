/**
 * Demo test panel. Not part of the player: it only calls window.MLBD_DEV /
 * window.MLBD_PLAYER and the server's /api/dev/* fault injectors, so every
 * mechanism can be triggered without devtools.
 *
 * The source rows are built from the decoded config of whichever title is
 * loaded, so the panel works on every title in the library instead of only the
 * one it was first written against.
 */
const out = document.getElementById("dev-out");
const show = (label, value) => {
  out.textContent = `${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
};

const api = (path, init) => fetch(path, init).then((r) => r.json()).catch((e) => ({ error: String(e) }));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const dev = () => window.MLBD_DEV;
const titleId = () => {
  const cfg = dev() && dev().config();
  return (cfg && cfg.title_id) || "";
};

/** Fault injection is addressed by (title, source id); the server owns the join. */
const sourceQuery = (sourceId) =>
  `title=${encodeURIComponent(titleId())}&id=${encodeURIComponent(sourceId)}`;

function renderSourceRows() {
  const host = document.getElementById("dev-sources");
  const d = dev();
  if (!host || !d) return;
  const rows = d.sources();
  host.querySelectorAll(".dev-src").forEach((n) => n.remove());
  host.insertAdjacentHTML("beforeend", rows.map((s) => `
    <div class="dev-src">
      <span class="dev-src__label">
        <b>${s.quality}p</b> · ${esc(s.provider)} · score ${s.score} · <em>${esc(s.health)}</em>${
          s.usable ? "" : " · excluded"
        }${s.urlHasToken ? "" : " · no mg="}
      </span>
      <span class="dev-src__btns">
        <button type="button" data-src="${esc(s.id)}" data-act="play">Play</button>
        <button type="button" data-src="${esc(s.id)}" data-act="bad">Mark no audio &times;2</button>
      </span>
    </div>`).join(""));
}

// The player applies its config asynchronously, so wait for it rather than
// assuming the rows can be built at script-evaluation time.
let waits = 0;
const waitForConfig = setInterval(() => {
  if (dev() && dev().config()) {
    clearInterval(waitForConfig);
    renderSourceRows();
  } else if (++waits > 40) {
    clearInterval(waitForConfig);
  }
}, 100);

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-src]");
  if (!btn) return;
  const d = dev();
  if (!d) return show("error", "window.MLBD_DEV not ready");
  const { src, act } = btn.dataset;
  try {
    if (act === "play") return show("playSource", d.mountSource(src));
    if (act === "bad") {
      const r = await api(`/api/dev/report-no-audio?${sourceQuery(src)}&times=2`, { method: "POST" });
      renderSourceRows();
      return show(`${src} marked no_audio`, r);
    }
  } catch (err) {
    show("error", String(err));
  }
});

document.querySelectorAll("[data-dev]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const d = dev();
    const what = btn.dataset.dev;
    if (!d) return show("error", "window.MLBD_DEV not ready");
    try {
      switch (what) {
        case "meta": return show("config meta", d.configMeta());
        case "config": {
          const cfg = d.config() || {};
          return show("decoded config", {
            keys: Object.keys(cfg),
            version: cfg.version, title: cfg.title, title_id: cfg.title_id, origin_fid: cfg.origin_fid,
            content_type: cfg.content_type, completed: cfg.completed,
            view_event: cfg.view_event, source_health_event: cfg.source_health_event,
            download_bridge: cfg.download_bridge, has_r2: cfg.has_r2,
            episodes: (cfg.episodes || []).length,
            sources: ((cfg.episodes || [])[0] || {}).sources?.length,
          });
        }
        case "sources": return show("sources", d.sources());
        case "current": return show("current", d.current());
        case "counters": return show("counters", d.counters());
        case "server": return show("server", await api("/api/dev/state"));

        case "seek": return show("seekBy", window.MLBD_PLAYER.seekBy(10));
        case "clear-pref": {
          localStorage.removeItem("mlbd_v78_quality_pref");
          return show("preference cleared", "reload to see the 720p default again");
        }

        case "expire": return show("invalidate tokens", await api("/api/dev/expire-tokens", { method: "POST" }));
        case "force-error": return show("forceMediaError", d.forceMediaError());
        case "hard-expire": {
          const r = await api("/api/dev/expire-tokens", { method: "POST" });
          const forced = d.forceMediaError();
          return show("hard gate test", {
            server: r, forcedMediaError: forced,
            watch: "reloadAvoided should increment, no page reload",
          });
        }
        case "reset-gate": {
          sessionStorage.removeItem("mlbd_wg_v1");
          sessionStorage.removeItem("mlbd_wg_v1_r");
          sessionStorage.removeItem("mlbd_wg_v1_rl");
          return show("reset", await api("/api/dev/rotate-back", { method: "POST" }));
        }

        case "toggle-cdn": {
          const st = await api("/api/dev/state");
          const c = (st.cdn || []).find((x) => x.label === "cdn-c");
          return show("toggle mirror C", await api(`/api/dev/set-broken?label=cdn-c&broken=${c && c.broken ? 0 : 1}`, { method: "POST" }));
        }
        case "mark-default-bad": {
          const list = d.sources();
          const target = list.find((s) => s.quality === 720) || list[0];
          if (!target) return show("no sources", "");
          const r = await api(`/api/dev/report-no-audio?${sourceQuery(target.id)}&times=2`, { method: "POST" });
          renderSourceRows();
          return show(`mark ${target.quality}p no_audio`, r);
        }
        case "heal": {
          const r = await api("/api/dev/heal", { method: "POST" });
          renderSourceRows();
          return show("heal", r);
        }
        case "reload-page": return location.reload();
        default: return show("unknown", what);
      }
    } catch (e) {
      show("error", String(e && e.stack ? e.stack : e));
    }
  });
});
