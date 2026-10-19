import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeEnrolledRepo, tempDir } from "./support/git-repo.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { resetProjectStateCache } from "../src/engine/project-state.ts";
import { recordEmission } from "../src/engine/observe.ts";
import { injectedPages, recordInjectedFeedback, recheckQueue, resolveRecheck } from "../src/engine/injected-feedback.ts";
import { reportedWrongPages } from "../src/engine/reported-wrong.ts";
import { buildTurnContext } from "../src/engine/turncontext.ts";
import { loadEditRules } from "../src/engine/edit-rules.ts";
import { resetAffinityCache, loadAffinity, affinityMultiplier } from "../src/engine/affinity.ts";
import { WikiIndex } from "../src/engine/db.ts";

let root: string, state: string;
const page = "docs/wiki/3_decision/retry.md";
beforeEach(() => {
  state = tempDir("wrong-state-"); setEffectiveStateRoot(state); resetProjectStateCache(); resetAffinityCache();
  root = makeEnrolledRepo("wrong-repo-");
  mkdirSync(join(root,"docs/wiki/3_decision"),{recursive:true});
  writeFileSync(join(root,page),"---\ntitle: Gateway retry budget\ndescription: Gateway retry budget\nstatus: stable\nx-llmwiki:\n  applies_to: ['src/**']\n  rule: Retry budget allows three attempts.\n  recall: ['gateway retry budget']\n---\nGateway retry budget allows three attempts.\n");
  writeFileSync(join(root,"source.ts"),"const attempts=3;\n");
  new WikiIndex(root).indexAll();
});
afterEach(() => { resetAffinityCache(); setEffectiveStateRoot(null); resetProjectStateCache(); rmSync(root,{recursive:true,force:true}); rmSync(state,{recursive:true,force:true}); });
function feedback(session: string, outcome: "used"|"wrong", now: number) {
  recordEmission(root,session,"turn_context",`  • Gateway retry budget → ${page}`);
  const s = injectedPages(root,session).pages[0]!;
  recordInjectedFeedback(root,{session,judgments:[{page,sha256:s.sha256,channel:s.channel,outcome,evidence:"Verified against source.ts"}]},now);
}
test("a reported wrong version is marked and cannot emit a declared rule until rechecked",async()=>{
  const now=Date.now();
  feedback("wrong-session","wrong",now);
  expect(reportedWrongPages(root).has(page)).toBe(true);
  const out=buildTurnContext(root,"gateway retry budget");
  expect(out).toContain("reported wrong; recheck required");
  expect(out).not.toContain("Retry budget allows three attempts.");
  expect(await loadEditRules(root)).toEqual([]);
  const id=recheckQueue(root)[0]!.id;
  resolveRecheck(root,{id,verification:"Checked implementation and reran retry tests",evidence:["source.ts"]});
  expect(reportedWrongPages(root).size).toBe(0);
  expect((await loadEditRules(root)).length).toBe(1);
});
test("a wrong report withdraws old explicit positive ranking evidence",()=>{
  const now=Date.now();
  feedback("used-1","used",now-86400000); feedback("used-2","used",now);
  resetAffinityCache(); expect(affinityMultiplier(loadAffinity(root,now),page)).toBeGreaterThan(1);
  feedback("wrong-3","wrong",now); resetAffinityCache();
  expect(affinityMultiplier(loadAffinity(root,now),page)).toBe(1);
});
test("source revision changes restore warnings and withhold rules without another feedback write",async()=>{
  const now=Date.now();
  feedback("used-before-recheck-1","used",now-86400000);
  feedback("used-before-recheck-2","used",now);
  feedback("wrong-before-recheck","wrong",now);
  const id=recheckQueue(root)[0]!.id;
  const input={id,verification:"Verified current source and retry tests",evidence:["source.ts"]};
  resolveRecheck(root,input);
  expect(reportedWrongPages(root).size).toBe(0);
  expect((await loadEditRules(root)).length).toBe(1);
  resetAffinityCache(); expect(affinityMultiplier(loadAffinity(root),page)).toBeGreaterThan(1);
  writeFileSync(join(root,"unrelated.ts"),"unrelated source\n");
  expect(reportedWrongPages(root).size).toBe(0);
  const old=statSync(join(root,"source.ts"));
  writeFileSync(join(root,"source.ts"),"const attempts=4;\n");
  utimesSync(join(root,"source.ts"),old.atime,old.mtime);
  expect(recheckQueue(root)[0]?.status).toBe("open");
  expect(reportedWrongPages(root).has(page)).toBe(true);
  resetAffinityCache(); expect(affinityMultiplier(loadAffinity(root),page)).toBe(1);
  expect(await loadEditRules(root)).toEqual([]);
  expect(buildTurnContext(root,"gateway retry budget")).toContain("reported wrong; recheck required");
  resolveRecheck(root,input);
  expect(reportedWrongPages(root).size).toBe(0);
  expect((await loadEditRules(root)).length).toBe(1);
});
for (const unsafe of ["missing","symlink"] as const) test(`${unsafe} recheck evidence restores rule suppression`,async()=>{
  feedback("wrong-before-unsafe-evidence","wrong",Date.now());
  resolveRecheck(root,{id:recheckQueue(root)[0]!.id,verification:"Verified source behavior",evidence:["source.ts"]});
  expect(reportedWrongPages(root).size).toBe(0);
  rmSync(join(root,"source.ts"));
  if (unsafe === "symlink") {
    writeFileSync(join(root,"source-copy.ts"),"const attempts=3;\n");
    symlinkSync(join(root,"source-copy.ts"),join(root,"source.ts"));
  }
  expect(recheckQueue(root)[0]?.status).toBe("open");
  expect(reportedWrongPages(root).has(page)).toBe(true);
  expect(await loadEditRules(root)).toEqual([]);
});
test("edited content with its old mtime restored invalidates old usage feedback",()=>{
  const now=Date.now();
  feedback("used-a","used",now-86400000); feedback("used-b","used",now);
  const old=statSync(join(root,page));
  writeFileSync(join(root,page),"Changed assertion, identical timestamps do not prove identity.\n");
  utimesSync(join(root,page),old.atime,old.mtime); resetAffinityCache();
  expect(affinityMultiplier(loadAffinity(root,now),page)).toBe(1);
});
