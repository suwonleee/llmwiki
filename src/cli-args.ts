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
  "--hook-event",
] as const;

const VALUE_FLAGS = new Set<string>(VALUE_FLAG_NAMES);

export class MissingCliFlagValueError extends Error {
  readonly name = "MissingCliFlagValueError";

  constructor(readonly flag: string) {
    super(`${flag} requires a value`);
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

    if (!VALUE_FLAGS.has(argument)) {
      flags[argument] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new MissingCliFlagValueError(argument);
    }
    flags[argument] = value;
    index += 1;
  }

  return { cmd, positionals, flags };
}
