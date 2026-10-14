// The x402 Doctor commit whose preflight code the bench runs (scripts/fetch-doctor.js puts its lib/ in vendor/).
// The skill text in skills/ comes from the same commit.

export const DOCTOR = { repository: "Fizzl13/x402-doctor", commit: "15b320bac97b33157a719143695f969fe8ee410f" };

export const DOCTOR_DIR = new URL(`../vendor/x402-doctor-${DOCTOR.commit.slice(0, 12)}/`, import.meta.url);
