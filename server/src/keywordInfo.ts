/**
 * Classification of QB64-PE built-in names, for hover and completion.
 *
 * A small helper layered on top of `core/keywords.ts` (which answers "is this a
 * built-in?"). This adds the coarser bucket used to pick an icon/label:
 * function / statement / metacommand / data type / built-in.
 */
import { isKeyword } from "./core/keywords.ts";

export type KeywordClass =
  | "function"
  | "statement"
  | "metacommand"
  | "type"
  | "builtin";

const TYPE_KEYWORDS = new Set([
  "ANY", "BYTE", "WORD", "INTEGER", "LONG", "SINGLE", "DOUBLE", "STRING",
  "UNSIGNED", "INTEGER64", "CUSTOMTYPE",
  "_BYTE", "_WORD", "_INTEGER", "_INTEGER64", "_UNSIGNED", "_UNSIGNED64",
  "_FLOAT", "_OFFSET", "_MEM",
]);

/** Value-returning built-ins (from the reference extension's completion list). */
const FUNCTION_KEYWORDS = new Set([
  "ABS", "ASC", "ACOS", "ACOSH", "ASIN", "ASINH", "ATAN2", "ATANH", "ATN",
  "CHR$", "COS", "COSH", "SIN", "SINH", "TAN", "TANH", "SQR", "INT", "FIX",
  "RND", "VAL", "STR$", "LEFT$", "RIGHT$", "MID$", "LEN", "INSTR", "UCASE$",
  "LCASE$", "TRIM$", "LTRIM$", "RTRIM$", "SPACE$", "STRING$", "HEX$", "OCT$",
  "BIN$", "RGB", "RGB32", "RED", "GREEN", "BLUE", "ALPHA", "POINT", "PEEK",
  "INP", "LOC", "LOF", "EOF", "INKEY$", "INPUT$", "TIMER", "DATE$", "TIME$",
  "SCREEN", "CSRLIN", "POS", "LPOS", "FREEFILE", "ERR", "ERL", "ENVIRON$",
  "COMMAND$", "DIR$", "CURDIR$", "CWD$", "VARPTR", "VARSEG", "FRE",
]);

/** Statement built-ins (from the reference extension's completion list). */
const STATEMENT_KEYWORDS = new Set([
  "PRINT", "INPUT", "DIM", "FOR", "NEXT", "IF", "THEN", "ELSE", "ELSEIF",
  "END", "SUB", "FUNCTION", "CALL", "GOSUB", "GOTO", "RETURN", "DO", "LOOP",
  "WHILE", "WEND", "SELECT", "CASE", "EXIT", "STOP", "RUN", "CHAIN", "SYSTEM",
  "CLS", "LOCATE", "COLOR", "PSET", "LINE", "CIRCLE", "PAINT", "GET", "PUT",
  "LOAD", "SAVE", "OPEN", "CLOSE", "READ", "WRITE", "DATA", "RESTORE", "ON",
  "RESUME", "ERROR", "DEF", "DECLARE", "SHARED", "STATIC", "CONST", "TYPE",
  "REDIM",
]);

/**
 * The bucket a built-in belongs to, or null when `word` is not a built-in.
 * `_`-prefixed and `$`-suffixed names default to functions; everything else
 * recognised but unlisted is a generic built-in.
 */
export function classifyKeyword(word: string): KeywordClass | null {
  if (!isKeyword(word)) return null;
  if (word.startsWith("$")) return "metacommand";
  const bare = word.replace(/[$%&!#`]+$/, "");
  const upper = bare.toUpperCase();
  if (TYPE_KEYWORDS.has(upper)) return "type";
  if (FUNCTION_KEYWORDS.has(upper)) return "function";
  if (STATEMENT_KEYWORDS.has(upper)) return "statement";
  if (word.startsWith("_") || /\$$/.test(word)) return "function";
  return "builtin";
}

/** Human-readable label for a bucket. */
export function keywordLabel(cls: KeywordClass): string {
  switch (cls) {
    case "function":
      return "built-in function";
    case "statement":
      return "statement";
    case "metacommand":
      return "metacommand";
    case "type":
      return "data type";
    case "builtin":
      return "built-in";
  }
}
