export type ParsedCliArgs = {
  readonly cmd: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
};

const VALUE_FLAG_NAMES = [
  "--path", "--scope", "--limit", "--kind", "--session", "--offset", "--map",
  "--write-model", "--verify-model", "--source", "--dest", "--model", "--date", "--min-pages",
  "--repo", "--max-pages", "--prompt", "--corpus", "--label",
  "--page", "--result", "--question", "--harness", "--older-than", "--review",
  "--hook-event", "--transcript", "--out", "--repeats", "--sessions",
] as const;

const VALUE_FLAGS = new Set<string>(VALUE_FLAG_NAMES);

const BOOLEAN_FLAG_NAMES = [
  "--check", "--commit", "--confirm", "--downstream-read", "--ensure", "--errors-only",
  "--fix", "--force", "--forget", "--help", "--if-due", "--keep", "--list", "--notice",
  "--normalize", "--report", "--sealed", "--skipped", "--topic", "--tune-only",
] as const;

const BOOLEAN_FLAGS = new Set<string>(BOOLEAN_FLAG_NAMES);

export class MissingCliFlagValueError extends Error {
  readonly name = "MissingCliFlagValueError";

  constructor(readonly flag: string) {
    super(`${flag} requires a value`);
  }
}

export class UnknownCliFlagError extends Error {
  readonly name = "UnknownCliFlagError";

  constructor(readonly flag: string) {
    super(`unknown option: ${flag}`);
  }
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const cmd = argv[0] ?? "";
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    if (BOOLEAN_FLAGS.has(argument)) {
      flags[argument] = true;
      continue;
    }

    if (!VALUE_FLAGS.has(argument)) throw new UnknownCliFlagError(argument);

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new MissingCliFlagValueError(argument);
    }
    flags[argument] = value;
    index += 1;
  }

  return { cmd, positionals, flags };
}
