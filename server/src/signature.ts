/**
 * `textDocument/signatureHelp` for QB64-PE.
 *
 * Finds the routine call the cursor is inside — the innermost unmatched
 * `name(` outside strings, or a statement-style SUB call `name arg, arg` — and
 * describes the routine's parameters, highlighting the argument being typed.
 */
import { identifierAt, scanLine, splitStatements } from "./core/lexer.ts";
import type { SymbolIndex } from "./core/index.ts";
import type { Position } from "./core/queries.ts";
import { isRoutine, resolveName } from "./core/queries.ts";
import type { QB64Symbol } from "./core/symbols.ts";
import { parameterLabel, signatureLabel } from "./core/format.ts";

export interface LspParameterInformation {
  label: string;
  documentation?: { kind: "markdown"; value: string };
}

export interface LspSignatureInformation {
  label: string;
  documentation?: { kind: "markdown"; value: string };
  parameters: LspParameterInformation[];
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

interface CallSite {
  name: string;
  parameterIndex: number;
  /** `Show a, b` rather than `Show(a, b)` — only SUBs can be called this way. */
  isStatement: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:~?(?:%%|&&|##|[%&!#`])|\$)?$/;
const NOT_A_CALL = new Set([
  "PRINT", "INPUT", "DIM", "REDIM", "STATIC", "COMMON", "CONST", "IF", "ELSEIF",
  "WHILE", "UNTIL", "FOR", "SELECT", "CASE", "LOCATE", "COLOR", "LINE", "CIRCLE",
  "PAINT", "PSET", "PRESET", "GET", "PUT", "OPEN", "CLOSE", "WRITE", "READ", "DATA",
  "SWAP", "ERASE", "SCREEN", "SOUND", "PLAY", "GOTO", "GOSUB", "RETURN", "LET",
  "SHARED", "DECLARE", "TYPE", "SUB", "FUNCTION", "END", "EXIT", "DO", "LOOP", "NEXT",
]);

/**
 * Finds the routine call the cursor is inside: the innermost unclosed
 * `name(` outside strings, or — failing that — a statement-style SUB call
 * `name arg, arg` on the current statement.
 */
function findCallSite(text: string): CallSite | null {
  const scan = scanLine(text);
  if (scan.commentStart >= 0 && scan.commentStart < text.length) {
    return null;
  }

  // Parenthesised call: track open parens outside strings on the masked text.
  const open: number[] = [];
  const commas: number[][] = [];
  for (let i = 0; i < scan.mask.length; i++) {
    const c = scan.mask[i];
    if (c === "(") {
      open.push(i);
      commas.push([]);
    } else if (c === ")") {
      open.pop();
      commas.pop();
    } else if (c === "," && open.length > 0) {
      commas[commas.length - 1].push(i);
    }
  }
  if (open.length > 0) {
    const paren = open[open.length - 1];
    let j = paren - 1;
    while (j >= 0 && /\s/.test(scan.mask[j])) j--;
    const id = j >= 0 ? identifierAt(text, j, scan) : null;
    if (id && id.end === j + 1 && !NOT_A_CALL.has(id.word.toUpperCase())) {
      return {
        name: id.word,
        parameterIndex: commas[commas.length - 1].length,
        isStatement: false,
      };
    }
  }

  // Statement call: `Show a, b` on the last statement of the line.
  const statements = splitStatements(text, scan);
  const last = statements[statements.length - 1];
  if (!last) return null;
  const m = last.text.match(/^(?:CALL\s+)?(\S+)\s+([\s\S]*)$/i);
  if (!m || !NAME.test(m[1]) || NOT_A_CALL.has(m[1].toUpperCase())) {
    return null;
  }
  const args = scanLine(m[2]).mask;
  let depth = 0;
  let parameterIndex = 0;
  for (const c of args) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) parameterIndex++;
  }
  return { name: m[1], parameterIndex, isStatement: true };
}

function signatureOf(symbol: QB64Symbol): LspSignatureInformation {
  const parameters = symbol.parameters ?? [];
  const docParts: string[] = [];
  if (symbol.documentation) docParts.push(symbol.documentation);
  if (symbol.type === "FUNCTION" && symbol.dataType) {
    docParts.push(`**Returns** ${symbol.dataType}`);
  }

  return {
    label: signatureLabel(symbol),
    documentation:
      docParts.length > 0
        ? { kind: "markdown", value: docParts.join("\n\n") }
        : undefined,
    parameters: parameters.map((param) => ({
      label: parameterLabel(param),
      documentation: param.description
        ? { kind: "markdown", value: param.description }
        : undefined,
    })),
  };
}

export function buildSignatureHelp(
  index: SymbolIndex,
  file: string,
  position: Position
): LspSignatureHelp | null {
  const line = index.get(file)?.lines[position.line];
  if (line === undefined) return null;

  const call = findCallSite(line.substring(0, position.character));
  if (!call) return null;

  let candidates = resolveName(index, file, position.line, call.name).filter(isRoutine);
  if (call.isStatement) {
    candidates = candidates.filter((s) => s.type === "SUB");
  }
  if (candidates.length === 0) return null;

  return {
    signatures: candidates.map(signatureOf),
    activeSignature: 0,
    activeParameter: Math.max(0, call.parameterIndex),
  };
}
