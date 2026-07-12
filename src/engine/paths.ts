// Clone-root resolution. engine modules live at <clone>/src/engine, so the
// clone root is two levels up.
import { resolve } from "node:path";

export const CLONE_ROOT = resolve(import.meta.dir, "..", "..");
