/**
 * `textDocument/completion` for QB64-PE.
 *
 * Three modes, mirroring the reference VS Code extension:
 *  1. member completion right after `owner.` — the owner TYPE's fields;
 *  2. metacommand completion when the prefix is `$…`;
 *  3. everything visible at the cursor: symbols in scope (locals/parameters
 *     first, then the file, its includes and the rest of the compilation unit),
 *     then the built-in keywords.
 */
import { KEYWORDS } from "./core/keywords.ts";
import type { SymbolIndex } from "./core/index.ts";
import type { Position } from "./core/queries.ts";
import { memberContextAt, symbolsInScope } from "./core/queries.ts";
import type { QB64Symbol } from "./core/symbols.ts";
import { kindLabel, signatureLabel, symbolMarkdown } from "./core/format.ts";
import type { KeywordClass } from "./keywordInfo.ts";
import { classifyKeyword, keywordLabel } from "./keywordInfo.ts";

/** LSP `CompletionItemKind` values used below. */
const KIND = {
  Method: 2,
  Function: 3,
  Field: 5,
  Variable: 6,
  Keyword: 14,
  Constant: 21,
  Struct: 22,
} as const;

/** LSP `InsertTextFormat`. */
const PLAIN = 1;
const SNIPPET = 2;

interface CompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: { kind: "markdown"; value: string };
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  filterText?: string;
  textEdit?: { range: { start: Position; end: Position }; newText: string };
}

interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

/** Sort key so user symbols outrank built-ins, and nearer scopes win. */
function scopeSort(symbol: QB64Symbol): string {
  const tier =
    symbol.scope === "LOCAL" ? "0" : symbol.scope === "MODULE" ? "1" : "2";
  return `${tier}_${symbol.name}`;
}

/** Snippet that fills a routine's parameters as linked tab stops. */
function routineSnippet(symbol: QB64Symbol): string | undefined {
  const params = symbol.parameters ?? [];
  if (params.length === 0) return undefined;
  const body = params.map((p, i) => `\${${i + 1}:${p.name}}`).join(", ");
  return `${symbol.name}(${body})`;
}

function symbolItem(symbol: QB64Symbol, sortText?: string): CompletionItem | null {
  const base = {
    label: symbol.name,
    documentation: { kind: "markdown" as const, value: symbolMarkdown(symbol) },
    sortText: sortText ?? scopeSort(symbol),
  };

  switch (symbol.type) {
    case "SUB":
    case "FUNCTION": {
      const insertText = routineSnippet(symbol);
      return {
        ...base,
        kind: symbol.type === "SUB" ? KIND.Method : KIND.Function,
        detail: signatureLabel(symbol),
        insertText,
        insertTextFormat: insertText ? SNIPPET : PLAIN,
      };
    }
    case "VARIABLE":
      return {
        ...base,
        kind: KIND.Variable,
        detail: `${symbol.dataType || "SINGLE"} (${kindLabel(symbol)}${
          symbol.isArray ? ", array" : ""
        })`,
      };
    case "TYPE":
      return { ...base, kind: KIND.Struct, detail: "User-defined type" };
    case "CONST":
      return {
        ...base,
        kind: KIND.Constant,
        detail: symbol.value
          ? `CONST ${symbol.name} = ${symbol.value}`
          : "User-defined constant",
      };
    case "FIELD":
      return {
        ...base,
        kind: KIND.Field,
        detail: `${symbol.dataType ?? ""}${symbol.isArray ? "()" : ""} (field of ${
          symbol.parent ?? "?"
        })`.trim(),
      };
    default:
      return null; // labels are not offered as completions
  }
}

function keywordItem(keyword: string, cls: KeywordClass): CompletionItem {
  return {
    label: keyword,
    kind: cls === "function" ? KIND.Function : KIND.Keyword,
    detail: `QB64-PE ${keywordLabel(cls)}`,
    sortText: `5_${keyword}`,
  };
}

export function buildCompletions(
  index: SymbolIndex,
  file: string,
  position: Position
): CompletionList {
  // 1. `owner.` — only the owner TYPE's fields, in declaration order.
  const member = memberContextAt(index, file, position);
  if (member) {
    const prefix = member.prefix.toLowerCase();
    const items: CompletionItem[] = [];
    member.members
      .filter((f) => f.name.toLowerCase().startsWith(prefix))
      .forEach((f, i) => {
        const item = symbolItem(f, String(i).padStart(3, "0"));
        if (item) items.push(item);
      });
    return { isIncomplete: false, items };
  }

  // 2. `$` at a statement position completes metacommands. Give each item a
  // textEdit that swallows the typed `$…`, so the client matches on the whole
  // token instead of the bare word after `$`.
  const line = index.get(file)?.lines[position.line] ?? "";
  const before = line.substring(0, position.character);
  const meta = /(?:^|:|'|\bREM\s)\s*(\$[A-Za-z]*)$/i.exec(before);
  if (meta) {
    const range = {
      start: { line: position.line, character: position.character - meta[1].length },
      end: { line: position.line, character: position.character },
    };
    return {
      isIncomplete: false,
      items: KEYWORDS.filter((k) => k.startsWith("$")).map((k) => ({
        label: k,
        kind: KIND.Keyword,
        detail: "QB64-PE metacommand",
        sortText: k,
        filterText: k,
        textEdit: { range, newText: k },
      })),
    };
  }

  // 3. Visible symbols first (so same-named built-ins are de-duplicated away),
  // then every built-in keyword. The list is complete: the client filters.
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const push = (item: CompletionItem | null) => {
    if (!item) return;
    const key = item.label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const symbol of symbolsInScope(index, file, position.line)) {
    push(symbolItem(symbol));
  }
  for (const keyword of KEYWORDS) {
    const cls = classifyKeyword(keyword);
    if (cls) push(keywordItem(keyword, cls));
  }

  return { isIncomplete: false, items };
}
