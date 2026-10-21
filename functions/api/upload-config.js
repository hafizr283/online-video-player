import { json } from "../_lib/http.js";
import { publicUploadsEnabled } from "../_lib/settings.js";
import { MAX_UPLOAD } from "../_lib/uploads.js";

/** GET /api/upload-config — what the public upload page may offer right now. */
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    uploads_open: await publicUploadsEnabled(env),
    max_bytes: MAX_UPLOAD,
    accepted: "video/mp4",
  });
}
