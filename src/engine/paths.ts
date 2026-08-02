// Clone-root resolution. engine modules live at <clone>/src/engine, so the
// clone root is two levels up.
import { resolve } from "node:path";

export const CLONE_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * The clone root as it should appear inside a SHELL command string.
 *
 * Hook commands are bash commands: `bash '<clone>/hooks/sessionstart-inject.sh'`. On Windows the
 * native root is `C:\clone`, and pasting it in produced a mixed spelling — `C:\clone/hooks/…` —
 * that then had to survive a round-trip through settings.json, where JSON doubles every backslash.
 * bash reads `C:/clone/…` perfectly well, so one posix-shaped spelling is emitted everywhere and
 * the written command, doctor's "is this my clone?" check, and uninstall all compare the same
 * bytes.
 *
 * Windows-only by construction, not by coincidence: `\` is a legal character in a POSIX directory
 * name, so rewriting it unconditionally would point the hook of a clone under `/home/me/a\b` at a
 * path that does not exist. On POSIX this is CLONE_ROOT, identical byte for byte.
 */
export const CLONE_ROOT_SHELL =
  process.platform === "win32" ? CLONE_ROOT.replaceAll("\\", "/") : CLONE_ROOT;

/**
 * Fold a path (or a whole config file's text) to one spelling before comparing.
 *
 * Two things differ purely by transport, never by meaning: JSON escaping (`C:\\clone` on disk for
 * `C:\clone` in memory) and the separator (`\` vs `/`). Comparing raw settings.json text against a
 * native path failed on both counts at once, so a hook llmwiki had just written read back as
 * "points at a different clone" — which made `setup.sh` exit non-zero on every Windows install,
 * with nothing actually wrong.
 *
 * Deliberately applied to the haystack AND the needle: matching stays symmetric, so this can only
 * make previously-failing comparisons succeed, never the reverse. Raw text (not parsed JSON) stays
 * the input on purpose — the check has to keep working on a settings file too malformed to parse.
 */
export function normalizeConfigPath(value: string): string {
  return value.replaceAll("\\\\", "\\").replaceAll("\\", "/");
}
