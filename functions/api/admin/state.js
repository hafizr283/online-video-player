import { json } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { publicUploadsEnabled } from "../../_lib/settings.js";
import { readySources, rowToTitle } from "../../_lib/titles.js";

/** GET /api/admin/state — everything the admin page needs in one round trip. */
export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const [titleRows, catRows, commentRows, jobRows, uploadsOpen] = await Promise.all([
    env.DB.prepare("SELECT * FROM titles ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT * FROM categories ORDER BY sort, name").all(),
    env.DB.prepare(
      `SELECT c.*, t.name AS title_name
         FROM comments c LEFT JOIN titles t ON t.id = c.title_id
        ORDER BY c.at DESC LIMIT 100`,
    ).all(),
    env.DB.prepare("SELECT * FROM transcode_jobs ORDER BY created_at DESC LIMIT 20").all(),
    publicUploadsEnabled(env),
  ]);

  const titles = (titleRows.results || []).map(rowToTitle).map((t) => {
    const ready = readySources(t);
    return {
      ...t,
      ready_sources: ready.length,
      qualities: [...new Set(ready.map((s) => Number(s.quality)).filter(Boolean))].sort((a, b) => b - a),
    };
  });

  return json({
    ok: true,
    transcode: Boolean(env.GH_REPO && env.GH_TOKEN),
    public_uploads: uploadsOpen,
    titles,
    categories: catRows.results || [],
    comments: commentRows.results || [],
    jobs: jobRows.results || [],
    totals: {
      titles: titles.length,
      published: titles.filter((t) => t.status === "published").length,
      views: titles.reduce((n, t) => n + (Number(t.views) || 0), 0),
      comments: (commentRows.results || []).filter((c) => !c.hidden).length,
      pending_jobs: (jobRows.results || []).filter((j) => j.status === "queued" || j.status === "running").length,
    },
  });
}
