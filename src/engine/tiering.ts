import type { WikiConfig } from "./config.ts";
import type { KnowledgeStatus } from "./frontmatter.ts";

export const COLD_AFTER_DAYS = 180;

export type LifecycleTier = "hot" | "warm" | "cold" | "protected";

export type IncomingLinkState = { readonly kind: "none" } | { readonly kind: "protected-or-hot" } | { readonly kind: "stale" };

export type TieringPage = {
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

export type TieringConfig = {
  readonly files: Readonly<WikiConfig["files"]>;
  readonly queueDir: string;
  readonly categories: readonly Readonly<Pick<WikiConfig["categories"][number], "dir" | "domain" | "review">>[];
};

export type TieringPolicy = {
  readonly config: TieringConfig;
  readonly today: string;
};

export type TieringInput = {
  readonly page: TieringPage;
  readonly policy: TieringPolicy;
};

export type ProtectionReason =
  | "configured-l0" | "configured-overview" | "configured-log" | "queue-file" | "direction" | "decision" | "draft"
  | "unresolved-conflict" | "invalid-or-missing-date" | "manual-protected-tier" | "dirty-worktree"
  | "linked-from-protected-or-hot" | "superseded-without-successor";

export type AutoReason = "existing-hot-tier" | "eligible-recent" | "eligible-old" | "superseded-old";
export type AmbiguousReason = "missing-or-invalid-status" | "stale-link-graph" | "unsupported-category" | "invalid-policy-date";

export type TieringResult =
  | { readonly outcome: "protected"; readonly tier: "protected"; readonly reasons: readonly ProtectionReason[] }
  | { readonly outcome: "auto"; readonly tier: "hot" | "warm" | "cold"; readonly reason: AutoReason }
  | { readonly outcome: "ambiguous"; readonly tier: "warm"; readonly reason: AmbiguousReason };

type DateResult = { readonly kind: "valid"; readonly value: Date } | { readonly kind: "invalid" };
type StatusResult =
  | { readonly kind: "eligible"; readonly status: "ready" | "superseded" }
  | { readonly kind: "protected"; readonly reason: "draft" }
  | { readonly kind: "ambiguous"; readonly reason: "missing-or-invalid-status" };
type DeclaredTierResult =
  | { readonly kind: "derived" }
  | { readonly kind: "hot"; readonly reason: "existing-hot-tier" }
  | { readonly kind: "protected"; readonly reason: "manual-protected-tier" };
type EligibleClassificationInput = {
  readonly input: TieringInput;
  readonly pageDate: Date;
  readonly today: Date;
  readonly status: Extract<StatusResult, { readonly kind: "eligible" }>;
  readonly declaredTier: DeclaredTierResult;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled tiering variant: ${JSON.stringify(value)}`);
}

function parseDate(value: string | null): DateResult {
  if (value === null) return { kind: "invalid" };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return { kind: "invalid" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value: parsed };
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^docs\/wiki\//, "");
}

function configuredFileReason(path: string, policy: TieringPolicy): ProtectionReason | null {
  switch (path) {
    case policy.config.files.l0:
      return "configured-l0";
    case policy.config.files.overview:
      return "configured-overview";
    case policy.config.files.log:
      return "configured-log";
    default:
      return null;
  }
}

function configuredDomain(path: string, pageDomain: string | null, policy: TieringPolicy): string {
  const [directory] = path.split("/");
  return policy.config.categories.find((category) => category.dir === directory)?.domain ?? pageDomain ?? "";
}

function domainProtectionReason(domain: string): ProtectionReason | null {
  switch (domain) {
    case "direction":
      return "direction";
    case "decision":
    case "adr":
      return "decision";
    default:
      return null;
  }
}

function statusResult(status: KnowledgeStatus | null): StatusResult {
  switch (status) {
    case "ready":
    case "superseded":
      return { kind: "eligible", status };
    case "draft":
      return { kind: "protected", reason: "draft" };
    case null:
      return { kind: "ambiguous", reason: "missing-or-invalid-status" };
    default:
      return assertNever(status);
  }
}

function declaredTierResult(tier: LifecycleTier | null): DeclaredTierResult {
  switch (tier) {
    case "hot":
      return { kind: "hot", reason: "existing-hot-tier" };
    case "protected":
      return { kind: "protected", reason: "manual-protected-tier" };
    case "warm":
    case "cold":
    case null:
      return { kind: "derived" };
    default:
      return assertNever(tier);
  }
}

function linkReason(state: IncomingLinkState): ProtectionReason | null {
  switch (state.kind) {
    case "protected-or-hot":
      return "linked-from-protected-or-hot";
    case "none":
    case "stale":
      return null;
    default:
      return assertNever(state);
  }
}

function linkAmbiguity(state: IncomingLinkState): AmbiguousReason | null {
  switch (state.kind) {
    case "stale":
      return "stale-link-graph";
    case "none":
    case "protected-or-hot":
      return null;
    default:
      return assertNever(state);
  }
}

function missingSupersessionReason(page: TieringPage): ProtectionReason | null {
  switch (page.status) {
    case "superseded":
      return page.supersededBy === null || page.supersededBy.trim() === "" ? "superseded-without-successor" : null;
    case "ready":
    case "draft":
    case null:
      return null;
    default:
      return assertNever(page.status);
  }
}

function isOlderThanBoundary(pageDate: Date, today: Date): boolean {
  return (today.getTime() - pageDate.getTime()) / 86_400_000 > COLD_AFTER_DAYS;
}

function classifyEligible(value: EligibleClassificationInput): TieringResult {
  switch (value.declaredTier.kind) {
    case "hot":
      return { outcome: "auto", tier: "hot", reason: value.declaredTier.reason };
    case "protected":
      return { outcome: "protected", tier: "protected", reasons: [value.declaredTier.reason] };
    case "derived":
      break;
    default:
      return assertNever(value.declaredTier);
  }

  switch (value.status.status) {
    case "superseded":
      return isOlderThanBoundary(value.pageDate, value.today)
        ? { outcome: "auto", tier: "cold", reason: "superseded-old" }
        : { outcome: "auto", tier: "warm", reason: "eligible-recent" };
    case "ready": {
      const domain = configuredDomain(normalizedPath(value.input.page.path), value.input.page.domain, value.input.policy);
      switch (domain) {
        case "milestone":
        case "insight":
        case "lesson":
          return isOlderThanBoundary(value.pageDate, value.today)
            ? { outcome: "auto", tier: "cold", reason: "eligible-old" }
            : { outcome: "auto", tier: "warm", reason: "eligible-recent" };
        default:
          return { outcome: "ambiguous", tier: "warm", reason: "unsupported-category" };
      }
    }
    default:
      return assertNever(value.status.status);
  }
}

export function classifyTier(input: TieringInput): TieringResult {
  const path = normalizedPath(input.page.path);
  const pageDate = parseDate(input.page.date);
  const status = statusResult(input.page.status);
  const declaredTier = declaredTierResult(input.page.tier);
  const linkProtection = linkReason(input.page.incomingLinks);
  const reasons: readonly (ProtectionReason | null)[] = [
    configuredFileReason(path, input.policy),
    path === input.policy.config.queueDir || path.startsWith(`${input.policy.config.queueDir}/`) ? "queue-file" : null,
    domainProtectionReason(configuredDomain(path, input.page.domain, input.policy)),
    status.kind === "protected" ? status.reason : null,
    input.page.hasUnresolvedConflict ? "unresolved-conflict" : null,
    pageDate.kind === "invalid" ? "invalid-or-missing-date" : null,
    declaredTier.kind === "protected" ? declaredTier.reason : null,
    input.page.dirtyWorktree ? "dirty-worktree" : null,
    linkProtection,
    missingSupersessionReason(input.page),
  ];
  const protectedReasons = reasons.filter((reason): reason is ProtectionReason => reason !== null);
  if (protectedReasons.length > 0) return { outcome: "protected", tier: "protected", reasons: protectedReasons };

  const today = parseDate(input.policy.today);
  switch (today.kind) {
    case "invalid":
      return { outcome: "ambiguous", tier: "warm", reason: "invalid-policy-date" };
    case "valid":
      break;
    default:
      return assertNever(today);
  }

  switch (status.kind) {
    case "ambiguous":
      return { outcome: "ambiguous", tier: "warm", reason: status.reason };
    case "protected":
      return { outcome: "protected", tier: "protected", reasons: [status.reason] };
    case "eligible":
      break;
    default:
      return assertNever(status);
  }

  const ambiguity = linkAmbiguity(input.page.incomingLinks);
  if (ambiguity !== null) return { outcome: "ambiguous", tier: "warm", reason: ambiguity };
  switch (pageDate.kind) {
    case "valid":
      return classifyEligible({ input, pageDate: pageDate.value, today: today.value, status, declaredTier });
    case "invalid":
      return { outcome: "protected", tier: "protected", reasons: ["invalid-or-missing-date"] };
    default:
      return assertNever(pageDate);
  }
}
