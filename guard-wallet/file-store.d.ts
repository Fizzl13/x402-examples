import type { SpendingStore } from "./index.js";

/** A spending store in a JSON file (Node only, one process per file). */
export declare function fileStore(path: string): SpendingStore;
