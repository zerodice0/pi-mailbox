/**
 * pi-mailbox: queued, idle-time mail for pi sessions, with urgent amend (steer) and
 * cancel (abort + report).
 *
 * Backends (PI_MAILBOX_BACKEND=auto|ham|local, default auto):
 * - ham:   inside Herdr with the HAM plugin installed, HAM's ledger is the control
 *          plane (routing across repositories/hosts, roles, limits). Agents use the
 *          HAM CLI/skill; the user uses the HAM Mailbox TUI.
 * - local: everywhere else, a file mailbox shared by this user's pi sessions on this
 *          host. Agents get mailbox_* tools; the user gets /mail.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BOARD_KEYS } from "./src/board.ts";
import { cardLines, parseBundle } from "./src/card.ts";
import { PiMailbox, type Backend } from "./src/core.ts";
import { callReceiver, hamAvailable, insideHerdr } from "./src/ham.ts";
import { LocalMailbox, type Sender, type StoredMessage } from "./src/local.ts";

type Reply = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const reply = (value: unknown): Reply =>
  ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });

export const hamBackend: Backend = { name: "ham", client: "pi", call: callReceiver, eligible: insideHerdr };

export function localBackend(local: () => LocalMailbox): Backend {
  return {
    name: "local", client: "pi",
    call: (operation, data) => local().call(operation, data),
    eligible: () => true,
    registration: (ctx, pi) => ({
      agent_id: ctx.sessionManager.getSessionId(),
      alias: pi.getSessionName() || path.basename(ctx.cwd || "") || "pi",
      cwd: ctx.cwd,
    }),
  };
}

export async function chooseBackend(env: Record<string, string | undefined> = process.env): Promise<"ham" | "local"> {
  const choice = (env.PI_MAILBOX_BACKEND || "auto").toLowerCase();
  if (choice === "ham" || choice === "local") return choice;
  return (await hamAvailable(env)) ? "ham" : "local";
}

const short = (id: string) => id.slice(0, 8);
function line(message: StoredMessage): string {
  const tag = message.urgency ? `${message.kind}·${message.urgency}` : message.kind;
  const preview = message.body.replace(/\s+/g, " ").trim().slice(0, 80);
  return `${short(message.message_id)} ${message.state} [${tag}] ${message.sender_label} → ${message.recipient_label}: ${preview}`;
}

const USAGE = [
  "/mail, alt+m, ctrl+shift+m    toggle this session's mailbox panel (view only; drag its title to move)",
  "/mail board [on|off|reset]    show, hide, or move the panel back above the editor",
  "/mail why                     why queued mail is or is not being processed right now",
  "/mail agents                  list pi sessions you can address",
  "/mail send <to> [--fyi] <text>  queue mail for another pi session (as the user)",
  "/mail reply <id> <text>       reply to a message (as the user)",
  "/mail sent                    list mail you sent with /mail",
  "/mail amend <id> <text>       urgent supplement to your own mail (steered into that work)",
  "/mail cancel <id> [reason]    cancel your own mail (queued: withdrawn; otherwise that work aborts and reports)",
  "/mail recover <id> applied|requeue   resolve an uncertain delivery",
].join("\n");

export default async function piMailbox(pi: ExtensionAPI): Promise<void> {
  const env = process.env;
  // pi-subagents children never receive or send; their parent session owns the mailbox.
  if (env.PI_SUBAGENT_CHILD) return;
  const kind = await chooseBackend(env);
  let store: LocalMailbox | undefined;
  const local = () => (store ??= new LocalMailbox());
  const mailbox = new PiMailbox(pi, kind === "ham" ? hamBackend : localBackend(local));

  // Show injected bundles as a mail card; the agent still receives the full bundle text.
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  pi.registerMessageRenderer("ham_mailbox", (message, options) => {
    const raw = typeof message.content === "string" ? message.content : "";
    const bundle = parseBundle(raw);
    if (!bundle) return undefined;
    return { render: (width: number) => cardLines(bundle, width, options.outputPad, options.expanded, visibleWidth,
      options.keyText("app.tools.expand"), raw), invalidate() {} };
  });

  pi.on("session_start", (_event, ctx) => mailbox.start(ctx));
  pi.on("session_shutdown", (_event, ctx) => mailbox.shutdown(ctx));
  pi.on("session_info_changed", (_event, ctx) => mailbox.refresh(ctx));
  pi.on("input", (event, ctx) => { if (event.source !== "extension") mailbox.input(ctx); });
  pi.on("before_agent_start", (event, ctx) => mailbox.natural(event, ctx));
  pi.on("agent_start", (_event, ctx) => mailbox.agentStart(ctx));
  pi.on("agent_settled", (_event, ctx) => mailbox.settled(ctx));
  pi.on("ui_prompt_start", (event, ctx) => mailbox.prompt(true, ctx, event.kind));
  pi.on("ui_prompt_end", (event, ctx) => mailbox.prompt(false, ctx, event.kind));
  pi.on("message_end", (_event, ctx) => mailbox.activity(ctx));
  pi.on("turn_end", (_event, ctx) => mailbox.activity(ctx));

  // ctrl+shift+m needs a terminal that reports modified keys (kitty protocol or modifyOtherKeys);
  // alt+m works everywhere. Linux input methods (fcitx5/IBus) may take ctrl+shift combinations.
  for (const key of BOARD_KEYS)
    pi.registerShortcut(key, { description: "Toggle the mailbox board (view only)", handler: async ctx => openBoard(ctx) });
  pi.registerCommand("mail", {
    description: "Mailbox: show, send, reply, amend or cancel mail between pi sessions",
    handler: async (args, ctx) => { await command(args.trim(), ctx); },
  });

  // The board stays open until hidden; awaiting it would hold pi's command queue the whole time.
  function openBoard(ctx: ExtensionContext, action?: "toggle" | "on" | "off" | "reset"): void {
    mailbox.showMailbox(ctx, action).catch(error => ctx.ui.notify(`mailbox board: ${String(error)}`, "error"));
  }

  async function command(args: string, ctx: ExtensionContext): Promise<void> {
    const [verb = "", ...rest] = args.split(/\s+/).filter(Boolean);
    const notify = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
    if (!verb || verb === "show") { openBoard(ctx); return; }
    if (verb === "board") {
      const action = rest[0] ?? "toggle";
      if (action !== "toggle" && action !== "on" && action !== "off" && action !== "reset")
        return notify("Usage: /mail board [on|off|reset]", "error");
      openBoard(ctx, action);
      return;
    }
    if (verb === "help") return notify(USAGE);
    if (verb === "why") return notify(await mailbox.explain(ctx));
    if (kind === "ham")
      return notify("HAM mode: send/amend/cancel as the user from the HAM Mailbox (Threads: Enter reply, u amend, c cancel). " +
        "Agents use the HAM skill CLI.", "warning");
    const user: Sender = { kind: "user" };
    try {
      if (verb === "agents") {
        const rows = local().agents().map(agent => `${agent.live ? "●" : "○"} ${agent.alias} (${short(agent.agent_id)}) ${agent.cwd}`);
        return notify(rows.join("\n") || "No pi sessions have registered yet.");
      }
      if (verb === "sent") return notify(local().sent("user").map(line).join("\n") || "You have not sent mail with /mail.");
      if (verb === "send") {
        const [to, ...words] = rest;
        const fyi = words[0] === "--fyi";
        const body = (fyi ? words.slice(1) : words).join(" ");
        if (!to || !body) return notify("Usage: /mail send <to> [--fyi] <text>", "error");
        const message = local().send(user, to, { body, kind: fyi ? "fyi" : "action" });
        return notify(`Queued ${short(message.message_id)} for ${message.recipient_label}.`);
      }
      if (verb === "reply") {
        const [reference, ...words] = rest;
        if (!reference || !words.length) return notify("Usage: /mail reply <id> <text>", "error");
        const parent = local().findMessage(reference);
        const to = parent.sender === "user" ? parent.recipient : parent.sender;
        const message = local().send(user, to, { body: words.join(" "), kind: "action", reply_to: parent.message_id });
        return notify(`Reply ${short(message.message_id)} queued for ${message.recipient_label}.`);
      }
      if (verb === "amend" || verb === "cancel") {
        const [reference, ...words] = rest;
        if (!reference || (verb === "amend" && !words.length)) return notify(`Usage: /mail ${verb} <id> ${verb === "amend" ? "<text>" : "[reason]"}`, "error");
        const target = local().findMessage(reference);
        const result = local().urgent(user, target.message_id, verb, words.join(" ") || undefined);
        return notify("cancelled" in result ? `${short(target.message_id)} was still queued: withdrawn, nothing delivered.`
          : `${verb === "amend" ? "Amend" : "Cancel"} ${short(result.message_id)} sent to ${result.recipient_label}.`);
      }
      if (verb === "recover") {
        const [reference, disposition] = rest;
        if (!reference || (disposition !== "applied" && disposition !== "requeue"))
          return notify("Usage: /mail recover <id> applied|requeue", "error");
        const message = local().recover(local().findMessage(reference).message_id, disposition);
        return notify(`${short(message.message_id)} is now ${message.state}.`);
      }
      notify(USAGE, "warning");
    } catch (error) {
      notify(String(error instanceof Error ? error.message : error), "error");
    }
  }

  if (kind !== "local") return;

  // Agent-side tools exist only for the local backend; with HAM, agents use the HAM skill.
  const self = (): Sender => {
    const agent = mailbox.registration?.agent;
    if (!agent) throw new Error("This pi session has no mailbox registration (interactive sessions only).");
    return { kind: "agent", agent_id: agent.agent_id };
  };
  const selfId = () => (self() as { agent_id: string }).agent_id;
  pi.registerTool({
    name: "mailbox_send", label: "Send mail",
    description: "Queue mail for another pi session on this host. It is processed when that session is idle. " +
      "Use reply_to with a received message ID to reply in its thread; kind action asks for work, fyi informs.",
    promptSnippet: "Send queued mail to another pi session (local mailbox)",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient alias or session ID (see mailbox_agents)." }),
      body: Type.String(),
      kind: Type.Optional(Type.Union([Type.Literal("action"), Type.Literal("fyi")])),
      reply_to: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String({ maxLength: 256 })),
    }),
    async execute(_id, params) {
      const message = local().send(self(), params.to, { body: params.body, kind: params.kind ?? "action",
        reply_to: params.reply_to ?? null, subject: params.subject });
      return reply({ message_id: message.message_id, thread_id: message.thread_id, to: message.recipient_label, state: message.state });
    },
  });
  pi.registerTool({
    name: "mailbox_list", label: "List mail",
    description: "View your mailbox without acknowledging anything (default: queued/delivering/delivered).",
    parameters: Type.Object({ message_id: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      const messages = params.message_id ? [local().findMessage(params.message_id)].filter(message => message.recipient === selfId())
        : local().read(selfId(), { all: params.all });
      return reply(messages.map(message => ({ message_id: message.message_id, thread_id: message.thread_id, from: message.sender_label,
        kind: message.kind, urgency: message.urgency, reply_to: message.reply_to, state: message.state, subject: message.subject,
        body: message.body })));
    },
  });
  pi.registerTool({
    name: "mailbox_handle", label: "Complete mail",
    description: "Mark received messages handled once their work is done (a reply with reply_to already does this).",
    parameters: Type.Object({ message_ids: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params) {
      return reply(local().handle(selfId(), params.message_ids).map(message => ({ message_id: message.message_id, state: message.state })));
    },
  });
  pi.registerTool({
    name: "mailbox_agents", label: "Mail addresses",
    description: "List pi sessions on this host that can receive mail (● live).",
    parameters: Type.Object({}),
    async execute() {
      return reply(local().agents().map(agent => ({ alias: agent.alias, agent_id: agent.agent_id, live: agent.live, cwd: agent.cwd })));
    },
  });
  pi.registerTool({
    name: "mailbox_amend", label: "Amend sent mail",
    description: "Urgently supplement mail YOU sent earlier; the recipient gets it steered into that work. Only for real corrections.",
    parameters: Type.Object({ message_id: Type.String(), body: Type.String() }),
    async execute(_id, params) { return reply(local().urgent(self(), params.message_id, "amend", params.body)); },
  });
  pi.registerTool({
    name: "mailbox_cancel", label: "Cancel sent mail",
    description: "Cancel mail YOU sent earlier. Still queued: withdrawn. Otherwise the recipient aborts that work and reports back.",
    parameters: Type.Object({ message_id: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(_id, params) { return reply(local().urgent(self(), params.message_id, "cancel", params.reason)); },
  });
}
