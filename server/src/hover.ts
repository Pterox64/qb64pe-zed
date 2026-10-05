/**
 * `textDocument/hover` for QB64-PE.
 *
 * Two sources, mirroring the reference VS Code extension's hover provider:
 *  1. user-defined symbols resolved through the index (scope-aware), rendered
 *     with `core/format.ts`'s `symbolMarkdown`;
 *  2. built-in keyword help, converted from the installed QB64PE wiki when a
 *     help directory is available, else a short built-in description.
 */
import { identifierAt } from "./core/lexer.ts";
import type { SymbolIndex } from "./core/index.ts";
import type { Position } from "./core/queries.ts";
import { resolveAt } from "./core/queries.ts";
import { symbolMarkdown } from "./core/format.ts";
import { classifyKeyword, keywordLabel } from "./keywordInfo.ts";
import type { HelpService } from "./help.ts";

export interface LspRange {
  start: Position;
  end: Position;
}

export interface Hover {
  contents: { kind: "markdown"; value: string };
  range?: LspRange;
}

function fallbackMarkdown(word: string, label: string): string {
  return (
    "```QB64PE\n" + word + "\n```\n\n" +
    `*QB64-PE ${label} — see the QB64-PE wiki for details.*`
  );
}

export function buildHover(
  index: SymbolIndex,
  file: string,
  position: Position,
  help: HelpService | null
): Hover | null {
  const line = index.get(file)?.lines[position.line];
  if (line === undefined) return null;

  // 1. User-defined symbols win: the index knows scope, includes and members.
  const resolution = resolveAt(index, file, position);
  if (resolution?.symbol) {
    return {
      contents: { kind: "markdown", value: symbolMarkdown(resolution.symbol) },
      range: resolution.range,
    };
  }

  // 2. Built-in keyword help (and metacommands like `$CONSOLE`).
  const id = identifierAt(line, position.character);
  if (!id) return null;
  const cls = classifyKeyword(id.word);
  if (!cls) return null;

  const helpMarkdown = help?.getHoverHelp(id.word) ?? null;
  return {
    contents: {
      kind: "markdown",
      value: helpMarkdown ?? fallbackMarkdown(id.word, keywordLabel(cls)),
    },
    range: {
      start: { line: position.line, character: id.start },
      end: { line: position.line, character: id.end },
    },
  };
}
