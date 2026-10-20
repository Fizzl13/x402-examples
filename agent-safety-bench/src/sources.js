// The commits of Fizzl's services whose own code the bench runs: x402 Doctor's preflight (lib/) and presign-guard's
// pre-sign check (src/). scripts/fetch-sources.js puts each in vendor/. The skill texts in skills/ come from the same
// commits (skills/SOURCE.json).

export const DOCTOR = { repository: "Fizzl13/x402-doctor", commit: "7cfaa05bfd81dcd544b15f9307ae81984f9dea4b", paths: ["lib"] };
export const GUARD = { repository: "Fizzl13/presign-guard", commit: "362e571fa2878b509f83de8446bc5eb66c843b4d", paths: ["src"] };
export const SOURCES = [DOCTOR, GUARD];

export const dirOf = (source) => new URL(`../vendor/${source.repository.split("/")[1]}-${source.commit.slice(0, 12)}/`, import.meta.url);
export const DOCTOR_DIR = dirOf(DOCTOR);
export const GUARD_DIR = dirOf(GUARD);
