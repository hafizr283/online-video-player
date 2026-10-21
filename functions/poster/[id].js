import { escapeHtml } from "../_lib/http.js";

/**
 * GET /poster/:id.svg
 *
 * A generated poster for a title that has no captured frame yet (drafts, old
 * imports, a failed capture). Deterministic: the same id always gets the same
 * colour, so a card does not change identity between two page loads.
 */
export async function onRequestGet({ env, params }) {
  const raw = String(params.id || "").replace(/\.svg$/i, "");
  const id = decodeURIComponent(raw);

  let name = id;
  try {
    const row = await env.DB.prepare("SELECT name FROM titles WHERE id = ?").bind(id).first();
    if (row?.name) name = row.name;
  } catch { /* the poster still renders if D1 is briefly unavailable */ }

  let hash = 0;
  for (const ch of id) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const hue2 = (hue + 40) % 360;

  const words = String(name).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > 14 && line) { lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  const title = lines.slice(0, 4);
  const startY = 380 - (title.length - 1) * 38;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750" role="img" aria-label="${escapeHtml(name)}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 42% 26%)"/>
      <stop offset="1" stop-color="hsl(${hue2} 55% 9%)"/>
    </linearGradient>
    <radialGradient id="v" cx="0.5" cy="0.35" r="0.8">
      <stop offset="0" stop-color="#fff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.35"/>
    </radialGradient>
  </defs>
  <rect width="500" height="750" fill="url(#g)"/>
  <rect width="500" height="750" fill="url(#v)"/>
  <g font-family="Arial, Helvetica, sans-serif" fill="#fff" text-anchor="middle">
    ${title.map((t, i) => `<text x="250" y="${startY + i * 76}" font-size="58" font-weight="700">${escapeHtml(t)}</text>`).join("\n    ")}
    <text x="250" y="690" font-size="20" fill="#fff" opacity="0.65" letter-spacing="3">FAST PLAYER</text>
  </g>
</svg>`;

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
