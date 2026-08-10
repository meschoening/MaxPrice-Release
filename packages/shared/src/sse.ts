// Shared SSE frame splitter. `splitSseFrames` is copied verbatim from
// apps/hub-desktop/src/lib/hub-stream.ts so both the hub-desktop stream reader
// and the sidecar's hub-client can share one spec-correct, CRLF-aware framer.
// (A later wave repoints hub-stream.ts at this copy and deletes the local one.)

export type SseFrame = { event: string; data: string };

// Pure SSE framer. SSE frames are separated by a blank line; each frame's
// `event:` / `data:` fields are extracted (multiple `data:` lines join with
// \n per the spec), comment lines (leading ':') and the heartbeat colon-line
// are skipped. The trailing partial block is returned as `remainder`; feed it
// back as the next call's `carry`.
export function splitSseFrames(
  carry: string,
  chunk: string,
): { frames: SseFrame[]; remainder: string } {
  const combined = (carry + chunk).replace(/\r\n/g, "\n");
  const blocks = combined.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length > 0 || event !== "message") {
      frames.push({ event, data: dataLines.join("\n") });
    }
  }
  return { frames, remainder };
}
