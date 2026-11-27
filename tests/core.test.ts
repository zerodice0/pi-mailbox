import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiMailbox, STALE_TURN_MS, acceptedEntry, isTyping, statusText, type Timers } from "../src/core.ts";
import { parseReply } from "../src/ham.ts";
import type { Call, ClaimBundle, Inspection, NativeMessage, UrgentItem } from "../src/types.ts";

const SESSION = "/tmp/pi-session.jsonl";
const AGENT = { terminal_id: "term-b", agent_id: "agent-b", generation: 3, session_ref: SESSION, alias: "blue-owl" };
const THREAD_A = "00000000-0000-4000-8000-00000000000a";
const THREAD_B = "00000000-0000-4000-8000-00000000000b";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function inspection(overrides: Partial<Inspection> = {}): Inspection {
  return { thresholds: { idle_minutes: 0, coalesce_seconds: 0, wakes_per_hour: 20, max_hop: 10 }, role: "worker",
    turn_state: "idle", wake_count: 0, pending_claims: [], has_action: false, coalesce_until: 0, urgent: [], inbox: [],
    queued_total: 0, ...overrides };
}

let claimSerial = 0;
function bundle(threads: string[], urgencies: (null | "amend" | "cancel")[] = threads.map(() => null), via = "wake"): ClaimBundle {
  const claim_id = `claim-${++claimSerial}`, marker = `HAM_CLAIM_${claim_id}_marker`;
  const content = marker + "\nHAM mail bundle " + claim_id;
  const message: NativeMessage = { customType: "ham_mailbox", content, display: true,
    details: { protocol: 1, claim_id, agent_id: AGENT.agent_id, generation: AGENT.generation, session_ref: SESSION, marker } };
  return { claim_id, agent_id: AGENT.agent_id, generation: AGENT.generation, session_ref: SESSION, marker,
    content_sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), message, via,
    messages: threads.map((thread_id, index) => ({ message_id: `${claim_id}-m${index}`, thread_id, kind: "action",
      urgency: urgencies[index] })) };
}

class Harness {
  directory = mkdtempSync(path.join(os.tmpdir(), "ham-pi-mailbox-"));
  editor = "";
  idle = true;
  queuedInPi = false;
  mode = "tui";
  entries: { type: string; id: string; customType: string; content: string; details: unknown }[] = [];
  sent: { message: NativeMessage; options: unknown }[] = [];
  aborts = 0;
  notes: string[] = [];
  statuses: (string | undefined)[] = [];
  calls: { operation: string; data: Record<string, unknown> }[] = [];
  state = inspection();
  claims: ClaimBundle[] = [];
  environment: Record<string, string | undefined> = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p2" };
  clock = 1_000_000;
  timers: Timers = { setTimeout: () => ({}), clearTimeout: () => undefined, setInterval: () => ({}), clearInterval: () => undefined,
    now: () => this.clock };
  context: ExtensionContext;
  mailbox: PiMailbox;
  handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();

  constructor() {
    directories.push(this.directory);
    const owner = this;
    this.context = {
      get mode() { return owner.mode; }, hasUI: true, cwd: this.directory,
      sessionManager: { getSessionFile: () => SESSION, getBranch: () => [...this.entries], getEntries: () => [...this.entries] },
      isIdle: () => this.idle, hasPendingMessages: () => this.queuedInPi,
      abort: () => { this.aborts++; },
      ui: { setStatus: (_key: string, text: string | undefined) => { this.statuses.push(text); },
        notify: (message: string) => { this.notes.push(message); }, getEditorText: () => this.editor,
        onTerminalInput: () => () => undefined },
    } as unknown as ExtensionContext;
    const pi = {
      sendMessage: (message: NativeMessage, options: unknown) => { this.sent.push({ message, options }); },
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { this.handlers.set(name, handler); },
      registerCommand: () => undefined, registerShortcut: () => undefined,
    } as unknown as ExtensionAPI;
    const call: Call = async (operation, data) => {
      this.calls.push({ operation, data });
      if (operation === "register") return { ...this.state, agent: AGENT, bell_directory: this.directory, bell_name: "term-b" } as never;
      if (operation === "inspect") return this.state as never;
      if (operation === "claim") return (this.claims.shift() ?? { claim_id: null, reason: "empty" }) as never;
      if (operation === "applied") return { receipts: [] } as never;
      return { released: 1, uncertain: 0 } as never;
    };
    this.mailbox = new PiMailbox(pi, { name: "ham", client: "pi", call,
      eligible: env => env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID }, this.environment, this.timers);
  }
  operations() { return this.calls.map(call => call.operation); }
  claimCalls() { return this.calls.filter(call => call.operation === "claim").map(call => call.data); }
  journal(message: NativeMessage, id = "entry-" + this.entries.length) {
    this.entries.push({ type: "custom_message", id, customType: message.customType, content: message.content, details: message.details });
  }
  async start() { await this.mailbox.start(this.context); }
  async kick() { await this.mailbox.kick(this.context); }
  /** Deliver an ordinary bundle on thread A and let the agent start working on it. */
  async workingOn(thread = THREAD_A) {
    this.state = inspection({ has_action: true, queued_total: 1 });
    this.claims.push(bundle([thread]));
    await this.kick();
    expect(this.sent.length).toBe(1);
    this.journal(this.sent[0].message);
    this.idle = false;
    this.mailbox.agentStart(this.context);
    this.state = inspection();
  }
}

function urgent(kind: "amend" | "cancel", thread = THREAD_A): UrgentItem {
  return { message_id: `${kind}-${thread}`, urgency: kind, target_message_id: "original-" + thread, thread_id: thread };
}

test("only the interactive root pi in Herdr registers; subagents and headless modes stay passive", async () => {
  for (const change of [(h: Harness) => { h.environment.PI_SUBAGENT_CHILD = "1"; }, (h: Harness) => { h.mode = "json"; },
    (h: Harness) => { delete h.environment.HERDR_ENV; }]) {
    const harness = new Harness();
    change(harness);
    await harness.start();
    await harness.kick();
    expect(harness.calls).toEqual([]);
  }
  const harness = new Harness();
  await harness.start();
  expect(harness.calls[0]).toEqual({ operation: "register", data: { session_ref: SESSION, client: "pi" } });
});

test("ordinary mail is processed at idle with an empty editor, then acknowledged from the journal", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ has_action: true, queued_total: 2 });
  harness.editor = "half typed";
  await harness.kick();
  expect(harness.claimCalls()).toEqual([]);
  harness.editor = "";
  harness.claims.push(bundle([THREAD_A]));
  await harness.kick();
  expect(harness.claimCalls()).toEqual([{ terminal_id: "term-b", agent_id: "agent-b", generation: 3, wake: true }]);
  expect(harness.sent).toHaveLength(1);
  expect(harness.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  expect(harness.mailbox.activeThreads.has(THREAD_A)).toBe(true);
  harness.journal(harness.sent[0].message, "accepted-1");
  await harness.mailbox.confirm(harness.context);
  const applied = harness.calls.find(call => call.operation === "applied");
  expect(applied?.data.entry_id).toBe("accepted-1");
  expect(harness.mailbox.pending.size).toBe(0);
});

test("ordinary mail waits while pi is busy, for HAM role/turn gates and never claims without has_action", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ has_action: false, queued_total: 1 });
  await harness.kick();
  harness.state = inspection({ has_action: true, role: null });
  await harness.kick();
  harness.state = inspection({ has_action: true, turn_state: "working" });
  await harness.kick();
  harness.state = inspection({ has_action: true });
  harness.idle = false;
  await harness.kick();
  expect(harness.claimCalls()).toEqual([]);
});

test("cancel aborts only the run working on the cancelled thread, even over a draft, then reports at idle", async () => {
  const harness = new Harness();
  await harness.start();
  await harness.workingOn(THREAD_A);
  harness.editor = "user draft";
  harness.state = inspection({ urgent: [urgent("cancel", THREAD_A)], queued_total: 1, has_action: true });
  await harness.kick();
  await harness.kick();
  expect(harness.aborts).toBe(1);
  expect(harness.notes.some(note => note.includes("cancelled"))).toBe(true);
  expect(harness.claimCalls()).toHaveLength(1);  // only the original wake claim
  // pi settles after the abort; the cancel is claimed and starts a reporting turn despite the draft.
  harness.idle = true;
  harness.mailbox.settled(harness.context);
  harness.claims.push(bundle([THREAD_A], ["cancel"], "urgent"));
  await harness.kick();
  expect(harness.claimCalls().at(-1)).toEqual({ terminal_id: "term-b", agent_id: "agent-b", generation: 3, urgent: ["cancel"] });
  expect(harness.sent).toHaveLength(2);
  expect(harness.sent[1].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  expect(harness.editor).toBe("user draft");
});

test("cancel for other work never interrupts the current run; it goes first at idle", async () => {
  const harness = new Harness();
  await harness.start();
  await harness.workingOn(THREAD_A);
  harness.state = inspection({ urgent: [urgent("cancel", THREAD_B)], queued_total: 2, has_action: true });
  await harness.kick();
  expect(harness.aborts).toBe(0);
  expect(harness.claimCalls()).toHaveLength(1);
  harness.idle = true;
  harness.mailbox.settled(harness.context);
  harness.claims.push(bundle([THREAD_B], ["cancel"], "urgent"));
  await harness.kick();
  expect(harness.claimCalls().at(-1)?.urgent).toEqual(["cancel"]);
});

test("amend steers into the run on the same thread, but never over a draft", async () => {
  const harness = new Harness();
  await harness.start();
  await harness.workingOn(THREAD_A);
  harness.state = inspection({ urgent: [urgent("amend", THREAD_A), urgent("amend", THREAD_B)], queued_total: 2 });
  harness.editor = "typing";
  await harness.kick();
  expect(harness.claimCalls()).toHaveLength(1);
  harness.editor = "";
  harness.claims.push(bundle([THREAD_A], ["amend"], "urgent"));
  await harness.kick();
  expect(harness.claimCalls().at(-1)).toEqual({ terminal_id: "term-b", agent_id: "agent-b", generation: 3,
    urgent: ["amend"], message_ids: [`amend-${THREAD_A}`] });
  expect(harness.sent.at(-1)?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
  expect(harness.aborts).toBe(0);
});

test("amend for other work and amend at idle wait for an empty editor, then start a turn", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ urgent: [urgent("amend", THREAD_B)], queued_total: 1, has_action: true });
  harness.editor = "draft";
  await harness.kick();
  expect(harness.claimCalls()).toEqual([]);
  harness.editor = "";
  harness.claims.push(bundle([THREAD_B], ["amend"], "urgent"));
  await harness.kick();
  expect(harness.claimCalls()).toEqual([{ terminal_id: "term-b", agent_id: "agent-b", generation: 3, urgent: ["amend"] }]);
  expect(harness.sent.at(-1)?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
});

test("a claim whose final gate changed is released not_applied instead of being injected", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ urgent: [urgent("amend", THREAD_B)], queued_total: 1 });
  harness.claims.push(bundle([THREAD_B], ["amend"], "urgent"));
  const original = harness.calls.push.bind(harness.calls);
  harness.calls.push = (...items) => {
    const result = original(...items);
    if (items[0].operation === "claim") harness.editor = "typed during claim";
    return result;
  };
  await harness.kick();
  expect(harness.sent).toEqual([]);
  const release = harness.calls.find(call => call.operation === "release");
  expect(release?.data.disposition).toBe("not_applied");
});

test("a sent message that never reached the journal is released not_applied after the start grace", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ has_action: true });
  harness.claims.push(bundle([THREAD_A]));
  await harness.kick();
  const pending = [...harness.mailbox.pending.values()][0];
  pending.sentAt = Date.now() - 10000;
  harness.state = inspection();
  await harness.kick();
  const release = harness.calls.find(call => call.operation === "release");
  expect(release?.data).toMatchObject({ claim_id: pending.claim_id, disposition: "not_applied" });
});

test("natural receipt attaches queued mail to a user prompt but not to its own custom runs", async () => {
  const harness = new Harness();
  await harness.start();
  harness.claims.push(bundle([THREAD_A]));
  expect(await harness.mailbox.natural({ messageType: "custom" }, harness.context)).toBeUndefined();
  const result = await harness.mailbox.natural({ messageType: "user", prompt: "hello" }, harness.context);
  expect(result?.message.customType).toBe("ham_mailbox");
  expect(harness.claimCalls().at(-1)?.wake).toBe(false);
  expect(harness.mailbox.activeThreads.has(THREAD_A)).toBe(true);
});

test("status text, journal matching and reply parsing", () => {
  expect(statusText(undefined, 0)).toBeUndefined();
  expect(statusText({ queued_total: 0, urgent: [] }, 0)).toBeUndefined();
  expect(statusText({ queued_total: 3, urgent: [urgent("cancel")] }, 1, "HAM")).toBe("HAM ✉ 3 !1 …");
  const claim = bundle([THREAD_A]);
  const entry = { type: "custom_message", id: "e1", customType: "ham_mailbox", content: claim.message.content, details: claim.message.details };
  expect(acceptedEntry([entry], claim)).toBe("e1");
  expect(acceptedEntry([{ ...entry, content: claim.message.content + "x" }], claim)).toBeUndefined();
  const parsed = parseReply("inspect", { ...inspection(), urgent: [urgent("amend")], inbox: undefined, queued_total: undefined });
  expect(parsed.urgent[0].urgency).toBe("amend");
  expect(parsed.inbox).toEqual([]);
  expect(() => parseReply("inspect", { ...inspection(), urgent: [{ ...urgent("amend"), urgency: "steer" }] })).toThrow();
});

test("/mail why explains each blocked wake gate, including a turn flag that never settled", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ has_action: true, queued_total: 1, turn_state: "working",
    inbox: [{ message_id: "m1", thread_id: THREAD_A, kind: "action", urgency: null, target_message_id: null, sender: "h/a",
      subject: "", preview: "do it", state: "queued", created_at: 0 }] });
  let text = await harness.mailbox.explain(harness.context);
  expect(text).toContain("Queue: 1 queued (1 action, 0 urgent) · turn state working");
  expect(text).toContain("Now: waiting — HAM reports turn state 'working'");

  harness.state = { ...harness.state, turn_state: "idle" };
  harness.editor = "draft";
  text = await harness.mailbox.explain(harness.context);
  expect(text).toContain("waiting — the editor has a draft");
  harness.editor = "";

  // pi went idle but agent_settled never reached the receiver.
  harness.mailbox.agentStart(harness.context);
  text = await harness.mailbox.explain(harness.context);
  expect(text).toContain("receiver still thinks a turn is running");
  await harness.kick();
  expect(harness.claimCalls()).toEqual([]);
  expect(await harness.mailbox.explain(harness.context)).toMatch(/Last skipped: pi is idle, but the receiver still thinks a turn is running \(agent_settled never arrived\); it is dropped after 60s \(for \d+s\)/);

  harness.mailbox.settled(harness.context);
  expect(await harness.mailbox.explain(harness.context)).toContain("Now: ready; the next check claims and delivers the mail.");
});

test("/mail why reports an empty queue and a declined claim", async () => {
  const harness = new Harness();
  await harness.start();
  expect(await harness.mailbox.explain(harness.context)).toContain("Now: nothing is waiting.");
  harness.state = inspection({ has_action: true, queued_total: 1 });
  await harness.kick();  // no claim bundle queued in the harness: the backend declines
  expect(await harness.mailbox.explain(harness.context)).toContain("Last skipped: HAM declined the wake claim: empty");
});

test("persistent custom panels are not dialogs; a real dialog blocks until it closes or the editor submits", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ has_action: true, queued_total: 1 });
  harness.mailbox.prompt(true, harness.context, "custom");   // quota / pi-team / mailbox board overlay
  harness.claims.push(bundle([THREAD_A]));
  await harness.kick();
  expect(harness.sent.length).toBe(1);

  const blocked = new Harness();
  await blocked.start();
  blocked.state = inspection({ has_action: true, queued_total: 1 });
  blocked.mailbox.prompt(true, blocked.context, "select");
  await blocked.kick();
  expect(blocked.claimCalls()).toEqual([]);
  expect(await blocked.mailbox.explain(blocked.context)).toContain("an extension dialog is open (1)");
  blocked.mailbox.input(blocked.context);                     // ui_prompt_end was lost, the editor submitted
  const text = await blocked.mailbox.explain(blocked.context);
  expect(text).toContain("dialogs 0");
  expect(text).toMatch(/Recovered: dropped a stuck dialog count \(the editor submitted a prompt\) 0s ago/);
});

test("a turn flag that outlives the turn is dropped after pi stays idle for STALE_TURN_MS", async () => {
  const harness = new Harness();
  await harness.start();
  harness.state = inspection({ has_action: true, queued_total: 1 });
  harness.mailbox.agentStart(harness.context);   // agent_settled never arrives; pi is idle
  harness.claims.push(bundle([THREAD_A]));
  await harness.kick();
  expect(harness.sent.length).toBe(0);
  harness.clock += STALE_TURN_MS - 1;
  await harness.kick();
  expect(harness.sent.length).toBe(0);
  harness.clock += 1;
  await harness.kick();   // drops the flag
  await harness.kick();
  expect(harness.sent.length).toBe(1);
  expect(await harness.mailbox.explain(harness.context)).toContain("Recovered: dropped a stuck turn running flag");

  // Not while pi itself is busy or still has queued messages.
  const busy = new Harness();
  await busy.start();
  busy.state = inspection({ has_action: true, queued_total: 1 });
  busy.mailbox.agentStart(busy.context);
  busy.queuedInPi = true;
  await busy.kick();
  busy.clock += STALE_TURN_MS * 5;
  await busy.kick();
  expect(await busy.mailbox.explain(busy.context)).toContain("turn running yes");
});

test("only typing and paste count as input; mouse, focus and terminal replies do not", () => {
  for (const data of ["a", "한", "\r", "\x1b[A", "\x1b[109;6u", "\x1b[200~paste\x1b[201~", "\x1b"]) expect(isTyping(data)).toBe(true);
  for (const data of ["\x1b[I", "\x1b[O", "\x1b[<0;10;5M", "\x1b[<32;11;5M\x1b[<0;11;5m", "\x1b[<64;3;3M", "\x1b[M !!",
    "\x1b[12;40R", "\x1b[?62;22c", "\x1b[>1;10;0c", "\x1b[?1u", "\x1b]11;rgb:0000/0000/0000\x07", "\x1bP>|kitty\x1b\\", ""])
    expect(isTyping(data)).toBe(false);
});
