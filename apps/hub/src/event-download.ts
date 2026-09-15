import type { HubEventsPullResponse } from "@maxprice/shared";

const MIN_GZIP_BYTES = 1024;

// An explicit gzip preference overrides wildcard acceptance, including q=0.
function acceptsGzip(header: string | undefined): boolean {
  let wildcard = false;
  let gzipAccepted: boolean | undefined;
  for (const entry of (header ?? "").split(",")) {
    const [coding, ...params] = entry.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    const accepted = Number.isFinite(q) && q > 0 && q <= 1;
    if (coding === "gzip") gzipAccepted = accepted;
    else wildcard = accepted;
  }
  return gzipAccepted ?? wildcard;
}

// A page is capped at 5,000 rows. Bun's native level-1 gzip keeps compression
// bounded to one page; node:zlib's async wrapper was much slower in the Windows
// compiled-build benchmark. Snapshot and compress the same envelope atomically.
export function eventDownloadResponse(
  page: HubEventsPullResponse,
  acceptEncoding: string | undefined,
): Response {
  const json = JSON.stringify(page);
  const headers = new Headers({ "content-type": "application/json", vary: "Accept-Encoding" });
  if (Buffer.byteLength(json) < MIN_GZIP_BYTES || !acceptsGzip(acceptEncoding)) {
    return new Response(json, { headers });
  }
  const compressed = Bun.gzipSync(Buffer.from(json), { level: 1 });
  headers.set("content-encoding", "gzip");
  return new Response(compressed, { headers });
}
