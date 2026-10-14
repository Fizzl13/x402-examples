// The x402 Doctor commit whose preflight code the bench runs (scripts/fetch-doctor.js puts its lib/ in vendor/).
// The skill text in skills/ comes from the same commit.

export const DOCTOR = { repository: "Fizzl13/x402-doctor", commit: "42b122fb32100dcaf5087a6e062dfbbbccec0979" };

export const DOCTOR_DIR = new URL(`../vendor/x402-doctor-${DOCTOR.commit.slice(0, 12)}/`, import.meta.url);
