// Secret screening for evidence excerpts.
//
// v3 persists 1–2 lines of raw session evidence into wiki pages, and those pages get committed to
// a repo the whole team clones. The raw material is a session transcript — which routinely holds
// credentials, because people paste them and agents run commands with them inline. A real example
// from this engine's own development (2026-07-20): a session ran
//   AWS_ACCESS_KEY_ID=AKIA… AWS_SECRET_ACCESS_KEY='…' aws sts get-caller-identity
// which grounding.ts records verbatim as a `shell_run` fact. Minting that into a footnote and
// committing it would put a live key in git history permanently — unrecoverable, since rewriting
// shared history is not a real option.
//
// So screening is a GATE, not a lint: excerpts must pass through here before anything persists
// them, and lint re-checks on read so a hand-written excerpt can't bypass the mint path.
//
// Design choices:
//   • Redact the TOKEN, keep the sentence. "aws sts get-caller-identity" is the evidential
//     content; the key is not. Dropping the whole line would cost provenance for no safety gain.
//   • Deny by shape, not by name list. A key is recognizable by its own format; waiting to
//     recognize the variable it was assigned to is how leaks get missed.
//   • When redaction eats most of the line, give up on the excerpt entirely (caller decides) —
//     a mostly-«redacted» quote proves nothing and still risks leaking the remainder.

export const REDACTED = "«redacted»";

// "Nothing left worth keeping" is measured in ABSOLUTE surviving characters, not as a fraction of
// the original. A ratio rule is language-biased: a 40-char key is a small slice of an English
// sentence but half of an equally-informative Korean one, so the same evidence would be dropped in
// one language and kept in the other. This engine is language-neutral by policy, so the floor is
// "does enough readable text remain to ground anything", with a low ratio only as a backstop for
// a short fragment buried in a huge secret.
const GUTTED_FLOOR_CHARS = 20;
const GUTTED_RATIO_BACKSTOP = 0.2;

// Provider key shapes. Ordered longest/most-specific first so a nested match (sk-ant- inside sk-)
// redacts once, wholly.
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key-block", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?(-----END[ A-Z]*PRIVATE KEY-----)?/g },
  // Length is open-ended and there is NO trailing \b on these two. An exact `{16}\b` reads the
  // spec correctly (a real AWS id is exactly 20 chars) and screens wrongly: a longer look-alike
  // matches the first 16 and then fails the boundary against char 17, so the whole run passes
  // through UNREDACTED. That is the wrong way to be wrong for a screener — over-redacting a
  // look-alike costs a few characters of evidence, under-redacting publishes a credential.
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16,}/g },
  { name: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35,}/g },
  { name: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: "github-token", re: /\bgh[pousr]_[0-9A-Za-z]{20,}/g },
  { name: "anthropic-key", re: /\bsk-ant-[0-9A-Za-z_-]{20,}/g },
  { name: "openai-key", re: /\bsk-[0-9A-Za-z]{20,}/g },
  { name: "jwt", re: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g },
  { name: "bearer-token", re: /\b[Bb]earer\s+[0-9A-Za-z._~+/-]{20,}=*/g },
  { name: "url-userinfo", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi },
];

// KEY=value / KEY: value where the NAME says secret. Value may be quoted; stop at the quote or
// whitespace. Deliberately after the shape patterns so a recognizable key redacts by shape first.
const ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)(\s*[=:]\s*)(?:"([^"]*)"|'([^']*)'|(\S+))/gi;

// High-entropy standalone blobs (base64/hex) that no named pattern caught. Long + mixed-class is
// the signal; prose and file paths do not look like this. Kept last and deliberately narrow —
// a false redaction inside evidence is a real cost, so this only fires on ≥32 chars with both
// cases AND digits, and never on something containing a path separator or a dot-extension.
const ENTROPY_RE = /\b(?![A-Za-z]+\b)[A-Za-z0-9+/_-]{32,}={0,2}\b/g;

function looksHighEntropy(tok: string): boolean {
  if (/[./\\]/.test(tok)) return false; // paths, filenames, versions
  const hasLower = /[a-z]/.test(tok);
  const hasUpper = /[A-Z]/.test(tok);
  const hasDigit = /[0-9]/.test(tok);
  return (hasLower && hasUpper && hasDigit) || (/^[0-9a-f]{40,}$/i.test(tok) && !/^0+$/.test(tok));
}

export interface ScreenResult {
  text: string; // the screened text (secrets replaced with REDACTED)
  redactions: string[]; // pattern names that fired, in order — for reporting, never the values
  /** True when so much was redacted that the excerpt no longer carries evidence. */
  gutted: boolean;
}

/**
 * Screen a candidate excerpt. ALWAYS call this before persisting transcript-derived text into a
 * wiki page. Never logs or returns the matched secret values.
 */
export function screenSecrets(input: string): ScreenResult {
  const redactions: string[] = [];
  let text = input;

  for (const { name, re } of SECRET_PATTERNS) {
    text = text.replace(re, () => {
      redactions.push(name);
      return REDACTED;
    });
  }

  text = text.replace(ASSIGNMENT_RE, (_m, key: string, sep: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value || value === REDACTED) return `${key}${sep}${value}`;
    redactions.push("named-assignment");
    return `${key}${sep}${REDACTED}`;
  });

  text = text.replace(ENTROPY_RE, (m) => {
    if (!looksHighEntropy(m)) return m;
    redactions.push("high-entropy");
    return REDACTED;
  });

  // "Mostly redacted" is measured on visible characters, ignoring the placeholders themselves.
  const surviving = text.split(REDACTED).join("").replace(/\s+/g, " ").trim().length;
  const original = input.replace(/\s+/g, " ").trim().length;
  const gutted =
    redactions.length > 0 &&
    original > 0 &&
    (surviving < GUTTED_FLOOR_CHARS || surviving / original < GUTTED_RATIO_BACKSTOP);

  return { text, redactions, gutted };
}

/** Cheap boolean for lint's read-time re-check: does this text still carry a recognizable secret? */
export function hasSecret(text: string): boolean {
  return screenSecrets(text).redactions.length > 0;
}
