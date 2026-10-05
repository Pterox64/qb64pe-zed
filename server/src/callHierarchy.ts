/**
 * `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls` and
 * `callHierarchy/outgoingCalls`, wrapping `core/callHierarchy.ts`.
 *
 * An internal `CallItem` rides along in the LSP item's `data`, so the client's
 * echo of the item round-trips without re-resolving; a foreign item is
 * reconstructed from its `uri`/`kind`/ranges.
 */
import type { SymbolIndex } from "./core/index.ts";
import type { Position, Range } from "./core/queries.ts";
import type { CallItem } from "./core/callHierarchy.ts";
import {
  callHierarchyItemAt,
  incomingCalls,
  outgoingCalls,
} from "./core/callHierarchy.ts";
import { pathToUri, uriToPath } from "./uri.ts";

/** LSP `SymbolKind`: Module=2, Method=6, Function=12. */
const KIND: Record<CallItem["kind"], number> = {
  sub: 6,
  function: 12,
  module: 2,
};

export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  /** Internal item, echoed back by the client (may be absent). */
  data?: CallItem;
}

export interface LspIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: Range[];
}

export interface LspOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: Range[];
}

function toLsp(item: CallItem): LspCallHierarchyItem {
  return {
    name: item.name,
    kind: KIND[item.kind],
    detail: item.detail,
    uri: pathToUri(item.file),
    range: item.range,
    selectionRange: item.selectionRange,
    data: item,
  };
}

function fromLsp(item: any): CallItem | null {
  // Prefer the item we attached; a client may strip `data`, so fall back to
  // reconstructing from the standard fields.
  if (item?.data?.file && item.data.range && item.data.selectionRange) {
    return item.data as CallItem;
  }
  if (typeof item?.uri !== "string" || !item.range || !item.selectionRange) {
    return null;
  }
  const kind: CallItem["kind"] =
    item.kind === 2 ? "module" : item.kind === 6 ? "sub" : "function";
  return {
    name: String(item.name ?? ""),
    kind,
    detail: String(item.detail ?? ""),
    file: uriToPath(item.uri),
    range: item.range,
    selectionRange: item.selectionRange,
  };
}

export function buildPrepareCallHierarchy(
  index: SymbolIndex,
  file: string,
  position: Position
): LspCallHierarchyItem[] | null {
  const item = callHierarchyItemAt(index, file, position);
  return item ? [toLsp(item)] : null;
}

export function buildIncomingCalls(
  index: SymbolIndex,
  lspItem: unknown
): LspIncomingCall[] | null {
  const item = fromLsp(lspItem);
  if (!item) return null;
  return incomingCalls(index, item).map((c) => ({
    from: toLsp(c.from),
    fromRanges: c.fromRanges,
  }));
}

export function buildOutgoingCalls(
  index: SymbolIndex,
  lspItem: unknown
): LspOutgoingCall[] | null {
  const item = fromLsp(lspItem);
  if (!item) return null;
  return outgoingCalls(index, item).map((c) => ({
    to: toLsp(c.to),
    fromRanges: c.fromRanges,
  }));
}
