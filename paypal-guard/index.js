// fizzl-paypal-guard: limits, checks and the owner's approval between an AI agent and PayPal's Agent Toolkit.
// See README.md. Everything the guard reads from PayPal is read-only; it never moves money itself.
export { createGuard, memoryStore } from "./src/guard.js";
export { paypalReader, toMilli, fromMilli } from "./src/paypal.js";
export { consoleApproval, telegramApproval } from "./src/approvals.js";
export { jevIntent } from "./src/intent.js";
export { ACTIONS, DEFAULT_POLICY, kindOf, describe } from "./src/actions.js";
export const VERSION = "0.1.0";
