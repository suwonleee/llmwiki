import { expect, test } from "bun:test";
import type { KnowledgeStatus } from "../src/engine/frontmatter.ts";
import { defaults } from "../src/engine/config.ts";

type LifecycleTier = "hot" | "warm" | "cold" | "protected";
type IncomingLinkState =
  | { readonly kind: "none" }
  | { readonly kind: "protected-or-hot" }
  | { readonly kind: "stale" };

type TieringPage = {
  readonly path: string;
  readonly status: KnowledgeStatus | null;
  readonly tier: LifecycleTier | null;
  readonly date: string | null;
  readonly domain: string | null;
  readonly supersededBy: string | null;
  readonly hasUnresolvedConflict: boolean;
  readonly dirtyWorktree: boolean;
  readonly incomingLinks: IncomingLinkState;
};

type TieringPolicy = {
  readonly config: {
    readonly files: { readonly l0: string; readonly overview: string; readonly log: string };
    readonly queueDir: string;
    readonly categories: readonly { readonly dir: string; readonly domain: string; readonly review: "human" | "model" }[];
  };
  readonly today: string;
};

type TieringInput = {
  readonly page: TieringPage;
  readonly policy: TieringPolicy;
};

type TieringResult =
  | {
      readonly outcome: "protected";
      readonly tier: "protected";
      readonly reasons: readonly string[];
    }
  | {
      readonly outcome: "auto";
      readonly tier: "hot" | "warm" | "cold";
      readonly reason: string;
    }
  | {
      readonly outcome: "ambiguous";
      readonly tier: "warm";
      readonly reason: string;
    };

type TieringModule = {
  readonly COLD_AFTER_DAYS: number;
  readonly classifyTier: (input: TieringInput) => TieringResult;
};

const policy = (): TieringPolicy => {
  const config = defaults();
  return {
    config: {
      files: config.files,
      queueDir: config.queueDir,
      categories: config.categories,
    },
    today: "2026-07-01",
  };
};

const page = (overrides: Partial<TieringPage> = {}): TieringPage => ({
  path: "2_milestone/example.md",
  status: "ready",
  tier: null,
  date: "2026-06-30",
  domain: "milestone",
  supersededBy: null,
  hasUnresolvedConflict: false,
  dirtyWorktree: false,
  incomingLinks: { kind: "none" },
  ...overrides,
});

const input = (overrides: Partial<TieringPage> = {}): TieringInput => ({ page: page(overrides), policy: policy() });

const loadPolicy = async (): Promise<TieringModule> => import("../src/engine/tiering.ts");

test("baseline policy inputs retain the configured root, queue, and knowledge categories", () => {
  // Given: stock team conventions
  const config = defaults();

  // When: their policy-relevant fields are read
  const actual = {
    files: config.files,
    queueDir: config.queueDir,
    domains: config.categories.map((category) => category.domain),
  };

  // Then: tiering can receive a fully configured policy without filesystem access
  expect(actual).toEqual({
    files: { l0: "current-state.md", overview: "overview.md", log: "log.md" },
    queueDir: "0_review",
    domains: ["direction", "milestone", "decision", "insight"],
  });
});

test("classifyTier protects every non-reversible policy branch", async () => {
  const tiering = await loadPolicy();
  const cases: readonly { readonly name: string; readonly value: TieringInput; readonly reason: string }[] = [
    { name: "configured L0", value: input({ path: "current-state.md" }), reason: "configured-l0" },
    { name: "configured overview", value: input({ path: "overview.md" }), reason: "configured-overview" },
    { name: "configured log", value: input({ path: "log.md" }), reason: "configured-log" },
    { name: "open review queue file", value: input({ path: "0_review/cleanup.md" }), reason: "queue-file" },
    { name: "direction knowledge", value: input({ path: "1_direction/strategy.md", domain: "direction" }), reason: "direction" },
    { name: "decision knowledge", value: input({ path: "3_decision/adr.md", domain: "decision" }), reason: "decision" },
    { name: "unresolved draft", value: input({ status: "draft" }), reason: "draft" },
    { name: "unresolved conflict", value: input({ hasUnresolvedConflict: true }), reason: "unresolved-conflict" },
    { name: "missing date", value: input({ date: null }), reason: "invalid-or-missing-date" },
    { name: "invalid date", value: input({ date: "2026-02-29" }), reason: "invalid-or-missing-date" },
    { name: "manually protected tier", value: input({ tier: "protected" }), reason: "manual-protected-tier" },
    { name: "dirty worktree page", value: input({ dirtyWorktree: true }), reason: "dirty-worktree" },
    {
      name: "protected or hot incoming link",
      value: input({ incomingLinks: { kind: "protected-or-hot" } }),
      reason: "linked-from-protected-or-hot",
    },
    {
      name: "superseded page without successor",
      value: input({ status: "superseded", supersededBy: null }),
      reason: "superseded-without-successor",
    },
  ];

  for (const scenario of cases) {
    // Given: a page with exactly one protection condition
    // When: policy classifies it
    const actual = tiering.classifyTier(scenario.value);

    // Then: source content cannot be made cold automatically
    expect(actual).toEqual({ outcome: "protected", tier: "protected", reasons: [scenario.reason] });
  }
});

test("classifyTier classifies reversible and review-required outcomes with a fixed clock", async () => {
  const tiering = await loadPolicy();
  const cases: readonly { readonly name: string; readonly value: TieringInput; readonly expected: TieringResult }[] = [
    {
      name: "an existing hot tier",
      value: input({ tier: "hot" }),
      expected: { outcome: "auto", tier: "hot", reason: "existing-hot-tier" },
    },
    {
      name: "an exact 180-day milestone boundary",
      value: input({ date: "2026-01-02" }),
      expected: { outcome: "auto", tier: "warm", reason: "eligible-recent" },
    },
    {
      name: "an older milestone",
      value: input({ date: "2026-01-01" }),
      expected: { outcome: "auto", tier: "cold", reason: "eligible-old" },
    },
    {
      name: "an older insight",
      value: input({ path: "4_insight/gotcha.md", domain: "insight", date: "2026-01-01" }),
      expected: { outcome: "auto", tier: "cold", reason: "eligible-old" },
    },
    {
      name: "an older superseded page with a successor",
      value: input({ status: "superseded", supersededBy: "3_decision/new.md", date: "2026-01-01" }),
      expected: { outcome: "auto", tier: "cold", reason: "superseded-old" },
    },
    {
      name: "a stale link graph",
      value: input({ incomingLinks: { kind: "stale" }, date: "2026-01-01" }),
      expected: { outcome: "ambiguous", tier: "warm", reason: "stale-link-graph" },
    },
    {
      name: "an old topic without a policy basis for auto-cold",
      value: input({ path: "5_topic/architecture.md", domain: "topic", date: "2026-01-01" }),
      expected: { outcome: "ambiguous", tier: "warm", reason: "unsupported-category" },
    },
  ];

  expect(tiering.COLD_AFTER_DAYS).toBe(180);
  for (const scenario of cases) {
    // Given: fixed date input and one lifecycle state
    // When: policy classifies it
    const actual = tiering.classifyTier(scenario.value);

    // Then: only explicit, reversible cases become auto tiers
    expect(actual).toEqual(scenario.expected);
  }
});
