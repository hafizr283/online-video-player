/**
 * Azure Blob service SAS, signed with WebCrypto.
 *
 * The browser uploads straight to Blob storage, so the Function never sees the
 * bytes — it only mints a short-lived, single-blob SAS. The account key stays in
 * a Pages secret and is never sent anywhere.
 *
 * The string-to-sign below is the service-SAS form for signed version
 * 2022-11-02. Field order is fixed by the protocol; do not "tidy" it.
 */

const SAS_VERSION = "2022-11-02";
const encoder = new TextEncoder();

const b64 = (bytes) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
};

export function containerUrl(env, container = env.AZURE_CONTAINER || "movies") {
  return `https://${env.AZURE_ACCOUNT}.blob.core.windows.net/${container}`;
}

/** The public URL of one blob. The container is public-read; the URL is the handle. */
export function publicBlobUrl(env, blob, container) {
  const path = String(blob).split("/").map(encodeURIComponent).join("/");
  return `${containerUrl(env, container)}/${path}`;
}

const azureTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * @param {object} env          AZURE_ACCOUNT, AZURE_KEY, AZURE_CONTAINER
 * @param {object} options      blob, permissions ("rcw", "cw", "d", "r"), minutes
 * @returns {Promise<string>}   full URL, SAS in the query string
 */
export async function blobSas(env, {
  blob, permissions, minutes = 60, container = env.AZURE_CONTAINER || "movies", startMs, expiryMs,
}) {
  if (!env.AZURE_ACCOUNT || !env.AZURE_KEY) throw new Error("Azure is not configured");

  const now = Date.now();
  const start = azureTime(startMs ?? now - 5 * 60 * 1000); // tolerate runner clock skew
  const expiry = azureTime(expiryMs ?? now + minutes * 60 * 1000);
  const canonical = `/blob/${env.AZURE_ACCOUNT}/${container}/${blob}`;

  const fields = [
    permissions,   // signedPermissions
    start,         // signedStart
    expiry,        // signedExpiry
    canonical,     // canonicalizedResource
    "",            // signedIdentifier
    "",            // signedIP
    "https",       // signedProtocol
    SAS_VERSION,   // signedVersion
    "b",           // signedResource (b = one blob)
    "",            // signedSnapshotTime
    "",            // signedEncryptionScope
    "",            // rscc
    "",            // rscd
    "",            // rsce
    "",            // rscl
    "",            // rsct
  ];
  const stringToSign = fields.join("\n");

  const key = Uint8Array.from(atob(env.AZURE_KEY), (c) => c.charCodeAt(0));
  const hmac = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = b64(await crypto.subtle.sign("HMAC", hmac, encoder.encode(stringToSign)));

  const query = new URLSearchParams({
    sv: SAS_VERSION,
    sr: "b",
    sp: permissions,
    st: start,
    se: expiry,
    spr: "https",
    sig: signature,
  });
  return `${publicBlobUrl(env, blob, container)}?${query.toString()}`;
}

/** Azure wants block IDs to be equal-length base64 strings. */
export const blockId = (index) => btoa(`block-${String(index).padStart(6, "0")}`);
