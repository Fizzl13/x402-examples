export declare const VERSION: string;
export declare const LIST_URL: string;

export type PayerKind = "eip3009" | "permit2" | "solana" | "algorand" | "xrpl";
export interface Payer { payer: string; network: string | null; kind: PayerKind }
export interface SdnEntry { uid?: number; name: string; type?: string; programs: string[]; currency?: string }

/** The payer of an x402 payment: the PAYMENT-SIGNATURE / X-PAYMENT header (base64 JSON) or the decoded object. */
export declare function payerOf(header: string | object): Payer | null;
export declare function addressKey(address: string): string;

export interface ScreenOptions {
  /** The list to load (default: presign-guard's free open copy of the OFAC SDN list). */
  listUrl?: string;
  /** How often to download it again (default 6 hours). */
  refreshMs?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The JSON of /v1/sanctions, to skip the download. */
  list?: object;
}
export interface Screen {
  ready(): Promise<object | null>;
  check(address: string): { listed: boolean; entries: SdnEntry[]; published: string | null } | null;
  status(): { addresses: number; published?: string | null; checkedAt?: string | null; lastError?: string };
}
export declare function createScreen(options?: ScreenOptions): Screen;

export type PaymentCheck =
  | ({ blocked: boolean; entries: SdnEntry[]; published: string | null } & Payer)
  | ({ blocked: false; unscreened: "no_payment" | "payer_unreadable" | "list_unavailable" } & Partial<Payer>);
/** Screen one payment header, for frameworks other than Express. */
export declare function checkPayment(header: string | undefined | null, screen: Screen): Promise<PaymentCheck>;

export interface BlockedPayment { payer: string; network: string | null; kind: PayerKind; list: "OFAC SDN"; entries: { name: string; programs: string[] }[]; published: string | null }
export interface ScreenPayersOptions extends ScreenOptions {
  /** Answer 503 while no list can be loaded (default false: payments go through unscreened, with one warning). */
  failClosed?: boolean;
  /** Called for every payment it refuses (log it, alert someone). */
  onBlocked?: (info: BlockedPayment, req: any) => void;
  /** Share one screen between middlewares. */
  screen?: Screen;
}
/** Express middleware; put it before the x402 payment middleware. A listed payer gets 451 and is never charged. */
export declare function screenPayers(options?: ScreenPayersOptions): ((req: any, res: any, next: (err?: any) => void) => Promise<void>) & { screen: Screen };
