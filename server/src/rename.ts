/**
 * `textDocument/prepareRename` and `textDocument/rename` for QB64-PE.
 *
 * Wraps `core/rename.ts`: prepareRename reports the range to rename (or why it
 * cannot be renamed), and rename produces a `WorkspaceEdit` with every
 * occurrence, keeping each site's own type sigil.
 */
import type { SymbolIndex } from "./core/index.ts";
import type { Position, Range } from "./core/queries.ts";
import { resolveAt } from "./core/queries.ts";
import { renameEdits, validateNewName } from "./core/rename.ts";
import { pathToUri } from "./uri.ts";

export interface LspTextEdit {
  range: Range;
  newText: string;
}

export interface LspWorkspaceEdit {
  changes: Record<string, LspTextEdit[]>;
}

export type PrepareRenameResult =
  | { ok: true; range: Range; placeholder: string }
  | { ok: false; message: string };

export type RenameResult =
  | { ok: true; edit: LspWorkspaceEdit }
  | { ok: false; message: string };

export function buildPrepareRename(
  index: SymbolIndex,
  file: string,
  position: Position
): PrepareRenameResult {
  const resolution = resolveAt(index, file, position);
  if (!resolution) {
    return { ok: false, message: "You can only rename identifiers." };
  }
  if (!resolution.symbol) {
    return {
      ok: false,
      message: `Cannot rename '${resolution.word}': it is not a user-defined symbol.`,
    };
  }
  return { ok: true, range: resolution.range, placeholder: resolution.word };
}

export function buildRename(
  index: SymbolIndex,
  file: string,
  position: Position,
  newName: string
): RenameResult {
  const resolution = resolveAt(index, file, position);
  if (!resolution?.symbol) {
    return { ok: false, message: "No renamable symbol under the cursor." };
  }

  const problem = validateNewName(resolution.symbol, newName);
  if (problem) return { ok: false, message: problem };

  const changes: Record<string, LspTextEdit[]> = {};
  for (const e of renameEdits(index, resolution.symbol, newName.trim())) {
    const uri = pathToUri(e.file);
    (changes[uri] ??= []).push({ range: e.range, newText: e.newText });
  }
  return { ok: true, edit: { changes } };
}
