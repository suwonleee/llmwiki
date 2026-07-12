# Codex adapter — native SessionStart / UserPromptSubmit hooks

Recent OpenAI Codex CLI ships a Claude-compatible lifecycle hook system (`codex-rs/hooks/`):
a `command` hook's **plain stdout on exit 0 is injected into model context** (developer-role
message), and `UserPromptSubmit` receives `{prompt, session_id, cwd, transcript_path, ...}`
as JSON on stdin — the same payload shape our Claude hook scripts already consume.
**So the two llmwiki hook scripts work on Codex as-is.**

## Wire it (per repo: `<repo>/.codex/hooks.json`, or user-wide: `$CODEX_HOME/hooks.json`)

Copy `hooks.json.example`, replacing `__LLMWIKI_ROOT__` with this clone's absolute path:

```bash
sed "s|__LLMWIKI_ROOT__|$(cd "$(dirname "$0")/../.." && pwd)|g" hooks.json.example > ~/.codex/hooks.json
```

Then **trust the hooks once** (verified on codex-cli 0.142.0): launch interactive `codex`
once — it shows "Hooks need review → Trust all and continue". Accepting writes per-hook
entries to config.toml (`[hooks.state."<path>:<event>:<idx>:<idx>"] trusted_hash =
"sha256:…"` — note: per-hook hashes, NOT one file hash). One-time per hooks.json change.
Verification without a model call: `codex exec "<term-rich prompt>"` prints
`hook: SessionStart / UserPromptSubmit … Completed`, and the rollout jsonl records the
injected banner as a developer-role message.

Warning — schema gotcha (verified on 0.142.0): hooks.json must contain ONLY the top-level `hooks`
key — a top-level `description` field makes the WHOLE config fail to parse
(`unknown field 'description'`) and hooks silently never run.

## Fallbacks (older Codex without the hooks crate)

- Cold-start: call the harness-neutral CLI from AGENTS.md / a startup prompt:
  `bun <clone>/src/cli.ts context <repo>` (model-driven, not guaranteed).
- Per-turn: none natively — the model can call `bun <clone>/src/cli.ts search <repo> <query>`
  as a tool instead. Per-turn injection is a progressive enhancement, never a baseline.

## Coexistence with OMX (oh-my-codex)

OMX's reconcile only manages hook entries whose command matches its own
`codex-native-hook.js` — foreign entries (ours) are preserved, and non-OMX trust-state keys
survive `omx setup`. Two cautions:
- Do NOT put llmwiki directives as bare lines in an OMX-generated AGENTS.md (clobbered on
  regen; use `<!-- USER:OMX:POLICY:START/END -->` markers if you must) and never in
  `developer_instructions` (OMX-owned).
- OMX's built-in wiki (`omx_wiki/`) also injects a summary at SessionStart → duplicate
  context. Recommend `wiki.enabled=false` in `.omx-config.json` when llmwiki runs the wiki.
