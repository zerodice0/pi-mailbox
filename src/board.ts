/**
 * Mailbox side panel: a non-capturing overlay in the quota/pi-team frame and palette, so the
 * user keeps typing while it is open. It reads the live mailbox state on every render and is
 * view-only: opening it, selecting or scrolling never acknowledges mail.
 *
 * It sits at the bottom right, above the editor, and grows upward. In fullscreen mode the
 * title row is a drag handle; clicks and the wheel choose which message the detail shows.
 * The position is an offset from that anchor, so it survives terminal resizes and restarts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OverlayOptions, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { clip, fg, oneLine, row, rule, titleRule, wrap, type Line, type Measure, type Segment, type Tone } from "./palette.ts";
import type { InboxItem } from "./types.ts";

export const BOARD_KEYS = ["alt+m", "ctrl+shift+m"] as const;
export const WIDTH = 50;
/** Rows kept free at the bottom for the editor and footer. */
export const BOTTOM = 6;
const RIGHT = 1;
const LIST_ROWS = 6;
const BODY_ROWS = 3;

export interface BoardSnapshot {
  backend: "ham" | "local";
  items: InboxItem[];
  urgent: ReadonlySet<string>;
  /** A claimed bundle is on its way into this session. */
  processing: boolean;
  /** The receiver is failing; the board says so instead of showing stale mail as current. */
  error?: string;
}
export interface Position { offsetX: number; offsetY: number }

export function boardOptions(saved?: Position): OverlayOptions {
  return {
    anchor: "bottom-right", width: WIDTH, nonCapturing: true,
    offsetX: saved?.offsetX ?? -RIGHT, offsetY: saved?.offsetY ?? -BOTTOM,
    visible: (columns, rows) => columns >= WIDTH + 40 && rows >= BOTTOM + 10,
  };
}

const positionFile = (root: string) => path.join(root, "board.json");
export function loadPosition(root: string): Position | undefined {
  try {
    const value = JSON.parse(readFileSync(positionFile(root), "utf8")) as Partial<Position>;
    return Number.isInteger(value.offsetX) && Number.isInteger(value.offsetY) ? value as Position : undefined;
  } catch { return undefined; }
}
export function savePosition(root: string, position: Position): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = `${positionFile(root)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(position), { mode: 0o600 });
    renameSync(temporary, positionFile(root));
  } catch { /* the position is a convenience */ }
}

const rank = (item: InboxItem) => item.urgency === "cancel" ? 0 : item.urgency === "amend" ? 1 : item.kind === "action" ? 2 : 3;
/** Queue order as the session will meet it: cancel, amend, action, then FYI; oldest first within each. */
export const ordered = (items: readonly InboxItem[]) => [...items].sort((a, b) => rank(a) - rank(b) || a.created_at - b.created_at);

function badge(item: InboxItem): [mark: string, tone: Tone, word: string] {
  if (item.state === "delivering") return ["◌", "label", "sending"];
  if (item.urgency === "cancel") return ["✗", "crit", "cancel"];
  if (item.urgency === "amend") return ["◆", "warn", "amend"];
  return item.kind === "action" ? ["●", "ok", "action"] : ["○", "label", item.kind];
}
/** `host/label` and `user@host` read as the label or `user`; the full address stays in the detail. */
export const who = (sender: string) => {
  const label = sender.split("/").pop() || sender;
  return label.startsWith("user@") ? "user" : label;
};
export function age(seconds: number, now: number): string {
  const elapsed = Math.max(0, now / 1000 - seconds);
  if (elapsed < 60) return "now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.floor(elapsed / 86400)}d`;
}

const SENDER = 13;
const fit = (text: string, width: number, measure: Measure) => {
  const part = clip(text, width, measure);
  return part + " ".repeat(Math.max(0, width - measure(part)));
};
export function boardLines(snapshot: BoardSnapshot, selectedId: string | undefined, inner: number, measure: Measure,
                           now = Date.now()): { lines: (Line | "rule")[]; list: string[]; listStart: number; selected?: string } {
  if (snapshot.error) return { lines: [{ left: [["Mailbox unavailable", "crit", true]] }, { left: [[oneLine(snapshot.error), "label"]] }], list: [], listStart: 0 };
  const items = ordered(snapshot.items);
  if (!items.length) return {
    lines: [
      { left: [["No mail waiting", "name", true]] },
      { left: [["Mail is handled when this session is idle", "label"]] },
      { left: [["Drag this title to move · alt+m to hide", "label"]] },
    ], list: [], listStart: 0,
  };
  const index = Math.max(0, items.findIndex(item => item.message_id === selectedId));
  const current = items[index];
  const start = Math.max(0, Math.min(index - Math.floor(LIST_ROWS / 2), items.length - LIST_ROWS));
  const shown = items.slice(start, start + LIST_ROWS);
  const lines: (Line | "rule")[] = shown.map(item => {
    const [mark, tone, word] = badge(item);
    const chosen = item === current;
    const urgent = item.urgency !== null || snapshot.urgent.has(item.message_id);
    return {
      left: [[chosen ? "›" : " ", "ok"], [" "], [mark, tone], [" "], [word.padEnd(6), urgent ? tone : "label"], [" "],
        [fit(who(item.sender), SENDER, measure), "name", chosen], [" "], [oneLine(item.subject || item.preview), "label"]],
      right: [[age(item.created_at, now), "label"]],
    } satisfies Line;
  });
  const hidden = items.length - shown.length;
  if (hidden) lines.push({ left: [["  "], [`+${hidden} more · scroll to see`, "label"]] });
  const [mark, tone, word] = badge(current);
  lines.push("rule");
  const header: Segment[] = [[mark, tone], [" "], [word, tone === "label" ? "name" : tone, true], [" from ", "label"], [current.sender, "name"]];
  lines.push({ left: header, right: [[current.message_id.slice(0, 8), "label"]] });
  if (current.target_message_id) {
    const verb = current.urgency === "cancel" ? "cancels" : current.urgency === "amend" ? "adds to" : "replies to";
    lines.push({ left: [["↳ ", "label"], [`${verb} ${current.target_message_id.slice(0, 8)}`, "label"]] });
  }
  if (current.subject) lines.push({ left: [[oneLine(current.subject), "name", true]] });
  for (const text of wrap(oneLine(current.preview) || "(empty)", inner, BODY_ROWS, measure)) lines.push({ left: [[text, "name"]] });
  return { lines, list: shown.map(item => item.message_id), listStart: start, selected: current.message_id };
}

export class MailboxBoard {
  private selectedId?: string;
  private list: string[] = [];
  /** Row of the first list item inside the rendered board. */
  private listTop = 2;
  private height = 0;
  private drag?: { x: number; y: number; ox: number; oy: number };

  constructor(private readonly options: {
    snapshot: () => BoardSnapshot;
    overlay: OverlayOptions;
    terminal: () => { columns: number; rows: number };
    measure: Measure;
    requestRender: () => void;
    moved: (position: Position) => void;
    now?: () => number;
  }) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { measure } = this.options;
    const snapshot = this.options.snapshot();
    const inner = width - 4;
    const { lines, list, selected } = boardLines(snapshot, this.selectedId, inner, measure, this.options.now?.() ?? Date.now());
    this.list = list;
    this.selectedId = selected;
    const queued = snapshot.items.length, urgent = snapshot.items.filter(item => item.urgency || snapshot.urgent.has(item.message_id)).length;
    const facts = [snapshot.backend === "ham" ? "HAM" : "local", queued ? `${queued} queued` : "empty",
      urgent && `${urgent} urgent`, snapshot.processing && "delivering"].filter(Boolean).join(" · ");
    const title = ` ${fg(this.drag ? "ok" : "title", "mailbox", true)} `;
    const note = ` ${fg(urgent ? "warn" : "label", facts)} `;
    const out = [
      titleRule(width, title, note, measure),
      row({ left: [] }, width, measure),
      ...lines.map(line => line === "rule" ? rule(width, ["├", "┤"]) : row(line, width, measure)),
      row({ left: [] }, width, measure),
      rule(width, ["╰", "╯"]),
    ];
    this.listTop = 2;
    this.height = out.length;
    return out;
  }

  /** Fullscreen mode routes mouse input to overlays, including non-capturing ones. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { overlay } = this.options;
    if (this.drag) {
      if (event.type === "drag" || event.type === "move") {
        const { columns, rows } = this.options.terminal();
        overlay.offsetX = Math.min(0, Math.max(-(columns - WIDTH), this.drag.ox + event.screenX - this.drag.x));
        overlay.offsetY = Math.min(0, Math.max(-(rows - this.height), this.drag.oy + event.screenY - this.drag.y));
        return { handled: true, capture: true, render: true };
      }
      if (event.type === "release" || event.type === "click") {
        this.drag = undefined;
        this.options.moved({ offsetX: overlay.offsetX ?? 0, offsetY: overlay.offsetY ?? 0 });
        return { handled: true, render: true };
      }
      return { handled: true, capture: true };
    }
    if (event.type === "press" && event.button === "left" && event.y === 0) {
      this.drag = { x: event.screenX, y: event.screenY, ox: overlay.offsetX ?? 0, oy: overlay.offsetY ?? 0 };
      return { capture: true, render: true };
    }
    if (event.type === "wheel" && event.wheelDelta) return this.step(Math.sign(event.wheelDelta));
    if (event.type === "press" && event.button === "left") {
      const id = this.list[event.y - this.listTop];
      if (id) { this.selectedId = id; return { handled: true, render: true }; }
    }
    // Swallow the rest so a click on the panel never starts a transcript selection underneath.
    return { handled: true };
  }

  private step(direction: number): TuiMouseEventResult {
    const items = ordered(this.options.snapshot().items);
    const index = items.findIndex(item => item.message_id === this.selectedId);
    const next = items[Math.max(0, Math.min(items.length - 1, index + direction))];
    if (next) this.selectedId = next.message_id;
    return { handled: true, render: true };
  }
}
