/** Receiver protocol shared by the HAM and local backends (HAM `ledger runtime` protocol 1). */
export type Request = Record<string, unknown>;
export type Urgency = "amend" | "cancel";

export interface NativeAgent { terminal_id: string; agent_id: string; generation: number; session_ref: string; alias?: string }
export interface NativeClaim {
  claim_id: string; agent_id: string; generation: number; session_ref: string; marker: string; content_sha256: string;
}
export interface ClaimDetails { protocol: 1; claim_id: string; agent_id: string; generation: number; session_ref: string; marker: string }
export interface NativeMessage { customType: "ham_mailbox"; content: string; details: ClaimDetails; display: true }
export interface ClaimedMessage { message_id: string; thread_id: string; kind: string; urgency: Urgency | null }
export interface ClaimBundle extends NativeClaim {
  message: NativeMessage; messages: ClaimedMessage[]; skip_input_quiet?: boolean; via?: string;
}
export interface Thresholds { idle_minutes: number; coalesce_seconds: number; wakes_per_hour: number; max_hop: number }
export interface UrgentItem { message_id: string; urgency: Urgency; target_message_id: string; thread_id: string }
export interface InboxItem {
  message_id: string; thread_id: string; kind: string; urgency: Urgency | null; target_message_id: string | null;
  sender: string; subject: string; preview: string; state: string; created_at: number;
}
export interface Inspection {
  thresholds: Thresholds; role: "main" | "worker" | null; turn_state: string; wake_count: number;
  pending_claims: NativeClaim[]; has_action: boolean; coalesce_until: number; skip_input_quiet?: boolean;
  urgent: UrgentItem[]; inbox: InboxItem[]; queued_total: number;
}
export interface Registration extends Inspection { agent: NativeAgent; bell_directory: string; bell_name: string }
export interface ReceiverReplies {
  register: Registration; inspect: Inspection; claim: ClaimBundle | { claim_id: null; reason: string };
  applied: { receipts: unknown[] }; release: { released: number; uncertain: number };
}
export type Operation = keyof ReceiverReplies;
export type Call = <O extends Operation>(operation: O, data: Request) => Promise<ReceiverReplies[O]>;

/** Coded failure from a backend; `code` drives diagnostics such as native_session_pending. */
export class ReceiverError extends Error {
  constructor(readonly code: string, message: string, readonly phase: string) {
    super("mailbox: " + code + ": " + message);
  }
}

export const DEFAULT_THRESHOLDS: Thresholds = { idle_minutes: 3, coalesce_seconds: 60, wakes_per_hour: 4, max_hop: 10 };
