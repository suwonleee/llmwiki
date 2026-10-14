// Which files a shell command is about to WRITE — the Bash half of the edit-time rules hook.
//
// Measured (24 real Claude Code runs): with the hook on Edit/Write a path rule was applied 5/5, but
// in 15/24 runs the agent edited through the Bash tool instead — `python3 - <<'EOF' … open(p,'w')
// … EOF`, `sed -i`, `cat > f <<EOF`, `tee`, `perl -pi` — and the rule never arrived (0/15).
// Bypass-permissions mode encourages exactly that, so the PreToolUse hook also matches `Bash`.
//
// A Bash hook fires on EVERY shell command, so this module is the whole hot path for the common
// case: a pure string scan with no filesystem access and no imports beyond node:path, run before
// enrollment checks or any wiki read. An empty answer means "not a write" and the hook exits.
//
// The heuristic (a write is any of these; everything else is read-only, however many matching
// paths it mentions — `cat`, `grep`, `rg`, `sed` without -i, `git diff/log`, `2>&1`, `>/dev/null`):
//   - an output redirect `>`, `>>`, `>|`, `&>`, `N>` to a file (not `/dev/*`, not `>&N`) —
//     which also covers `cat > f <<EOF` → the target;
//   - `tee FILE…` → the files;
//   - `sed -i` / `--in-place`, `perl -i` / `-pi` → the file operands (the script is skipped);
//   - `cp` / `mv` / `install` / `rsync` / `ln` → the destination (and dest/<source name>; `mv` also
//     its sources, which it removes);
//   - an inline interpreter (python*, node, bun, deno, ruby, perl, php) whose source — a `-c`/`-e`
//     argument, a heredoc, a here-string, or a heredoc piped into it — contains a write call
//     (`open(…, 'w'|'a'|'x'|'r+')`, `.write(` other than std{out,err}, `write_text`, `write_bytes`,
//     `writeFile[Sync]`, `appendFile[Sync]`, `Bun.write`, `File.write`, perl `open(…, '>')`, …) →
//     the path-like string literals of that source plus the interpreter's path-like arguments;
//   - `bash|sh|zsh -c '…'` and `find … -exec …` / `xargs …` are looked through.
// When a write form names no target of its own (`find src | xargs sed -i …`), every path-like word
// in the command is a candidate. "Path-like" = contains `/` or ends in a file extension.
//
// Heredoc bodies are content, not shell: a `>` inside one never counts as a redirect. A leading
// `cd DIR &&` re-bases later relative targets. Targets come back as written (relative ones under
// any `cd`); resolving against the session cwd, `~`, globs and directories is the caller's job
// (edit-rules.ts), which only runs once this has said "write".
import { join, isAbsolute, basename } from "node:path";

interface Segment {
  readonly argv: string[];
  readonly redirects: { op: string; target: string }[];
  readonly bodies: string[]; // heredoc bodies and here-strings: content handed to the command
  pipedFrom: Segment | null;
  dir: string; // the `cd` in effect, "" = the session cwd
}

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", ";;", "\n", "(", ")"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec", "builtin", "noglob"]);
const INTERPRETER = /^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|ruby|perl|php)$/;
const SOURCE_FLAGS = new Set(["-c", "-e", "-E", "--eval", "-r", "--command"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const COPIERS = new Set(["cp", "mv", "install", "rsync", "ln", "gcp", "gmv"]);
// Flags of the copiers that consume the next argument (so it is not mistaken for a source).
const COPIER_VALUE_FLAGS = new Set(["-m", "-o", "-g", "-S", "-e", "--mode", "--owner", "--group", "--suffix"]);

// Write calls in inline interpreter source. `.write(` excludes `stdout.write(`/`stderr.write(`,
// which print rather than write a file.
const WRITE_CALL = new RegExp(
  [
    String.raw`\bopen\s*\([^\n;]*?(?:,\s*|mode\s*=\s*)['"](?:[wax]|r\+)[bt+]*['"]\s*[,)]`, // python/ruby open(p, 'w')
    String.raw`\bopen\s*\(?[^\n;]*?,\s*['"]\+?>`, // perl open($fh, '>', $p)
    String.raw`(?<!std(?:out|err))\.write\s*\(`,
    String.raw`\bwrite_(?:text|bytes)\s*\(`,
    String.raw`\b(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\b`,
    String.raw`\bBun\.write\s*\(`,
    String.raw`\b(?:File|IO)\.(?:write|binwrite)\b`,
    String.raw`\bfile_put_contents\s*\(`,
    String.raw`\bshutil\.(?:copy\w*|move)\s*\(`,
    String.raw`\bos\.(?:replace|rename)\s*\(`,
  ].join("|"),
);

const EXTENSION = /\.[A-Za-z0-9_]{1,10}$/;

/** A word that names a file: has a `/` or a file extension, and is not a flag, URL or variable. */
function pathLike(word: string): boolean {
  if (!word || word.length > 4096 || word.startsWith("-") || word.includes("://") || word.includes("\n")) return false;
  if (/\$(?!HOME\b)|\$\{|`/.test(word)) return false; // unresolvable expansion
  return word.includes("/") || EXTENSION.test(word);
}

/** A redirect/tee/copy target: anything but a device, a descriptor or stdout. */
function fileTarget(word: string): boolean {
  return !!word && word !== "-" && !/^\d+$/.test(word) && !word.startsWith("&") && !word.startsWith("/dev/");
}

// ---- tokenizer ---------------------------------------------------------------------------
//
// Enough of POSIX shell for this question: quotes, escapes, `$(…)`/backticks as opaque word
// text, separators, redirects with an optional fd prefix, heredocs (`<<`, `<<-`, quoted
// delimiters) and here-strings. Not a shell: an unbalanced construct just ends the word.

function parse(cmd: string): Segment[] {
  const segments: Segment[] = [];
  let cur = newSegment(null, "");
  let word = "";
  let inWord = false;
  let pendingOp: string | null = null; // redirect waiting for its target word
  const heredocs: { delim: string; strip: boolean; seg: Segment }[] = [];
  let dir = "";

  function newSegment(pipedFrom: Segment | null, d: string): Segment {
    return { argv: [], redirects: [], bodies: [], pipedFrom, dir: d };
  }
  function flush(): void {
    if (!inWord) return;
    if (pendingOp !== null) {
      if (pendingOp === "<<" || pendingOp === "<<-") heredocs.push({ delim: word, strip: pendingOp === "<<-", seg: cur });
      else if (pendingOp === "<<<") cur.bodies.push(word);
      else cur.redirects.push({ op: pendingOp, target: word });
      pendingOp = null;
    } else cur.argv.push(word);
    word = "";
    inWord = false;
  }
  function endSegment(sep: string): void {
    flush();
    pendingOp = null;
    if (cur.argv.length || cur.redirects.length || cur.bodies.length) {
      segments.push(cur);
      // `cd DIR` re-bases what follows it in this command (a subshell's cd leaks here; rare).
      if (cur.argv[0] === "cd" && cur.argv.length === 2 && !cur.argv[1]!.startsWith("-")) {
        const to = cur.argv[1]!;
        dir = isAbsolute(to) || to.startsWith("~") ? to : dir ? join(dir, to) : to;
      }
    }
    const piped = sep === "|" || sep === "|&";
    cur = newSegment(piped ? (segments[segments.length - 1] ?? null) : null, dir);
  }

  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i]!;
    if (c === "\\") {
      if (cmd[i + 1] === "\n") i += 2;
      else {
        word += cmd[i + 1] ?? "";
        inWord = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      word += cmd.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"' || (c === "$" && cmd[i + 1] === "'")) {
      const quote = c === '"' ? '"' : "'";
      let j = c === '"' ? i + 1 : i + 2;
      while (j < n && cmd[j] !== quote) {
        if (cmd[j] === "\\" && j + 1 < n) {
          const e = cmd[j + 1]!;
          word += quote === "'" && e === "n" ? "\n" : e;
          j += 2;
        } else word += cmd[j++];
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if ((c === "$" && cmd[i + 1] === "(") || c === "`") {
      // Command/arithmetic substitution: opaque text of the current word.
      let j = i + 1;
      if (c === "`") {
        const end = cmd.indexOf("`", j);
        j = end < 0 ? n : end + 1;
      } else {
        let depth = 0;
        for (; j < n; j += 1) {
          const d = cmd[j];
          if (d === "(") depth += 1;
          else if (d === ")" && --depth === 0) break;
        }
        j += 1;
      }
      word += cmd.slice(i, j);
      inWord = true;
      i = j;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      const end = cmd.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "\n") {
      endSegment("\n");
      i += 1;
      // Heredoc bodies start on the line after their operator, in operator order.
      while (heredocs.length) {
        const h = heredocs.shift()!;
        const lines: string[] = [];
        while (i < n) {
          const nl = cmd.indexOf("\n", i);
          const line = cmd.slice(i, nl < 0 ? n : nl);
          i = nl < 0 ? n : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.seg.bodies.push(lines.join("\n"));
      }
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && cmd[i + 1] === ">")) {
      // An all-digit word glued to the operator is its fd (`2>`), not an argument.
      if (inWord && /^\d+$/.test(word) && i > 0 && cmd[i - 1] !== " ") {
        word = "";
        inWord = false;
      } else flush();
      if ((c === ">" || c === "<") && cmd[i + 1] === "(") {
        // Process substitution `>(cmd)` / `<(cmd)`: not a file redirect.
        word += c;
        inWord = true;
        i += 1;
        continue;
      }
      const ops = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<"];
      const op = ops.find((o) => cmd.startsWith(o, i))!;
      i += op.length;
      pendingOp = op === ">|" ? ">" : op;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      const two = cmd.slice(i, i + 2);
      const sep = SEPARATORS.has(two) ? two : c;
      endSegment(sep);
      i += sep.length;
      continue;
    }
    word += c;
    inWord = true;
    i += 1;
  }
  endSegment(";");
  return segments;
}

// ---- write forms -------------------------------------------------------------------------

/** argv with leading `VAR=value` assignments and wrappers (sudo, env, nohup, …) removed. */
function command(argv: readonly string[]): string[] {
  let k = 0;
  while (k < argv.length) {
    const a = argv[k]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) k += 1;
    else if (WRAPPERS.has(a)) {
      k += 1;
      while (k < argv.length && argv[k]!.startsWith("-")) k += 1; // the wrapper's own flags
    } else break;
  }
  return argv.slice(k);
}

const positionals = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith("-") || a === "-");

function sedTargets(args: readonly string[]): string[] | null {
  let inPlace = false;
  let hasScriptFlag = false;
  const operands: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!;
    if (a === "--in-place" || a.startsWith("--in-place=")) inPlace = true;
    else if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
      hasScriptFlag = true;
      k += 1; // the script itself
    } else if (a.startsWith("--expression=") || a.startsWith("--file=")) hasScriptFlag = true;
    else if (/^-[A-Za-z]+/.test(a) && !a.startsWith("--")) {
      if (/^-[A-Za-z]*i/.test(a)) {
        inPlace = true;
        // BSD sed's `-i ''` / `-i .bak`: the suffix is its own argument.
        const next = args[k + 1];
        if (a === "-i" && next !== undefined && (next === "" || /^\.[\w~-]*$/.test(next))) k += 1;
      }
      if (/^-[A-Za-z]*[ef]$/.test(a)) {
        hasScriptFlag = true;
        k += 1;
      }
    } else operands.push(a);
  }
  if (!inPlace) return null;
  return hasScriptFlag ? operands : operands.slice(1);
}

function perlInPlace(args: readonly string[]): string[] | null {
  let inPlace = false;
  const operands: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!;
    if (/^-[A-Za-z0-9]*i/.test(a) && !a.startsWith("--")) inPlace = true;
    if (/^-[A-Za-z0-9.]*[eE]$/.test(a) && !a.startsWith("--")) k += 1; // -e CODE
    else if (!a.startsWith("-")) operands.push(a);
  }
  return inPlace ? operands : null;
}

function copierTargets(name: string, args: readonly string[]): string[] {
  const ops: string[] = [];
  let targetDir: string | null = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k]!;
    if (a === "-t" || a === "--target-directory") targetDir = args[++k] ?? null;
    else if (a.startsWith("--target-directory=")) targetDir = a.slice("--target-directory=".length);
    else if (COPIER_VALUE_FLAGS.has(a)) k += 1;
    else if (!a.startsWith("-")) ops.push(a);
  }
  const dest = targetDir ?? (ops.length >= 2 ? ops[ops.length - 1]! : null);
  if (!dest) return [];
  const sources = targetDir ? ops : ops.slice(0, -1);
  const out = [dest, ...sources.map((s) => join(dest, basename(s)))];
  if (name === "mv" || name === "gmv") out.push(...sources);
  return out;
}

/** Path-like string literals of interpreter source, or [] when it writes nothing. */
function sourceTargets(source: string): string[] {
  if (!WRITE_CALL.test(source)) return [];
  const out: string[] = [];
  for (const m of source.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const lit = m[2]!;
    if (pathLike(lit)) out.push(lit);
  }
  return out.length ? out : ["\0write"]; // a write whose target is a variable → fall back
}

/** Targets one segment writes; `["\0write"]` = a write with no target of its own. */
function segmentTargets(seg: Segment, depth: number): string[] {
  const out: string[] = [];
  for (const r of seg.redirects) {
    if ((r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" || r.op === "<>") && fileTarget(r.target)) {
      out.push(r.target);
    }
  }
  const argv = command(seg.argv);
  const name = basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (!name) return out;
  if (name === "tee") {
    out.push(...positionals(args).filter(fileTarget));
  } else if (name === "sed" || name === "gsed") {
    const t = sedTargets(args);
    if (t) out.push(...(t.length ? t : ["\0write"]));
  } else if (name === "perl") {
    const t = perlInPlace(args);
    if (t) out.push(...(t.length ? t : ["\0write"]));
  } else if (COPIERS.has(name)) {
    out.push(...copierTargets(name, args));
  } else if (name === "xargs" || name === "find") {
    // Look through to the command they run: `xargs [flags] CMD …`, `find … -exec CMD … ;`.
    let k = 0;
    if (name === "xargs") {
      while (k < args.length && args[k]!.startsWith("-")) k += /^-[ILnPsdE]$/.test(args[k]!) ? 2 : 1;
    } else {
      k = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok") + 1;
      if (k === 0) return out;
    }
    const inner = args.slice(k).filter((a) => a !== "{}" && a !== ";" && a !== "+");
    if (inner.length && depth < 3) {
      const t = segmentTargets({ argv: inner, redirects: [], bodies: [], pipedFrom: null, dir: seg.dir }, depth + 1);
      if (t.length) out.push("\0write");
    }
  }
  if (INTERPRETER.test(name) || SHELLS.has(name)) {
    const sources: string[] = [...seg.bodies, ...(seg.pipedFrom?.bodies ?? [])];
    let script = -1;
    for (let k = 0; k < args.length; k += 1) {
      if (SOURCE_FLAGS.has(args[k]!) || /^-[A-Za-z]*c$/.test(args[k]!)) {
        if (args[k + 1] !== undefined) sources.push(args[k + 1]!);
        script = k + 1;
        break;
      }
    }
    if (SHELLS.has(name)) {
      if (script > 0 && depth < 3) out.push(...bashWriteTargets(args[script]!, depth + 1));
      for (const body of seg.bodies) if (depth < 3) out.push(...bashWriteTargets(body, depth + 1));
    } else {
      for (const src of sources) {
        const t = sourceTargets(src);
        if (t.length) {
          out.push(...t);
          out.push(...positionals(args.filter((_, k) => k !== script)).filter(pathLike));
        }
      }
    }
  }
  return out;
}

/**
 * The files `cmd` is about to write, as written (relative ones re-based under any `cd`), or []
 * when it looks read-only. Pure string work — safe to run on every shell command.
 */
export function bashWriteTargets(cmd: string, depth = 0): string[] {
  if (!cmd) return [];
  const segments = parse(cmd);
  const found = new Set<string>();
  let fallback = false;
  for (const seg of segments) {
    for (const t of segmentTargets(seg, depth)) {
      if (t === "\0write") {
        fallback = true;
        continue;
      }
      found.add(seg.dir && !isAbsolute(t) && !t.startsWith("~") ? join(seg.dir, t) : t);
    }
  }
  if (fallback) {
    // A write whose target the command does not spell out (a variable, stdin from find/xargs):
    // every path-like word in the command is a candidate.
    for (const seg of segments) {
      for (const w of seg.argv) {
        if (pathLike(w)) found.add(seg.dir && !isAbsolute(w) && !w.startsWith("~") ? join(seg.dir, w) : w);
      }
    }
  }
  return [...found];
}
