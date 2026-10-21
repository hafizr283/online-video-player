import { json } from "../_lib/http.js";

/**
 * POST /media/event — the player's progress/telemetry ping.
 *
 * Views are counted by /api/view, which has its own dedupe rules. This endpoint
 * accepts the event and stores nothing: a page-load ping is not a view, and
 * keeping a second, unaudited counter would only create a number nobody trusts.
 */
export const onRequestPost = () => json({ ok: true, ignored: true });

export const onRequestGet = () => json({ ok: true });
