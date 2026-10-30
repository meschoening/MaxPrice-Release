import { connect } from "node:net";

// HTTP/1.1 to 127.0.0.1 over a TCP socket of its own: the operator commands'
// requests to a running Hub (operator-client.ts, ADR-0127 §7), and `page`'s
// /healthz check (page-publish.ts, ADR-0125 §4). Not `fetch`:
// on Bun 1.3.14 both `fetch` and `node:http` send even
// `http://127.0.0.1:<port>` through HTTP_PROXY or http_proxy when either is
// set, Authorization header and body included, so the operator token, a
// session key or a password would cross the proxy, and a remote proxy's 502
// would fail every command. NO_PROXY is no cure: `localhost` in it does not
// cover 127.0.0.1, Bun reads no_proxy over NO_PROXY, and a value set at run
// time does not always reach Bun's native side. A socket takes no proxy.
//
// One request per connection, `Connection: close`. The answer is read until
// its body is whole, framed by `Transfer-Encoding: chunked` (decoded), else
// its Content-Length, else the connection's close. A signal, when given,
// ends the socket at once, whatever part of the answer is still to come.
//
// A connection that fails rejects with the socket's error, its `code` the
// errno's (ECONNREFUSED); an answer that is not HTTP/1.x, or ends before it
// is whole, with code EPROTO; an aborted request with code ABORT_ERR.

export type LoopbackRequest = {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  // Sent as UTF-8, with its Content-Length.
  body?: string;
  signal?: AbortSignal;
};

export type LoopbackAnswer = {
  status: number;
  // By lowercased name; a repeated header's values joined with ", ".
  headers: Record<string, string>;
  // Decoded as UTF-8.
  body: string;
};

// More than any Hub answer's head, so a listener that never ends one is cut
// short rather than buffered.
const MAX_HEAD_BYTES = 64 * 1024;
const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

type Head = { status: number; headers: Record<string, string>; bodyStart: number };

function coded(message: string, code: string, name = "Error"): Error {
  return Object.assign(new Error(message), { name, code });
}

function malformed(what: string): Error {
  return coded(`the answer is not HTTP/1.x: ${what}`, "EPROTO");
}

function cutShort(ended: boolean): null {
  if (ended) throw malformed("it ended before it was whole");
  return null;
}

// The status line and headers, once the blank line that ends them is in.
function parseHead(received: Buffer): Head | null {
  const end = received.indexOf(HEAD_END);
  if (end === -1) {
    if (received.length > MAX_HEAD_BYTES) throw malformed("its head never ends");
    return null;
  }
  const [statusLine = "", ...lines] = received.subarray(0, end).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
  if (status === null) throw malformed("its status line");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw malformed("a header line");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { status: Number(status[1]), headers, bodyStart: end + HEAD_END.length };
}

// A chunked body's content, once its last chunk and trailers are in.
function dechunk(data: Buffer, ended: boolean): Buffer | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = data.indexOf(CRLF, at);
    if (lineEnd === -1) return cutShort(ended);
    // The size, before any chunk extension.
    const size = data.subarray(at, lineEnd).toString("latin1").split(";")[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(size)) throw malformed("a chunk size");
    const length = parseInt(size, 16);
    at = lineEnd + CRLF.length;
    if (length === 0) {
      // Trailers, which nothing here reads, then the blank line.
      for (;;) {
        const trailerEnd = data.indexOf(CRLF, at);
        if (trailerEnd === -1) return cutShort(ended);
        if (trailerEnd === at) return Buffer.concat(parts);
        at = trailerEnd + CRLF.length;
      }
    }
    if (data.length < at + length + CRLF.length) return cutShort(ended);
    if (!data.subarray(at + length, at + length + CRLF.length).equals(CRLF)) {
      throw malformed("a chunk's end");
    }
    parts.push(data.subarray(at, at + length));
    at += length + CRLF.length;
  }
}

// The body, once it is whole, by the head's framing.
function bodyOf(head: Head, received: Buffer, ended: boolean): Buffer | null {
  // 1xx, 204 and 304 answers carry none.
  if (head.status < 200 || head.status === 204 || head.status === 304) return Buffer.alloc(0);
  const data = received.subarray(head.bodyStart);
  const coding = head.headers["transfer-encoding"];
  if (coding !== undefined && /(?:^|,)\s*chunked\s*$/i.test(coding)) return dechunk(data, ended);
  const length = coding === undefined ? head.headers["content-length"] : undefined;
  if (length !== undefined) {
    if (!/^\d+$/.test(length)) throw malformed("its Content-Length");
    const bytes = Number(length);
    return data.length >= bytes ? data.subarray(0, bytes) : cutShort(ended);
  }
  return ended ? data : null;
}

function requestBytes({ port, method, path, headers = {}, body }: LoopbackRequest): Buffer {
  const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
  const lines = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  // A GET with no body sends no length (RFC 9110 §8.6); any other method
  // says it has none.
  if (payload !== undefined) lines.push(`Content-Length: ${payload.length}`);
  else if (method !== "GET" && method !== "HEAD") lines.push("Content-Length: 0");
  // No part of the head may break a line, or it would write a header of its
  // own: fetch refuses the same.
  if (lines.some((line) => /[\r\n\0]/.test(line)) || /\s/.test(method + path)) {
    throw new TypeError("a request line or header holds a character HTTP does not allow");
  }
  const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
  return payload === undefined ? head : Buffer.concat([head, payload]);
}

export function loopbackRequest(request: LoopbackRequest): Promise<LoopbackAnswer> {
  const { port, signal } = request;
  return new Promise((resolve, reject) => {
    const aborted = () => coded("the request was aborted", "ABORT_ERR", "AbortError");
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    let bytes: Buffer;
    try {
      bytes = requestBytes(request);
    } catch (error) {
      reject(error);
      return;
    }
    const socket = connect({ host: "127.0.0.1", port });
    let received = Buffer.alloc(0);
    let head: Head | null = null;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      finish();
    };
    const onAbort = () => settle(() => reject(aborted()));
    // Whether what has arrived is the whole answer; `ended`, that no more
    // will.
    const look = (ended: boolean) => {
      if (settled) return;
      try {
        head ??= parseHead(received);
        if (head === null) {
          cutShort(ended);
          return;
        }
        const content = bodyOf(head, received, ended);
        if (content === null) return;
        const { status, headers } = head;
        settle(() => resolve({ status, headers, body: content.toString("utf8") }));
      } catch (error) {
        settle(() => reject(error));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      look(false);
    });
    socket.on("end", () => look(true));
    socket.on("close", () => look(true));
    socket.on("error", (error) => settle(() => reject(error)));
    // Buffered until the connection is up. The write side stays open: a
    // server may read an early end as the client gone.
    socket.write(bytes);
  });
}
