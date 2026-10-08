// Defly Connect as a global for the dashboard, served from this server (CSP: script-src 'self'), loaded only when
// someone clicks "Sign in with Defly". Defly signs transactions only (no arbitrary data), so the sign-in is a
// transaction this server builds and never sends; algosdk turns its bytes into what Defly Connect wants.
// Rebuild with `npm ci && npm run build` in this folder after a version bump.
import { DeflyWalletConnect } from "@blockshake/defly-connect";
import { decodeUnsignedTransaction } from "algosdk";
window.DeflyWalletConnect = DeflyWalletConnect;
window.deflyDecodeTxn = (bytes) => decodeUnsignedTransaction(bytes);
