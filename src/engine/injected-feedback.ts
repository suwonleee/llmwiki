// Explicit close-out self-assessments. These are not golden labels or work-feedback test cases.
// Unknown and missing feedback never count against a page; wrong claims await grounded recheck.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isEnrolledFresh } from "./enrollment.ts";
import { readDetailedEmissions, type EmissionChannel } from "./observe.ts";
import { createRepoFile, readRepoFileBytes, repoFileMtime } from "./repo-write.ts";
import { ensureProjectStateDir, projectStatePath, projectStateIsRegularFile, readProjectState, writeProjectStateQuietly } from "./project-state.ts";

const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const MAX_RECEIPTS = 2000, MAX_BYTES = 64 * 1024, DAY = 86400000;
const DIR = "injected-feedback";
export interface InjectionJudgment {
  page: string; sha256: string; channel: EmissionChannel;
  outcome: "used" | "irrelevant" | "wrong" | "unknown";
  evidence: string;
  used?: boolean; // usage and correctness are independent; wrong+used is retained, never rewarded
}
export interface InjectionFeedbackInput { session: string; judgments: InjectionJudgment[] }
interface Receipt extends InjectionFeedbackInput { schema_version: 1; classification: "self-assessment"; at: number }
export interface RecheckItem { id: string; page: string; sha256: string; evidence: string; session: string; at: number; status: "open" | "resolved" }
interface Resolution { schema_version: 1; id: string; page: string; sha256: string; evidence: { path: string; sha256: string }[]; verification: string; at: number }
const text = (v: unknown, n: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= n;

export function injectedPages(root: string, session: string) {
  if (!text(session, 256)) throw new Error("exact session required");
  const rows = new Map<string, { page: string; sha256: string; channel: EmissionChannel; first: number; last: number; current: boolean }>();
  for (const e of readDetailedEmissions(root, session)) for (const s of e.snapshots) {
    const key = `${e.channel}\0${s.page}\0${s.sha256}`;
    const prior = rows.get(key);
    if (prior) { prior.first = Math.min(prior.first, e.ts); prior.last = Math.max(prior.last, e.ts); }
    else {
      const bytes = readRepoFileBytes(root, s.page);
      rows.set(key, { ...s, channel: e.channel, first: e.ts, last: e.ts, current: bytes !== null && hash(bytes) === s.sha256 });
    }
  }
  return { schema_version: 1, session, pages: [...rows.values()], coverage: "versioned-emissions-only" };
}

function receipts(root: string): Receipt[] {
  let names: string[];
  try { names = readdirSync(projectStatePath(root, DIR)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort(); }
  catch { return []; }
  if (names.length > MAX_RECEIPTS) throw new Error("feedback read budget exceeded");
  const out: Receipt[] = [];
  for (const n of names) {
    if (!projectStateIsRegularFile(root, DIR, n)) continue;
    try {
      const r = JSON.parse(readProjectState(root, `${DIR}/${n}`, MAX_BYTES) ?? "null");
      if (r?.schema_version === 1 && r.classification === "self-assessment" && Number.isFinite(r.at) &&
          text(r.session, 256) && Array.isArray(r.judgments) && r.judgments.length <= 32) out.push(r);
    } catch { /* damaged feedback is not evidence */ }
  }
  return out;
}

export function recordInjectedFeedback(root: string, input: unknown, now = Date.now()) {
  if (!isEnrolledFresh(root)) throw new Error("repository not enrolled");
  const v = input as InjectionFeedbackInput;
  if (!v || !text(v.session, 256) || !Array.isArray(v.judgments) || v.judgments.length < 1 || v.judgments.length > 32)
    throw new Error("exact session and 1–32 judgments required");
  const seen = injectedPages(root, v.session).pages;
  const keys = new Set<string>();
  const judgments = v.judgments.map(j => {
    if (!j || !text(j.page, 512) || !/^[a-f0-9]{64}$/.test(j.sha256) ||
        !["used", "irrelevant", "wrong", "unknown"].includes(j.outcome) || !text(j.evidence, 1000) || (j.used !== undefined && typeof j.used !== "boolean"))
      throw new Error("page, emitted sha256, channel, outcome and concrete evidence required");
    const key = `${j.channel}\0${j.page}`;
    if (keys.has(key)) throw new Error("duplicate page/channel judgment");
    keys.add(key);
    if (!seen.some(s => s.page === j.page && s.channel === j.channel && s.sha256 === j.sha256))
      throw new Error("page version was not emitted in this session");
    return { page: j.page, sha256: j.sha256, channel: j.channel, outcome: j.outcome, evidence: j.evidence.trim(), ...(j.used !== undefined ? { used: j.used } : {}) };
  }).sort((a,b) => `${a.channel}/${a.page}`.localeCompare(`${b.channel}/${b.page}`));
  const content = { session: v.session, judgments };
  const name = `${hash(v.session)}.json`;
  const priorText = readProjectState(root, `${DIR}/${name}`, MAX_BYTES);
  if (priorText !== null) {
    const prior = JSON.parse(priorText) as Receipt;
    if (JSON.stringify({ session: prior.session, judgments: prior.judgments }) !== JSON.stringify(content))
      throw new Error("session already recorded; immutable feedback cannot be replaced");
    rebuildUsageAffinity(root, now);
    return { path: projectStatePath(root, DIR, name), duplicate: true };
  }
  const dir = ensureProjectStateDir(root, DIR);
  if (readdirSync(dir).length >= MAX_RECEIPTS) throw new Error("feedback budget reached");
  const receipt: Receipt = { schema_version: 1, classification: "self-assessment", at: now, ...content };
  const encoded = JSON.stringify(receipt) + "\n";
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("feedback exceeds 64 KiB");
  if (!createRepoFile(dir, name, encoded, 0o600)) throw new Error("session already recorded; immutable feedback cannot be replaced");
  rebuildUsageAffinity(root, now);
  return { path: join(dir, name), duplicate: false };
}

/** Explicit ingestion does the expensive fold. Hot paths read just its compact aggregate. */
function rebuildUsageAffinity(root: string, now: number): void {
  const byPage = new Map<string, { modifiedAt: number; sha256: string; channels: Record<string, { sessions: number; opened: number; days: Set<number>; signal: "feedback" }> }>();
  for (const r of receipts(root)) {
    if (r.at > now || r.at < now - 30 * DAY) continue;
    for (const j of r.judgments) {
      if (!["used", "irrelevant"].includes(j.outcome) || j.channel === "edit_rules") continue;
      const bytes = readRepoFileBytes(root, j.page);
      if (bytes === null || hash(bytes) !== j.sha256) continue;
      const modifiedAt = repoFileMtime(root, j.page);
      if (modifiedAt === null) continue;
      const p = byPage.get(j.page) ?? { modifiedAt, sha256: j.sha256, channels: {} };
      const c = p.channels[j.channel] ?? { sessions: 0, opened: 0, days: new Set<number>(), signal: "feedback" };
      c.sessions++; c.opened += +(j.outcome === "used"); c.days.add(Math.floor(r.at / DAY));
      p.channels[j.channel] = c; byPage.set(j.page, p);
    }
  }
  const pages = Object.fromEntries([...byPage.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(0,512).map(([path,p]) =>
    [path, { modifiedAt: p.modifiedAt, sha256: p.sha256, channels: Object.fromEntries(Object.entries(p.channels).map(([ch,c])=>[ch,{...c, days:c.days.size}])) }]));
  const wrong = recheckQueue(root).filter(i=>i.status === "open").slice(0,512).map(i=>({page:i.page,sha256:i.sha256}));
  // Explicitly reported wrong versions do not retain positive ranking evidence while pending.
  for (const item of wrong) if (pages[item.page]?.sha256 === item.sha256) delete pages[item.page];
  if (!writeProjectStateQuietly(root, ["observe", "usage-affinity.json"], JSON.stringify({ version: 1, generatedAt: now, pages, wrong }) + "\n"))
    throw new Error("could not write usage affinity in existing engine-held state");
}

function resolutions(root: string): Resolution[] {
  let names: string[];
  try { names = readdirSync(projectStatePath(root, "rechecks")).filter(n => /^[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/.test(n)); }
  catch { return []; }
  if (names.length > MAX_RECEIPTS * 8) throw new Error("recheck receipt budget exceeded");
  const out: Resolution[] = [];
  for (const name of names) {
    if (!projectStateIsRegularFile(root, "rechecks", name)) continue;
    try {
      const r = JSON.parse(readProjectState(root, `rechecks/${name}`, MAX_BYTES) ?? "null") as Resolution;
      if (r?.schema_version === 1 && /^[a-f0-9]{64}$/.test(r.id) && text(r.page, 512) &&
          /^[a-f0-9]{64}$/.test(r.sha256) && text(r.verification, 2000) && Number.isFinite(r.at) &&
          Array.isArray(r.evidence) && r.evidence.length >= 1 && r.evidence.length <= 8 &&
          r.evidence.every(e => text(e?.path, 512) && !e.path.replaceAll("\\", "/").toLowerCase().startsWith("docs/wiki/") && /^[a-f0-9]{64}$/.test(e.sha256))) out.push(r);
    } catch { /* damaged or forged-looking receipt cannot close a recheck */ }
  }
  return out;
}

export function recheckQueue(root: string): RecheckItem[] {
  const items = new Map<string, RecheckItem>();
  const verified = resolutions(root);
  for (const r of receipts(root)) for (const j of r.judgments) if (j.outcome === "wrong") {
    const id = hash(`${j.page}\0${j.sha256}`);
    if (items.has(id)) continue;
    const bytes = readRepoFileBytes(root, j.page);
    const current = bytes === null ? null : hash(bytes);
    const resolved = verified.some(resolution => resolution.id === id && resolution.page === j.page &&
      current === resolution.sha256 && resolution.evidence.every(e => {
        const b = readRepoFileBytes(root, e.path); return b !== null && hash(b) === e.sha256;
      }));
    items.set(id, { id, page: j.page, sha256: j.sha256, evidence: j.evidence, session: r.session, at: r.at, status: resolved ? "resolved" : "open" });
  }
  return [...items.values()].sort((a,b)=>a.at-b.at);
}

/** A changed page alone never closes a wrong report. Explicit raw evidence and verification do. */
export function resolveRecheck(root: string, input: unknown, now = Date.now()) {
  if (!isEnrolledFresh(root)) throw new Error("repository not enrolled");
  const v = input as { id: string; verification: string; evidence: string[] };
  if (!v || !/^[a-f0-9]{64}$/.test(v.id) || !text(v.verification, 2000) || !Array.isArray(v.evidence) ||
      v.evidence.length < 1 || v.evidence.length > 8 || !v.evidence.every(p=>text(p,512) && !p.replaceAll("\\", "/").toLowerCase().startsWith("docs/wiki/")))
    throw new Error("recheck requires id, verification, and 1–8 raw source/test evidence paths");
  const item = recheckQueue(root).find(i=>i.id === v.id);
  if (!item) throw new Error("unknown recheck id");
  const snap = (path: string) => { const b = readRepoFileBytes(root,path); if (b===null || b.length>1024*1024) throw new Error(`unsafe or missing evidence: ${path}`); return {path,sha256:hash(b)}; };
  const page = snap(item.page);
  const resolution: Resolution = {schema_version:1,id:v.id,page:item.page,sha256:page.sha256,evidence:v.evidence.map(snap),verification:v.verification.trim(),at:now};
  const dir = ensureProjectStateDir(root, "rechecks");
  // Bind each immutable receipt to its accepted page/evidence revision. A later source edit
  // reopens the same wrong-page item and can receive fresh evidence without overwriting history.
  const revision = hash(JSON.stringify({ page: resolution.page, sha256: resolution.sha256,
    evidence: resolution.evidence, verification: resolution.verification }));
  const name = `${v.id}-${revision}.json`;
  if (!createRepoFile(dir,name,JSON.stringify(resolution)+"\n",0o600)) {
    const prior = readProjectState(root, `rechecks/${name}`, MAX_BYTES);
    if (!projectStateIsRegularFile(root, "rechecks", name) || prior === null)
      throw new Error("unsafe recheck receipt; immutable history cannot be replaced");
    const parsed = JSON.parse(prior) as Resolution;
    if (JSON.stringify({ ...parsed, at: 0 }) !== JSON.stringify({ ...resolution, at: 0 }))
      throw new Error("recheck receipt mismatch; immutable history cannot be replaced");
  }
  rebuildUsageAffinity(root, now);
  return { path: join(dir,name), status: "resolved" };
}
