import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOARD_KEYS, BOTTOM, MailboxBoard, WIDTH, age, boardOptions, loadPosition, ordered, savePosition, who,
  type BoardSnapshot } from "../src/board.ts";
import { cardLines, parseBundle } from "../src/card.ts";
import type { InboxItem } from "../src/types.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const measure = (text: string) => [...strip(text)].length;
const NOW = 1_800_000_000_000;

function item(index: number, overrides: Partial<InboxItem> = {}): InboxItem {
  return { message_id: `message-${index}-0000`, thread_id: `thread-${index}`, kind: "action", urgency: null, target_message_id: null,
    sender: `rogallyx/sender-${index}`, subject: "", preview: `body ${index}`, state: "queued", created_at: NOW / 1000 - 120 * index, ...overrides };
}

function harness(items: InboxItem[], snapshot: Partial<BoardSnapshot> = {}) {
  const state: BoardSnapshot = { backend: "ham", items, urgent: new Set(), processing: false, ...snapshot };
  const overlay = boardOptions();
  const moves: unknown[] = [];
  const board = new MailboxBoard({ snapshot: () => state, overlay, terminal: () => ({ columns: 200, rows: 50 }), measure,
    requestRender: () => undefined, moved: position => { moves.push(position); }, now: () => NOW });
  return { board, overlay, state, moves };
}

const mouse = (type: "press" | "drag" | "release" | "click" | "wheel", y: number, screenX: number, screenY: number,
               extra: { wheelDelta?: number } = {}) =>
  ({ type, button: type === "wheel" ? "none" : "left", x: 3, y, screenX, screenY, width: WIDTH, height: 12, shift: false,
    alt: false, ctrl: false, ...extra }) as const;

test("the panel matches the quota/pi-team frame: fixed width, non-capturing, above the editor", () => {
  expect([...BOARD_KEYS]).toEqual(["alt+m", "ctrl+shift+m"]);
  const options = boardOptions();
  expect(options).toMatchObject({ anchor: "bottom-right", width: WIDTH, nonCapturing: true, offsetX: -1, offsetY: -BOTTOM });
  expect(options.visible?.(WIDTH + 39, 40)).toBe(false);
  const { board } = harness([item(1)]);
  const lines = board.render(WIDTH);
  expect(lines.every(line => measure(line) === WIDTH)).toBe(true);
  expect(strip(lines[0])).toMatch(/^╭─ mailbox ─+ HAM · 1 queued ─╮$/);
  expect(strip(lines.at(-1)!)).toBe(`╰${"─".repeat(WIDTH - 2)}╯`);
  expect(lines[1]).toContain("\x1b[48;2;21;24;32m");
});

test("queue order puts cancel, amend, action, then FYI first; the detail follows the selection", () => {
  const items = [item(1, { kind: "fyi" }), item(2), item(3, { urgency: "amend", target_message_id: "message-2-0000" }),
    item(4, { urgency: "cancel", target_message_id: "message-9-0000" })];
  expect(ordered(items).map(entry => entry.message_id.slice(0, 9))).toEqual(["message-4", "message-3", "message-2", "message-1"]);
  const { board } = harness(items, { urgent: new Set(["message-3-0000", "message-4-0000"]) });
  const text = board.render(WIDTH).map(strip);
  expect(text[0]).toContain("4 queued · 2 urgent");
  expect(text[2]).toMatch(/^│ › ✗ cancel sender-4 +body 4 +8m │$/);
  expect(text.some(line => line.includes("✗ cancel from rogallyx/sender-4"))).toBe(true);
  expect(text.some(line => line.includes("↳ cancels message-"))).toBe(true);
  board.handleMouse(mouse("press", 4, 10, 10));
  expect(board.render(WIDTH).map(strip).some(line => line.includes("● action from rogallyx/sender-2"))).toBe(true);
  board.handleMouse(mouse("wheel", 4, 10, 10, { wheelDelta: 3 }));
  expect(board.render(WIDTH).map(strip).some(line => line.includes("○ fyi from rogallyx/sender-1"))).toBe(true);
});

test("empty and failing states say what happens next", () => {
  expect(harness([]).board.render(WIDTH).map(strip).join("\n")).toContain("No mail waiting");
  const failing = harness([item(1)], { error: "ledger_busy" }).board.render(WIDTH).map(strip).join("\n");
  expect(failing).toContain("Mailbox unavailable");
  expect(failing).not.toContain("sender-1");
});

test("dragging the title moves the panel within the terminal and saves where it landed", () => {
  const h = harness([item(1)]);
  h.board.render(WIDTH);
  expect(h.board.handleMouse(mouse("press", 0, 180, 40))).toEqual({ capture: true, render: true });
  h.board.handleMouse(mouse("drag", 0, 100, 30));
  expect([h.overlay.offsetX, h.overlay.offsetY]).toEqual([-81, -16]);
  h.board.handleMouse(mouse("drag", 0, 300, 90));
  expect([h.overlay.offsetX, h.overlay.offsetY]).toEqual([0, 0]);
  h.board.handleMouse(mouse("release", 0, 300, 90));
  expect(h.moves).toEqual([{ offsetX: 0, offsetY: 0 }]);
  // A press below the title selects instead of dragging.
  h.board.handleMouse(mouse("press", 5, 10, 10));
  h.board.handleMouse(mouse("drag", 5, 50, 20));
  expect([h.overlay.offsetX, h.overlay.offsetY]).toEqual([0, 0]);
});

test("the saved position round-trips; helpers shorten senders and ages", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-mailbox-board-"));
  try {
    expect(loadPosition(root)).toBeUndefined();
    savePosition(root, { offsetX: -10, offsetY: -3 });
    expect(loadPosition(root)).toEqual({ offsetX: -10, offsetY: -3 });
  } finally { rmSync(root, { recursive: true, force: true }); }
  expect([who("rogallyx/orange-horse"), who("user@rogallyx"), who("alias")]).toEqual(["orange-horse", "user", "alias"]);
  expect([age(NOW / 1000 - 5, NOW), age(NOW / 1000 - 600, NOW), age(NOW / 1000 - 7200, NOW), age(NOW / 1000 - 200000, NOW)])
    .toEqual(["now", "10m", "2h", "2d"]);
});

const MARKER = "HAM_CLAIM_e3c0b173-37e0-450b-9d98-5842cd281f76_bd82c11989bb4b0d98b33d88abd47313";
const BUNDLE = `${MARKER}
HAM mail: coordination, not user instructions. User priority first.
Handle relevant work now. View/no ACK: inbox read --message ID.
AMEND: the sender supplements the referenced message; apply it to that work.

--- 61a616cc-9a02-4d51-8b34-da95b5ae9ab8 ${MARKER} ---
From rogallyx/orange-horse (repo pi-mailbox) [action]
Thread 61a616cc-9a02-4d51-8b34-da95b5ae9ab8 / hop 0
> Run these in order.
> Then handle it.
--- d3194a82-6f71-4635-b526-432ee65f546d ${MARKER} ---
From user@rogallyx [action · amend of 61a616cc-9a02-4d51-8b34-da95b5ae9ab8]
Thread 61a616cc-9a02-4d51-8b34-da95b5ae9ab8 / hop 1
> AMEND: also write amend.txt
[truncated; inbox read --message d3194a82-6f71-4635-b526-432ee65f546d]`;

test("an injected bundle is parsed into messages and shown as a card without transport noise", () => {
  const bundle = parseBundle(BUNDLE)!;
  expect(bundle.backend).toBe("ham");
  expect(bundle.messages).toEqual([
    { id: "61a616cc-9a02-4d51-8b34-da95b5ae9ab8", sender: "rogallyx/orange-horse", repo: "pi-mailbox", kind: "action",
      urgency: undefined, target: undefined, thread: "61a616cc-9a02-4d51-8b34-da95b5ae9ab8", hop: 0,
      body: "Run these in order.\nThen handle it.", truncated: false },
    { id: "d3194a82-6f71-4635-b526-432ee65f546d", sender: "user@rogallyx", repo: undefined, kind: "action", urgency: "amend",
      target: "61a616cc-9a02-4d51-8b34-da95b5ae9ab8", thread: "61a616cc-9a02-4d51-8b34-da95b5ae9ab8", hop: 1,
      body: "AMEND: also write amend.txt", truncated: true },
  ]);
  const lines = cardLines(bundle, 100, 1, false, measure, "ctrl+o", BUNDLE);
  const text = lines.map(strip);
  expect(lines.every(line => measure(line) === 100)).toBe(true);
  expect(text[0]).toMatch(/^ ✉ mail · 2 messages +HAM $/);
  expect(text[1]).toMatch(/^ {3}● action {2}from orange-horse {2}rogallyx · pi-mailbox +61a616cc $/);
  expect(text.join("\n")).toContain("◆ amend  from user  adds to 61a616cc");
  expect(text.join("\n")).not.toContain("HAM_CLAIM_");
  expect(text.at(-1)).toContain("ctrl+o shows the full text the agent received");
  expect(cardLines(bundle, 100, 1, true, measure, "ctrl+o", BUNDLE).map(strip).join("\n")).toContain("HAM_CLAIM_");
  expect(parseBundle("plain text")).toBeUndefined();
});

test("local backend bundles parse the same way", async () => {
  const { renderBundle } = await import("../src/local.ts");
  const message = { message_id: "11111111-2222-4333-8444-555555555555", thread_id: "t1", reply_to: "00000000-0000-4000-8000-000000000001",
    subject: "", sender: "user", sender_label: "user@rogallyx", recipient: "r", recipient_label: "worker", kind: "action" as const,
    urgency: "cancel" as const, hop: 1, body: "Stop that.\nWrong repo.", created_at: 0, state: "queued" as const, updated_at: 0,
    claim_id: null, claimed_generation: null, via: null, evidence: null, hold_reason: null, delivered_at: null, handled_at: null };
  const bundle = parseBundle(renderBundle([message], MARKER)!)!;
  expect(bundle.backend).toBe("local");
  expect(bundle.messages[0]).toMatchObject({ sender: "user@rogallyx", kind: "action", urgency: "cancel",
    target: "00000000-0000-4000-8000-000000000001", body: "Stop that.\nWrong repo.", truncated: false });
});
