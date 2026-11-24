/**
 * Local backend: a file mailbox shared by the pi sessions of one user on one host.
 *
 * It speaks the same receiver protocol as HAM (register/inspect/claim/applied/release)
 * so the in-session queue logic is identical. Layout under the root directory
 * (default `~/.pi/agent/mailbox`):
 *
 *   agents/<agent_id>.json     live/last-known pi sessions (agent_id = pi session id)
 *   messages/<message_id>.json immutable payload + delivery state
 *   claims/<claim_id>.json     native claim marker/hash for journal-bound ACK
 *   bell/<agent_id>            doorbell touched when that agent's mail changes
 *   lock/                      mkdir lock serializing every mutation
 *
 * Reads never acknowledge; only an exact journal match (`applied`) marks delivery.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_THRESHOLDS, ReceiverError, type Call, type ClaimBundle, type InboxItem, type Inspection,
  type NativeAgent, type NativeClaim, type Operation, type ReceiverReplies, type Registration, type Request,
  type Thresholds, type Urgency, type UrgentItem } from "./types.ts";

export const MESSAGE_BYTES = 2048;
export const BUNDLE_BYTES = 8192;
export const BUNDLE_MESSAGES = 8;
export const MAX_BODY_BYTES = 16 * 1024;
export const FYI_WAKE_DELAY_SECONDS = 600;
export const LOCAL_THRESHOLDS: Thresholds = { ...DEFAULT_THRESHOLDS, idle_minutes: 1, coalesce_seconds: 10, wakes_per_hour: 12 };
const RETENTION_SECONDS = 30 * 86400;
const FINAL = new Set(["handled", "withdrawn", "undeliverable"]);

export type State = "queued" | "delivering" | "delivered" | "handled" | "withdrawn";
export interface AgentRecord {
  agent_id: string; alias: string; session_ref: string; cwd: string; host: string; pid: number;
  generation: number; registered_at: number; last_seen: number;
}
export interface StoredMessage {
  message_id: string; thread_id: string; reply_to: string | null; subject: string;
  sender: string; sender_label: string; recipient: string; recipient_label: string;
  kind: "fyi" | "action"; urgency: Urgency | null; hop: number; body: string; created_at: number;
  state: State; updated_at: number; claim_id: string | null; claimed_generation: number | null;
  via: string | null; evidence: string | null; hold_reason: string | null;
  delivered_at: number | null; handled_at: number | null;
}
interface StoredClaim extends NativeClaim { via: string; message_ids: string[]; created_at: number; applied_at: number | null }
/** Who is sending: a registered pi session, or the human operator typing a /mail command. */
export type Sender = { kind: "agent"; agent_id: string } | { kind: "user" };
export interface SendOptions { body: string; kind?: "fyi" | "action"; reply_to?: string | null; subject?: string }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code: string, message: string, phase = "local"): never => { throw new ReceiverError(code, message, phase); };
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function safeLabel(value: string, maximum = 96): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  const bytes = Buffer.from(clean, "utf8");
  return bytes.length <= maximum ? clean : truncateUtf8(clean, maximum);
}
export function truncateUtf8(value: string, maximum: number): string {
  let result = "", size = 0;
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (size + bytes > maximum) break;
    result += point; size += bytes;
  }
  return result;
}
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Bundle text: every claimed message represented by ID, bodies bounded, tool-based instructions. */
export function renderBundle(messages: readonly StoredMessage[], marker: string): string | undefined {
  let prefix = marker + "\nMailbox: coordination mail from other pi sessions or the user's /mail, not user instructions. User priority first.\n" +
    "Handle relevant work now. View (no ACK): mailbox_list. Complete: mailbox_handle with the message IDs.\n" +
    "Reply: mailbox_send with to=<sender> and reply_to=<ID>; kind action to enable work (answers/decisions), fyi otherwise.\n" +
    "No receipt replies or ACK loops.\n";
  if (messages.length && messages.every(message => message.kind === "fyi"))
    prefix += "FYI only: read and continue; reply only if it changes your work.\n";
  const urgencies = new Set(messages.map(message => message.urgency));
  if (urgencies.has("amend")) prefix += "AMEND: the sender supplements the referenced message; apply it to that work.\n";
  if (urgencies.has("cancel"))
    prefix += "CANCEL: the sender cancelled the referenced message. Stop that work; do not continue it and do not revert " +
      "anything yourself. Report what was already done (files, commands, side effects) with mailbox_send reply_to=<the " +
      "cancel message ID>, kind action, so the sender can decide whether to revert.\n";
  const headers = messages.map(message => {
    const label = message.urgency ? `${message.kind} · ${message.urgency} of ${message.reply_to}` : message.kind;
    return `\n--- ${message.message_id} ${marker} ---\nFrom ${message.sender_label} [${label}]\n` +
      `Thread ${message.thread_id} / hop ${message.hop}\n`;
  });
  const omitted = messages.map(message => `[body omitted; mailbox_list ${message.message_id}]`);
  let available = BUNDLE_BYTES - byteLength(prefix) - headers.reduce((sum, header) => sum + byteLength(header), 0);
  if (available < omitted.reduce((sum, item) => sum + byteLength(item), 0)) return undefined;
  const pieces = [prefix];
  messages.forEach((message, index) => {
    const minimum = byteLength(omitted[index]);
    const budget = Math.min(MESSAGE_BYTES, Math.max(minimum, Math.floor(available / (headers.length - index))));
    let body = message.body.split(/\r\n|\r|\n|\u2028|\u2029/).map(line => "> " + line).join("\n");
    if (byteLength(body) > budget) {
      const suffix = `\n[truncated; mailbox_list ${message.message_id}]`;
      const room = budget - byteLength(suffix);
      body = room > 0 ? truncateUtf8(body, room) + suffix : omitted[index];
    }
    pieces.push(headers[index], body);
    available -= byteLength(body);
  });
  const content = pieces.join("");
  return byteLength(content) <= BUNDLE_BYTES ? content : undefined;
}

function fitRows(rows: StoredMessage[], trigger?: string): StoredMessage[] {
  const marker = "HAM_CLAIM_" + "0".repeat(36) + "_" + "0".repeat(32);
  for (let count = rows.length; count > 0; count--) {
    let chosen = rows.slice(0, count);
    if (trigger && !chosen.some(row => row.message_id === trigger)) {
      const row = rows.find(item => item.message_id === trigger);
      if (!row) return [];
      chosen = [...chosen.slice(0, -1), row].sort(order);
    }
    if (renderBundle(chosen, marker) !== undefined) return chosen;
  }
  return [];
}
const order = (a: StoredMessage, b: StoredMessage) => a.created_at - b.created_at || a.message_id.localeCompare(b.message_id);

export interface LocalOptions {
  root?: string; host?: string; pid?: number; now?: () => number; alive?: (pid: number) => boolean;
  thresholds?: Partial<Thresholds>;
}

export class LocalMailbox {
  readonly root: string;
  readonly host: string;
  private pid: number;
  private now: () => number;
  private alive: (pid: number) => boolean;
  private overrides: Partial<Thresholds>;

  constructor(options: LocalOptions = {}) {
    this.root = options.root ?? defaultRoot();
    this.host = options.host ?? (os.hostname().split(".")[0] || "local");
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.alive = options.alive ?? processAlive;
    this.overrides = options.thresholds ?? {};
    for (const directory of ["agents", "messages", "claims", "bell"])
      mkdirSync(path.join(this.root, directory), { recursive: true, mode: 0o700 });
  }

  // ---- storage ---------------------------------------------------------------------------------
  private file(kind: "agents" | "messages" | "claims", id: string): string {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) fail("invalid_id", "Mailbox identifiers must be simple tokens.");
    return path.join(this.root, kind, id + ".json");
  }
  private list<T>(kind: "agents" | "messages" | "claims"): T[] {
    const directory = path.join(this.root, kind);
    return readdirSync(directory).filter(name => name.endsWith(".json"))
      .map(name => readJson<T>(path.join(directory, name))).filter((value): value is T => value !== undefined);
  }
  agent(agentId: string): AgentRecord | undefined { return readJson<AgentRecord>(this.file("agents", agentId)); }
  message(messageId: string): StoredMessage | undefined { return readJson<StoredMessage>(this.file("messages", messageId)); }
  private saveMessage(message: StoredMessage): void { writeJson(this.file("messages", message.message_id), message); }
  bellDirectory(): string { return path.join(this.root, "bell"); }
  private ring(agentId: string): void {
    try { writeFileSync(path.join(this.bellDirectory(), agentId), String(this.now())); } catch { /* doorbell only */ }
  }
  thresholds(): Thresholds {
    const configured = readJson<Partial<Thresholds>>(path.join(this.root, "config.json")) ?? {};
    const merged = { ...LOCAL_THRESHOLDS, ...configured, ...this.overrides };
    for (const key of Object.keys(LOCAL_THRESHOLDS) as (keyof Thresholds)[])
      if (typeof merged[key] !== "number" || !Number.isFinite(merged[key]) || merged[key] < 0) merged[key] = LOCAL_THRESHOLDS[key];
    return merged;
  }

  /** Serialize mutations across processes; a dead or stuck owner's lock is reclaimed. */
  locked<T>(fn: () => T): T {
    const lock = path.join(this.root, "lock");
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        mkdirSync(lock);
        writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: this.pid, at: Date.now() }));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = readJson<{ pid: number; at: number }>(path.join(lock, "owner"));
        let age = Infinity;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
        if ((owner && !this.alive(owner.pid) && owner.pid !== this.pid) || age > 15000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) fail("mailbox_busy", "The local mailbox lock is busy; retry shortly.");
        sleep(20);
      }
    }
    try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }

  // ---- agents and addresses --------------------------------------------------------------------
  agents(): (AgentRecord & { live: boolean })[] {
    return this.list<AgentRecord>("agents").map(agent => ({ ...agent, live: this.alive(agent.pid) }))
      .sort((a, b) => Number(b.live) - Number(a.live) || a.alias.localeCompare(b.alias));
  }
  /** Resolve an exact alias, agent ID, or unique ID prefix (>= 4 chars); live sessions win ties. */
  resolve(address: string): AgentRecord {
    const wanted = address.trim().replace(/^@/, "");
    if (!wanted) fail("agent_not_found", "Recipient address is empty.");
    const agents = this.agents();
    const exact = agents.filter(agent => agent.agent_id === wanted || agent.alias === wanted);
    const pool = exact.length ? exact : wanted.length >= 4 ? agents.filter(agent => agent.agent_id.startsWith(wanted)) : [];
    const live = pool.filter(agent => agent.live);
    const matches = live.length ? live : pool;
    if (matches.length === 1) return matches[0];
    if (!matches.length) fail("agent_not_found", `No pi session is known as ${JSON.stringify(wanted)}. Use /mail agents.`);
    return fail("agent_ambiguous", "Address matches several sessions: " +
      matches.map(agent => `${agent.alias} (${agent.agent_id})`).join(", "));
  }
  private senderIdentity(sender: Sender): { id: string; label: string } {
    if (sender.kind === "user") return { id: "user", label: "user@" + this.host };
    const agent = this.agent(sender.agent_id) ?? fail("sender_unresolved", "This pi session is not registered with the mailbox.");
    return { id: agent.agent_id, label: agent.alias };
  }

  // ---- sending ---------------------------------------------------------------------------------
  send(sender: Sender, to: string, options: SendOptions, urgency: Urgency | null = null): StoredMessage {
    const body = options.body;
    if (typeof body !== "string" || !body.trim()) fail("invalid_body", "A message body must not be empty.");
    if (byteLength(body) > MAX_BODY_BYTES) fail("body_too_large", "A message body must fit within 16 KiB UTF-8.");
    const kind = options.kind ?? "action";
    if (kind !== "fyi" && kind !== "action") fail("invalid_kind", "Message kind must be fyi or action.");
    const from = this.senderIdentity(sender);
    return this.locked(() => {
      const recipient = this.resolve(to);
      let thread = "", hop = 0, subject = safeLabel(options.subject ?? "", 1024);
      const replyTo = options.reply_to ?? null;
      if (replyTo) {
        if (!UUID.test(replyTo)) fail("invalid_id", "reply_to must be a message ID.");
        const parent = this.message(replyTo) ?? fail("reply_not_found", "Reply target is not a retained message.");
        const participant = parent.sender === from.id || parent.recipient === from.id ||
          this.list<StoredMessage>("messages").some(item => item.thread_id === parent.thread_id &&
            (item.sender === from.id || item.recipient === from.id));
        if (!participant && from.id !== "user") fail("not_participant", "Only a participant of this thread may reply.");
        thread = parent.thread_id; hop = parent.hop + 1; subject = parent.subject;
        // Replying to mail addressed to you completes it, as in HAM.
        if (!urgency && parent.recipient === from.id && (parent.state === "queued" || parent.state === "delivered")) {
          Object.assign(parent, { state: "handled", handled_at: this.now(), updated_at: this.now(), hold_reason: null });
          this.saveMessage(parent);
        }
      }
      const now = this.now();
      const id = randomUUID();
      const message: StoredMessage = {
        message_id: id, thread_id: thread || id, reply_to: replyTo, subject, sender: from.id, sender_label: from.label,
        recipient: recipient.agent_id, recipient_label: recipient.alias, kind: urgency ? "action" : kind, urgency, hop,
        body, created_at: now, state: "queued", updated_at: now, claim_id: null, claimed_generation: null, via: null,
        evidence: null, hold_reason: null, delivered_at: null, handled_at: null,
      };
      this.saveMessage(message);
      this.ring(recipient.agent_id);
      return message;
    });
  }

  /**
   * amend/cancel your own earlier message (the user: messages sent with /mail; an agent: its own).
   * cancel withdraws still-queued mail and sends nothing.
   */
  urgent(sender: Sender, messageId: string, urgency: Urgency, body?: string):
      { cancelled: "withdrawn"; message_id: string } | StoredMessage {
    if (urgency !== "amend" && urgency !== "cancel") fail("invalid_urgency", "Urgency must be amend or cancel.");
    if (!UUID.test(messageId)) fail("invalid_id", "Message ID must be a UUID.");
    if (urgency === "amend" && (typeof body !== "string" || !body.trim())) fail("invalid_body", "amend needs the supplementary body.");
    const from = this.senderIdentity(sender);
    const outcome = this.locked(() => {
      const parent = this.message(messageId) ?? fail("message_not_found", "amend/cancel needs a retained message you sent.");
      if (parent.urgency) fail("invalid_urgency", "amend/cancel must address the original message, not another amend/cancel.");
      if (parent.sender !== from.id) fail("not_sender", "You can only amend or cancel mail you sent.");
      if (parent.state === "withdrawn") {
        if (urgency === "cancel") return { cancelled: "withdrawn" as const, message_id: messageId };
        fail("nothing_to_cancel", "The original message was withdrawn.");
      }
      if (urgency === "cancel" && parent.state === "queued") {
        Object.assign(parent, { state: "withdrawn", updated_at: this.now(), hold_reason: null });
        this.saveMessage(parent);
        this.ring(parent.recipient);
        return { cancelled: "withdrawn" as const, message_id: messageId };
      }
      return parent;
    });
    if ("cancelled" in outcome) return outcome;
    const text = body && body.trim() ? body : `The sender cancelled message ${messageId}.`;
    return this.send(sender, outcome.recipient, { body: text, kind: "action", reply_to: messageId }, urgency);
  }

  /** Resolve a full message ID or a unique prefix (>= 6 chars), as shown in /mail lists. */
  findMessage(reference: string): StoredMessage {
    const wanted = reference.trim().toLowerCase();
    if (UUID.test(wanted)) return this.message(wanted) ?? fail("message_not_found", "No retained message has that ID.");
    if (wanted.length < 6 || !/^[0-9a-f-]+$/.test(wanted)) fail("invalid_id", "Use a message ID or a prefix of at least 6 characters.");
    const matches = this.list<StoredMessage>("messages").filter(message => message.message_id.startsWith(wanted));
    if (matches.length !== 1) fail(matches.length ? "message_ambiguous" : "message_not_found",
      matches.length ? "Several messages share that prefix; use more characters." : "No retained message has that ID prefix.");
    return matches[0];
  }
  /** Messages a sender has sent (for /mail sent and amend/cancel lookups). */
  sent(senderId: string, limit = 20): StoredMessage[] {
    return this.list<StoredMessage>("messages").filter(message => message.sender === senderId).sort(order).slice(-limit);
  }

  /** View-only inbox (queued/delivering/delivered unless `all`). Never acknowledges. */
  read(agentId: string, options: { all?: boolean; message_id?: string } = {}): StoredMessage[] {
    return this.list<StoredMessage>("messages").filter(message => message.recipient === agentId &&
      (options.message_id ? message.message_id === options.message_id
        : options.all || ["queued", "delivering", "delivered"].includes(message.state))).sort(order);
  }
  handle(agentId: string, ids: readonly string[]): StoredMessage[] {
    if (!ids.length) fail("invalid_id", "At least one message ID is required.");
    return this.locked(() => ids.map(id => {
      const message = this.message(id);
      if (!message || message.recipient !== agentId) return fail("message_not_found", `Message ${id} is not in this inbox.`);
      if (message.state === "delivering") fail("delivery_in_progress", "Resolve an uncertain delivery before handling it.");
      if (message.state === "withdrawn") fail("message_final", "A withdrawn message cannot be handled.");
      if (message.state !== "handled") {
        Object.assign(message, { state: "handled", handled_at: this.now(), updated_at: this.now(), hold_reason: null });
        this.saveMessage(message);
      }
      return message;
    }));
  }
  /** Operator recovery of an uncertain claim: requeue (not applied) or mark delivered (applied). */
  recover(messageId: string, disposition: "applied" | "requeue"): StoredMessage {
    return this.locked(() => {
      const message = this.message(messageId) ?? fail("message_not_found", "No such message.");
      if (message.state !== "delivering") fail("not_uncertain", "Only a delivering (uncertain) message can be recovered.");
      if (disposition === "applied")
        Object.assign(message, { state: "delivered", delivered_at: this.now(), evidence: "operator:applied", hold_reason: null });
      else Object.assign(message, { state: "queued", claim_id: null, claimed_generation: null, via: null,
        evidence: "operator:requeue", hold_reason: null });
      message.updated_at = this.now();
      this.saveMessage(message);
      this.ring(message.recipient);
      return message;
    });
  }
  /** Drop final messages and spent claims after 30 days. */
  retention(): number {
    const cutoff = this.now() - RETENTION_SECONDS;
    let removed = 0;
    for (const message of this.list<StoredMessage>("messages")) {
      if (FINAL.has(message.state) && message.updated_at < cutoff) {
        rmSync(this.file("messages", message.message_id), { force: true }); removed++;
      }
    }
    for (const claim of this.list<StoredClaim>("claims"))
      if (claim.created_at < cutoff) rmSync(this.file("claims", claim.claim_id), { force: true });
    return removed;
  }

  // ---- receiver protocol -------------------------------------------------------------------------
  readonly call: Call = async <O extends Operation>(operation: O, data: Request): Promise<ReceiverReplies[O]> => {
    const result = operation === "register" ? this.register(data)
      : operation === "inspect" ? this.inspect(this.identityOf(data))
      : operation === "claim" ? this.claim(data)
      : operation === "applied" ? this.applied(data)
      : operation === "release" ? this.release(data)
      : fail("invalid_request", "Unknown receiver operation.");
    return result as ReceiverReplies[O];
  };

  private identityOf(data: Request): AgentRecord {
    const agent = typeof data.agent_id === "string" ? this.agent(data.agent_id) : undefined;
    if (!agent || data.terminal_id !== agent.agent_id || data.generation !== agent.generation || agent.pid !== this.pid)
      fail("stale_session", "The mailbox registration changed; re-register this session.", "identity");
    return agent!;
  }

  /** Register this pi process as `agent_id` (the pi session id). A new process bumps the generation. */
  register(data: Request): Registration {
    const session = data.session_ref, agentId = data.agent_id, alias = data.alias, cwd = data.cwd;
    if (typeof session !== "string" || !path.isAbsolute(session)) fail("invalid_session", "session_ref must be the session file path.", "register");
    if (typeof agentId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(agentId)) fail("invalid_session", "agent_id must be the pi session id.", "register");
    const agent = this.locked(() => {
      const previous = this.agent(agentId as string);
      const now = this.now();
      const record: AgentRecord = {
        agent_id: agentId as string, alias: this.uniqueAlias(typeof alias === "string" ? alias : "", agentId as string),
        session_ref: session as string, cwd: typeof cwd === "string" ? cwd : "", host: this.host, pid: this.pid,
        generation: previous && previous.pid === this.pid ? previous.generation : (previous?.generation ?? 0) + 1,
        registered_at: previous && previous.pid === this.pid ? previous.registered_at : now, last_seen: now,
      };
      writeJson(this.file("agents", record.agent_id), record);
      return record;
    });
    try { this.retention(); } catch { /* best effort */ }
    const native: NativeAgent = { terminal_id: agent.agent_id, agent_id: agent.agent_id, generation: agent.generation,
      session_ref: agent.session_ref, alias: agent.alias };
    return { ...this.inspect(agent), agent: native, bell_directory: this.bellDirectory(), bell_name: agent.agent_id };
  }
  private uniqueAlias(requested: string, agentId: string): string {
    const base = safeLabel(requested, 48).replace(/\s+/g, "-") || "pi-" + agentId.slice(0, 8);
    const taken = this.agents().filter(agent => agent.agent_id !== agentId && agent.live && agent.alias === base);
    return taken.length ? `${base}-${agentId.slice(0, 4)}` : base;
  }

  private queued(agent: AgentRecord, maximumHop: number): StoredMessage[] {
    return this.read(agent.agent_id).filter(message => message.state === "queued" && message.hop <= maximumHop);
  }
  private readyAt(message: StoredMessage, thresholds: Thresholds): number {
    const coalesced = message.created_at + thresholds.coalesce_seconds;
    return message.kind === "fyi" && !message.urgency ? Math.max(coalesced, message.created_at + FYI_WAKE_DELAY_SECONDS) : coalesced;
  }
  private moot(message: StoredMessage): boolean {
    if (message.urgency !== "cancel" || !message.reply_to) return false;
    const target = this.message(message.reply_to);
    return !target || target.state === "withdrawn";
  }
  private wakeCount(agent: AgentRecord, now: number): number {
    return this.list<StoredClaim>("claims").filter(claim => claim.agent_id === agent.agent_id && claim.via === "wake" &&
      claim.created_at > now - 3600).length;
  }

  inspect(agent: AgentRecord): Inspection {
    const now = this.now(), thresholds = this.thresholds();
    const queued = this.queued(agent, thresholds.max_hop);
    const triggers = queued.filter(message => message.kind === "action" || this.readyAt(message, thresholds) <= now);
    const pending = this.list<StoredClaim>("claims").filter(claim => claim.agent_id === agent.agent_id && claim.applied_at === null &&
      claim.message_ids.some(id => this.message(id)?.state === "delivering"));
    const urgent: UrgentItem[] = queued.filter(message => message.urgency && !this.moot(message)).map(message => ({
      message_id: message.message_id, urgency: message.urgency!, target_message_id: message.reply_to!, thread_id: message.thread_id }));
    const inbox: InboxItem[] = this.read(agent.agent_id).filter(message => message.state !== "delivered").slice(0, 20).map(message => ({
      message_id: message.message_id, thread_id: message.thread_id, kind: message.kind, urgency: message.urgency,
      target_message_id: message.urgency ? message.reply_to : null, sender: message.sender_label, subject: message.subject,
      preview: truncateUtf8(message.body.replace(/\s+/g, " ").trim(), 240), state: message.state, created_at: message.created_at }));
    return { thresholds, role: "worker", turn_state: "idle", wake_count: this.wakeCount(agent, now),
      pending_claims: pending.map(({ claim_id, agent_id, generation, session_ref, marker, content_sha256 }) =>
        ({ claim_id, agent_id, generation, session_ref, marker, content_sha256 })),
      has_action: triggers.length > 0,
      coalesce_until: triggers.length ? Math.min(...triggers.map(message => this.readyAt(message, thresholds))) : 0,
      skip_input_quiet: false, urgent, inbox, queued_total: queued.length };
  }

  claim(data: Request): ClaimBundle | { claim_id: null; reason: string } {
    const agent = this.identityOf(data);
    const wake = data.wake === true;
    const urgent = data.urgent;
    const narrowed = data.message_ids;
    if (urgent !== undefined && (!Array.isArray(urgent) || !urgent.length || urgent.some(kind => kind !== "amend" && kind !== "cancel")))
      fail("invalid_urgency", "urgent must list amend and/or cancel.", "claim");
    if (urgent !== undefined && wake) fail("invalid_request", "An urgent claim is not a wake claim.", "claim");
    if (narrowed !== undefined && (urgent === undefined || !Array.isArray(narrowed) || !narrowed.length ||
        narrowed.some(id => typeof id !== "string" || !UUID.test(id))))
      fail("invalid_request", "message_ids narrows a nonempty urgent claim only.", "claim");
    return this.locked(() => {
      const now = this.now(), thresholds = this.thresholds();
      // A cancel whose original was withdrawn before delivery has nothing to stop or report.
      for (const message of this.queued(agent, Infinity)) {
        if (this.moot(message)) {
          Object.assign(message, { state: "handled", handled_at: now, updated_at: now, evidence: "cancel:target_withdrawn" });
          this.saveMessage(message);
        }
      }
      let rows = this.queued(agent, thresholds.max_hop);
      let via = wake ? "wake" : "before_agent_start";
      if (urgent !== undefined) {
        const kinds = new Set(urgent as string[]);
        const chosen = rows.filter(row => row.urgency && kinds.has(row.urgency) &&
          (narrowed === undefined || (narrowed as string[]).includes(row.message_id)));
        if (!chosen.length) return { claim_id: null, reason: "empty" };
        const targets = new Set(chosen.map(row => row.reply_to));
        rows = fitRows([...new Map([...rows.filter(row => targets.has(row.message_id)), ...chosen]
          .map(row => [row.message_id, row])).values()].sort(order));
        if (!rows.some(row => row.urgency)) return { claim_id: null, reason: "unrepresentable" };
        via = "urgent";
      } else if (wake) {
        const ready = (row: StoredMessage) => this.readyAt(row, thresholds) <= now;
        const trigger = rows.filter(row => row.kind === "action" || ready(row))
          .sort((a, b) => Number(!(a.kind === "action" && ready(a))) - Number(!(b.kind === "action" && ready(b))) ||
            this.readyAt(a, thresholds) - this.readyAt(b, thresholds))[0];
        if (!trigger) return { claim_id: null, reason: "no_action" };
        if (this.wakeCount(agent, now) >= thresholds.wakes_per_hour) return { claim_id: null, reason: "hourly_limit" };
        if (this.readyAt(trigger, thresholds) > now) return { claim_id: null, reason: "coalescing" };
        rows = fitRows(rows.slice(0, BUNDLE_MESSAGES), trigger.message_id);
      } else {
        rows = fitRows(rows.slice(0, BUNDLE_MESSAGES));
      }
      if (!rows.length) return { claim_id: null, reason: "empty" };
      const claimId = randomUUID();
      const marker = `HAM_CLAIM_${claimId}_${randomUUID().replace(/-/g, "")}`;
      const content = renderBundle(rows, marker) ?? fail("context_too_large", "Claimed messages are not representable.", "claim");
      for (const row of rows) {
        Object.assign(row, { state: "delivering", claim_id: claimId, claimed_generation: agent.generation, via,
          hold_reason: "acceptance_unknown", evidence: null, updated_at: now });
        this.saveMessage(row);
      }
      const digest = sha256(content);
      const claim: StoredClaim = { claim_id: claimId, agent_id: agent.agent_id, generation: agent.generation,
        session_ref: agent.session_ref, marker, content_sha256: digest, via, message_ids: rows.map(row => row.message_id),
        created_at: now, applied_at: null };
      writeJson(this.file("claims", claimId), claim);
      return { claim_id: claimId, agent_id: agent.agent_id, generation: agent.generation, session_ref: agent.session_ref,
        marker, content_sha256: digest, via, skip_input_quiet: false,
        messages: rows.map(row => ({ message_id: row.message_id, thread_id: row.thread_id, kind: row.kind, urgency: row.urgency })),
        message: { customType: "ham_mailbox", content, display: true, details: { protocol: 1, claim_id: claimId,
          agent_id: agent.agent_id, generation: agent.generation, session_ref: agent.session_ref, marker } } };
    });
  }

  private claimOf(data: Request): StoredClaim {
    const id = data.claim_id;
    if (typeof id !== "string" || !UUID.test(id)) fail("invalid_id", "claim_id must be a UUID.", "claim");
    const claim = readJson<StoredClaim>(this.file("claims", id as string)) ?? fail("claim_not_found", "Claim is absent.", "claim");
    if (claim.agent_id !== data.agent_id || claim.generation !== data.generation) fail("stale_claim", "Claim agent/generation does not match.", "claim");
    return claim;
  }
  applied(data: Request): { receipts: unknown[] } {
    return this.locked(() => {
      const claim = this.claimOf(data);
      if (claim.session_ref !== data.session_ref || claim.marker !== data.marker || claim.content_sha256 !== data.content_sha256 ||
          typeof data.entry_id !== "string" || !data.entry_id)
        fail("invalid_evidence", "ACK must match the exact session, claim marker and accepted context hash.", "applied");
      const now = this.now();
      const receipts = claim.message_ids.map(id => this.message(id)).filter((row): row is StoredMessage => !!row).map(row => {
        if (row.state === "delivering" && row.claim_id === claim.claim_id) {
          Object.assign(row, { state: "delivered", delivered_at: now, updated_at: now, hold_reason: null,
            evidence: `pi:accepted-journal:${claim.session_ref}#${data.entry_id};sha256=${claim.content_sha256}` });
          this.saveMessage(row);
        }
        return { message_id: row.message_id, state: row.state };
      });
      claim.applied_at = now;
      writeJson(this.file("claims", claim.claim_id), claim);
      return { receipts };
    });
  }
  release(data: Request): { released: number; uncertain: number } {
    const disposition = data.disposition;
    if ((disposition !== "not_applied" && disposition !== "unknown") || typeof data.evidence !== "string" || !data.evidence.trim())
      fail("invalid_disposition", "Release needs not_applied/unknown and explicit evidence.", "release");
    return this.locked(() => {
      const claim = this.claimOf(data);
      let count = 0;
      for (const id of claim.message_ids) {
        const row = this.message(id);
        if (!row || row.state !== "delivering" || row.claim_id !== claim.claim_id) continue;
        count++;
        if (disposition === "not_applied")
          Object.assign(row, { state: "queued", claim_id: null, claimed_generation: null, via: null, hold_reason: null });
        else row.hold_reason = "acceptance_unknown";
        row.evidence = data.evidence as string; row.updated_at = this.now();
        this.saveMessage(row);
      }
      if (disposition === "not_applied") rmSync(this.file("claims", claim.claim_id), { force: true });
      return { released: disposition === "not_applied" ? count : 0, uncertain: disposition === "unknown" ? count : 0 };
    });
  }
}

export function defaultRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.PI_MAILBOX_DIR) return path.resolve(env.PI_MAILBOX_DIR);
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent");
  return path.join(agentDir, "mailbox");
}
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export const localExists = (root: string) => existsSync(root);
