import { json } from "../_lib/http.js";

/**
 * POST /media/health — the player's source-health ping.
 *
 * With every file on Blob storage there is no mirror to heal and no per-file
 * health token, so the honest answer is "nothing to report". The endpoint exists
 * so the player's background pings do not turn into 404 noise in the console.
 */
export const onRequestPost = () => json({ ok: true, ignored: true });

export const onRequestGet = () => json({ ok: true });
