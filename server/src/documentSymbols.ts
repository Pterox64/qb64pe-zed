/**
 * Maps QB64-PE source to a hierarchical `DocumentSymbol[]` for the LSP
 * `textDocument/documentSymbol` request.
 *
 * This is the spike-level replacement for the reference extension's
 * `core/outline.ts`. It intentionally depends only on the vendored
 * `core/parser.ts` + `core/lexer.ts` (no workspace index / queries layer), so
 * it stays small while producing the same shape of outline: routines with
 * their parameters and locals nested, TYPEs with their fields, and `$INCLUDE`
 * directives plus named labels at the top level.
 */
import { parseFile, stripSigil } from "./core/parser.ts";
import type { QB64Symbol } from "./core/symbols.ts";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  /** Standard LSP SymbolKind values. */
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

/** LSP `SymbolKind` values used below. */
const KIND = {
  MODULE: 2,
  NAMESPACE: 3,
  FIELD: 8,
  FUNCTION: 12,
  VARIABLE: 13,
  CONSTANT: 14,
  METHOD: 6,
  KEY: 20,
  STRUCT: 23,
  TYPE_PARAMETER: 26,
} as const;

function lineLength(lines: string[], line: number): number {
  return lines[line]?.length ?? 0;
}

function lineRange(lines: string[], line: number): Range {
  return {
    start: { line, character: 0 },
    end: { line, character: lineLength(lines, line) },
  };
}

/**
 * Range of `name` on `line`, falling back to the whole line. The parser only
 * records the line, so the column is recovered by locating the identifier
 * (word-bounded, case-insensitive) in the source line.
 */
function nameRange(lines: string[], line: number, name: string): Range {
  const text = lines[line] ?? "";
  const bare = stripSigil(name);
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${escaped}(?:~?(?:%%|&&|##|[%&!#\`])|\\$)?`, "i").exec(
    text
  );
  if (!m) return lineRange(lines, line);
  return {
    start: { line, character: m.index },
    end: { line, character: m.index + m[0].length },
  };
}

/** Column range of a parameter name inside a routine header line. */
function parameterSymbolRange(
  lines: string[],
  routine: QB64Symbol,
  paramName: string
): Range {
  return nameRange(lines, routine.line, paramName);
}

function isRoutine(s: QB64Symbol): boolean {
  return s.type === "SUB" || s.type === "FUNCTION";
}

function routineDetail(s: QB64Symbol): string {
  const params = (s.parameters ?? [])
    .map(
      (p) =>
        `${p.byRef === false ? "BYVAL " : ""}${p.name}${p.isArray ? "()" : ""}${
          p.type ? ` AS ${p.type}` : ""
        }`
    )
    .join(", ");
  const head = `${s.type}${s.isStatic ? " STATIC" : ""}`;
  const list = params ? `(${params})` : "";
  const ret = s.type === "FUNCTION" && s.dataType ? ` → ${s.dataType}` : "";
  const ext = s.isExternal
    ? `DECLARE LIBRARY${s.library ? ` "${s.library}"` : ""}`
    : "";
  return [head + list + ret, ext].filter(Boolean).join("  ");
}

function variableDetail(s: QB64Symbol): string {
  if (s.type === "CONST") return s.value !== undefined ? `= ${s.value}` : "CONST";
  const parts: string[] = [];
  if (s.dataType) parts.push(s.dataType);
  if (s.isArray) parts.push("()");
  if (s.isShared) parts.push("SHARED");
  if (s.isImplicit) parts.push("(implicit)");
  return parts.join(" ").replace(/ \(\)/, "()");
}

function fieldDetail(f: QB64Symbol): string {
  return `${f.dataType ?? ""}${f.isArray ? "()" : ""}`.trim();
}

export function buildDocumentSymbols(
  content: string,
  filePath: string
): DocumentSymbol[] {
  const lines = content.split(/\r?\n/);
  const { symbols, includes } = parseFile(content, filePath);

  const nodes: DocumentSymbol[] = [];
  const routines: { symbol: QB64Symbol; node: DocumentSymbol }[] = [];

  for (const include of includes) {
    nodes.push({
      name: include.path,
      detail: "$INCLUDE",
      kind: KIND.NAMESPACE,
      range: lineRange(lines, include.line),
      selectionRange: lineRange(lines, include.line),
    });
  }

  for (const s of symbols) {
    if (isRoutine(s)) {
      const end = s.isExternal ? s.line : s.endLine ?? s.line;
      const node: DocumentSymbol = {
        name: s.name,
        detail: routineDetail(s),
        kind: s.type === "SUB" ? KIND.METHOD : KIND.FUNCTION,
        range: {
          start: { line: s.line, character: 0 },
          end: { line: end, character: lineLength(lines, end) },
        },
        selectionRange: nameRange(lines, s.line, s.name),
        children: [],
      };

      if (!s.isExternal) {
        for (const p of s.parameters ?? []) {
          const range = parameterSymbolRange(lines, s, p.name);
          node.children!.push({
            name: p.name,
            detail: `${p.byRef === false ? "BYVAL " : ""}${p.type ?? ""}`.trim(),
            kind: KIND.TYPE_PARAMETER,
            range,
            selectionRange: range,
          });
        }
        routines.push({ symbol: s, node });
      }
      nodes.push(node);
      continue;
    }

    if (s.type === "TYPE") {
      nodes.push({
        name: s.name,
        detail: "TYPE",
        kind: KIND.STRUCT,
        range: {
          start: { line: s.line, character: 0 },
          end: {
            line: s.endLine ?? s.line,
            character: lineLength(lines, s.endLine ?? s.line),
          },
        },
        selectionRange: nameRange(lines, s.line, s.name),
        children: (s.members ?? []).map((f) => ({
          name: f.name,
          detail: fieldDetail(f),
          kind: KIND.FIELD,
          range: lineRange(lines, f.line),
          selectionRange: nameRange(lines, f.line, f.name),
        })),
      });
      continue;
    }

    if (s.type === "LABEL") {
      if (/^\d+$/.test(s.name)) continue; // line numbers would flood the outline
      nodes.push({
        name: s.name,
        detail: "label",
        kind: KIND.KEY,
        range: lineRange(lines, s.line),
        selectionRange: nameRange(lines, s.line, s.name),
      });
      continue;
    }

    if (s.type === "CONST" || s.type === "VARIABLE") {
      const node: DocumentSymbol = {
        name: s.name,
        detail: variableDetail(s),
        kind: s.type === "CONST" ? KIND.CONSTANT : KIND.VARIABLE,
        range: lineRange(lines, s.line),
        selectionRange: nameRange(lines, s.line, s.name),
      };
      const owner =
        s.scope === "LOCAL"
          ? routines.find(
              (r) =>
                r.symbol.line <= s.line &&
                s.line <= (r.symbol.endLine ?? r.symbol.line)
            )
          : undefined;
      if (owner) {
        owner.node.children!.push(node);
      } else {
        nodes.push(node);
      }
    }
  }

  const byLine = (a: DocumentSymbol, b: DocumentSymbol) =>
    a.range.start.line - b.range.start.line ||
    a.selectionRange.start.character - b.selectionRange.start.character;
  nodes.sort(byLine);
  for (const n of nodes) n.children?.sort(byLine);
  return nodes;
}
