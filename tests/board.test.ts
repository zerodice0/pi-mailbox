import { expect, test } from "bun:test";
import { BOARD_KEYS, MailboxBoard, boardPlacement, type BoardSnapshot } from "../src/board.ts";
import type { InboxItem } from "../src/types.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const deps = {
  truncateToWidth: (text: string, width: number) => [...strip(text)].slice(0, width).join(""),
  visibleWidth: (text: string) => [...strip(text)].length,
  wrapTextWithAnsi: (text: string, width: number) => text.match(new RegExp(`.{1,${width}}`, "g")) ?? [""],
  matchesKey: (data: string, key: string) => data === key,
};
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keybindings = { matches: (data: string, binding: string) =>
  ({ "tui.select.up": "up", "tui.select.down": "down", "tui.select.cancel": "escape", "tui.select.confirm": "enter" } as Record<string, string>)[binding] === data };

function item(index: number, overrides: Partial<InboxItem> = {}): InboxItem {
  return { message_id: `message-${index}`, thread_id: `thread-${index}`, kind: "action", urgency: null, target_message_id: null,
    sender: `sender-${index}`, subject: `subject ${index}`, preview: `body ${index}`, state: "queued", created_at: index, ...overrides };
}

function harness(items: InboxItem[], bounds = { row: 1, col: 40, width: 60, height: 12 }) {
  const snapshot: BoardSnapshot = { title: "HAM mailbox", summary: "HAM ✉ 2", items, urgent: new Set() };
  const placement = boardPlacement();
  let closed = 0, renders = 0;
  const board = new MailboxBoard({ snapshot: () => snapshot, placement, bounds: () => bounds, theme, keybindings, deps,
    requestRender: () => { renders++; }, close: () => { closed++; } });
  return { board, placement, snapshot, bounds, get closed() { return closed; }, get renders() { return renders; } };
}

const mouse = (type: "press" | "drag" | "release" | "click" | "wheel", x: number, y: number, screenX: number, screenY: number,
               extra: { wheelDelta?: number } = {}) =>
  ({ type, button: type === "wheel" ? "none" : "left", x, y, screenX, screenY, width: 60, height: 12, shift: false, alt: false,
    ctrl: false, ...extra }) as const;

test("the board renders a bordered box at the given width and reads live state", () => {
  const h = harness([item(1)]);
  const lines = h.board.render(60);
  expect(lines.every(line => deps.visibleWidth(line) === 60)).toBe(true);
  expect(strip(lines[0])).toStartWith("╭─ HAM mailbox · 1 shown");
  expect(strip(lines.at(-1)!)).toStartWith("╰─ ↑↓ select");
  h.snapshot.items.push(item(2));
  expect(h.board.render(60).some(line => line.includes("sender-2"))).toBe(true);
});

test("both board keys, Esc and q close it; arrows select", () => {
  expect([...BOARD_KEYS]).toEqual(["alt+m", "ctrl+shift+m"]);
  for (const key of [...BOARD_KEYS, "escape", "q"]) {
    const h = harness([item(1), item(2)]);
    h.board.handleInput(key);
    expect(h.closed).toBe(1);
  }
  const h = harness([item(1), item(2)]);
  h.board.handleInput("down");
  expect(h.board.render(60).find(line => line.includes("›"))).toContain("sender-2");
});

test("dragging the title row moves the board and keeps the clamped position on release", () => {
  const h = harness([item(1)]);
  expect(h.board.handleMouse(mouse("press", 5, 0, 45, 1))).toEqual({ capture: true, focus: true });
  h.board.handleMouse(mouse("drag", 5, 0, 20, 8));
  expect([h.placement.row, h.placement.col]).toEqual([8, 15]);
  h.board.handleMouse(mouse("drag", 5, 0, 2, -3));
  expect([h.placement.row, h.placement.col]).toEqual([0, 0]);
  h.board.handleMouse(mouse("release", 5, 0, 2, -3));
  // On release the board snaps to where pi-tui actually rendered it.
  expect([h.placement.row, h.placement.col]).toEqual([1, 40]);
  // A press below the title does not start a drag.
  h.board.handleMouse(mouse("press", 5, 3, 45, 4));
  h.board.handleMouse(mouse("drag", 5, 3, 10, 10));
  expect([h.placement.row, h.placement.col]).toEqual([1, 40]);
});

test("shift+arrows move from the rendered position; clicks and the wheel select", () => {
  const h = harness([item(1), item(2), item(3)]);
  h.board.handleInput("shift+down");
  expect([h.placement.row, h.placement.col]).toEqual([2, 40]);
  Object.assign(h.bounds, { row: 2 });  // pi-tui re-rendered it there
  h.board.handleInput("shift+left");
  expect([h.placement.row, h.placement.col]).toEqual([2, 38]);
  h.board.render(60);
  h.board.handleMouse(mouse("click", 5, 3, 45, 4));
  expect(h.board.render(60).find(line => line.includes("›"))).toContain("sender-3");
  h.board.handleMouse(mouse("wheel", 5, 3, 45, 4, { wheelDelta: -2 }));
  expect(h.board.render(60).find(line => line.includes("›"))).toContain("sender-2");
});
