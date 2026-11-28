/**
 * Receiver trace: one JSON object per line saying why queued mail waited and how it was delivered.
 * The receiver's in-memory state is overwritten as soon as mail is delivered, so this file is what a
 * later "why was this mail not processed for two hours" question is answered from.
 * It records reasons and counts only; never mail bodies, prompts or typed text.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A trace file is cut back to its newer half when it grows past this many bytes. */
export const TRACE_LIMIT = 256 * 1024;
/** Trace files of sessions that have not written for this long are removed when a receiver starts. */
export const TRACE_KEEP_MS = 14 * 86400000;

export interface TraceLine { at: string; event: string; [field: string]: unknown }

export class Trace {
  readonly file: string;
  constructor(root: string, session: string, private now: () => number = Date.now) {
    const directory = path.join(root, "trace");
    this.file = path.join(directory, path.basename(session).replace(/\.jsonl$/, "") + ".jsonl");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name);
        if (file !== this.file && this.now() - statSync(file).mtimeMs > TRACE_KEEP_MS) rmSync(file, { force: true });
      }
    } catch { /* diagnostics only */ }
  }
  write(event: string, fields: Record<string, unknown> = {}): void {
    try {
      appendFileSync(this.file, JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...fields }) + "\n", { mode: 0o600 });
      if (statSync(this.file).size <= TRACE_LIMIT) return;
      const text = readFileSync(this.file, "utf8");
      writeFileSync(this.file, text.slice(text.indexOf("\n", text.length - TRACE_LIMIT / 2) + 1), { mode: 0o600 });
    } catch { /* diagnostics only: a full disk must not stop mail */ }
  }
  /** The newest `count` lines, oldest first. */
  tail(count: number): TraceLine[] {
    try {
      return readFileSync(this.file, "utf8").trimEnd().split("\n").slice(-count).flatMap(line => {
        try { return [JSON.parse(line) as TraceLine]; } catch { return []; }
      });
    } catch { return []; }
  }
}

/**
 * What kind of terminal input last counted as typing, without recording what was typed:
 * "text", "control", "paste", "csi-u"/"csi-~" for keys, another single escape sequence verbatim (so a
 * terminal reply mistaken for typing can be identified), or "escape(n)".
 */
export function inputKind(data: string): string {
  if (data.startsWith("\x1b[200~")) return "paste";
  if (data.startsWith("\x1b")) {
    if (!/^\x1b[\[O][\d;:<>?$ ]*[A-Za-z~]$/.test(data)) return `escape(${data.length})`;
    // CSI u and CSI ~ carry the key itself; keep only their shape.
    return /[u~]$/.test(data) ? `csi-${data.at(-1)}` : JSON.stringify(data).slice(1, -1);
  }
  if (data.length > 1) return "text";
  return data < " " || data === "\x7f" ? "control" : "text";
}
