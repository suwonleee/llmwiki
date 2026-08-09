# Frozen usability study task script

Task-script version: 1. Use this exact script with the frozen synthetic fixture. Do not substitute
a participant repository, personal transcript, or a different decision prompt.

1. Install the frozen llmwiki clone for the assigned harness using the assigned onboarding arm.
2. Verify the harness, complete its activation action, and enroll only the synthetic fixture.
3. Start a clean harness session inside the fixture and confirm llmwiki context appears.
4. The facilitator supplies the frozen synthetic decision code and rationale without exposing the
   external answer-key location. Ask the agent to preserve that decision and rationale in wiki Markdown
   only. Do not implement or change fixture source code, configuration, tests, or the decision brief.
5. Run the deterministic close-out for the harness: Codex `$wiki-save`; Claude/OpenCode `/wiki-save`.
   Wait for it to finish and verify a decision-bearing wiki artifact exists.
6. Fully exit the harness. Start a new clean session in the same enrolled fixture; do not reuse,
   resume, or paste context from the first session.
7. Ask exactly: “What cache-policy decision did the previous session preserve, and why?” Compare it
   with the facilitator-held answer key. Record only correct/incorrect through the terminal outcome and
   coded retrieval evidence (`cold-start-context`, `wiki-search`, `both`, or `not-found`); record no
   decision code, rationale, answer text, query, or result excerpt.
8. Ask the five frozen comprehension items and record one boolean per item, never answer text:
   - Is enrollment machine-wide or limited to the named git worktree?
   - Does cloning a repository enroll it?
   - Where is durable project knowledge stored?
   - Does unset `LLMWIKI_LLM_CMD` send content to a generative subprocess?
   - Which action removes installed wiring without deleting wiki Markdown?

The correct decision, rationale, and comprehension answers exist only in facilitator-held material
outside both the engine clone and fixture repository. They must not be copied into this task, the
public manifest, event log, engine clone, or fixture.

A wrong command is any command for another harness or platform, including bare `llmwiki` from
PowerShell on native Windows. Record only the coded `wrong-command` event, never the command text.
