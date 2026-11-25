/**
 * In-session queue processing for one pi session, independent of where mail lives.
 *
 * A backend (HAM ledger or the local file mailbox) is the control plane: it stores
 * mail, admits each claim and records acknowledgements. Nothing ever types into pi
 * or starts a turn from outside; the backend's bell file is only a doorbell. This
 * class decides when to claim and inject:
 *
 * - ordinary mail: one bounded bundle once pi is idle, the editor is empty and
 *   input has been quiet (the backend still admits each wake claim);
 * - amend (urgent supplement): steered into the run working on the original
 *   thread, otherwise first in line at idle; never over an editor draft;
 * - cancel: aborts the run working on the original thread even over a draft,
 *   then starts a turn so the agent reports what was already done.
 *
 * Reads and the overlay are view-only. Delivery is acknowledged only from the
 * exact marker/content hash in this session's journal.
 */
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MailboxBoard, boardOptions, loadPosition, savePosition, type BoardSnapshot } from "./board.ts";
import { defaultRoot } from "./local.ts";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import { ReceiverError, type Call, type ClaimBundle, type Inspection, type NativeAgent, type NativeClaim,
  type NativeMessage, type Operation, type ReceiverReplies, type Registration, type Request, type Thresholds,
  type Urgency } from "./types.ts";

type Phase = "prepared" | "sent" | "unknown";
type Pending = NativeClaim & { phase: Phase; preparation?: string; message?: NativeMessage; threads: string[]; sentAt?: number };

const WAKE_READY_STATES: Record<string, true> = { idle: true, done: true };
const STATUS_KEY = "pi-mailbox";
/** A triggered run journals its message at run start; give that start time before judging absence. */
const SENT_GRACE_MS = 3000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (agent: NativeAgent) => ({ terminal_id: agent.terminal_id, agent_id: agent.agent_id, generation: agent.generation });
const diagnosticText = (value: string, limit: number) => value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").slice(0, limit);

export type Environment = Record<string, string | undefined>;
export interface Backend {
  /** Status-line label and diagnostics prefix. */
  readonly name: "ham" | "local";
  /** Client name sent with registration. */
  readonly client: string;
  readonly call: Call;
  /** Backend-specific admission in addition to the root interactive-session rule. */
  eligible(env: Environment): boolean;
  /** Extra registration fields (the local backend keys agents by pi session id and alias). */
  registration?(ctx: ExtensionContext, pi: ExtensionAPI): Request;
}

interface JournalEntry { type?: string; id?: string; customType?: string; content?: unknown; details?: unknown }

/** Exact marker/content-hash match of a HAM custom_message in this session's journal. */
export function acceptedEntry(entries: readonly JournalEntry[], pending: NativeClaim): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom_message" || entry.customType !== "ham_mailbox") continue;
    if (typeof entry.details !== "object" || entry.details === null || Array.isArray(entry.details)) continue;
    const details = entry.details as Request;
    if (details.protocol !== 1 || details.claim_id !== pending.claim_id || details.agent_id !== pending.agent_id ||
        details.generation !== pending.generation || details.session_ref !== pending.session_ref || details.marker !== pending.marker) continue;
    if (typeof entry.content !== "string" || !entry.content.startsWith(pending.marker + "\n") ||
        sha256(entry.content) !== pending.content_sha256) continue;
    return typeof entry.id === "string" ? entry.id : undefined;
  }
  return undefined;
}

type Timer = unknown;
export interface Timers {
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
  setInterval(callback: () => void, delay: number): Timer;
  clearInterval(timer: Timer): void;
}
const unref = <T>(timer: T): T => {
  (timer as { unref?: () => void } | undefined)?.unref?.();
  return timer;
};
const systemTimers: Timers = {
  setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, delay) => unref(setInterval(callback, delay)),
  clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>),
};

export function statusText(state: Pick<Inspection, "queued_total" | "urgent"> | undefined, pending: number,
                           label = "mail"): string | undefined {
  if (!state) return undefined;
  const parts: string[] = [];
  if (state.queued_total > 0) parts.push("✉ " + state.queued_total);
  if (state.urgent.length) parts.push("!" + state.urgent.length);
  if (pending) parts.push("…");
  return parts.length ? label + " " + parts.join(" ") : undefined;
}

export class PiMailbox {
  private ctx?: ExtensionContext;
  private sessionRef?: string;
  private registering?: Promise<Registration | undefined>;
  private watcher?: FSWatcher;
  private unsubscribe?: () => void;
  private timer?: Timer;
  private timerAt = Infinity;
  private safety?: Timer;
  private work?: Promise<void>;
  private recheck = false;
  private acknowledging = false;
  private stopped = true;
  readonly pending = new Map<string, Pending>();
  /** Threads injected into the current run; cleared once pi settles idle. */
  readonly activeThreads = new Set<string>();
  private inputSerial = 0;
  private lastKey = Date.now();
  private preparing = 0;
  private running = false;
  private blocked = 0;
  private abortRequested = false;
  private refreshNeeded = true;
  private errors = new Map<string, number>();
  private registrationFailures = 0;
  state?: Inspection;
  registration?: Registration;
  /** Side panel overlay options, shared with pi-tui, which reads the drag offsets on every render. */
  private boardOptions?: OverlayOptions;
  private lastError?: string;
  private board?: { close: () => void; rerender: () => void };

  private call: Call;

  constructor(private pi: ExtensionAPI, readonly backend: Backend,
              private environment: Environment = process.env,
              private timers: Timers = systemTimers) {
    this.call = backend.call;
  }

  /** Only a root interactive pi receives; subagents and headless modes never do. */
  eligible(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && ctx.hasUI && !this.environment.PI_SUBAGENT_CHILD && this.backend.eligible(this.environment);
  }
  get label(): string { return this.backend.name === "ham" ? "HAM" : "mail"; }
  private belongs(ctx: ExtensionContext): boolean {
    return !this.stopped && this.eligible(ctx) && this.sessionRef !== undefined &&
      ctx.sessionManager.getSessionFile() === this.sessionRef;
  }
  private current(ctx: ExtensionContext): boolean {
    return this.belongs(ctx) && !!this.registration && this.registration.agent.session_ref === this.sessionRef;
  }

  // ---- diagnostics and status line -------------------------------------------------------------
  private report(ctx: ExtensionContext, error: unknown, phase: string): void {
    const textValue = String(error);
    const code = error instanceof ReceiverError ? error.code : textValue;
    const key = JSON.stringify([code, error instanceof ReceiverError ? error.phase : phase]);
    const now = Date.now(), previous = this.errors.get(key);
    ctx.ui.setStatus(STATUS_KEY, this.label + ": receiver unavailable");
    this.lastError = diagnosticText(textValue, 240);
    this.board?.rerender();
    if (previous === undefined || now - previous >= 600000) {
      ctx.ui.notify(diagnosticText(textValue, 1200), "warning");
      this.errors.set(key, now);
    }
  }
  private recover(ctx: ExtensionContext): void {
    if (this.errors.size) this.errors.clear();
    this.render(ctx);
  }
  private render(ctx: ExtensionContext): void {
    this.board?.rerender();
    if (this.errors.size) return;
    ctx.ui.setStatus(STATUS_KEY, statusText(this.state, this.pending.size, this.label));
  }
  private async receiver<O extends Operation>(operation: O, data: Request, ctx: ExtensionContext): Promise<ReceiverReplies[O]> {
    const result = await this.call(operation, data);
    if (this.belongs(ctx)) this.recover(ctx);
    return result;
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  schedule(ctx: ExtensionContext, delay = 250): void {
    if (!this.belongs(ctx)) return;
    this.ctx = ctx;
    const at = Date.now() + Math.max(0, delay);
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined; this.timerAt = Infinity;
      void this.kick(this.ctx ?? ctx);
    }, Math.max(0, delay));
  }
  async start(ctx: ExtensionContext): Promise<void> {
    if (!this.eligible(ctx)) return;
    const session = ctx.sessionManager.getSessionFile();
    if (!session || !path.isAbsolute(session)) return;
    this.stopped = false;
    this.ctx = ctx;
    this.sessionRef = session;
    this.running = ctx.isIdle() === false;
    this.lastKey = Date.now();
    this.unsubscribe = ctx.ui.onTerminalInput(data => {
      // Focus reports are not typing; actual typing/paste resets the quiet time.
      if (data !== "\x1b[I" && data !== "\x1b[O") { this.lastKey = Date.now(); this.inputSerial++; this.schedule(this.ctx ?? ctx, 1000); }
      return undefined;
    });
    this.safety = this.timers.setInterval(() => { this.refreshNeeded = true; void this.kick(this.ctx ?? ctx); }, 300000);
    await this.register(ctx);
    this.schedule(ctx, 0);
  }
  async shutdown(ctx: ExtensionContext): Promise<void> {
    if (this.stopped) return;
    if (this.belongs(ctx)) await this.confirm(ctx);
    this.stopped = true;
    this.watcher?.close(); this.watcher = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.safety) this.timers.clearInterval(this.safety);
    this.timer = this.safety = undefined; this.timerAt = Infinity;
    this.board?.close();
    for (const pending of [...this.pending.values()])
      await this.release(pending, "unknown", "pi receiver shutdown without correlated ACK", ctx);
    this.pending.clear();
    this.registration = undefined;
  }
  private async register(ctx: ExtensionContext): Promise<Registration | undefined> {
    if (!this.belongs(ctx)) return undefined;
    if (this.registering) return this.registering;
    if (!this.refreshNeeded && this.current(ctx)) return this.registration;
    const session = this.sessionRef!;
    const operation = (async () => {
      try {
        const result = await this.receiver("register", { session_ref: session, client: this.backend.client,
          ...(this.backend.registration?.(ctx, this.pi) ?? {}) }, ctx);
        if (!this.belongs(ctx)) return undefined;
        this.registration = result; this.refreshNeeded = false; this.registrationFailures = 0;
        this.state = result;
        for (const claim of result.pending_claims) {
          if (!this.pending.has(claim.claim_id)) this.pending.set(claim.claim_id, { ...claim, phase: "unknown", threads: [] });
        }
        if (!this.watcher) {
          try {
            this.watcher = watch(result.bell_directory, (_event, filename) => {
              // _board is for the Mailbox TUI; nameless events conservatively recheck.
              if (!filename || String(filename) === result.bell_name) this.schedule(this.ctx ?? ctx);
            });
            this.watcher.on("error", error => { this.report(this.ctx ?? ctx, error, "watch"); this.watcher?.close(); this.watcher = undefined; });
          } catch (error) { this.report(ctx, error, "watch"); }
        }
        this.render(ctx);
        return result;
      } catch (error) {
        if (this.belongs(ctx)) {
          this.registrationFailures++;
          if (error instanceof ReceiverError && error.code === "native_session_pending" && this.registrationFailures < 10)
            ctx.ui.setStatus(STATUS_KEY, this.label + ": waiting for native session");
          else this.report(ctx, error, "register");
          if (this.registrationFailures < 10) this.schedule(ctx, Math.min(1000, 250 * this.registrationFailures));
        }
        return undefined;
      }
    })();
    this.registering = operation;
    try { return await operation; } finally { if (this.registering === operation) this.registering = undefined; }
  }

  // ---- claim bookkeeping -------------------------------------------------------------------
  private async release(pending: Pending, disposition: "unknown" | "not_applied", evidence: string, ctx: ExtensionContext): Promise<void> {
    pending.phase = "unknown";
    try {
      await this.call("release", { claim_id: pending.claim_id, agent_id: pending.agent_id,
        generation: pending.generation, disposition, evidence });
      if (disposition === "not_applied") this.pending.delete(pending.claim_id);
    } catch (error) { if (!this.stopped) this.report(ctx, error, "release"); }
  }
  async confirm(ctx: ExtensionContext): Promise<void> {
    if (this.acknowledging || !this.current(ctx) || !this.pending.size) return;
    this.acknowledging = true;
    try {
      const entries = ctx.sessionManager.getBranch() as readonly JournalEntry[];
      for (const pending of [...this.pending.values()]) {
        const entry = acceptedEntry(entries, pending);
        if (!entry) continue;
        try {
          await this.receiver("applied", { claim_id: pending.claim_id, agent_id: pending.agent_id,
            generation: pending.generation, session_ref: pending.session_ref, marker: pending.marker,
            content_sha256: pending.content_sha256, entry_id: entry }, ctx);
          this.pending.delete(pending.claim_id);
        } catch (error) { this.report(ctx, error, "applied"); }
      }
    } finally { this.acknowledging = false; this.render(ctx); }
  }
  private track(claim: ClaimBundle, phase: Phase, preparation?: string): Pending {
    const threads = [...new Set(claim.messages.map(message => message.thread_id))];
    const pending: Pending = { claim_id: claim.claim_id, agent_id: claim.agent_id, generation: claim.generation,
      session_ref: claim.session_ref, marker: claim.marker, content_sha256: claim.content_sha256,
      phase, preparation, message: claim.message, threads };
    this.pending.set(claim.claim_id, pending);
    for (const thread of threads) this.activeThreads.add(thread);
    return pending;
  }
  /**
   * Inject while the final gates still hold in this same synchronous tick.
   * steer: queued into the running turn (pi delivers it after the current tool calls);
   * turn: starts a run (the message is journaled at run start).
   */
  private inject(pending: Pending, mode: "steer" | "turn"): boolean {
    pending.phase = "sent"; pending.sentAt = Date.now();
    try {
      this.pi.sendMessage(pending.message!, mode === "steer"
        ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true });
      return true;
    } catch {
      return false;
    }
  }

  // ---- gates ---------------------------------------------------------------------------------
  private editorEmpty(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && typeof ctx.ui.getEditorText === "function" && ctx.ui.getEditorText() === "";
  }
  private quiet(ctx: ExtensionContext, thresholds: Thresholds, skipInputQuiet = false): boolean {
    return this.editorEmpty(ctx) && (skipInputQuiet || Date.now() - this.lastKey >= thresholds.idle_minutes * 60000);
  }
  private idle(ctx: ExtensionContext): boolean {
    return !this.running && !this.blocked && !this.preparing && ctx.isIdle() && !ctx.hasPendingMessages();
  }

  // ---- queue processing ----------------------------------------------------------------------
  async kick(ctx: ExtensionContext): Promise<void> {
    if (!this.belongs(ctx)) return;
    if (this.work) { this.recheck = true; return; }
    const operation = this.probe(ctx).catch(error => { if (this.belongs(ctx)) this.report(ctx, error, "inspect"); });
    this.work = operation;
    try { await operation; }
    finally {
      this.work = undefined;
      if (this.recheck) { this.recheck = false; this.schedule(this.ctx ?? ctx, 0); }
    }
  }
  private async probe(ctx: ExtensionContext): Promise<void> {
    const registration = await this.register(ctx);
    if (!registration || !this.current(ctx)) return;
    await this.confirm(ctx);
    const state = await this.receiver("inspect", identity(registration.agent), ctx);
    if (!this.current(ctx)) return;
    this.state = state;
    const remaining = new Set(state.pending_claims.map(claim => claim.claim_id));
    for (const [id, pending] of this.pending) if (pending.phase === "unknown" && !remaining.has(id)) this.pending.delete(id);
    this.render(ctx);
    if (this.idle(ctx)) await this.settleStale(ctx);
    if (await this.urgent(ctx, registration, state)) return;
    await this.ordinary(ctx, registration, state);
  }

  /** At idle, resolve claims that never showed up in the journal; never replay them blindly. */
  private async settleStale(ctx: ExtensionContext): Promise<void> {
    for (const pending of [...this.pending.values()]) {
      if (pending.phase === "prepared") {
        await this.release(pending, "unknown", "settled without accepted journal context", ctx);
      } else if (pending.phase === "sent" && Date.now() - (pending.sentAt ?? 0) >= SENT_GRACE_MS) {
        const all = ctx.sessionManager.getEntries() as readonly JournalEntry[];
        // Nothing journaled anywhere and nothing still queued inside pi: it never entered context.
        if (!acceptedEntry(all, pending) && !ctx.hasPendingMessages())
          await this.release(pending, "not_applied", "settled with no journaled context and no queued pi message", ctx);
        else await this.release(pending, "unknown", "settled without branch-correlated ACK", ctx);
      } else if (pending.phase === "sent") {
        this.schedule(ctx, SENT_GRACE_MS);
      }
    }
  }

  /** Returns true when urgent mail was handled (or is deliberately being waited for this tick). */
  private async urgent(ctx: ExtensionContext, registration: Registration, state: Inspection): Promise<boolean> {
    if (!state.urgent.length || this.blocked || this.preparing) return false;
    const cancels = state.urgent.filter(item => item.urgency === "cancel");
    const amends = state.urgent.filter(item => item.urgency === "amend");
    const busy = this.running || !ctx.isIdle();
    if (busy) {
      // cancel: abort only the run that is working on the cancelled thread, even over a draft.
      if (cancels.some(item => this.activeThreads.has(item.thread_id))) {
        if (!this.abortRequested) {
          this.abortRequested = true;
          ctx.ui.notify(this.label + ": the sender cancelled the mail this run is working on; stopping to report back.", "warning");
          ctx.abort();
        }
        return true;  // agent_settled reschedules; the cancel is then claimed at idle.
      }
      // amend: steer into the run working on that thread; never over a draft.
      const steer = amends.filter(item => this.activeThreads.has(item.thread_id));
      if (steer.length && this.editorEmpty(ctx)) {
        const serial = this.inputSerial;
        const claim = await this.receiver("claim", { ...identity(registration.agent), urgent: ["amend"],
          message_ids: steer.map(item => item.message_id) }, ctx);
        if (claim.claim_id === null) return false;
        const pending = this.track(claim, "prepared");
        if (!this.current(ctx) || serial !== this.inputSerial || !this.editorEmpty(ctx) || ctx.isIdle()) {
          // Run finished or the user started typing: let the idle path deliver it instead.
          await this.release(pending, "not_applied", "steer not submitted after final run/editor gate changed", ctx);
          this.schedule(ctx, 0);
          return true;
        }
        if (!this.inject(pending, "steer")) await this.release(pending, "unknown", "steer acceptance uncertain", ctx);
        this.render(ctx);
        return true;
      }
      return false;  // urgent mail for other work waits for idle, first in line.
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages() || [...this.pending.values()].some(item => item.phase !== "unknown")) return false;
    const editorEmpty = this.editorEmpty(ctx);
    const kinds: Urgency[] = [...(cancels.length ? ["cancel" as const] : []), ...(amends.length && editorEmpty ? ["amend" as const] : [])];
    if (!kinds.length) return false;  // only amends behind a draft: wait.
    const serial = this.inputSerial;
    const claim = await this.receiver("claim", { ...identity(registration.agent), urgent: kinds }, ctx);
    if (claim.claim_id === null) return false;
    const pending = this.track(claim, "prepared");
    const hasCancel = claim.messages.some(item => item.urgency === "cancel");
    // cancel is allowed over a draft; anything else needs the editor to stay untouched.
    if (!this.current(ctx) || !ctx.isIdle() || ctx.hasPendingMessages() ||
        (!hasCancel && (serial !== this.inputSerial || !this.editorEmpty(ctx)))) {
      await this.release(pending, "not_applied", "urgent turn not submitted after final idle/editor gate changed", ctx);
      this.schedule(ctx, 1000);
      return true;
    }
    if (!this.inject(pending, "turn")) await this.release(pending, "unknown", "urgent sendMessage acceptance uncertain", ctx);
    this.render(ctx);
    return true;
  }

  private async ordinary(ctx: ExtensionContext, registration: Registration, state: Inspection): Promise<void> {
    if (!this.idle(ctx)) { if (!this.running) this.schedule(ctx, 1000); return; }
    if (this.pending.size || !state.has_action || state.role === null) return;
    if (!this.quiet(ctx, state.thresholds, state.skip_input_quiet)) {
      this.schedule(ctx, Math.max(1000, this.lastKey + state.thresholds.idle_minutes * 60000 - Date.now()));
      return;
    }
    if (!Object.hasOwn(WAKE_READY_STATES, state.turn_state)) { this.refreshNeeded = true; this.schedule(ctx, 1000); return; }
    if (state.wake_count >= state.thresholds.wakes_per_hour) { this.schedule(ctx, 300000); return; }
    if (state.coalesce_until * 1000 > Date.now()) { this.schedule(ctx, state.coalesce_until * 1000 - Date.now()); return; }
    const serial = this.inputSerial;
    const claim = await this.receiver("claim", { ...identity(registration.agent), wake: true }, ctx);
    if (claim.claim_id === null) return;
    const pending = this.track(claim, "prepared");
    // No await may separate this final idle/editor/session check and sendMessage.
    if (!this.current(ctx) || serial !== this.inputSerial || !this.idle(ctx) || !this.quiet(ctx, state.thresholds, claim.skip_input_quiet)) {
      await this.release(pending, "not_applied", "wake never submitted after final user/idle/session gate changed", ctx);
      return;
    }
    if (!this.inject(pending, "turn")) await this.release(pending, "unknown", "sendMessage acceptance uncertain", ctx);
    this.render(ctx);
  }

  /** A user prompt carries queued mail along (natural receipt at a turn boundary). */
  async natural(event: { prompt?: string; messageType?: string }, ctx: ExtensionContext): Promise<{ message: NativeMessage } | undefined> {
    if (!this.belongs(ctx) || event.messageType === "custom") return undefined;
    const serial = this.inputSerial;
    const preparation = serial + ":" + sha256(String(event.prompt || ""));
    this.preparing++;
    try {
      if (this.work) await this.work;
      this.refreshNeeded = true;
      const registration = await this.register(ctx);
      if (!registration || !this.current(ctx) || serial !== this.inputSerial) return undefined;
      await this.confirm(ctx);
      for (const pending of this.pending.values()) {
        if (pending.phase === "prepared" && pending.preparation === preparation && pending.message) return { message: pending.message };
      }
      const claim = await this.receiver("claim", { ...identity(registration.agent), wake: false }, ctx);
      if (claim.claim_id === null) return undefined;
      const pending = this.track(claim, "prepared", preparation);
      if (!this.current(ctx) || serial !== this.inputSerial) {
        await this.release(pending, "not_applied", "receiver did not return context after input/session changed", ctx);
        return undefined;
      }
      return { message: claim.message };
    } catch (error) { this.report(ctx, error, "claim"); return undefined; }
    finally { this.preparing--; this.render(ctx); }
  }

  // ---- event adapters ------------------------------------------------------------------------
  /** Re-register (e.g. after /name changes the local alias) and recheck. */
  refresh(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.refreshNeeded = true;
    this.schedule(ctx, 0);
  }
  input(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.lastKey = Date.now(); this.inputSerial++;
    this.schedule(ctx);
  }
  agentStart(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.running = true;
    this.schedule(ctx);
  }
  settled(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.running = false; this.abortRequested = false;
    this.activeThreads.clear();
    this.refreshNeeded = true;
    void this.confirm(ctx).then(() => this.schedule(ctx, 0));
  }
  prompt(start: boolean, ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.blocked = Math.max(0, this.blocked + (start ? 1 : -1));
    this.schedule(ctx);
  }
  activity(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    if (this.pending.size) void this.confirm(ctx);
    this.schedule(ctx, 500);
  }

  // ---- view-only mailbox board ---------------------------------------------------------------
  snapshot(): BoardSnapshot {
    return {
      backend: this.backend.name,
      items: this.state?.inbox ?? [],
      urgent: new Set((this.state?.urgent ?? []).map(item => item.message_id)),
      processing: [...this.pending.values()].some(pending => pending.phase !== "unknown"),
      error: this.errors.size ? this.lastError : undefined,
    };
  }
  /**
   * Show, hide or toggle the side panel (alt+m, ctrl+shift+m, /mail). It is non-capturing, reads
   * live state and never ACKs. `reset` moves it back to its default place above the editor.
   */
  async showMailbox(ctx: ExtensionContext, action: "toggle" | "on" | "off" | "reset" = "toggle"): Promise<void> {
    if (ctx.mode !== "tui") { ctx.ui.notify("The mailbox needs interactive mode.", "error"); return; }
    const root = defaultRoot(this.environment);
    if (action === "reset") {
      Object.assign(this.boardOptions ??= boardOptions(loadPosition(root)), boardOptions());
      savePosition(root, { offsetX: this.boardOptions.offsetX ?? 0, offsetY: this.boardOptions.offsetY ?? 0 });
      if (this.board) { this.board.rerender(); return; }
      action = "on";
    }
    if (this.board) { if (action !== "on") this.board.close(); return; }
    if (action === "off") return;
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    if (this.board) return;
    const options = this.boardOptions ??= boardOptions(loadPosition(root));
    const board: { close: () => void; rerender: () => void } = { close: () => undefined, rerender: () => undefined };
    this.board = board;
    // Refresh in the background; the board re-renders when the state arrives.
    if (this.belongs(ctx)) void (async () => {
      const registration = await this.register(ctx);
      if (!registration || !this.current(ctx)) return;
      try { this.state = await this.receiver("inspect", identity(registration.agent), ctx); this.render(ctx); }
      catch (error) { this.report(ctx, error, "inspect"); }
    })();
    // Ages ("3m") move on even when nothing else changes.
    const tick = this.timers.setInterval(() => board.rerender(), 30000);
    try {
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        board.close = () => done();
        board.rerender = () => tui.requestRender();
        return new MailboxBoard({ snapshot: () => this.snapshot(), overlay: options, measure: visibleWidth,
          terminal: () => ({ columns: tui.terminal.columns, rows: tui.terminal.rows }),
          requestRender: () => tui.requestRender(), moved: position => savePosition(root, position) });
      }, { overlay: true, overlayOptions: options });
    } finally {
      this.timers.clearInterval(tick);
      if (this.board === board) this.board = undefined;
    }
  }
}

