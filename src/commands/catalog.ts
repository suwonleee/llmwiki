export const COMMAND_GROUPS = [
  "Project setup",
  "Index and retrieve",
  "Capture and close out",
  "Maintain the wiki",
  "Evaluate changes",
  "Human memory quiz",
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export type CommandSpec = {
  readonly name: string;
  readonly group: CommandGroup;
  readonly usage: string;
  readonly summary: string;
};

export const COMMANDS = [
  { name: "init", group: "Project setup", usage: "init <workspace>", summary: "Enroll one Git worktree and create its wiki skeleton." },
  { name: "disable", group: "Project setup", usage: "disable <workspace>", summary: "Disable automatic integration without deleting wiki files." },
  { name: "status", group: "Project setup", usage: "status [workspace]", summary: "Explain whether a worktree is enrolled." },
  { name: "verify", group: "Project setup", usage: "verify [workspace] [--harness all|claude|codex|opencode]", summary: "Prove machine wiring and project work-memory readiness in one receipt." },
  { name: "enabled", group: "Project setup", usage: "enabled [workspace]", summary: "Return enrollment as an exit code for adapters." },
  { name: "doctor", group: "Project setup", usage: "doctor [--harness all|claude|codex|opencode] [--fix] [--installation-only]", summary: "Check the machine installation and selected harness wiring." },
  { name: "wiki-doctor", group: "Project setup", usage: "wiki-doctor [workspace] [--fix] [--date YYYY-MM-DD]", summary: "Check and safely repair one project wiki." },
  { name: "locate", group: "Project setup", usage: "locate [claude|codex|opencode] [path]", summary: "Find and verify harness transcript storage." },
  { name: "connect", group: "Project setup", usage: "connect <harness> <path> | connect <harness> --forget", summary: "Persist or forget one verified harness data location." },
  { name: "config", group: "Project setup", usage: "config [workspace]", summary: "Show the effective project conventions and validation result." },
  { name: "conventions", group: "Project setup", usage: "conventions [workspace]", summary: "Render the effective authoring rules for an agent." },
  { name: "state-path", group: "Project setup", usage: "state-path <workspace> [subpath] [--ensure]", summary: "Print or create this worktree's engine-held state path." },
  { name: "migrate-state", group: "Project setup", usage: "migrate-state [--commit]", summary: "Plan or apply migration from the legacy state root." },
  { name: "purge-state", group: "Project setup", usage: "purge-state [--report|--confirm]", summary: "Describe or remove only llmwiki-owned machine state." },

  { name: "index", group: "Index and retrieve", usage: "index <workspace>", summary: "Incrementally index wiki pages and rebuild references." },
  { name: "reindex", group: "Index and retrieve", usage: "reindex <workspace>", summary: "Rebuild the project index from disk." },
  { name: "refs", group: "Index and retrieve", usage: "refs <workspace>", summary: "Rebuild the citation and wiki-link graph." },
  { name: "lint", group: "Index and retrieve", usage: "lint <workspace> [--path GLOB] [--scope SCOPE] [--errors-only]", summary: "Run deterministic wiki validation." },
  { name: "search", group: "Index and retrieve", usage: "search <workspace> <query> [--limit N] [--kind KIND]", summary: "Search distinct wiki pages through the local index." },
  { name: "context", group: "Index and retrieve", usage: "context [workspace] [--hook-event SessionStart]", summary: "Build the enrolled project's cold-start context." },
  { name: "turn-context", group: "Index and retrieve", usage: "turn-context [workspace] [--prompt TEXT] [--session ID] [--hook-event UserPromptSubmit]", summary: "Build related-page pointers for one user turn." },
  { name: "digest", group: "Index and retrieve", usage: "digest [workspace]", summary: "Render a deterministic relationship digest." },
  { name: "context-audit", group: "Index and retrieve", usage: "context-audit [workspace]", summary: "Audit always-injected agent instruction files." },
  { name: "git-rules", group: "Index and retrieve", usage: "git-rules", summary: "Print the optional repository Git conventions." },

  { name: "update-status", group: "Capture and close out", usage: "update-status <workspace>", summary: "List captured transcripts still awaiting close-out." },
  { name: "save-current", group: "Capture and close out", usage: "save-current <workspace> --session ID", summary: "Select the exact current session for manual close-out." },
  { name: "related", group: "Capture and close out", usage: "related <workspace> <transcript>", summary: "Find same-topic pending sessions as optional material." },
  { name: "update-next", group: "Capture and close out", usage: "update-next <workspace> <transcript>", summary: "Extract the next screened transcript increment." },
  { name: "update-done", group: "Capture and close out", usage: "update-done <workspace> <transcript> <offset> [--skipped]", summary: "Advance a transcript watermark after close-out." },
  { name: "update-enqueue", group: "Capture and close out", usage: "update-enqueue <workspace> <transcript> [--session ID]", summary: "Add a transcript to the close-out queue." },
  { name: "register-transcript", group: "Capture and close out", usage: "register-transcript <workspace> [transcript] [--session ID]", summary: "Register transcript files as citable provenance." },
  { name: "excerpt", group: "Capture and close out", usage: "excerpt <transcript> [--offset N] [--kind fact|judgment] [--limit N]", summary: "Mint bounded, screened evidence excerpts." },
  { name: "reconcile", group: "Capture and close out", usage: "reconcile <workspace> [--commit]", summary: "Reconcile cited sessions with the capture ledger." },
  { name: "capture-prune", group: "Capture and close out", usage: "capture-prune [--older-than DAYS]", summary: "Mark expired queue entries and prune owned exports." },
  { name: "ingest", group: "Capture and close out", usage: "ingest <workspace> <file> [--repo PATH] [--source KIND] [--commit] [--force]", summary: "Condense an explicit file without daemon discovery." },
  { name: "hermes-export", group: "Capture and close out", usage: "hermes-export <repo> [--session ID] [--out FILE] [--list]", summary: "Export a screened Hermes session for explicit ingest." },

  { name: "skeleton", group: "Maintain the wiki", usage: "skeleton <workspace>", summary: "Ensure the configured wiki structure exists." },
  { name: "autoupdate", group: "Maintain the wiki", usage: "autoupdate <workspace> [--commit] [--limit N] [--write-model MODEL] [--verify-model MODEL]", summary: "Run the gated unattended factual update pass." },
  { name: "review", group: "Maintain the wiki", usage: "review <workspace> [--commit] [--date YYYY-MM-DD] [--min-pages N] [--max-pages N] [--model MODEL] [--force] [--if-due]", summary: "Run bounded semantic review without editing existing pages." },
  { name: "consolidate", group: "Maintain the wiki", usage: "consolidate <workspace> [--commit] [--limit N]", summary: "Surface or merge durable concepts into topic pages." },
  { name: "distill-verify", group: "Maintain the wiki", usage: "distill-verify <old-snapshot.md> <new-page.md>", summary: "Check citation and conflict-callout preservation." },
  { name: "topics", group: "Maintain the wiki", usage: "topics [workspace]", summary: "Render the deterministic topic relationship view." },
  { name: "gaps", group: "Maintain the wiki", usage: "gaps <workspace> [--date YYYY-MM-DD] [--check]", summary: "Refresh or check the self-closing gap queue." },
  { name: "overview", group: "Maintain the wiki", usage: "overview <workspace> [--normalize|--check]", summary: "Normalize the bounded overview entry point." },
  { name: "migrate", group: "Maintain the wiki", usage: "migrate <workspace> [--commit] [--map old=new,...]", summary: "Plan or apply configured wiki-structure migration." },
  { name: "db-health", group: "Maintain the wiki", usage: "db-health <workspace> [--notice]", summary: "Inspect derived database integrity and storage." },
  { name: "compact", group: "Maintain the wiki", usage: "compact <workspace> [--commit]", summary: "Plan or apply eligible derived-database compaction." },
  { name: "wiki-clean", group: "Maintain the wiki", usage: "wiki-clean <workspace> [--date YYYY-MM-DD] [--commit]", summary: "Plan or apply deterministic wiki cleanup." },
  { name: "wiki-clean-apply", group: "Maintain the wiki", usage: "wiki-clean-apply <workspace> --review FILE --commit", summary: "Apply accepted ambiguous cleanup candidates." },

  { name: "bench", group: "Evaluate changes", usage: "bench <workspace> [--tune-only|--sealed] [--transcript FILE] [--limit N] [--downstream-read]", summary: "Run the deterministic retrieval benchmark." },
  { name: "bench-scale", group: "Evaluate changes", usage: "bench-scale [--repeats N]", summary: "Run generated 10/100/1000-page correctness tiers." },
  { name: "bench-capture", group: "Evaluate changes", usage: "bench-capture [--repeats N] [--sessions N,N,...]", summary: "Measure Claude/Codex/OpenCode discovery and revision-gate scale." },
  { name: "downstream-read", group: "Evaluate changes", usage: "downstream-read [workspace] [--transcript FILE] [--limit N]", summary: "Measure whether injected pointers were opened later." },
  { name: "compare-arm", group: "Evaluate changes", usage: "compare-arm <repo-template> --corpus DIR --label NAME [--keep] [--topic] [--write-model MODEL] [--verify-model MODEL]", summary: "Build and score one frozen-corpus comparison arm." },
  { name: "compare-verdict", group: "Evaluate changes", usage: "compare-verdict <current.json> <challenger.json>", summary: "Judge two compatible arm reports with regression gates." },

  { name: "quiz-status", group: "Human memory quiz", usage: "quiz-status <workspace> [--date YYYY-MM-DD]", summary: "Show due reviews and new quiz candidates." },
  { name: "quiz-next", group: "Human memory quiz", usage: "quiz-next <workspace> [--limit N] [--date YYYY-MM-DD]", summary: "Select the next bounded set of quiz source pages." },
  { name: "quiz-record", group: "Human memory quiz", usage: "quiz-record <workspace> --page PATH --result correct|wrong|skip [--question TEXT] [--date YYYY-MM-DD]", summary: "Record one result and advance the forgetting curve." },
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof COMMANDS)[number]["name"];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function renderRootHelp(version: string): string {
  const lines = [
    `llmwiki ${version} — local-first project wiki`,
    "",
    "usage: llmwiki <command> [options]",
    "  llmwiki <command> --help",
    "",
    "Get started:",
    "  1. From the engine clone: ./setup.sh --harness <claude|codex|opencode>",
    "  2. Enroll one project:   llmwiki init <workspace>",
    "  3. Verify everything:    llmwiki verify <workspace> --harness <harness>",
    "  4. Check enrollment:     llmwiki status <workspace>",
    "  5. Find prior context:   llmwiki search <workspace> <query>",
    "",
    "Commands:",
  ];
  for (const group of COMMAND_GROUPS) {
    lines.push(`  ${group}:`);
    for (const command of COMMANDS.filter((entry) => entry.group === group)) {
      lines.push(`    ${command.name.padEnd(20)} ${command.summary}`);
    }
  }
  // Keep the compact command line for existing doctor checks and lightweight shell consumers.
  lines.push(
    "",
    `commands: ${COMMANDS.map((command) => command.name).join(", ")}`,
    "",
    "Global options:",
    "  --help       Show this help.",
    "  --version    Show the installed engine version.",
    "",
  );
  return lines.join("\n");
}

export function renderCommandHelp(command: CommandSpec): string {
  return [
    "Usage:",
    `  llmwiki ${command.usage}`,
    "",
    command.summary,
    "",
    "Run `llmwiki --help` to browse related commands.",
    "",
  ].join("\n");
}
