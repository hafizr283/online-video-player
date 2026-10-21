import { fail, json } from "../../_lib/http.js";
import { cardOf, publishedTitles } from "../../_lib/titles.js";

/** GET /api/category/:id — the cards for one category page. */
export async function onRequestGet({ env, params }) {
  const id = String(params.id || "");
  const category = await env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
  if (!category) return fail(404, "unknown_category");

  const titles = (await publishedTitles(env)).filter((t) => t.categories.includes(id));
  if (!titles.length) return fail(404, "unknown_category");

  return json({
    ok: true,
    category: { id: category.id, name: category.name },
    count: titles.length,
    titles: titles.map(cardOf),
  }, { cache: "public, max-age=30" });
}
