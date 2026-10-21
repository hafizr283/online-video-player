import { json } from "../_lib/http.js";
import { cardOf, categoriesWithCounts } from "../_lib/titles.js";

/**
 * GET /api/library
 *
 * Published titles only, shaped exactly like the catalogue the existing
 * front-end already renders. Cached for 30 seconds at the edge: a view counter
 * that ticks does not need to invalidate a page.
 */
export async function onRequestGet({ env }) {
  const { titles, categories } = await categoriesWithCounts(env);
  const cards = new Map(titles.map((t) => [t.id, cardOf(t)]));

  const rows = [];
  for (const category of categories) {
    const members = titles.filter((t) => t.categories.includes(category.id));
    if (!members.length) continue;
    rows.push({
      id: category.id,
      name: category.name,
      url: category.url,
      titles: members.map((t) => cards.get(t.id)),
    });
  }

  const loose = titles.filter((t) => !t.categories.length).map((t) => cards.get(t.id));
  if (loose.length) rows.push({ id: "more-titles", name: "More to watch", url: null, titles: loose });

  return json({
    ok: true,
    count: titles.length,
    categories: categories.filter((c) => c.count > 0),
    rows,
    titles: titles.map((t) => cards.get(t.id)),
  }, { cache: "public, max-age=30" });
}
