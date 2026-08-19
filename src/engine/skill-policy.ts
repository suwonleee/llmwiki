// The ONE place the wiki skills' invocation rule is written down.
//
// These skills are human-invoked by design — their own bodies say so ("Why a human-invoked
// command and not a hook"): the close-out runs warm and human-present, and undistilled
// transcript is consumed only when a person calls a wiki command. Nothing enforces that unless
// each install surface carries the gate, and the two harnesses spell the same rule differently:
//
//   Claude Code, Qwen   `disable-model-invocation: true` in SKILL.md frontmatter
//   Codex               `policy.allow_implicit_invocation: false` in <skill>/agents/openai.yaml
//                       (Codex ignores the frontmatter key entirely)
//
// Two surfaces ship these skills — the clone install (src/daemon/wire-codex.ts) and the plugin
// bundle (src/plugin/build-assets.ts) — and a plugin install never runs the wiring, so BOTH have
// to emit BOTH spellings. Measured before this existed: 16 Codex sessions ran 275 write-class
// `llmwiki` commands after finishing unrelated work, with no wiki request anywhere in them.
//
// Change the rule here and both surfaces follow; tests/skill-policy.test.ts fails if one drifts.
import { join } from "node:path";

/** Where Codex looks for a skill's invocation policy, relative to the skill directory. */
export const SKILL_POLICY_REL = join("agents", "openai.yaml");

/** The frontmatter key Claude Code and Qwen honor. Emitted directly under `name:`. */
export const FRONTMATTER_GATE = "disable-model-invocation: true";

/** The line Codex reads. Both emitters must produce it verbatim; doctor greps for it. */
export const CODEX_GATE = "allow_implicit_invocation: false";

/**
 * Body of `<skill>/agents/openai.yaml`.
 *
 * `owner` is the emitting surface's ownership marker: the wiring writes its clone-scoped marker so
 * `--revert` removes only what it installed, the bundle writes its generated-asset marker so the
 * drift test can tell a generated file from a hand-written one.
 */
export function skillPolicyYaml(sourceText: string, skillName: string, owner: string): string {
  const described = /^description:\s*(.+)$/m.exec(sourceText)?.[1]?.trim() ?? skillName;
  const summary = described.length > 96 ? `${described.slice(0, 95)}…` : described;
  return (
    `# ${owner}\n` +
    "# Invocation gate: this skill is human-invoked by design (see SKILL.md). Dropping the line\n" +
    "# below lets Codex run a close-out or a deep pass on its own, mid-task.\n" +
    "interface:\n" +
    `  display_name: "$${skillName}"\n` +
    `  short_description: ${JSON.stringify(summary)}\n` +
    "\npolicy:\n" +
    `  ${CODEX_GATE}\n`
  );
}
