export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

// RFC 3986 encoding of one path segment, as SigV4 requires.
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Builds a SigV4-signed, path-style PUT request (`{endpoint}/{bucket}/{key}`), which works
 * against AWS S3 and S3-compatible stores (R2, MinIO, DigitalOcean Spaces, Backblaze B2, ...).
 */
export async function buildS3PutRequest(
  target: S3Target,
  key: string,
  body: string | Uint8Array,
  contentType: string,
  now: Date = new Date()
): Promise<Request> {
  const base = new URL(target.endpoint);
  const basePath = base.pathname.replace(/\/+$/, "");
  const canonicalPath = `${basePath}/${[target.bucket, ...key.split("/")].map(encodeSegment).join("/")}`;

  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    canonicalPath,
    "",
    `content-type:${contentType}`,
    `host:${base.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let signingKey = await hmac(encoder.encode(`AWS4${target.secretAccessKey}`), dateStamp);
  for (const part of [target.region, "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = toHex(await hmac(signingKey, stringToSign));

  return new Request(`${base.origin}${canonicalPath}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
}
