/**
 * `textDocument/semanticTokens/full`, wrapping `core/semantic.ts`.
 *
 * Zed merges these with tree-sitter highlighting when the user sets
 * `"semantic_tokens": "combined"`. The legend uses only standard LSP token
 * types and modifiers, so no `semantic_token_rules.json` is needed.
 */
import type { SymbolIndex } from "./core/index.ts";
import {
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
  semanticTokens,
} from "./core/semantic.ts";

export const SEMANTIC_TOKENS_LEGEND = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS],
};

export interface LspSemanticTokens {
  /** Delta-encoded: [deltaLine, deltaStart, length, tokenType, tokenModifiers]. */
  data: number[];
}

export function buildSemanticTokens(
  index: SymbolIndex,
  file: string
): LspSemanticTokens {
  const tokens = semanticTokens(index, file)
    .slice()
    .sort((a, b) => a.line - b.line || a.start - b.start);

  const typeIndex = new Map(TOKEN_TYPES.map((t, i) => [t, i] as const));
  const modIndex = new Map(TOKEN_MODIFIERS.map((m, i) => [m, i] as const));

  const data: number[] = [];
  let prevLine = 0;
  let prevStart = 0;
  for (const t of tokens) {
    const deltaLine = t.line - prevLine;
    const deltaStart = deltaLine === 0 ? t.start - prevStart : t.start;
    let mask = 0;
    for (const m of t.modifiers) {
      const i = modIndex.get(m);
      if (i !== undefined) mask |= 1 << i;
    }
    data.push(deltaLine, deltaStart, t.length, typeIndex.get(t.type) ?? 0, mask);
    prevLine = t.line;
    prevStart = t.start;
  }
  return { data };
}
