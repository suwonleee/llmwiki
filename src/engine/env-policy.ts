// Bun automatically loads .env files from the current working directory before application code
// runs. Hooks and installed CLI commands run with the user's repository as cwd, so a tracked file
// can otherwise masquerade as a machine-level environment decision.
import { readRepoFileResult } from "./repo-write.ts";

const REPOSITORY_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
] as const;

/**
 * Return an environment value only when the current repository's env files cannot have supplied
 * it. Unsafe env-file candidates fail closed: a symlink or unreadable/non-regular file must never
 * be mistaken for an absent file after Bun has already autoloaded it.
 */
export function envValueOutsideRepoFiles(name: string, cwd = process.cwd()): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`^\\s*(export\\s+)?${escaped}\\s*=`, "m");
  for (const filename of REPOSITORY_ENV_FILES) {
    const result = readRepoFileResult(cwd, filename);
    if (result.status === "absent") continue;
    if (result.status === "unsafe") return undefined;
    if (declaration.test(result.bytes.toString("utf-8"))) return undefined;
  }
  return value;
}
