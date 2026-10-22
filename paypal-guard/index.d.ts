export type Kind = "read" | "refund" | "dispute" | "books" | "stop" | "price" | "bill" | "other" | "unknown";
export type Rule = "allow" | "ask" | "deny" | { perAction?: string; perDay?: string; countPerDay?: number };

export interface Policy {
  /** Currency of the limits, e.g. "USD". */
  currency?: string;
  refund?: Rule; dispute?: Rule; books?: Rule; stop?: Rule; price?: Rule; bill?: Rule; other?: Rule; read?: Rule; unknown?: Rule;
  /** A refund, cancellation or bill for someone other than the customer in the conversation. Default "deny". */
  otherCustomer?: "ask" | "deny";
  /** A refund of a payment with an open dispute or chargeback: the buyer would be paid twice. Default "deny". */
  openDispute?: "ask" | "deny";
  /** The shop's return period in days, counted from purchaseDateOf (else the payment date). Default null: not checked. */
  returnDays?: number | null;
  /** A refund past the return period (a warranty claim). Default "ask". */
  afterReturnDays?: "ask" | "deny";
  /** Jev says the action doesn't follow from the customer's request. Default "ask". */
  offIntent?: "ask" | "deny";
}

export interface Context {
  /** The email address of the customer the agent is helping, from the app (inbox, login), not from the model. */
  customer?: string;
  /** The customer's message, for the intent check. */
  request?: string;
}

export interface Reason { code: string; message: string }

export interface ApprovalRequest {
  id: string; agent: string; tool: string; kind: Kind; summary: string; reasons: Reason[];
  customer: string | null; request: string | null; amount: string | null; currency: string | null;
}
export type Approve = ((request: ApprovalRequest) => Promise<{ approved: boolean; by?: string; [k: string]: any }>) & {
  /** Called after an approved action ran, with the approver's own answer. */
  report?: (answer: any, outcome: { ok: boolean; result?: any; error?: string }) => Promise<void>;
};

export interface Reader {
  capture(id: string): Promise<{ amount: string | null; currency: string | null; refunded: string; payer: string | null; orderId: string | null; status: string | null; customId: string | null; invoiceId: string | null; paidAt?: string | null } | null>;
  subscription(id: string): Promise<{ payer: string | null; status: string | null; planId: string | null } | null>;
  invoice(id: string): Promise<{ recipients: string[]; amount: string | null; currency: string | null; status: string | null } | null>;
  dispute(id: string): Promise<{ amount: string | null; currency: string | null; status: string | null; reason: string | null; stage?: string | null; captureId?: string | null; payer?: string | null; customId?: string | null } | null>;
  /** The disputes and chargebacks on a capture that aren't resolved. Optional: without it, refunds skip the open-dispute check. */
  disputes?(captureId: string): Promise<{ id: string; amount: string | null; currency: string | null; status: string | null; reason: string | null; stage: string | null; channel: string | null }[]>;
}

export interface GuardEvent {
  at: string; agent: string; id?: string; tool: string; kind: Kind; decision: "allow" | "ask" | "deny";
  summary: string; customer: string | null; reasons?: Reason[];
  outcome: "done" | "asked" | "blocked" | "failed"; approvedBy?: string | null; error?: string;
}

export interface Blocked { blocked: true; tool: string; decision: "ask" | "deny"; reasons: string[]; message: string; approvalId?: string }

export interface Store { get(key: string): Promise<any>; set(key: string, value: any): Promise<void> }

export interface GuardOptions {
  policy?: Policy;
  /** Read-only PayPal lookups (paypalReader). Without one, refunds and cancellations can't be checked and ask. */
  reader?: Reader | null;
  /** How to ask the owner (telegramApproval, consoleApproval, or your own). Without one, "ask" means no. */
  approve?: Approve | null;
  /** jevIntent(), or your own (request) -> { fits } check. */
  intent?: ((q: { request: string; customer: string | null; action: string }) => Promise<{ fits: number } | null>) | null;
  /** Name shown to the owner. */
  agent?: string;
  /** Where the day's totals are kept. Default: in memory (one process). */
  store?: Store;
  onEvent?: (e: GuardEvent) => void;
  /** Your own answer to "whose is this?" (e.g. from your order database), when PayPal has no payer email. */
  customerOf?: (x: { tool: string; args: any; facts: any }) => Promise<string | string[] | null> | string | string[] | null;
  /** When the return period starts for this payment (the delivery date, from your orders). Default: the day PayPal took the payment. */
  purchaseDateOf?: (x: { tool: string; args: any; facts: any }) => Promise<string | number | Date | null> | string | number | Date | null;
  now?: () => number;
  keepEvents?: number;
}

export interface Guard {
  policy: Required<Policy>;
  run<T>(tool: string, args: any, exec: (args: any) => Promise<T>, ctx?: Context): Promise<T | Blocked>;
  check(tool: string, args?: any, ctx?: Context): Promise<{ tool: string; kind: Kind; decision: "allow" | "ask" | "deny"; summary: string; reasons: Reason[]; facts: any }>;
  wrapTools<T extends Record<string, any>>(tools: T, opts?: { context?: Context | (() => Context | Promise<Context>) }): T;
  events(): GuardEvent[];
}

export function createGuard(opts?: GuardOptions): Guard;
export function memoryStore(): Store;
export function paypalReader(opts: { clientId: string; clientSecret: string; sandbox?: boolean; fetch?: typeof fetch; timeoutMs?: number }): Reader;
export function consoleApproval(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Approve;
export function telegramApproval(opts: { token: string; chatId: string | number; timeoutMs?: number; fetch?: typeof fetch }): Approve;
/** Ask through the Fizzl Agent Wallet: dashboard, phone, Telegram, and a receipt. `key` is the agent key (awk_…). */
export function fizzlWalletApproval(opts: { key: string; url?: string; timeoutMs?: number; kind?: string; fetch?: typeof fetch }): Approve;
export function jevIntent(opts?: { apiKey?: string; model?: string; timeoutMs?: number; fetch?: typeof fetch; log?: { warn?: (...a: any[]) => void } }): ((q: { request: string; customer: string | null; action: string }) => Promise<{ fits: number } | null>) | null;
export const ACTIONS: Readonly<Record<string, Kind>>;
export const DEFAULT_POLICY: Readonly<Required<Policy>>;
export function kindOf(tool: string): Kind;
export function describe(tool: string, args?: any, facts?: any): string;
export function toMilli(v: string | number): bigint;
export function fromMilli(n: bigint): string;
export const VERSION: string;
