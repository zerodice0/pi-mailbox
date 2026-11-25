/**
 * View-only mailbox board: a bordered overlay that reads the live mailbox state on every
 * render, so it updates while open. Opening, scrolling or selecting never acknowledges mail.
 *
 * Moving: drag the title row with the mouse (pi fullscreen mode routes mouse events to
 * overlays), or use shift+arrows. The placement object is shared with the overlay options
 * (pi-tui reads row/col on every render and clamps them to the terminal), so the position
 * survives closing and reopening within the session.
 */
import type { Component, OverlayBounds, OverlayOptions, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { InboxItem } from "./types.ts";

export const BOARD_KEYS = ["alt+m", "ctrl+shift+m"] as const;

/** pi-tui helpers, injected so the board stays testable without a terminal. */
export interface BoardDeps {
  truncateToWidth(text: string, width: number, ellipsis?: string, pad?: boolean): string;
  visibleWidth(text: string): number;
  wrapTextWithAnsi(text: string, width: number): string[];
  matchesKey(data: string, key: string): boolean;
}
export interface BoardTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}
export interface BoardKeybindings { matches(data: string, binding: string): boolean }
export interface BoardSnapshot { title: string; summary: string; items: InboxItem[]; urgent: ReadonlySet<string> }

/** Overlay options owned by the mailbox for the whole session; row/col appear once the board is moved. */
export function boardPlacement(): OverlayOptions {
  return { anchor: "top-right", width: "60%", minWidth: 40, maxHeight: "80%", margin: 1 };
}

const LIST_ROWS = 8;
const DETAIL_ROWS = 6;

export class MailboxBoard implements Component {
  private selected = 0;
  private drag?: { dx: number; dy: number };
  /** Screen rows of the list items from the last render, relative to the board top. */
  private listTop = 0;
  private listStart = 0;

  constructor(private readonly options: {
    snapshot: () => BoardSnapshot;
    placement: OverlayOptions;
    bounds: () => OverlayBounds | undefined;
    theme: BoardTheme;
    keybindings: BoardKeybindings;
    deps: BoardDeps;
    requestRender: () => void;
    close: () => void;
  }) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { theme, deps } = this.options;
    const { title, summary, items, urgent } = this.options.snapshot();
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const inner = Math.max(10, width - 4);
    const border = (text: string) => theme.fg("border", text);
    const row = (content: string) => {
      const cell = deps.truncateToWidth(content, inner, "…");
      return border("│") + " " + cell + " ".repeat(Math.max(0, inner - deps.visibleWidth(cell))) + " " + border("│");
    };
    const rule = (left: string, label: string, right: string) => {
      const text = label ? deps.truncateToWidth(label, Math.max(0, width - 5), "…") : "";
      const fill = Math.max(0, width - 2 - (text ? deps.visibleWidth(text) + 2 : 0) - 1);
      return border(left + "─") + (text ? " " + text + " " : "") + border("─".repeat(fill) + right);
    };

    const lines = [rule("╭", theme.fg("accent", theme.bold(title)) + theme.fg("dim", ` · ${items.length} shown · ${summary}`), "╮")];
    if (!items.length) {
      this.listTop = 1; this.listStart = 0;
      lines.push(row(theme.fg("dim", "No queued mail.")));
    } else {
      this.listStart = Math.max(0, Math.min(this.selected - Math.floor(LIST_ROWS / 2), items.length - LIST_ROWS));
      this.listTop = lines.length;
      for (const [offset, item] of items.slice(this.listStart, this.listStart + LIST_ROWS).entries()) {
        const index = this.listStart + offset;
        const tag = item.urgency ? `[${item.urgency}]` : `[${item.kind}]`;
        const color = item.urgency === "cancel" ? "error" : item.urgency === "amend" || urgent.has(item.message_id)
          ? "warning" : item.kind === "action" ? "accent" : "muted";
        const state = item.state === "delivering" ? " (delivering)" : "";
        const head = `${index === this.selected ? theme.fg("accent", "›") : " "} ${theme.fg(color, tag)} ${item.sender}${state} — ${item.subject || item.preview}`;
        lines.push(row(index === this.selected ? theme.bold(head) : head));
      }
      if (items.length > LIST_ROWS) lines.push(row(theme.fg("dim", `(${this.selected + 1}/${items.length})`)));
      const current = items[this.selected];
      lines.push(border("├" + "─".repeat(Math.max(0, width - 2)) + "┤"));
      if (current.urgency) lines.push(row(theme.fg("warning", `${current.urgency} of ${current.target_message_id}`)));
      for (const line of deps.wrapTextWithAnsi(current.preview || "(empty)", inner).slice(0, DETAIL_ROWS)) lines.push(row(line));
      lines.push(row(theme.fg("dim", current.message_id)));
    }
    lines.push(rule("╰", theme.fg("dim", "↑↓ select · drag title or shift+arrows move · Esc close · view only"), "╯"));
    return lines;
  }

  handleInput(data: string): void {
    const { keybindings, deps, close } = this.options;
    const count = this.options.snapshot().items.length;
    const move = ([["shift+up", 0, -1], ["shift+down", 0, 1], ["shift+left", -2, 0], ["shift+right", 2, 0]] as const)
      .find(([key]) => deps.matchesKey(data, key));
    if (move) this.moveBy(move[1], move[2]);
    else if (keybindings.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (keybindings.matches(data, "tui.select.down")) this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
    else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm") || data === "q" ||
             BOARD_KEYS.some(key => deps.matchesKey(data, key))) { close(); return; }
    else return;
    this.options.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.drag) {
      if (event.type === "drag" || event.type === "move") {
        this.place(event.screenY - this.drag.dy, event.screenX - this.drag.dx);
        return { handled: true, render: true };
      }
      if (event.type === "release") {
        this.drag = undefined;
        // Keep the clamped on-screen position, not wherever the pointer left the terminal.
        const bounds = this.options.bounds();
        if (bounds) this.place(bounds.row, bounds.col);
        return { handled: true, render: true };
      }
    }
    if (event.type === "press" && event.button === "left" && event.y === 0) {
      this.drag = { dx: event.x, dy: event.y };
      return { capture: true, focus: true };
    }
    if (event.type === "wheel" && event.wheelDelta) {
      const count = this.options.snapshot().items.length;
      this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected + Math.sign(event.wheelDelta)));
      return { handled: true, render: true };
    }
    if ((event.type === "press" || event.type === "click") && event.button === "left") {
      const index = this.listStart + event.y - this.listTop;
      const count = this.options.snapshot().items.length;
      if (event.y >= this.listTop && event.y < this.listTop + LIST_ROWS && index >= 0 && index < count) this.selected = index;
      return { handled: true, focus: true, render: true };
    }
    return { handled: true };
  }

  private moveBy(dx: number, dy: number): void {
    // Start from the rendered (already clamped) position so moves never accumulate off-screen.
    const { placement } = this.options;
    const bounds = this.options.bounds();
    const row = bounds?.row ?? (typeof placement.row === "number" ? placement.row : 0);
    const col = bounds?.col ?? (typeof placement.col === "number" ? placement.col : 0);
    this.place(row + dy, col + dx);
  }

  private place(row: number, col: number): void {
    // pi-tui clamps absolute row/col to the terminal; only negative values need care here.
    this.options.placement.row = Math.max(0, row);
    this.options.placement.col = Math.max(0, col);
  }
}
