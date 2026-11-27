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
  /** Clock for the stale-state recovery; tests replace it. */
  now?(): number;
}
/** How long pi may report idle while the receiver still holds a turn open before the flag is dropped. */
export const STALE_TURN_MS = 60000;
/**
 * Terminal input that is not the user typing: focus reports, mouse reports (SGR and X10), cursor
 * position and device attribute replies, kitty keyboard flag replies, OSC and DCS replies.
 */
const NOT_TYPING = /^(?:\x1b\[[IO]|\x1b\[<[\d;]*[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\?\d*u|\x1b\][\s\S]*(?:\x07|\x1b\\)|\x1bP[\s\S]*\x1b\\)+$/;
export const isTyping = (data: string): boolean => data.length > 0 && !NOT_TYPING.test(data);
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
  /** When pi was first seen idle while `running` was still set. */
  private staleSince?: number;
  /** The last time the receiver dropped a stuck flag on its own, shown by `/mail why`. */
  private lastRecovery?: { what: string; at: number };
  private abortRequested = false;
  private refreshNeeded = true;
  private errors = new Map<string, number>();
  private registrationFailures = 0;
  state?: Inspection;
  registration?: Registration;
  /** Side panel overlay options, shared with pi-tui, which reads the drag offsets on every render. */
  private boardOptions?: OverlayOptions;
  private lastError?: string;
  /** The most recent reason a wake was not attempted, and since when it has held. */
  private lastSkip?: { reason: string; since: number };
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
      // Only typing and paste reset the quiet time; mouse, focus and terminal replies do not.
      if (isTyping(data)) { this.lastKey = Date.now(); this.inputSerial++; this.schedule(this.ctx ?? ctx, 1000); }
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
    this.recoverStaleTurn(ctx);
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

  /**
   * Why an idle-time wake cannot happen right now, in the order the wake path checks.
   * Each blocker carries the recheck it needs; an empty list means a wake claim may be tried.
   * `/mail why` shows the same list, so the explanation never drifts from the behaviour.
   */
  wakeBlockers(ctx: ExtensionContext, state: Inspection): { text: string; retry?: () => void }[] {
    const blockers: { text: string; retry?: () => void }[] = [];
    if (!this.idle(ctx)) {
      const idleNow = ctx.isIdle();
      if (this.running) blockers.push(idleNow && !ctx.hasPendingMessages()
        ? { text: "pi is idle, but the receiver still thinks a turn is running (agent_settled never arrived);" +
            ` it is dropped after ${STALE_TURN_MS / 1000}s`, retry: () => this.schedule(ctx, 5000) }
        : { text: "a turn is running" });
      if (this.blocked) blockers.push({ text: `an extension dialog is open (${this.blocked})`, retry: () => this.schedule(ctx, 1000) });
      if (this.preparing) blockers.push({ text: "a user prompt is being prepared", retry: () => this.schedule(ctx, 1000) });
      if (!idleNow && !this.running) blockers.push({ text: "pi is busy", retry: () => this.schedule(ctx, 1000) });
      if (ctx.hasPendingMessages()) blockers.push({ text: "pi has queued messages waiting to run", retry: () => this.schedule(ctx, 1000) });
      return blockers;
    }
    if (this.pending.size) {
      const phases = [...this.pending.values()].map(pending => pending.phase).join(", ");
      return [{ text: `a claimed bundle is not resolved yet (${phases}); /mail recover settles an uncertain one` }];
    }
    if (!state.has_action) return [{ text: state.queued_total
      ? "only FYI mail is queued; it waits for its batching delay or the next prompt"
      : "nothing is queued" }];
    if (state.role === null) return [{ text: "this session has no HAM role in this repository (mode off or not a member)" }];
    const thresholds = state.thresholds;
    const quietFor = Date.now() - this.lastKey, needed = thresholds.idle_minutes * 60000;
    if (!this.editorEmpty(ctx)) blockers.push({ text: "the editor has a draft",
      retry: () => this.schedule(ctx, Math.max(1000, this.lastKey + needed - Date.now())) });
    if (!state.skip_input_quiet && quietFor < needed) blockers.push({
      text: `terminal input ${Math.round(quietFor / 1000)}s ago; waits for ${thresholds.idle_minutes} min without input`,
      retry: () => this.schedule(ctx, Math.max(1000, this.lastKey + needed - Date.now())) });
    if (blockers.length) return blockers;
    if (!Object.hasOwn(WAKE_READY_STATES, state.turn_state))
      return [{ text: `HAM reports turn state '${state.turn_state}', not idle/done (Herdr's view of this pane)`,
        retry: () => { this.refreshNeeded = true; this.schedule(ctx, 1000); } }];
    if (state.wake_count >= thresholds.wakes_per_hour)
      return [{ text: `hourly wake limit reached (${state.wake_count}/${thresholds.wakes_per_hour})`, retry: () => this.schedule(ctx, 300000) }];
    const coalesce = state.coalesce_until * 1000 - Date.now();
    if (coalesce > 0) return [{ text: `collecting mail for ${Math.ceil(coalesce / 1000)}s more`, retry: () => this.schedule(ctx, coalesce) }];
    return [];
  }

  private now(): number { return this.timers.now?.() ?? Date.now(); }
  private recovered(what: string): void { this.lastRecovery = { what, at: this.now() }; }
  /** Drop a `running` flag that outlived the turn: pi has been idle with an empty queue for a while. */
  private recoverStaleTurn(ctx: ExtensionContext): void {
    if (!this.running || !ctx.isIdle() || ctx.hasPendingMessages()) { this.staleSince = undefined; return; }
    const now = this.now();
    this.staleSince ??= now;
    if (now - this.staleSince < STALE_TURN_MS) return;
    this.staleSince = undefined;
    this.recovered("turn running flag (agent_settled never arrived)");
    this.settled(ctx);
  }

  private skip(reason: string | undefined): void {
    if (reason === undefined) this.lastSkip = undefined;
    else if (this.lastSkip?.reason !== reason) this.lastSkip = { reason, since: Date.now() };
  }

  private async ordinary(ctx: ExtensionContext, registration: Registration, state: Inspection): Promise<void> {
    const [blocker] = this.wakeBlockers(ctx, state);
    if (blocker) { this.skip(blocker.text); blocker.retry?.(); return; }
    const serial = this.inputSerial;
    const claim = await this.receiver("claim", { ...identity(registration.agent), wake: true }, ctx);
    if (claim.claim_id === null) { this.skip(`${this.label} declined the wake claim: ${claim.reason}`); return; }
    const pending = this.track(claim, "prepared");
    // No await may separate this final idle/editor/session check and sendMessage.
    if (!this.current(ctx) || serial !== this.inputSerial || !this.idle(ctx) || !this.quiet(ctx, state.thresholds, claim.skip_input_quiet)) {
      this.skip("input or session changed while claiming; retrying");
      await this.release(pending, "not_applied", "wake never submitted after final user/idle/session gate changed", ctx);
      return;
    }
    this.skip(undefined);
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
    // The editor just submitted a prompt, so no modal dialog can be holding the keyboard.
    if (this.blocked) { this.blocked = 0; this.recovered("dialog count (the editor submitted a prompt)"); }
    this.lastKey = Date.now(); this.inputSerial++;
    this.schedule(ctx);
  }
  agentStart(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.running = true; this.staleSince = undefined;
    this.schedule(ctx);
  }
  settled(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    this.running = false; this.abortRequested = false; this.staleSince = undefined;
    this.activeThreads.clear();
    this.refreshNeeded = true;
    void this.confirm(ctx).then(() => this.schedule(ctx, 0));
  }
  /**
   * pi reports select/confirm/input/editor dialogs and every `ctx.ui.custom()` the same way, but only
   * when its nesting depth leaves or returns to zero. Persistent panels (this board, quota, pi-team)
   * are `custom` overlays that stay open for hours, so `custom` is not treated as a dialog: a modal
   * custom view is still covered by the input-quiet gate while the user types in it.
   */
  prompt(start: boolean, ctx: ExtensionContext, kind?: string): void {
    if (!this.belongs(ctx) || kind === "custom") return;
    this.blocked = Math.max(0, this.blocked + (start ? 1 : -1));
    this.schedule(ctx);
  }
  activity(ctx: ExtensionContext): void {
    if (!this.belongs(ctx)) return;
    if (this.pending.size) void this.confirm(ctx);
    this.schedule(ctx, 500);
  }

  // ---- diagnostics ---------------------------------------------------------------------------
  /** `/mail why`: what the receiver sees right now and why it is (not) processing mail. View-only. */
  async explain(ctx: ExtensionContext): Promise<string> {
    const ago = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(1)}h`;
    const lines = [`${this.label} receiver (${this.backend.name} backend)`];
    if (!this.eligible(ctx)) return lines.concat("Not receiving: only the root interactive pi session receives mail" +
      (this.backend.name === "ham" ? " inside Herdr" : "") + ".").join("\n");
    if (this.stopped || !this.belongs(ctx)) return lines.concat("Not receiving: the receiver has not started for this session.").join("\n");
    const registration = await this.register(ctx);
    if (!registration || !this.current(ctx))
      return lines.concat(`Not registered: ${this.lastError ?? "registration has not completed"}`).join("\n");
    let state: Inspection | undefined;
    try { state = await this.receiver("inspect", identity(registration.agent), ctx); this.state = state; this.render(ctx); }
    catch (error) { return lines.concat(`Inspect failed: ${diagnosticText(String(error), 400)}`).join("\n"); }
    const agent = registration.agent;
    lines[0] += ` · ${agent.alias ?? agent.agent_id.slice(0, 8)} (generation ${agent.generation}${state.role ? `, ${state.role}` : ""})`;
    const actions = state.inbox.filter(item => item.kind === "action").length;
    lines.push(`Queue: ${state.queued_total} queued (${actions} action, ${state.urgent.length} urgent)` +
      ` · turn state ${state.turn_state} · wakes ${state.wake_count}/${state.thresholds.wakes_per_hour} this hour`);
    lines.push(`Session: pi ${ctx.isIdle() ? "idle" : "busy"} · turn running ${this.running ? "yes" : "no"} · dialogs ${this.blocked}` +
      ` · preparing ${this.preparing} · pi queue ${ctx.hasPendingMessages() ? "not empty" : "empty"}`);
    lines.push(`Input: editor ${this.editorEmpty(ctx) ? "empty" : "has a draft"} · last input ${ago(Date.now() - this.lastKey)} ago` +
      ` (needs ${state.thresholds.idle_minutes}m)`);
    if (this.pending.size) lines.push(`Claims in flight: ${[...this.pending.values()].map(item => `${item.claim_id.slice(0, 8)} ${item.phase}`).join(", ")}`);
    if (this.errors.size && this.lastError) lines.push(`Receiver error: ${this.lastError}`);
    if (state.urgent.length) lines.push(this.running || !ctx.isIdle()
      ? "Urgent: cancels for the running thread abort it; amends steer in when the editor is empty; others wait for idle."
      : "Urgent: processed first once the editor is empty (a cancel also over a draft).");
    const blockers = state.queued_total ? this.wakeBlockers(ctx, state) : [];
    if (!state.queued_total) lines.push("Now: nothing is waiting.");
    else if (!blockers.length) lines.push("Now: ready; the next check claims and delivers the mail.");
    else lines.push(...blockers.map((blocker, index) => `${index ? "     " : "Now: "}waiting — ${blocker.text}`));
    if (this.lastRecovery) lines.push(`Recovered: dropped a stuck ${this.lastRecovery.what} ${ago(this.now() - this.lastRecovery.at)} ago`);
    if (this.lastSkip && state.queued_total)
      lines.push(`Last skipped: ${this.lastSkip.reason} (for ${ago(Date.now() - this.lastSkip.since)})`);
    this.schedule(ctx, 0);
    return lines.join("\n");
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

