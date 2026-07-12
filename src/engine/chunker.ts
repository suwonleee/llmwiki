// Text chunker for wiki pages + sources → ~512-token chunks for FTS search.
// `storeChunks` is the synchronous bun:sqlite variant; chunks_fts is kept in
// sync by triggers in schema.sql.
import type { Database } from "bun:sqlite";

export const CHUNK_SIZE = 512;
export const CHUNK_OVERLAP = 128;
export const MIN_CHUNK_TOKENS = 32;
export const MAX_CHUNK_CHARS = 10_000;

const SENTENCE_RE = /(?<=[.!?。！？])\s+/;
const HEADER_RE = /^(#{1,6})\s+(.+)$/m;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

export interface Chunk {
  index: number;
  content: string;
  page: number | null;
  startChar: number;
  tokenCount: number;
  headerBreadcrumb: string;
}

function mkChunk(
  index: number,
  content: string,
  page: number | null,
  startChar: number,
  tokenCount: number,
  headerBreadcrumb = "",
): Chunk {
  return { index, content, page, startChar, tokenCount, headerBreadcrumb };
}

export function chunkText(
  content: string,
  chunkSize: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP,
  page: number | null = null,
): Chunk[] {
  if (!content || !content.trim()) return [];

  const paragraphs = splitParagraphs(content);
  let headerStack: [number, string][] = [];
  const chunks: Chunk[] = [];
  let currentBlocks: string[] = [];
  let currentTokens = 0;
  let currentStart = 0;
  let charPos = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    const m = HEADER_RE.exec(para);
    if (m && m.index === 0) {
      const level = m[1]!.length;
      const heading = m[2]!.trim();
      headerStack = headerStack.filter(([l]) => l < level);
      headerStack.push([level, heading]);
    }

    if (currentTokens + paraTokens > chunkSize && currentBlocks.length) {
      const text = currentBlocks.join("\n\n");
      if (estimateTokens(text) >= MIN_CHUNK_TOKENS) {
        const breadcrumb = headerStack.map(([, t]) => t).join(" > ");
        chunks.push(mkChunk(chunks.length, text, page, currentStart, estimateTokens(text), breadcrumb));
      }
      const [overlapBlocks, overlapTokens] = getOverlap(currentBlocks, overlap);
      currentBlocks = overlapBlocks;
      currentTokens = overlapTokens;
      currentStart = charPos - overlapBlocks.reduce((s, b) => s + b.length + 2, 0);
    }

    currentBlocks.push(para);
    currentTokens += paraTokens;
    charPos += para.length + 2;
  }

  if (currentBlocks.length) {
    const text = currentBlocks.join("\n\n");
    if (estimateTokens(text) >= MIN_CHUNK_TOKENS) {
      const breadcrumb = headerStack.map(([, t]) => t).join(" > ");
      chunks.push(mkChunk(chunks.length, text, page, currentStart, estimateTokens(text), breadcrumb));
    }
  }

  return enforceMaxChars(chunks);
}

function enforceMaxChars(chunks: Chunk[]): Chunk[] {
  if (!chunks.some((c) => c.content.length > MAX_CHUNK_CHARS)) return chunks;
  const result: Chunk[] = [];
  for (const c of chunks) {
    if (c.content.length <= MAX_CHUNK_CHARS) {
      result.push(mkChunk(result.length, c.content, c.page, c.startChar, c.tokenCount, c.headerBreadcrumb));
      continue;
    }
    const base = c.startChar || 0;
    let offset = 0;
    for (const piece of splitOversized(c.content)) {
      result.push(mkChunk(result.length, piece, c.page, base + offset, estimateTokens(piece), c.headerBreadcrumb));
      offset += piece.length;
    }
  }
  return result;
}

function splitOversized(text: string): string[] {
  const parts = text.split(SENTENCE_RE);
  const pieces: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? (current + " " + part).trim() : part;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
    } else {
      if (current) pieces.push(current);
      if (part.length <= MAX_CHUNK_CHARS) {
        current = part;
      } else {
        for (let i = 0; i < part.length; i += MAX_CHUNK_CHARS) {
          pieces.push(part.slice(i, i + MAX_CHUNK_CHARS));
        }
        current = "";
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p);
}

function getOverlap(blocks: string[], targetTokens: number): [string[], number] {
  const result: string[] = [];
  let tokens = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const bt = estimateTokens(blocks[i]!);
    if (tokens + bt > targetTokens) break;
    result.unshift(blocks[i]!);
    tokens += bt;
  }
  return [result, tokens];
}

export function storeChunks(db: Database, documentId: string, chunks: Chunk[]): void {
  db.run("DELETE FROM document_chunks WHERE document_id = ?", [documentId]);
  if (chunks.length) {
    const stmt = db.prepare(
      "INSERT INTO document_chunks " +
        "(document_id, chunk_index, content, page, start_char, token_count, header_breadcrumb) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of chunks) {
      stmt.run(documentId, c.index, c.content, c.page, c.startChar, c.tokenCount, c.headerBreadcrumb);
    }
  }
}
