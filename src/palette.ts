/**
 * The titanium palette and frame helpers shared with quota-panel.ts and pi-team's side
 * panel, so the mailbox reads as part of the same right-hand stack.
 *
 * Text uses name/label (both pass 4.5:1 on the panel); dim and border carry rails and rules.
 */
export const palette = {
  panel: "#151820", border: "#2a3038", title: "#d4c090", name: "#e8ecf4", label: "#9ca3b0", dim: "#6b7280",
  ok: "#00b4ff", good: "#00ff88", warn: "#ffb347", crit: "#ff4757",
} as const;
export type Tone = Exclude<keyof typeof palette, "panel">;
export type Segment = [text: string, tone?: Tone, bold?: boolean];
export interface Line { left: Segment[]; right?: Segment[] }

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
export const fg = (tone: Tone, text: string, bold = false) =>
  `${bold ? "\x1b[1m" : ""}\x1b[38;2;${rgb(palette[tone])}m${text}\x1b[39m${bold ? "\x1b[22m" : ""}`;
export const BG = `\x1b[48;2;${rgb(palette.panel)}m`;
export const BG_OFF = "\x1b[49m";

export type Measure = (text: string) => number;

/** Collapse control characters and whitespace runs: mail bodies are untrusted text. */
export const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/** Truncate plain text ourselves: pi-tui's truncateToWidth() inserts a full reset that would drop the panel background. */
export function clip(text: string, width: number, measure: Measure): string {
  if (width <= 0) return "";
  if (measure(text) <= width) return text;
  let out = "", used = 0;
  for (const ch of text) {
    const w = measure(ch);
    if (used + w > width - 1) break;
    out += ch; used += w;
  }
  return out + "…";
}

/** Word-wrap plain text into at most `lines` rows; the last row is clipped. */
export function wrap(text: string, width: number, lines: number, measure: Measure): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest && out.length < lines) {
    if (measure(rest) <= width || out.length === lines - 1) { out.push(clip(rest, width, measure)); break; }
    const chars = [...rest];
    let cut = 0, used = 0, space = -1;
    for (let i = 0; i < chars.length; i++) {
      used += measure(chars[i]);
      if (used > width) break;
      if (chars[i] === " ") space = i;
      cut = i + 1;
    }
    const at = space > width / 2 ? space : Math.max(1, cut);
    out.push(chars.slice(0, at).join("").trimEnd());
    rest = chars.slice(at).join("").trimStart();
  }
  return out;
}

/** Paint segments left to right within `width`, stopping at the first clipped segment. */
export function paint(segments: Segment[], width: number, measure: Measure): { out: string; used: number } {
  let used = 0, out = "";
  for (const [text, tone, bold] of segments) {
    if (!text) continue;
    const part = clip(text, width - used, measure);
    if (!part) break;
    used += measure(part);
    out += tone ? fg(tone, part, bold) : part;
    if (part !== text) break;
  }
  return { out, used };
}

/** One framed row on the panel background: left segments, optional right-aligned segments. */
export function row(line: Line, width: number, measure: Measure): string {
  const inner = width - 4;
  const right = line.right ? paint(line.right, Math.max(0, Math.floor(inner / 2)), measure) : { out: "", used: 0 };
  const left = paint(line.left, inner - right.used - (right.used ? 1 : 0), measure);
  const gap = " ".repeat(Math.max(0, inner - left.used - right.used));
  return `${BG}${fg("border", "│")} ${left.out}${gap}${right.out} ${fg("border", "│")}${BG_OFF}`;
}

export const rule = (width: number, [left, right]: [string, string]) =>
  `${BG}${fg("border", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`)}${BG_OFF}`;

/** Top frame row: `╭─ title ───── note ─╮`. */
export function titleRule(width: number, title: string, note: string, measure: Measure): string {
  const fill = Math.max(1, width - 2 - measure(title) - measure(note) - 2);
  return `${BG}${fg("border", "╭─")}${title}${fg("border", "─".repeat(fill))}${note}${fg("border", "─╮")}${BG_OFF}`;
}
