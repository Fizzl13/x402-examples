import type { OverLimitInfo } from "./index.js";

export interface Ac2ApproverOptions {
  /** Your Algorand address: only its signature approves. Default: the wallet the AC2 service is paired with, fixed at the first request. */
  owner?: string;
  /** The AC2 service's control socket. Default AC2_DAEMON_SOCKET, else ~/.ac2/ac2d.sock (as ac2-cli). */
  socket?: string;
  /** How long the agent waits for your approval. Default 10 minutes; no answer counts as Deny. */
  timeoutMs?: number;
  /** Name of the agent in the request. Default "Your agent". */
  label?: string;
}

/** What an AC2 approval proves: the owner's Ed25519 signature over the approval text. */
export interface Ac2ApprovalProof {
  via: "ac2";
  /** The Algorand address that signed. */
  owner: string;
  id: string;
  /** The text that was signed; it starts with "fizzl-approval-v1". */
  payload: string;
  /** Base64 Ed25519 signature by the owner's account key. */
  signature: string;
  signedAt: string;
}

/** An onOverLimit for guardWallet: asks you in your AC2 wallet and checks that the signature is the owner's. */
export declare function ac2Approver(options?: Ac2ApproverOptions): (info: OverLimitInfo) => Promise<false | { approved: true; proof: Ac2ApprovalProof }>;

/** True when signature (base64) is owner's Ed25519 signature over payload. */
export declare function verifyApproval(owner: string, payload: string, signature: string): boolean;

/** The text the owner signs for an over-limit request. */
export declare function approvalText(info: OverLimitInfo, options: { label: string; id: string; expiresAt: number }): string;

/** The 32-byte public key in an Algorand address, or null when the address or its checksum is wrong. */
export declare function algorandPublicKey(address: string): Buffer | null;

/** The AC2 service's control socket path, as ac2-cli resolves it. */
export declare function defaultSocketPath(env?: Record<string, string | undefined>, platform?: string): string;
