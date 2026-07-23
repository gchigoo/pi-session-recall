import { CHUNKER_CONFIG, CHUNKER_VERSION } from "../config/versions.js";

/**
 * Deterministic chunker v1（roadmap §5.1）。
 */

export interface ChunkPiece {
  chunkIndex: number;
  text: string;
  chunkerVersion: string;
}

/**
 * 规范化文本：NFC、换行统一、首尾空白。
 */
export function canonicalizeText(input: string): string {
  return input.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/**
 * 统计 Unicode scalar 数量（近似用 code point）。
 */
export function scalarLength(text: string): number {
  return [...text].length;
}

/**
 * 将已通过 policy 的文本切分为确定性 chunks。
 */
export function chunkText(input: string): ChunkPiece[] {
  const text = canonicalizeText(input);
  if (text.length === 0) {
    return [];
  }

  const { targetScalars, hardMaxScalars, overlapScalars, minMergeScalars } = CHUNKER_CONFIG;
  const segments = splitPreferBoundaries(text);
  const pieces: string[] = [];
  let buffer = "";

  for (const segment of segments) {
    if (scalarLength(segment) > hardMaxScalars) {
      if (buffer.length > 0) {
        pieces.push(buffer);
        buffer = "";
      }
      pieces.push(...hardSplit(segment, hardMaxScalars, overlapScalars));
      continue;
    }

    const candidate = buffer.length === 0 ? segment : `${buffer}\n\n${segment}`;
    if (scalarLength(candidate) <= targetScalars) {
      buffer = candidate;
      continue;
    }

    if (buffer.length > 0) {
      pieces.push(buffer);
    }
    if (scalarLength(segment) <= hardMaxScalars) {
      buffer = segment;
    } else {
      pieces.push(...hardSplit(segment, hardMaxScalars, overlapScalars));
      buffer = "";
    }
  }

  if (buffer.length > 0) {
    pieces.push(buffer);
  }

  const merged = mergeShortFragments(pieces, minMergeScalars, hardMaxScalars);
  return merged.map((piece, chunkIndex) => ({
    chunkIndex,
    text: piece,
    chunkerVersion: CHUNKER_VERSION,
  }));
}

/**
 * 优先按段落 / 代码围栏边界切分。
 */
function splitPreferBoundaries(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const result: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.includes("```")) {
      result.push(...splitCodeAware(paragraph));
    } else {
      result.push(paragraph);
    }
  }
  return result.filter((part) => part.length > 0);
}

/**
 * 粗粒度代码块切分：围栏内外分开。
 */
function splitCodeAware(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf("```");
    if (start < 0) {
      parts.push(rest);
      break;
    }
    if (start > 0) {
      parts.push(rest.slice(0, start));
    }
    const end = rest.indexOf("```", start + 3);
    if (end < 0) {
      parts.push(rest.slice(start));
      break;
    }
    parts.push(rest.slice(start, end + 3));
    rest = rest.slice(end + 3);
  }
  return parts.filter((part) => part.length > 0);
}

/**
 * 硬切分并带固定 overlap。
 */
function hardSplit(text: string, hardMax: number, overlap: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(start + hardMax, chars.length);
    out.push(chars.slice(start, end).join(""));
    if (end >= chars.length) {
      break;
    }
    start = Math.max(0, end - overlap);
  }
  return out;
}

/**
 * 短碎片与前一 chunk 确定性合并。
 */
function mergeShortFragments(pieces: string[], minMerge: number, hardMax: number): string[] {
  if (pieces.length === 0) {
    return [];
  }
  const merged: string[] = [pieces[0]!];
  for (let i = 1; i < pieces.length; i += 1) {
    const current = pieces[i]!;
    const prev = merged[merged.length - 1]!;
    if (scalarLength(current) < minMerge && scalarLength(`${prev}\n\n${current}`) <= hardMax) {
      merged[merged.length - 1] = `${prev}\n\n${current}`;
    } else {
      merged.push(current);
    }
  }
  return merged;
}
