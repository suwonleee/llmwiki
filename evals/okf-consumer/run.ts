import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [engineArg, output] = process.argv.slice(2);
if (!engineArg || !output) throw Error('Usage: bun run.ts ENGINE_ROOT OUTPUT.json');
const engine = resolve(engineArg);
const temp = mkdtempSync(join(tmpdir(), 'llmwiki-okf-eval-'));
process.env.LLMWIKI_STATE_DIR = join(temp, 'engine-state');
const { searchWiki } = await import(join(engine, 'src/engine/page-rank.ts'));
const { buildTurnContext } = await import(join(engine, 'src/engine/turncontext.ts'));
const { WikiIndex } = await import(join(engine, 'src/engine/db.ts'));
const source = readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8');
const fixtures = JSON.parse(source);
const results: any[] = [];
try {
  for (const c of fixtures.cases) {
    const root = join(temp, c.id);
    mkdirSync(join(root,'docs/wiki'), {recursive:true});
    for (const p of c.pages) {
      const fm: any = {type:p.type,title:p.title,description:p.title,status:p.status ?? 'stable'};
      if (p.tags) fm.tags = p.tags;
      if (p.stale_after) fm.stale_after = p.stale_after;
      const lines = Object.entries(fm).map(([k,v])=>`${k}: ${JSON.stringify(v)}`);
      if (p.rule) lines.push('x-llmwiki:', `  rule: ${JSON.stringify(p.rule)}`);
      writeFileSync(join(root,'docs/wiki',p.path), `---\n${lines.join('\n')}\n---\n${p.body}\n`);
    }
    writeFileSync(join(root,'outside.md'),'---\ntype: Decision\ntitle: Outside policy\nx-llmwiki:\n  rule: "RULE_ESCAPE: Wait forever."\n---\nOutside wiki.\n');
    new WikiIndex(root).indexAll();
    const start = performance.now();
    const hits = searchWiki(root,c.query,3).map((h:any)=>h.page.rel);
    const context = buildTurnContext(root,c.query,'',{affinity:null});
    const ms = performance.now()-start;
    results.push({id:c.id,query:c.query,want:c.want ?? null,hits,top1:c.want ? hits[0]===c.want:null,top3:c.want ? hits.includes(c.want):null,required:c.required??[],delivered:(c.required??[]).filter((r:string)=>context.includes(r)),forbidden:c.forbidden??[],unrelatedDelivered:(c.forbidden??[]).filter((r:string)=>context.includes(r)),silentExpected:!!c.silent,silent:context.length===0,chars:context.length,ms,context});
  }
  const retrieval=results.filter(r=>r.want);
  const report = {engine,fixtureSHA256:createHash('sha256').update(source).digest('hex'),scope:'Synthetic deterministic diagnostic; not model accuracy or external-user productivity evidence.',summary:{cases:results.length,retrievalCases:retrieval.length,top1:retrieval.filter(r=>r.top1).length,top3:retrieval.filter(r=>r.top3).length,requiredRules:results.reduce((n,r)=>n+r.required.length,0),deliveredRules:results.reduce((n,r)=>n+r.delivered.length,0),forbiddenRules:results.reduce((n,r)=>n+r.forbidden.length,0),unrelatedDelivered:results.reduce((n,r)=>n+r.unrelatedDelivered.length,0),fillerFired:results.filter(r=>r.silentExpected&&!r.silent).length,chars:results.reduce((n,r)=>n+r.chars,0),meanMs:results.reduce((n,r)=>n+r.ms,0)/results.length},results};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary,null,2));
} finally {rmSync(temp,{recursive:true,force:true});}
