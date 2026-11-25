/**
 * Transcript card for an injected mail bundle (`ham_mailbox` custom message).
 *
 * The agent still receives the full bundle text (marker, handling instructions, headers,
 * quoted bodies); ACK depends on that exact text. This renderer only changes what the
 * user sees: who sent what, in the quota/pi-team palette, with the transport noise hidden.
 * The expanded view (app.tools.expand) shows the full text the agent received.
 */
import { BG, BG_OFF, fg, oneLine, paint, wrap, type Measure, type Segment, type Tone } from "./palette.ts";
import { who } from "./board.ts";

export interface BundleMessage {
  id: string; sender: string; repo?: string; kind: string; urgency?: "amend" | "cancel"; target?: string;
  thread: string; hop: number; body: string; truncated: boolean;
}
export interface Bundle { backend: "ham" | "local"; messages: BundleMessage[] }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Parse the bundle text written by HAM `ledger runtime` or the local backend; undefined if it does not match. */
export function parseBundle(content: string): Bundle | undefined {
  const marker = content.slice(0, content.indexOf("\n"));
  if (!/^HAM_CLAIM_\S+$/.test(marker)) return undefined;
  const header = new RegExp(`\\n--- (\\S+) ${escape(marker)} ---\\nFrom (.*) \\[([^\\]\\n]*)\\]\\nThread (\\S+) / hop (\\d+)\\n`, "g");
  const matches = [...content.matchAll(header)];
  if (!matches.length) return undefined;
  const messages = matches.map((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    const raw = content.slice(match.index + match[0].length, end);
    const lines = raw.split("\n");
    const quoted = lines.filter(line => line.startsWith(">")).map(line => line.replace(/^> ?/, ""));
    const [, address = match[2], repo] = /^(.*?)(?: \(repo ([^)]*)\))?$/.exec(match[2]) ?? [];
    const [, kind = match[3], urgency, target] = /^(\S+)(?: · (amend|cancel) of (\S+))?$/.exec(match[3]) ?? [];
    return { id: match[1], sender: address, repo, kind, urgency: urgency as BundleMessage["urgency"], target,
      thread: match[4], hop: Number(match[5]), body: quoted.join("\n"), truncated: lines.some(line => /^\[(truncated|body omitted);/.test(line)) };
  });
  return { backend: content.includes("\nHAM mail:") ? "ham" : "local", messages };
}

function badge(message: BundleMessage): [mark: string, tone: Tone, word: string] {
  if (message.urgency === "cancel") return ["✗", "crit", "cancel"];
  if (message.urgency === "amend") return ["◆", "warn", "amend"];
  return message.kind === "action" ? ["●", "ok", "action"] : ["○", "label", message.kind];
}

const BODY_ROWS = 4;
/** Card lines for one bundle at `width`, padded on the panel background. */
export function cardLines(bundle: Bundle, width: number, pad: number, expanded: boolean, measure: Measure,
                          expandKey: string, raw: string): string[] {
  const inner = Math.max(10, width - pad * 2);
  const line = (left: Segment[], right: Segment[] = []) => {
    const r = paint(right, Math.floor(inner / 2), measure);
    const l = paint(left, inner - r.used - (r.used ? 1 : 0), measure);
    return `${BG}${" ".repeat(pad)}${l.out}${" ".repeat(Math.max(0, inner - l.used - r.used))}${r.out}${" ".repeat(pad)}${BG_OFF}`;
  };
  const count = bundle.messages.length;
  const out = [line([["✉ ", "title"], ["mail", "title", true], [count > 1 ? ` · ${count} messages` : "", "label"]],
    [[bundle.backend === "ham" ? "HAM" : "local", "label"]])];
  let clipped = false;
  for (const message of bundle.messages) {
    const [mark, tone, word] = badge(message);
    const verb = message.urgency === "cancel" ? "cancels" : message.urgency === "amend" ? "adds to" : "";
    out.push(line([["  "], [mark, tone], [" "], [word, tone === "label" ? "name" : tone, true], ["  from ", "label"],
      [who(message.sender), "name", true], [message.sender.includes("/") ? `  ${message.sender.split("/")[0]}` : "", "label"],
      [message.repo ? ` · ${message.repo}` : "", "label"], [verb ? `  ${verb} ${message.target?.slice(0, 8)}` : "", "label"]],
      [[message.id.slice(0, 8), "label"]]));
    const body = message.body.split("\n").map(oneLine).filter(Boolean);
    const rows = expanded ? body.flatMap(text => wrap(text, inner - 4, 1000, measure))
      : wrap(body.join(" "), inner - 4, BODY_ROWS, measure);
    if (!expanded && measure(body.join(" ")) > (inner - 4) * BODY_ROWS) clipped = true;
    for (const text of rows.length ? rows : ["(empty)"]) out.push(line([["    "], [text, "name"]]));
    if (message.truncated) out.push(line([["    "], ["(shortened for the agent; the full text stays in the mailbox)", "label"]]));
  }
  if (expanded) {
    out.push(line([["  "], ["Full text the agent received:", "label", true]]));
    for (const text of raw.split("\n").flatMap(text => text.trim() ? wrap(oneLine(text), inner - 4, 1000, measure) : [""]))
      out.push(line([["    "], [text, "label"]]));
  } else {
    const hint = expandKey ? `${expandKey} shows ${clipped ? "the whole message and " : ""}the full text the agent received` : "";
    if (hint) out.push(line([["  "], [hint, "label"]]));
  }
  return out;
}
