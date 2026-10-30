import type { LookupFunction } from "node:net";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

// A GET that goes straight to its URL's host, never through a proxy. Bun's
// fetch and node:http send even a request for 127.0.0.1 through HTTP_PROXY
// when NO_PROXY does not name it. Setting NO_PROXY around a request would
// change it for the whole process, and Bun never sees it deleted again
// (measured on Bun 1.3.14, #500). loopback-http.ts answers that with a
// socket for the Hub on 127.0.0.1; `page` also asks the web server at the Hub
// page URL, as this machine reaches it (ADR-0125 §4), any host and https
// included, which that module does not, and its parser, private to it, is
// built for one Hub's answers. So this one speaks HTTP/1.0 over a socket of
// its own: node:net for http, node:tls
// (with the default certificate checks) for https. HTTP/1.0 with
// `Connection: close`. Content-Length and chunked framing must be complete;
// without either, the server ends the body by closing. The host is resolved here, by getaddrinfo, so a name
// this machine cannot resolve fails with the resolver's own error.

export type DirectAnswer = { status: number; body: string };

export type DirectGetOptions = {
  // Ends the request, connect, redirects and body included.
  signal: AbortSignal;
  // node:net's resolver hook; getaddrinfo by default.
  lookup?: LookupFunction;
};

export type DirectGet = (url: string, options: DirectGetOptions) => Promise<DirectAnswer>;

// An answer past this, head and body together, is rejected before parsing:
// a valid-looking prefix must never stand in for the whole view.
const MAX_ANSWER_BYTES = 1 << 20;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export const directGet: DirectGet = async (url, options) => {
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    const answer = await requestOnce(target, options);
    if (!REDIRECTS.has(answer.status) || answer.location === undefined) return answer;
    if (hop === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    const next = new URL(answer.location, target);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`a redirect to ${next.protocol} is not followed`);
    }
    target = next;
  }
};

function requestOnce(
  target: URL,
  { signal, lookup }: DirectGetOptions,
): Promise<DirectAnswer & { location?: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const tls = target.protocol === "https:";
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port) || (tls ? 443 : 80);
    const lookupOption = lookup === undefined ? {} : { lookup };
    // node:tls sends a name as the SNI and checks the certificate against
    // the host by default.
    const socket: Socket = tls
      ? tlsConnect({ host, port, ...lookupOption })
      : netConnect({ host, port, ...lookupOption });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      finish();
    };
    const onAbort = () => settle(() => reject(signal.reason ?? new Error("aborted")));
    signal.addEventListener("abort", onAbort, { once: true });

    socket.once(tls ? "secureConnect" : "connect", () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (size + chunk.length > MAX_ANSWER_BYTES) {
        settle(() => reject(new Error("the answer exceeds 1 MiB")));
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    socket.on("error", (error) => settle(() => reject(error)));
    socket.once("close", () =>
      settle(() => {
        try {
          resolve(parseAnswer(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      }),
    );
  });
}

function parseAnswer(raw: Buffer): DirectAnswer & { location?: string } {
  const end = raw.indexOf("\r\n\r\n");
  if (end === -1) throw new Error("the answer was not HTTP");
  const [statusLine = "", ...headerLines] = raw.subarray(0, end).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
  if (status === null) throw new Error("the answer was not HTTP");
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("the answer has an invalid header");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  let body = raw.subarray(end + 4);
  const code = Number(status[1]);
  const coding = headers.get("transfer-encoding");
  const length = headers.get("content-length");
  if (code < 200 || code === 204 || code === 304) body = Buffer.alloc(0);
  else if (coding !== undefined) {
    if (coding.toLowerCase() !== "chunked" || length !== undefined) {
      throw new Error("the answer has unsupported or ambiguous framing");
    }
    body = dechunk(body);
  } else if (length !== undefined) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
      throw new Error("the answer has an invalid Content-Length");
    }
    if (body.length !== Number(length)) {
      throw new Error("the answer does not match its Content-Length");
    }
  }
  return {
    status: code,
    body: body.toString("utf8"),
    ...(headers.has("location") ? { location: headers.get("location") } : {}),
  };
}

// Like loopback-http.ts's decoder, require each chunk's size, data and CRLF,
// then the last chunk and all trailers' terminating blank line. This parser
// sees a closed, bounded answer, so incomplete or excess bytes are errors.
function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", at);
    if (lineEnd === -1) throw new Error("the chunked answer ended before it was whole");
    const size = body.subarray(at, lineEnd).toString("latin1").split(";")[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(size)) throw new Error("the answer has an invalid chunk size");
    const length = parseInt(size, 16);
    if (!Number.isSafeInteger(length)) throw new Error("the answer has an invalid chunk size");
    at = lineEnd + 2;
    if (length === 0) {
      for (;;) {
        const trailerEnd = body.indexOf("\r\n", at);
        if (trailerEnd === -1) throw new Error("the chunked answer ended before it was whole");
        if (trailerEnd === at) {
          if (at + 2 !== body.length) throw new Error("the chunked answer has excess bytes");
          return Buffer.concat(parts);
        }
        if (body.subarray(at, trailerEnd).indexOf(":") <= 0) {
          throw new Error("the answer has an invalid trailer");
        }
        at = trailerEnd + 2;
      }
    }
    if (body.length < at + length + 2) {
      throw new Error("the chunked answer ended before it was whole");
    }
    if (body.toString("latin1", at + length, at + length + 2) !== "\r\n") {
      throw new Error("the answer has an invalid chunk end");
    }
    parts.push(body.subarray(at, at + length));
    at += length + 2;
  }
}
