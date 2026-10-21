import { requireAdmin } from "../../_lib/auth.js";
import { fail, json } from "../../_lib/http.js";

/** DELETE /api/admin/comment?id=… — hide a comment. The row stays for the record. */
export async function onRequestDelete({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.response;

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return fail(400, "no_id");

  const result = await env.DB.prepare("UPDATE comments SET hidden = 1 WHERE id = ?").bind(id).run();
  if (!result.meta?.changes) return fail(404, "unknown_comment");

  return json({ ok: true, id, hidden: true });
}
