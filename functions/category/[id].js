import { escapeHtml, fail } from "../_lib/http.js";

const ADMIN_BUTTON =
  '<a class="site-bar__admin" href="/admin" title="Manage videos" aria-label="Manage videos">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/>' +
  '<circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>' +
  "<span>Manage videos</span></a>";

/** GET /category/:id - the static shell with its per-category meta. */
export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || "");
  const category = await env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
  if (!category) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM titles WHERE status = 'published' AND categories LIKE ?",
  ).bind(`%"${id}"%`).first();
  if (!count?.n) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

  const meta =
    `<script id="fpCategoryMeta" type="application/json">` +
    `${JSON.stringify({ id: category.id, name: category.name, count: count.n }).replace(/</g, "\\u003c")}</script>`;

  const asset = await env.ASSETS.fetch(new Request(new URL("/category.html", request.url)));
  if (!asset.ok) return fail(500, "template_missing");
  const html = (await asset.text())
    .replace("<!--FP_ADMIN_LINK-->", ADMIN_BUTTON)
    .replace("<!--FP_CATEGORY_META-->", meta)
    .replaceAll("<!--FP_CATEGORY-->", escapeHtml(category.name));

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
