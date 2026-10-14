// Fixtures must compress through whichever zstd this runtime actually has — the same ladder the
// engine climbs to DECOMPRESS (Bun API → node:zlib → the `zstd` binary; sources/codex.ts). Bun
// gained zstdCompressSync after 1.2.0; keeping the fixture fallback mirrors the reader
// without assuming every supported runtime exposes the newest compression API.
export function zstdCompressFixture(plain: Buffer): Buffer {
  try {
    const b: any = globalThis.Bun;
    if (typeof b?.zstdCompressSync === "function") return Buffer.from(b.zstdCompressSync(plain));
  } catch {
    /* fall through */
  }
  try {
    const zlib = require("node:zlib");
    if (typeof zlib.zstdCompressSync === "function") return Buffer.from(zlib.zstdCompressSync(plain));
  } catch {
    /* unavailable */
  }
  const bin = Bun.which("zstd");
  if (bin) {
    const r = Bun.spawnSync([bin, "-q", "-c"], { stdin: plain, stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    if (r.exitCode === 0 && r.stdout.length > 0) return Buffer.from(r.stdout);
  }
  throw new Error("no zstd available for fixtures: need Bun.zstdCompressSync, node:zlib zstd, or a `zstd` binary on PATH");
}
