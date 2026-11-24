import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMailbox, renderBundle, type StoredMessage } from "../src/local.ts";
import type { ClaimBundle } from "../src/types.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

let clock = 1_000_000;
function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-mailbox-local-"));
  directories.push(root);
  const make = (pid: number) => new LocalMailbox({ root, host: "host", pid, now: () => clock, alive: () => true,
    thresholds: { idle_minutes: 0, coalesce_seconds: 0 } });
  const a = make(101), b = make(202);
  const ra = a.register({ session_ref: "/s/a.jsonl", agent_id: "aaaaaaaa-1111", alias: "alpha", cwd: "/w/a" });
  const rb = b.register({ session_ref: "/s/b.jsonl", agent_id: "bbbbbbbb-2222", alias: "beta", cwd: "/w/b" });
  const idA = { terminal_id: ra.agent.agent_id, agent_id: ra.agent.agent_id, generation: ra.agent.generation };
  const idB = { terminal_id: rb.agent.agent_id, agent_id: rb.agent.agent_id, generation: rb.agent.generation };
  return { root, a, b, idA, idB, alpha: { kind: "agent" as const, agent_id: "aaaaaaaa-1111" } };
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function applied(box: LocalMailbox, claim: ClaimBundle, entry = "entry-1") {
  return box.applied({ claim_id: claim.claim_id, agent_id: claim.agent_id, generation: claim.generation,
    session_ref: claim.session_ref, marker: claim.marker, content_sha256: claim.content_sha256, entry_id: entry });
}
const bundle = (value: unknown) => value as ClaimBundle;

test("register keys agents by pi session id; addresses resolve by alias, id or prefix", () => {
  const { a } = harness();
  expect(a.agents().map(agent => agent.alias)).toEqual(["alpha", "beta"]);
  expect(a.resolve("beta").agent_id).toBe("bbbbbbbb-2222");
  expect(a.resolve("@alpha").agent_id).toBe("aaaaaaaa-1111");
  expect(a.resolve("bbbb").agent_id).toBe("bbbbbbbb-2222");
  expect(() => a.resolve("zzz")).toThrow("agent_not_found");
});

test("send, inspect, wake claim and journal-bound ACK", async () => {
  const { a, b, idB, alpha } = harness();
  const sent = a.send(alpha, "beta", { body: "Implement it" });
  expect(sent.state).toBe("queued");
  const state = await b.call("inspect", idB);
  expect(state.has_action).toBe(true);
  expect(state.queued_total).toBe(1);
  expect(state.inbox[0].sender).toBe("alpha");
  const claim = bundle(await b.call("claim", { ...idB, wake: true }));
  expect(claim.via).toBe("wake");
  expect(claim.message.content).toContain("From alpha [action]");
  expect(claim.message.content).toContain("mailbox_send");
  expect(sha(claim.message.content)).toBe(claim.content_sha256);
  expect(b.message(sent.message_id)?.state).toBe("delivering");
  expect(() => applied(b, { ...claim, content_sha256: "x" })).toThrow("invalid_evidence");
  applied(b, claim);
  expect(b.message(sent.message_id)?.state).toBe("delivered");
  expect(b.message(sent.message_id)?.evidence).toContain("pi:accepted-journal:/s/b.jsonl#entry-1");
});

test("wake admission obeys coalescing, FYI delay and the hourly limit; natural claims do not", async () => {
  const { root } = harness();
  const box = new LocalMailbox({ root, host: "host", pid: 202, now: () => clock, alive: () => true,
    thresholds: { idle_minutes: 0, coalesce_seconds: 30, wakes_per_hour: 1 } });
  const sender = new LocalMailbox({ root, host: "host", pid: 101, now: () => clock, alive: () => true });
  const reg = box.register({ session_ref: "/s/b.jsonl", agent_id: "bbbbbbbb-2222", alias: "beta" });
  const id = { terminal_id: reg.agent.agent_id, agent_id: reg.agent.agent_id, generation: reg.agent.generation };
  sender.send({ kind: "agent", agent_id: "aaaaaaaa-1111" }, "beta", { body: "note", kind: "fyi" });
  expect((await box.call("claim", { ...id, wake: true })).claim_id).toBeNull();
  sender.send({ kind: "agent", agent_id: "aaaaaaaa-1111" }, "beta", { body: "do it" });
  expect(await box.call("claim", { ...id, wake: true })).toMatchObject({ claim_id: null, reason: "coalescing" });
  clock += 31;
  const first = bundle(await box.call("claim", { ...id, wake: true }));
  expect(first.messages).toHaveLength(2);
  applied(box, first);
  sender.send({ kind: "agent", agent_id: "aaaaaaaa-1111" }, "beta", { body: "again" });
  clock += 31;
  expect(await box.call("claim", { ...id, wake: true })).toMatchObject({ claim_id: null, reason: "hourly_limit" });
  expect((await box.call("claim", { ...id, wake: false })).claim_id).not.toBeNull();
});

test("release not_applied requeues; unknown stays delivering and blocks until recovered", async () => {
  const { a, b, idB, alpha } = harness();
  const sent = a.send(alpha, "beta", { body: "x" });
  const claim = bundle(await b.call("claim", { ...idB, wake: true }));
  await b.call("release", { claim_id: claim.claim_id, agent_id: claim.agent_id, generation: claim.generation,
    disposition: "not_applied", evidence: "never sent" });
  expect(b.message(sent.message_id)?.state).toBe("queued");
  const again = bundle(await b.call("claim", { ...idB, wake: true }));
  await b.call("release", { claim_id: again.claim_id, agent_id: again.agent_id, generation: again.generation,
    disposition: "unknown", evidence: "uncertain" });
  expect((await b.call("inspect", idB)).pending_claims.map(item => item.claim_id)).toEqual([again.claim_id]);
  expect(b.recover(sent.message_id, "requeue").state).toBe("queued");
  expect((await b.call("inspect", idB)).pending_claims).toEqual([]);
});

test("cancel withdraws queued mail; delivered mail gets an urgent cancel on the same thread", async () => {
  const { a, b, idB, alpha } = harness();
  const queued = a.send(alpha, "beta", { body: "wrong" });
  expect(a.urgent(alpha, queued.message_id, "cancel")).toEqual({ cancelled: "withdrawn", message_id: queued.message_id });
  expect(b.message(queued.message_id)?.state).toBe("withdrawn");
  const original = a.send(alpha, "beta", { body: "deploy" });
  applied(b, bundle(await b.call("claim", { ...idB, wake: true })));
  const cancel = a.urgent(alpha, original.message_id, "cancel", "wrong host") as StoredMessage;
  expect(cancel).toMatchObject({ urgency: "cancel", kind: "action", reply_to: original.message_id,
    thread_id: original.thread_id, hop: 1, recipient: "bbbbbbbb-2222" });
  const state = await b.call("inspect", idB);
  expect(state.urgent).toEqual([{ message_id: cancel.message_id, urgency: "cancel",
    target_message_id: original.message_id, thread_id: original.thread_id }]);
  const claim = bundle(await b.call("claim", { ...idB, urgent: ["cancel"] }));
  expect(claim.via).toBe("urgent");
  expect(claim.message.content).toContain(`[action · cancel of ${original.message_id}]`);
  expect(claim.message.content).toContain("CANCEL:");
});

test("only the sender (agent or /mail user) may amend or cancel its own original mail", async () => {
  const { a, b, alpha } = harness();
  const original = a.send(alpha, "beta", { body: "task" });
  const beta = { kind: "agent" as const, agent_id: "bbbbbbbb-2222" };
  expect(() => b.urgent(beta, original.message_id, "cancel")).toThrow("not_sender");
  expect(() => a.urgent({ kind: "user" }, original.message_id, "cancel")).toThrow("not_sender");
  expect(() => a.urgent(alpha, original.message_id, "amend", " ")).toThrow("invalid_body");
  const amend = a.urgent(alpha, original.message_id, "amend", "more") as StoredMessage;
  expect(() => a.urgent(alpha, amend.message_id, "cancel")).toThrow("invalid_urgency");
  const fromUser = a.send({ kind: "user" }, "beta", { body: "user task" });
  expect(fromUser.sender_label).toBe("user@host");
  expect((a.urgent({ kind: "user" }, fromUser.message_id, "cancel") as { cancelled: string }).cancelled).toBe("withdrawn");
});

test("an urgent amend claim brings a still-queued original and can be narrowed", async () => {
  const { a, b, idB, alpha } = harness();
  const first = a.send(alpha, "beta", { body: "first" });
  const second = a.send(alpha, "beta", { body: "second" });
  a.urgent(alpha, first.message_id, "amend", "first+");
  const amendSecond = a.urgent(alpha, second.message_id, "amend", "second+") as StoredMessage;
  const claim = bundle(await b.call("claim", { ...idB, urgent: ["amend"], message_ids: [amendSecond.message_id] }));
  expect(claim.messages.map(item => item.message_id)).toEqual([second.message_id, amendSecond.message_id]);
  expect(b.message(first.message_id)?.state).toBe("queued");
  await expect(b.call("claim", { ...idB, urgent: ["steer"] })).rejects.toThrow("invalid_urgency");
  await expect(b.call("claim", { ...idB, message_ids: [first.message_id] })).rejects.toThrow("invalid_request");
});

test("a cancel whose original was withdrawn first is settled without delivery", async () => {
  const { a, b, idB, alpha } = harness();
  const original = a.send(alpha, "beta", { body: "x" });
  const cancel = a.send(alpha, "beta", { body: "stop", reply_to: original.message_id }, "cancel");
  a.urgent(alpha, original.message_id, "cancel");
  expect((await b.call("inspect", idB)).urgent).toEqual([]);
  expect((await b.call("claim", { ...idB, urgent: ["cancel"] })).claim_id).toBeNull();
  expect(b.message(cancel.message_id)).toMatchObject({ state: "handled", evidence: "cancel:target_withdrawn" });
});

test("replying to received mail handles it; handle and read are recipient-scoped", async () => {
  const { a, b, idB, alpha } = harness();
  const beta = { kind: "agent" as const, agent_id: "bbbbbbbb-2222" };
  const question = a.send(alpha, "beta", { body: "status?" });
  applied(b, bundle(await b.call("claim", { ...idB, wake: true })));
  const answer = b.send(beta, "alpha", { body: "done", reply_to: question.message_id });
  expect(answer.thread_id).toBe(question.thread_id);
  expect(b.message(question.message_id)?.state).toBe("handled");
  expect(() => a.handle("aaaaaaaa-1111", [question.message_id])).toThrow("message_not_found");
  expect(a.read("aaaaaaaa-1111").map(message => message.message_id)).toEqual([answer.message_id]);
  expect(a.handle("aaaaaaaa-1111", [answer.message_id])[0].state).toBe("handled");
  expect(a.findMessage(answer.message_id.slice(0, 8)).message_id).toBe(answer.message_id);
});

test("a stale registration from another process cannot claim", async () => {
  const { root, idB } = harness();
  const other = new LocalMailbox({ root, host: "host", pid: 999, now: () => clock, alive: () => true });
  await expect(other.call("claim", { ...idB, wake: true })).rejects.toThrow("stale_session");
  const fresh = other.register({ session_ref: "/s/b.jsonl", agent_id: "bbbbbbbb-2222", alias: "beta" });
  expect(fresh.agent.generation).toBe(idB.generation + 1);
});

test("the lock reclaims an owner that died while holding it", () => {
  const { root } = harness();
  const dead = new LocalMailbox({ root, host: "host", pid: 4242, now: () => clock, alive: pid => pid !== 4242 });
  require("node:fs").mkdirSync(path.join(root, "lock"));
  require("node:fs").writeFileSync(path.join(root, "lock", "owner"), JSON.stringify({ pid: 4242, at: Date.now() }));
  const live = new LocalMailbox({ root, host: "host", pid: 101, now: () => clock, alive: pid => pid !== 4242 });
  expect(live.locked(() => "ok")).toBe("ok");
  void dead;
});

test("bundles stay bounded and represent every message", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    message_id: `0000000${index}-0000-4000-8000-000000000000`, thread_id: "t", reply_to: null, subject: "", sender: "s",
    sender_label: "alpha", recipient: "r", recipient_label: "beta", kind: "action", urgency: null, hop: 0,
    body: "한".repeat(3000), created_at: index, state: "queued", updated_at: 0, claim_id: null, claimed_generation: null,
    via: null, evidence: null, hold_reason: null, delivered_at: null, handled_at: null,
  } as StoredMessage));
  const content = renderBundle(messages, "MARK")!;
  expect(Buffer.byteLength(content)).toBeLessThanOrEqual(8192);
  for (const message of messages) expect(content).toContain(`[truncated; mailbox_list ${message.message_id}]`);
});
