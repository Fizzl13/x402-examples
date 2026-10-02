import type { OverLimitInfo } from "./index.js";

export interface TelegramApproverOptions {
  /** Bot token from @BotFather. A secret: keep it in an environment variable. */
  token: string;
  /** Your chat with the bot: send it /start, then findTelegramChats({ token }). */
  chatId: string | number;
  /** Telegram user ids allowed to answer. Default: chatId (you, in a private chat). */
  allowedUserIds?: Array<string | number>;
  /** How long the agent waits for your tap. Default 10 minutes; no answer counts as Deny. */
  timeoutMs?: number;
  /** Name of the agent in the message. Default "Your agent". */
  label?: string;
  fetch?: typeof globalThis.fetch;
  api?: string;
}

/** An onOverLimit for guardWallet: asks you on Telegram with Approve and Deny buttons. */
export declare function telegramApprover(options: TelegramApproverOptions): (info: OverLimitInfo) => Promise<boolean>;

/** The chats that sent your bot a message (send it /start first). */
export declare function findTelegramChats(options: { token: string; fetch?: typeof globalThis.fetch; api?: string }): Promise<Array<{ chatId: number; type: string; name: string; username: string | null }>>;
