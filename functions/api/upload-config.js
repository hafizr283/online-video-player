import { json } from "../_lib/http.js";
import { publicUploadSettings } from "../_lib/settings.js";
import { MAX_UPLOAD } from "../_lib/uploads.js";

/** GET /api/upload-config — what the public upload page may offer right now. */
export async function onRequestGet({ env }) {
  const settings = await publicUploadSettings(env);
  return json({
    ok: true,
    uploads_open: settings.open,
    upload_mode: settings.mode,
    max_bytes: MAX_UPLOAD,
    accepted: "video/mp4",
  });
}
