/**
 * Catalogue rendering, shared by the browse page, the category page and the
 * "more titles" row on the watch page.
 *
 * All three read the same server-built JSON (the server is the only thing that
 * knows how categories are resolved), so a movie added through the admin shows
 * up everywhere with no extra wiring here.
 */
const API = "/api/library";
const categoryApi = (id) => `/api/category/${encodeURIComponent(id)}`;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const qualitiesLabel = (t) => (t.qualities || []).map((q) => `${q}p`).join(" · ");

/** 950 stays 950; 12,400 becomes 12K; 1,240,000 becomes 1.2M. */
const compactCount = (n) => {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
};

const viewsLabel = (t) => (Number(t.views) > 0
  ? `${compactCount(t.views)} view${Number(t.views) === 1 ? "" : "s"}`
  : "");

const metaLine = (t) => [
  t.year,
  qualitiesLabel(t),
  `${t.source_count} source${t.source_count === 1 ? "" : "s"}`,
  viewsLabel(t),
].filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------
// Where this browser stopped watching
//
// The player writes one entry per title into localStorage; the shelf reads the
// same entries back, which is what makes "Continue watching" and the progress
// bar on a card cost no server work and no account. Everything here is optional:
// a visitor with storage blocked just sees the ordinary shelf.
// ---------------------------------------------------------------------------
const POS_PREFIX = "fp_pos:";
let progress = new Map();          // title id -> { t, d, at }

function readProgress() {
  const out = new Map();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      if (!key.startsWith(POS_PREFIX)) continue;
      const p = JSON.parse(localStorage.getItem(key) || "null");
      const t = Number(p && p.t);
      const d = Number(p && p.d);
      if (!(t > 20) || !(d > 0) || t > d - 25) continue;   // barely started or finished
      const id = key.slice(POS_PREFIX.length).replace(/^\/movie\//, "");
      out.set(id, { t, d, at: Number((p && p.at) || 0) });
    }
  } catch { /* private mode: no history, the rest of the shelf still works */ }
  return out;
}

function clockOf(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m} min`;
  return `${total}s`;
}

/**
 * A card is 172px wide and a poster is 500. Offer both and let the browser pick:
 * a 1x screen takes the small file, a retina screen the full one, and neither
 * downloads pixels it cannot show. Generated SVG posters have no small copy.
 */
function posterSrcset(url) {
  if (!/^\/poster\/[A-Za-z0-9_-]+\.jpg$/.test(String(url || ""))) return "";
  const small = url.replace(/\.jpg$/, "-250.jpg");
  return ` srcset="${esc(small)} 250w, ${esc(url)} 500w" sizes="(max-width: 760px) 45vw, 180px"`;
}

function cardHtml(t) {
  const badge = (t.qualities || [])[0];
  const seen = progress.get(t.id);
  const pct = seen ? Math.max(3, Math.min(99, Math.round((seen.t / seen.d) * 100))) : 0;
  return `<a class="card" href="${esc(t.url)}">
  <span class="card__art">
    <img loading="lazy" decoding="async" src="${esc(t.poster)}"${posterSrcset(t.poster)} alt="" width="500" height="750"
         data-fallback="/poster/${esc(t.id)}.svg">
    <span class="card__badge"${badge ? "" : " hidden"}>${esc(badge ? `${badge}p` : "")}</span>
    ${seen ? `<span class="card__progress" aria-hidden="true"><span style="width:${pct}%"></span></span>` : ""}
  </span>
  <span class="card__title">${esc(t.title)}</span>
  <span class="card__meta">${esc(seen ? `${clockOf(seen.d - seen.t)} left` : metaLine(t))}</span>
</a>`;
}

/** The shelf row that only exists for a visitor who has started something. */
function resumeRowHtml(titles) {
  const started = titles
    .filter((t) => progress.has(t.id))
    .sort((a, b) => progress.get(b.id).at - progress.get(a.id).at)
    .slice(0, 12);
  if (!started.length) return "";
  return `<section class="row row--resume" aria-labelledby="row-resume-h">
  <div class="row__head">
    <h2 id="row-resume-h">Continue watching</h2>
    <span class="row__count">${started.length}</span>
    <span class="row__spacer"></span>
    <div class="row__nav">
      <button type="button" data-scroll="-1" aria-label="Scroll left">&#8249;</button>
      <button type="button" data-scroll="1" aria-label="Scroll right">&#8250;</button>
    </div>
  </div>
  <div class="row__track">${started.map(cardHtml).join("")}</div>
</section>`;
}

function rowHtml(row, id) {
  const more = row.url
    ? `<a class="row__more" href="${esc(row.url)}">See all &rsaquo;</a>`
    : "";
  return `<section class="row" aria-labelledby="${id}-h">
  <div class="row__head">
    <h2 id="${id}-h">${esc(row.name)}</h2>
    <span class="row__count">${row.titles.length}</span>
    <span class="row__spacer"></span>
    ${more}
    <div class="row__nav">
      <button type="button" data-scroll="-1" aria-label="Scroll left">&#8249;</button>
      <button type="button" data-scroll="1" aria-label="Scroll right">&#8250;</button>
    </div>
  </div>
  <div class="row__track">${row.titles.map(cardHtml).join("")}</div>
</section>`;
}

function chipBarHtml(categories, activeId) {
  if (!categories.length) return "";
  const chip = (c, active) =>
    `<a class="chip${active ? " is-active" : ""}" href="${esc(c.url)}">${esc(c.name)}<span class="chip__n">${c.count}</span></a>`;
  return `<nav class="chipbar" aria-label="Categories">
  <a class="chip${activeId ? "" : " is-active"}" href="/">All</a>
  ${categories.map((c) => chip(c, c.id === activeId)).join("")}
</nav>`;
}

function heroHtml(t) {
  return `<section class="hero">
  <div>
    <span class="hero__eyebrow">Featured title</span>
    <h1>${esc(t.title)}</h1>
    <div class="hero__meta">${esc(metaLine(t))}</div>
    <p>${esc(t.description || "")}</p>
    <div class="hero__actions"><a class="btn btn--primary" href="${esc(t.url)}">&#9654; Watch now</a></div>
  </div>
  <a class="hero__art" href="${esc(t.url)}" tabindex="-1">
    <img src="${esc(t.poster)}" alt="" width="500" height="750" fetchpriority="high"
         data-fallback="/poster/${esc(t.id)}.svg">
  </a>
</section>`;
}

/**
 * Category chips are links, so they work without JS and can be opened in a new
 * tab. `names` is only present once the catalogue has loaded; before that the
 * chips degrade to plain labels rather than being missing.
 */
function titleMetaHtml(t, names) {
  const chips = [
    ...(t.categories || []).map((id) => {
      const name = names && names.get(id);
      return name
        ? `<a class="chip chip--cat" href="/category/${esc(id)}">${esc(name)}</a>`
        : `<span class="chip chip--cat">${esc(id)}</span>`;
    }),
    ...(t.qualities || []).map((q) => `<span class="chip chip--q">${q}p</span>`),
    ...(t.tags || []).map((x) => `<span class="chip">${esc(x)}</span>`),
  ].join("");
  return `<div class="title-meta__line">${esc(metaLine(t))}</div>
  ${t.description ? `<p>${esc(t.description)}</p>` : ""}
  <div class="chips">${chips}</div>`;
}

const loadCatalogue = async () => {
  const res = await fetch(API, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const categoryNames = (data) => new Map((data.categories || []).map((c) => [c.id, c.name]));

async function renderBrowse(root) {
  let data;
  try {
    data = await loadCatalogue();
  } catch (e) {
    root.innerHTML = `<p class="empty">The library could not be loaded (${esc(e.message)}). Please refresh in a moment.</p>`;
    return;
  }
  if (!data.count) {
    root.innerHTML = '<p class="empty">No titles have been published yet. Please check back soon.</p>';
    return;
  }
  progress = readProgress();
  root.innerHTML =
    heroHtml(data.titles[0]) +
    resumeRowHtml(data.titles) +
    chipBarHtml(data.categories, null) +
    data.rows.map((r, i) => rowHtml(r, `row-${i}`)).join("");
  document.body.classList.toggle("has-resume", progress.size > 0);
}

async function renderCategory(root) {
  let meta = null;
  try { meta = JSON.parse(document.getElementById("fpCategoryMeta").textContent); } catch { /* required */ }
  if (!meta) {
    root.innerHTML = '<p class="empty">This page is missing its category.</p>';
    return;
  }

  let data;
  try {
    const res = await fetch(categoryApi(meta.id), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    root.innerHTML = `<p class="empty">This category could not be loaded (${esc(e.message)}). Please refresh in a moment.</p>`;
    return;
  }

  let chips = "";
  try { chips = chipBarHtml((await loadCatalogue()).categories, meta.id); } catch { /* chips are optional */ }

  const heading = `<header class="cat-head">
  <h1>${esc(data.category.name)}</h1>
  <span class="row__count">${data.count} title${data.count === 1 ? "" : "s"}</span>
</header>
${data.category.description ? `<p class="cat-desc">${esc(data.category.description)}</p>` : ""}`;

  root.innerHTML = chips + heading + (data.count
    ? `<div class="grid">${data.titles.map(cardHtml).join("")}</div>`
    : '<p class="empty">No titles in this category yet.</p>');
}

async function renderDetail() {
  let current = null;
  const metaEl = document.getElementById("fpTitleMeta");
  try { current = JSON.parse(metaEl.textContent); } catch { /* meta is optional */ }

  progress = readProgress();

  if (current) document.title = `${current.title} — Fast Player`;

  const metaHost = document.getElementById("title-meta-root");
  const moreRoot = document.getElementById("more-titles");
  if (current && metaHost) metaHost.innerHTML = titleMetaHtml(current, null);

  let data;
  try { data = await loadCatalogue(); } catch { return; }

  // Re-render with real category names now that they are known.
  if (current && metaHost) metaHost.innerHTML = titleMetaHtml(current, categoryNames(data));

  if (!moreRoot) return;
  const others = (data.titles || []).filter((t) => !current || t.id !== current.id);
  moreRoot.innerHTML = others.length ? rowHtml({ name: "More to watch", titles: others }, "row-more") : "";
}

// One delegated listener keeps the arrows working for rows rendered later.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-scroll]");
  if (!btn) return;
  const track = btn.closest(".row")?.querySelector(".row__track");
  if (!track) return;
  track.scrollBy({ left: Number(btn.dataset.scroll) * track.clientWidth * 0.85, behavior: "smooth" });
});

// A poster frame lives beside its video, so deleting or moving the file can
// leave a card pointing at a 404. Fall back to the generated art once, rather
// than showing a broken-image icon on the shelf.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || !img.dataset.fallback || img.dataset.fellBack) return;
  img.dataset.fellBack = "1";
  img.src = img.dataset.fallback;
}, true);

const browseRoot = document.getElementById("catalogue-root");
if (browseRoot) renderBrowse(browseRoot);

const categoryRoot = document.getElementById("category-root");
if (categoryRoot) renderCategory(categoryRoot);

if (document.getElementById("fpTitleMeta")) renderDetail();

export { cardHtml, rowHtml, chipBarHtml };
