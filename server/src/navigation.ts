/**
 * Navigation features that all build on the index's occurrence queries:
 * go-to-definition, find-references and document highlights.
 */
import { fileDirectiveAt } from "./core/parser.ts";
import type { SymbolIndex } from "./core/index.ts";
import type { Occurrence, Position, Range } from "./core/queries.ts";
import { findDefinition, findOccurrences, resolveAt } from "./core/queries.ts";
import { pathToUri } from "./uri.ts";

export interface LspLocation {
  uri: string;
  range: Range;
}

export interface LspDocumentHighlight {
  range: Range;
  /** LSP DocumentHighlightKind: Text=1, Read=2, Write=3. */
  kind: number;
}

/** The type of the index's `$INCLUDE` resolver. */
export type IncludeResolver = (
  fromFile: string,
  includePath: string
) => string | null;

function toLocation(occurrence: Occurrence): LspLocation {
  return { uri: pathToUri(occurrence.file), range: occurrence.range };
}

/**
 * Definition of the symbol (or `$INCLUDE`/`$EXEICON` target) at `position`.
 * Returns null when there is nothing to jump to.
 */
export function buildDefinition(
  index: SymbolIndex,
  file: string,
  position: Position,
  resolveInclude: IncludeResolver
): LspLocation[] | null {
  const line = index.get(file)?.lines[position.line];
  if (line === undefined) return null;

  // `'$INCLUDE:'file.bi'` and `$EXEICON:'file.ico'` jump to the file itself.
  const directive = fileDirectiveAt(line);
  if (directive) {
    const target = resolveInclude(file, directive.path);
    if (!target) return null;
    const start = { line: 0, character: 0 };
    return [{ uri: pathToUri(target), range: { start, end: start } }];
  }

  // Everything else is a symbol: scope, includes and members are resolved by
  // the index, which returns the exact range of the declaring name.
  const definitions = findDefinition(index, file, position);
  return definitions.length > 0 ? definitions.map(toLocation) : null;
}

/** Every occurrence of the symbol at `position` across the compilation unit. */
export function buildReferences(
  index: SymbolIndex,
  file: string,
  position: Position,
  includeDeclaration: boolean
): LspLocation[] | null {
  const resolution = resolveAt(index, file, position);
  if (!resolution?.symbol) return null;
  return findOccurrences(index, resolution.symbol, includeDeclaration).map(toLocation);
}

/** Every occurrence of the symbol at `position` within this file only. */
export function buildDocumentHighlights(
  index: SymbolIndex,
  file: string,
  position: Position
): LspDocumentHighlight[] | null {
  const resolution = resolveAt(index, file, position);
  if (!resolution?.symbol) return null;
  return findOccurrences(index, resolution.symbol, true, [file]).map((o) => ({
    range: o.range,
    kind: o.kind === "read" ? 2 : 3,
  }));
}
