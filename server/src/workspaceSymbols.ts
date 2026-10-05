/**
 * Workspace symbol search (`workspace/symbol`, Ctrl+T): routines, TYPEs and
 * CONSTs in any indexed file whose name matches the query.
 */
import * as path from "node:path";
import type { SymbolIndex } from "./core/index.ts";
import type { QB64Symbol } from "./core/symbols.ts";
import { declarationOf, searchSymbols } from "./core/queries.ts";
import { pathToUri } from "./uri.ts";

export interface LspSymbolInformation {
  name: string;
  /** LSP SymbolKind. */
  kind: number;
  location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
  containerName?: string;
}

/** LSP `SymbolKind` values for the searchable symbol types. */
const KIND: Partial<Record<QB64Symbol["type"], number>> = {
  SUB: 6, // Method
  FUNCTION: 12, // Function
  TYPE: 23, // Struct
  CONST: 14, // Constant
};

export function buildWorkspaceSymbols(
  index: SymbolIndex,
  query: string
): LspSymbolInformation[] {
  return searchSymbols(index, query).map((s) => ({
    name: s.name,
    kind: KIND[s.type] ?? 1, // File
    location: { uri: pathToUri(s.file), range: declarationOf(index, s).range },
    containerName: path.basename(s.file),
  }));
}
