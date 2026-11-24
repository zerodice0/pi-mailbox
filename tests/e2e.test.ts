import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiMailbox, type Backend, type Timers } from "../src/core.ts";
import { LocalMailbox, type StoredMessage } from "../src/local.ts";
import type { NativeMessage } from "../src/types.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const timers: Timers = { setTimeout: () => ({}), clearTimeout: () => undefined, setInterval: () => ({}), clearInterval: () => undefined };

/** One simulated interactive pi session using the real local backend. */
class Session {
  editor = "";
  idle = true;
  entries: { type: string; id: string; customType: string; content: string; details: unknown }[] = [];
  sent: { message: NativeMessage; options: unknown }[] = [];
  aborts = 0;
  store: LocalMailbox;
  mailbox: PiMailbox;
  context: ExtensionContext;
  constructor(root: string, readonly id: string, readonly alias: string, pid: number) {
    this.store = new LocalMailbox({ root, host: "host", pid, alive: () => true, thresholds: { idle_minutes: 0, coalesce_seconds: 0 } });
    const backend: Backend = { name: "local", client: "pi", call: (operation, data) => this.store.call(operation, data),
      eligible: () => true, registration: () => ({ agent_id: id, alias, cwd: "/w/" + alias }) };
    const pi = { sendMessage: (message: NativeMessage, options: unknown) => {
      this.sent.push({ message, options });
      // pi journals an injected custom message when it is delivered.
      this.entries.push({ type: "custom_message", id: `${alias}-${this.entries.length}`, customType: message.customType,
        content: message.content, details: message.details });
    } } as unknown as ExtensionAPI;
    this.context = {
      mode: "tui", hasUI: true, cwd: "/w/" + alias,
      sessionManager: { getSessionFile: () => `/s/${alias}.jsonl`, getSessionId: () => id,
        getBranch: () => [...this.entries], getEntries: () => [...this.entries] },
      isIdle: () => this.idle, hasPendingMessages: () => false, abort: () => { this.aborts++; },
      ui: { setStatus: () => undefined, notify: () => undefined, getEditorText: () => this.editor, onTerminalInput: () => () => undefined },
    } as unknown as ExtensionContext;
    this.mailbox = new PiMailbox(pi, backend, {}, timers);
  }
  async kick() { await this.mailbox.kick(this.context); }
  get sender() { return { kind: "agent" as const, agent_id: this.id }; }
}

function pair() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-mailbox-e2e-"));
  directories.push(root);
  return { root, alpha: new Session(root, "aaaaaaaa-0001", "alpha", 101), beta: new Session(root, "bbbbbbbb-0002", "beta", 202) };
}

test("without HAM: mail between two pi sessions is processed at idle and acknowledged", async () => {
  const { alpha, beta } = pair();
  await alpha.mailbox.start(alpha.context);
  await beta.mailbox.start(beta.context);
  const sent = alpha.store.send(alpha.sender, "beta", { body: "Please run the tests" });
  beta.editor = "my draft";
  await beta.kick();
  expect(beta.sent).toHaveLength(0);
  beta.editor = "";
  await beta.kick();
  expect(beta.sent).toHaveLength(1);
  expect(beta.sent[0].message.content).toContain("Please run the tests");
  await beta.mailbox.confirm(beta.context);
  expect(beta.store.message(sent.message_id)?.state).toBe("delivered");
});

test("without HAM: cancel aborts the run on that thread even over a draft, then the report turn starts", async () => {
  const { alpha, beta } = pair();
  await alpha.mailbox.start(alpha.context);
  await beta.mailbox.start(beta.context);
  const task = alpha.store.send(alpha.sender, "beta", { body: "Delete the old build" });
  await beta.kick();
  await beta.mailbox.confirm(beta.context);
  beta.idle = false;
  beta.mailbox.agentStart(beta.context);
  beta.editor = "typing something";
  const cancel = alpha.store.urgent(alpha.sender, task.message_id, "cancel", "Wrong directory") as StoredMessage;
  await beta.kick();
  expect(beta.aborts).toBe(1);
  beta.idle = true;
  beta.mailbox.settled(beta.context);
  await beta.kick();
  expect(beta.sent.at(-1)?.message.content).toContain(`[action · cancel of ${task.message_id}]`);
  expect(beta.sent.at(-1)?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  await beta.mailbox.confirm(beta.context);
  expect(beta.store.message(cancel.message_id)?.state).toBe("delivered");
  expect(beta.editor).toBe("typing something");
});

test("without HAM: amend is steered into the run on that thread when the editor is empty", async () => {
  const { alpha, beta } = pair();
  await alpha.mailbox.start(alpha.context);
  await beta.mailbox.start(beta.context);
  const task = alpha.store.send(alpha.sender, "beta", { body: "Write the report" });
  await beta.kick();
  beta.idle = false;
  beta.mailbox.agentStart(beta.context);
  alpha.store.urgent(alpha.sender, task.message_id, "amend", "Include numbers");
  await beta.kick();
  expect(beta.aborts).toBe(0);
  expect(beta.sent.at(-1)?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
  expect(beta.sent.at(-1)?.message.content).toContain("Include numbers");
});
