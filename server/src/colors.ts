/**
 * `textDocument/documentColor` and `textDocument/colorPresentation`, wrapping
 * `core/colors.ts`.
 *
 * A `_RGB32(...)`/`_HSB(...)` call with integer-literal arguments gets an inline
 * colour chip; picking a colour rewrites the call, preserving its function name
 * and argument arity.
 */
import { findColors, formatColor } from "./core/colors.ts";
import type { Position, Range } from "./core/queries.ts";

export interface LspColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface LspColorInformation {
  range: Range;
  color: LspColor;
}

export interface LspColorPresentation {
  label: string;
  textEdit?: { range: Range; newText: string };
}

/** Character offsets at which each line starts (line i starts at starts[i]). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): Position {
  // Binary search for the last line start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

function offsetAt(starts: number[], text: string, position: Position): number {
  const line = Math.min(position.line, starts.length - 1);
  return Math.min(starts[line] + position.character, text.length);
}

export function buildColorInformations(text: string): LspColorInformation[] {
  const starts = lineStarts(text);
  return findColors(text).map((h) => ({
    range: { start: positionAt(starts, h.start), end: positionAt(starts, h.end) },
    color: { red: h.r / 255, green: h.g / 255, blue: h.b / 255, alpha: h.a / 255 },
  }));
}

export function buildColorPresentations(
  text: string,
  range: Range,
  color: LspColor
): LspColorPresentation[] {
  const starts = lineStarts(text);
  const original = text.substring(offsetAt(starts, text, range.start), offsetAt(starts, text, range.end));
  const m = /^(_(?:RGBA?|HSBA?)(?:32)?)\s*\(([^)]*)\)/i.exec(original);
  if (!m) return [];
  const func = m[1];
  const argCount = m[2].trim() === "" ? 0 : m[2].split(",").length;
  const to255 = (c: number) => Math.round(c * 255);
  const newText = formatColor(
    func,
    argCount,
    to255(color.red),
    to255(color.green),
    to255(color.blue),
    to255(color.alpha)
  );
  return [{ label: newText, textEdit: { range, newText } }];
}
