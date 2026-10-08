// Pera Connect as a global for the dashboard, served from this server (CSP: script-src 'self'), loaded only when
// someone clicks "Sign in with Pera". Rebuild with `npm ci && npm run build` in this folder after a version bump.
import { PeraWalletConnect } from "@perawallet/connect";
window.PeraWalletConnect = PeraWalletConnect;
