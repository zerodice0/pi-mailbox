/**
 * HAM backend: the HAM ledger (Herdr Agent Messenger) is the control plane.
 * Every operation runs `python3 -m ham cli ledger runtime ...` from the current
 * HAM plugin root; this file never opens the ledger itself.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ReceiverError, type Inspection, type NativeClaim, type Operation, type ReceiverReplies, type Request,
  type Urgency } from "./types.ts";

export function record(value: unknown): Request {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid HAM JSON object");
  return value as Request;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid HAM string field");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid HAM text field");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid HAM numeric field");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid HAM array field");
  return value;
}
function urgency(value: unknown): Urgency | null {
  if (value === null || value === undefined) return null;
  if (value !== "amend" && value !== "cancel") throw new Error("Invalid HAM urgency");
  return value;
}
function skipInputQuiet(value: Request): boolean {
  if (value.skip_input_quiet === undefined) return false;
  if (typeof value.skip_input_quiet !== "boolean") throw new Error("Invalid HAM input-quiet permission");
  return value.skip_input_quiet;
}
function nativeClaim(value: unknown): NativeClaim {
  const row = record(value);
  return { claim_id: string(row.claim_id), agent_id: string(row.agent_id), generation: number(row.generation),
    session_ref: string(row.session_ref), marker: string(row.marker), content_sha256: string(row.content_sha256) };
}
function inspection(value: Request): Inspection {
  const thresholds = record(value.thresholds);
  if (value.role !== null && value.role !== "main" && value.role !== "worker") throw new Error("Invalid HAM role");
  if (typeof value.has_action !== "boolean") throw new Error("Invalid HAM action eligibility");
  // Older ledgers lack the pi fields; treat them as nothing urgent/previewable.
  const urgent = value.urgent === undefined ? [] : array(value.urgent).map(item => {
    const row = record(item);
    const kind = urgency(row.urgency);
    if (kind === null) throw new Error("Invalid HAM urgent item");
    return { message_id: string(row.message_id), urgency: kind, target_message_id: string(row.target_message_id),
      thread_id: string(row.thread_id) };
  });
  const inbox = value.inbox === undefined ? [] : array(value.inbox).map(item => {
    const row = record(item);
    return { message_id: string(row.message_id), thread_id: string(row.thread_id), kind: string(row.kind),
      urgency: urgency(row.urgency), target_message_id: row.target_message_id === null || row.target_message_id === undefined
        ? null : string(row.target_message_id),
      sender: text(row.sender), subject: text(row.subject), preview: text(row.preview), state: string(row.state),
      created_at: number(row.created_at) };
  });
  return { thresholds: { idle_minutes: number(thresholds.idle_minutes), coalesce_seconds: number(thresholds.coalesce_seconds),
      wakes_per_hour: number(thresholds.wakes_per_hour), max_hop: number(thresholds.max_hop) },
    role: value.role, turn_state: string(value.turn_state), wake_count: number(value.wake_count),
    pending_claims: array(value.pending_claims).map(nativeClaim), has_action: value.has_action,
    coalesce_until: number(value.coalesce_until), skip_input_quiet: skipInputQuiet(value), urgent, inbox,
    queued_total: value.queued_total === undefined ? inbox.length : number(value.queued_total),
    capabilities: value.capabilities === undefined ? undefined : array(value.capabilities).map(string) };
}
export function parseReply<O extends Operation>(operation: O, raw: unknown): ReceiverReplies[O] {
  const value = record(raw);
  let parsed: ReceiverReplies[Operation];
  if (operation === "register") {
    const agent = record(value.agent);
    if (agent.alias !== undefined && agent.alias !== null && typeof agent.alias !== "string") throw new Error("Invalid HAM alias");
    parsed = { ...inspection(value), agent: { terminal_id: string(agent.terminal_id), agent_id: string(agent.agent_id),
      generation: number(agent.generation), session_ref: string(agent.session_ref), alias: agent.alias ?? undefined },
      bell_directory: string(value.bell_directory), bell_name: string(value.bell_name) };
  } else if (operation === "inspect") parsed = inspection(value);
  else if (operation === "claim") {
    if (value.claim_id === null) parsed = { claim_id: null, reason: string(value.reason) };
    else {
      const message = record(value.message), details = record(message.details);
      if (message.customType !== "ham_mailbox" || message.display !== true || details.protocol !== 1)
        throw new Error("Invalid HAM context message");
      parsed = { ...nativeClaim(value), skip_input_quiet: skipInputQuiet(value),
        via: typeof value.via === "string" ? value.via : undefined,
        idle_source: typeof value.idle_source === "string" ? value.idle_source : undefined,
        messages: array(value.messages).map(item => {
          const row = record(item);
          return { message_id: string(row.message_id), thread_id: string(row.thread_id), kind: string(row.kind),
            urgency: urgency(row.urgency) };
        }),
        message: { customType: "ham_mailbox", content: string(message.content), display: true,
          details: { protocol: 1, claim_id: string(details.claim_id), agent_id: string(details.agent_id),
            generation: number(details.generation), session_ref: string(details.session_ref), marker: string(details.marker) } } };
    }
  } else if (operation === "applied") parsed = { receipts: array(value.receipts) };
  else parsed = { released: number(value.released), uncertain: number(value.uncertain) };
  return parsed as ReceiverReplies[O];
}

const diagnosticText = (value: string, limit: number) => value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").slice(0, limit);

async function runJSON(phase: string, program: string, args: string[], input?: Request, cwd?: string): Promise<unknown> {
  const started = performance.now();
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0, timedOut = false, settled = false;
  let spawnError: unknown;
  const failure = (code: string, message: string, exitCode: number | null, signal: string | null) =>
    new ReceiverError(diagnosticText(code, 80), diagnosticText(message, 240) +
      ` phase=${phase} exit_code=${exitCode} signal=${signal} timed_out=${timedOut}` +
      ` elapsed_ms=${Math.round(performance.now() - started)} stdout_bytes=${stdoutBytes} stderr_bytes=${stderrBytes}` +
      ` stderr=${JSON.stringify(diagnosticText(stderr.trim(), Infinity).slice(-240))}`, phase);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(program, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw failure("cli_spawn_error", String(error), null, null);
  }
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15000);
  const outputDecoder = new StringDecoder("utf8"), errorDecoder = new StringDecoder("utf8");
  child.stdout.on("data", (data: Buffer) => {
    stdoutBytes += data.length;
    if (stdoutBytes <= 1024 * 1024) stdout += outputDecoder.write(data);
    else child.kill("SIGKILL");
  });
  child.stderr.on("data", (data: Buffer) => {
    stderrBytes += data.length; stderr = (stderr + errorDecoder.write(data)).slice(-4096);
  });
  const finish = (code: number | null, signal: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    stdout += outputDecoder.end(); stderr = (stderr + errorDecoder.end()).slice(-4096);
    try {
      if (spawnError !== undefined) throw failure("cli_spawn_error", String(spawnError), code, signal);
      if (timedOut) throw failure("cli_timeout", "child exceeded 15000ms deadline", code, signal);
      if (stdoutBytes > 1024 * 1024) throw failure("cli_output_limit", "child output exceeded 1MiB", code, signal);
      if (!stdout.trim()) throw failure(code === 0 ? "cli_empty_output" : "cli_exit", "no JSON response", code, signal);
      let result: unknown;
      try { result = JSON.parse(stdout); }
      catch (error) { throw failure(code === 0 ? "cli_invalid_json" : "cli_exit", String(error), code, signal); }
      const response = record(result);
      if (response.error !== undefined) {
        const error = record(response.error);
        throw failure(string(error.code), string(error.message), code, signal);
      }
      if (code !== 0) throw failure("cli_exit", "child exited without a structured error", code, signal);
      resolve(result);
    } catch (error) {
      reject(error instanceof ReceiverError ? error : failure("cli_invalid_json", String(error), code, signal));
    }
  };
  child.on("error", error => {
    spawnError = error;
    if (child.pid === undefined) finish(null, null);
  });
  child.on("close", finish);
  child.stdin.on("error", () => undefined);
  child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  return promise;
}

export async function findRoot(): Promise<string> {
  const explicit = process.env.HERDR_AGENT_MESSENGER_ROOT;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("HAM explicit root must be absolute");
    await access(path.join(explicit, "ham", "__init__.py"));
    await access(path.join(explicit, "herdr-plugin.toml"));
    return explicit;
  }
  // Discover the CURRENT structured plugin root on every operation (updates move it).
  const result = record(await runJSON("root", process.env.HERDR_BIN_PATH || "herdr",
    ["plugin", "list", "--json", "--plugin", "herdr.agent-messenger"]));
  const payload = record(result.result);
  const root = record(array(payload.plugins)[0]).plugin_root;
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("HAM plugin_root unavailable");
  await access(path.join(root, "ham", "__init__.py"));
  await access(path.join(root, "herdr-plugin.toml"));
  return root;
}

export async function callReceiver<O extends Operation>(operation: O, data: Request): Promise<ReceiverReplies[O]> {
  const root = await findRoot();
  const args = operation === "release" ? ["ledger", "delivery", "release"] : ["ledger", "runtime", operation];
  const response = await runJSON(operation, process.env.HERDR_AGENT_PYTHON || "python3", ["-m", "ham", "cli", ...args], data, root);
  return parseReply(operation, response);
}


export type Environment = Record<string, string | undefined>;

/** HAM receiving needs the pane's root interactive pi inside Herdr (HAM identifies callers by pane). */
export function insideHerdr(env: Environment): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID;
}

/** True when a HAM plugin root that speaks the runtime protocol can be found. */
export async function hamAvailable(env: Environment = process.env): Promise<boolean> {
  if (!insideHerdr(env)) return false;
  try {
    await findRoot();
    return true;
  } catch {
    return false;
  }
}

export function diagnostic(value: string, limit = 1200): string {
  return diagnosticText(value, limit);
}
