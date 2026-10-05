/**
 * QB64-PE language server (Stage 1).
 *
 * Speaks LSP over stdio using JSON-RPC 2.0 with `Content-Length` framing, and
 * implements:
 *
 *   initialize / initialized / shutdown / exit
 *   textDocument/didOpen · didChange · didClose
 *   textDocument/documentSymbol            (hierarchical outline)
 *   textDocument/foldingRange              (block-aware folding)
 *   textDocument/publishDiagnostics        (live linting)
 *
 * Diagnostics and folding reuse the reference VS Code extension's `vscode`-free
 * `core/` modules (vendored under `src/core/`), driven by a workspace
 * `SymbolIndex` that follows the `$INCLUDE` graph.
 *
 * Deliberately dependency-free (no `vscode-languageserver`), so the server runs
 * straight from the vendored `core/` modules under Node's TypeScript
 * type-stripping: `node src/server.ts --stdio`.
 */
import { buildDocumentSymbols } from "./documentSymbols.ts";
import { foldingRanges } from "./core/folding.ts";
import {
  SymbolIndex,
  createIncludeResolver,
  diskLoader,
} from "./core/index.ts";
import { diagnose } from "./core/diagnostics.ts";
import type { Diagnostic as CoreDiagnostic } from "./core/diagnostics.ts";
import { buildHover } from "./hover.ts";
import { buildCompletions } from "./completion.ts";
import { HelpService } from "./help.ts";
import type { IncludeResolver } from "./navigation.ts";
import {
  buildDefinition,
  buildDocumentHighlights,
  buildReferences,
} from "./navigation.ts";
import { buildWorkspaceSymbols } from "./workspaceSymbols.ts";
import { buildPrepareRename, buildRename } from "./rename.ts";
import { buildSignatureHelp } from "./signature.ts";
import { indexWorkspace } from "./workspace.ts";
import { uriToPath } from "./uri.ts";
import {
  buildIncomingCalls,
  buildOutgoingCalls,
  buildPrepareCallHierarchy,
} from "./callHierarchy.ts";
import { buildColorInformations, buildColorPresentations } from "./colors.ts";
import {
  SEMANTIC_TOKENS_LEGEND,
  buildSemanticTokens,
} from "./semanticTokens.ts";
import * as path from "node:path";

const SERVER_NAME = "qb64pe-lsp";
const SERVER_VERSION = "0.5.0";

/** LSP `ErrorCodes.RequestFailed` — a user-visible failure (e.g. bad rename). */
const REQUEST_FAILED = -32803;

// ---------------------------------------------------------------------------
// JSON-RPC framing over stdio.
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class MessageBuffer {
  private buffer = Buffer.alloc(0);

  /** Feed a chunk; returns every complete message it completes. */
  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header: drop it and resync on the next boundary.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;

      const body = this.buffer
        .subarray(bodyStart, bodyStart + length)
        .toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        messages.push(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        log(`failed to parse message: ${String(error)}`);
      }
    }

    return messages;
  }
}

function log(message: string): void {
  // stderr is safe: stdout carries the protocol.
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function send(message: JsonRpcMessage): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id: JsonRpcMessage["id"], result: unknown): void {
  send({ jsonrpc: "2.0", id: id ?? null, result });
}

function sendError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Server state.
// ---------------------------------------------------------------------------

/** Open documents: URI -> current (possibly unsaved) text. */
const documents = new Map<string, string>();

/** Workspace symbol index, following `$INCLUDE` graphs. Built on `initialize`. */
let index: SymbolIndex | null = null;

/** The `$INCLUDE` resolver backing `index` (for jumping into `$INCLUDE` targets). */
let includeResolver: IncludeResolver | null = null;

/** Keyword help, converted from the installed QB64PE wiki (may be null). */
let help: HelpService | null = null;

let shutdownRequested = false;

function workspaceRootFrom(params: any): string | null {
  if (typeof params?.rootUri === "string") return uriToPath(params.rootUri);
  const folders = params?.workspaceFolders;
  if (Array.isArray(folders) && folders.length > 0 && folders[0]?.uri) {
    return uriToPath(folders[0].uri);
  }
  if (typeof params?.rootPath === "string") return params.rootPath;
  return null;
}

/** Character offset of an LSP Position in `text` (UTF-16 units, lines by `\n`). */
function positionToOffset(
  text: string,
  position: { line: number; character: number },
): number {
  let line = 0;
  let offset = 0;
  while (line < position.line) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
    line++;
  }
  return Math.min(offset + position.character, text.length);
}

/** Applies LSP content changes (incremental ranges or whole-document) in order. */
function applyContentChanges(
  text: string,
  changes: Array<{
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    text: string;
  }>,
): string {
  let result = text;
  for (const change of changes) {
    if (!change || typeof change.text !== "string") continue;
    if (!change.range) {
      result = change.text;
      continue;
    }
    const start = positionToOffset(result, change.range.start);
    const end = positionToOffset(result, change.range.end);
    result =
      result.slice(0, start) + change.text + result.slice(Math.max(start, end));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------

/** LSP `DiagnosticSeverity`: 1 error, 2 warning, 4 hint. */
function lspSeverity(severity: CoreDiagnostic["severity"]): number {
  return severity === "error" ? 1 : severity === "warning" ? 2 : 4;
}

function toLspDiagnostic(d: CoreDiagnostic) {
  return {
    range: d.range,
    severity: lspSeverity(d.severity),
    code: d.code,
    source: SERVER_NAME,
    message: d.message,
    // LSP `DiagnosticTag.Unnecessary` = 1 (faded rendering).
    tags: d.unnecessary ? [1] : undefined,
  };
}

function publishDiagnostics(uri: string): void {
  if (!index) return;
  let diagnostics: unknown[] = [];
  try {
    diagnostics = diagnose(index, uriToPath(uri)).map(toLspDiagnostic);
  } catch (error) {
    log(`diagnostics failed for ${uri}: ${String(error)}`);
  }
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/**
 * Help directories, most explicit first. Sources, in order: the LSP
 * `initializationOptions` (`helpPath`, or `installPath` + `/internal/help`),
 * then the `QB64PE_HELP_PATH` / `QB64PE_INSTALL_PATH` environment variables.
 */
function helpDirsFrom(params: any): string[] {
  const dirs: string[] = [];
  const opts = params?.initializationOptions ?? {};
  if (typeof opts.helpPath === "string") dirs.push(opts.helpPath);
  if (typeof opts.installPath === "string") {
    dirs.push(path.join(opts.installPath, "internal", "help"));
  }
  if (process.env.QB64PE_HELP_PATH) dirs.push(process.env.QB64PE_HELP_PATH);
  if (process.env.QB64PE_INSTALL_PATH) {
    dirs.push(path.join(process.env.QB64PE_INSTALL_PATH, "internal", "help"));
  }
  return [...new Set(dirs)];
}

function handleInitialize(id: JsonRpcMessage["id"], params: any): void {
  const root = workspaceRootFrom(params);
  if (root) {
    includeResolver = createIncludeResolver(() => [root]);
    index = new SymbolIndex(includeResolver, diskLoader);
    const added = indexWorkspace(index, root);
    log(`indexed ${index.size} file(s); ${added} scanned from ${root}`);
  } else {
    // No workspace root: still index opened files, resolving relative includes
    // from each file's own directory.
    includeResolver = createIncludeResolver([]);
    index = new SymbolIndex(includeResolver, diskLoader);
  }

  const helpDirs = helpDirsFrom(params);
  help = helpDirs.length > 0 ? new HelpService(helpDirs) : null;
  if (help) log(`help directories: ${helpDirs.join(", ")}`);

  sendResult(id, {
    capabilities: {
      // Incremental sync: `didChange` carries ranged edits that the server
      // applies to the tracked text (a full document is also accepted).
      textDocumentSync: 2,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: [".", "$"] },
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      workspaceSymbolProvider: true,
      callHierarchyProvider: true,
      colorProvider: true,
      semanticTokensProvider: {
        legend: SEMANTIC_TOKENS_LEGEND,
        full: true,
      },
    },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

function handleDidOpen(params: any): void {
  const doc = params?.textDocument;
  if (!doc?.uri) return;
  documents.set(doc.uri, doc.text ?? "");
  index?.setFile(uriToPath(doc.uri), doc.text ?? "");
  publishDiagnostics(doc.uri);
}

function handleDidChange(params: any): void {
  const uri = params?.textDocument?.uri;
  if (!uri) return;
  const changes = params?.contentChanges;
  if (Array.isArray(changes) && changes.length > 0) {
    const previous = documents.get(uri) ?? "";
    const text = applyContentChanges(previous, changes);
    documents.set(uri, text);
    index?.setFile(uriToPath(uri), text);
    publishDiagnostics(uri);
  }
}

function handleDidClose(params: any): void {
  const uri = params?.textDocument?.uri;
  if (!uri) return;
  documents.delete(uri);
  // Fall back to the on-disk content, or drop the file from the index.
  const path = uriToPath(uri);
  const content = diskLoader(path);
  if (content !== null) index?.setFile(path, content);
  else index?.removeFile(path);
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: [] },
  });
}

function handleDocumentSymbol(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const text = uri !== undefined ? documents.get(uri) : undefined;
  if (text === undefined) {
    sendResult(id, []);
    return;
  }
  try {
    sendResult(id, buildDocumentSymbols(text, uriToPath(uri)));
  } catch (error) {
    log(`documentSymbol failed: ${String(error)}`);
    sendResult(id, []);
  }
}

function handleFoldingRange(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const text = uri !== undefined ? documents.get(uri) : undefined;
  if (text === undefined) {
    sendResult(id, []);
    return;
  }
  try {
    sendResult(id, foldingRanges(text.split(/\r?\n/)));
  } catch (error) {
    log(`foldingRange failed: ${String(error)}`);
    sendResult(id, []);
  }
}

function handleHover(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || uri === undefined || !position) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(id, buildHover(index, uriToPath(uri), position, help));
  } catch (error) {
    log(`hover failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleCompletion(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || uri === undefined || !position) {
    sendResult(id, { isIncomplete: false, items: [] });
    return;
  }
  try {
    sendResult(id, buildCompletions(index, uriToPath(uri), position));
  } catch (error) {
    log(`completion failed: ${String(error)}`);
    sendResult(id, { isIncomplete: false, items: [] });
  }
}

function handleDefinition(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || !includeResolver || uri === undefined || !position) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(
      id,
      buildDefinition(index, uriToPath(uri), position, includeResolver),
    );
  } catch (error) {
    log(`definition failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleReferences(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  const includeDeclaration = params?.context?.includeDeclaration !== false;
  if (!index || uri === undefined || !position) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(
      id,
      buildReferences(index, uriToPath(uri), position, includeDeclaration),
    );
  } catch (error) {
    log(`references failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleDocumentHighlight(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || uri === undefined || !position) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(id, buildDocumentHighlights(index, uriToPath(uri), position));
  } catch (error) {
    log(`documentHighlight failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handlePrepareRename(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || uri === undefined || !position) {
    sendError(id, REQUEST_FAILED, "No symbol to rename.");
    return;
  }
  try {
    const result = buildPrepareRename(index, uriToPath(uri), position);
    if (result.ok) {
      sendResult(id, { range: result.range, placeholder: result.placeholder });
    } else {
      sendError(id, REQUEST_FAILED, result.message);
    }
  } catch (error) {
    log(`prepareRename failed: ${String(error)}`);
    sendError(id, REQUEST_FAILED, "Rename is not available here.");
  }
}

function handleRename(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  const newName = typeof params?.newName === "string" ? params.newName : "";
  if (!index || uri === undefined || !position) {
    sendError(id, REQUEST_FAILED, "No symbol to rename.");
    return;
  }
  try {
    const result = buildRename(index, uriToPath(uri), position, newName);
    if (result.ok) {
      sendResult(id, result.edit);
    } else {
      sendError(id, REQUEST_FAILED, result.message);
    }
  } catch (error) {
    log(`rename failed: ${String(error)}`);
    sendError(id, REQUEST_FAILED, "Rename failed.");
  }
}

function handleSignatureHelp(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || uri === undefined || !position) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(id, buildSignatureHelp(index, uriToPath(uri), position));
  } catch (error) {
    log(`signatureHelp failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleWorkspaceSymbol(id: JsonRpcMessage["id"], params: any): void {
  if (!index) {
    sendResult(id, []);
    return;
  }
  try {
    const query = typeof params?.query === "string" ? params.query : "";
    sendResult(id, buildWorkspaceSymbols(index, query));
  } catch (error) {
    log(`workspace/symbol failed: ${String(error)}`);
    sendResult(id, []);
  }
}

function handlePrepareCallHierarchy(
  id: JsonRpcMessage["id"],
  params: any,
): void {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!index || uri === undefined || !position) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(id, buildPrepareCallHierarchy(index, uriToPath(uri), position));
  } catch (error) {
    log(`prepareCallHierarchy failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleIncomingCalls(id: JsonRpcMessage["id"], params: any): void {
  if (!index) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(id, buildIncomingCalls(index, params?.item));
  } catch (error) {
    log(`incomingCalls failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleOutgoingCalls(id: JsonRpcMessage["id"], params: any): void {
  if (!index) {
    sendResult(id, null);
    return;
  }
  try {
    sendResult(id, buildOutgoingCalls(index, params?.item));
  } catch (error) {
    log(`outgoingCalls failed: ${String(error)}`);
    sendResult(id, null);
  }
}

function handleDocumentColor(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const text = uri !== undefined ? documents.get(uri) : undefined;
  if (text === undefined) {
    sendResult(id, []);
    return;
  }
  try {
    sendResult(id, buildColorInformations(text));
  } catch (error) {
    log(`documentColor failed: ${String(error)}`);
    sendResult(id, []);
  }
}

function handleColorPresentation(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  const text = uri !== undefined ? documents.get(uri) : undefined;
  if (text === undefined || !params?.range || !params?.color) {
    sendResult(id, []);
    return;
  }
  try {
    sendResult(id, buildColorPresentations(text, params.range, params.color));
  } catch (error) {
    log(`colorPresentation failed: ${String(error)}`);
    sendResult(id, []);
  }
}

function handleSemanticTokens(id: JsonRpcMessage["id"], params: any): void {
  const uri = params?.textDocument?.uri;
  if (!index || uri === undefined) {
    sendResult(id, { data: [] });
    return;
  }
  try {
    sendResult(id, buildSemanticTokens(index, uriToPath(uri)));
  } catch (error) {
    log(`semanticTokens failed: ${String(error)}`);
    sendResult(id, { data: [] });
  }
}

function dispatch(message: JsonRpcMessage): void {
  const { method } = message;

  if (method === undefined) return; // a response to a server-initiated request

  switch (method) {
    case "initialize":
      handleInitialize(message.id, message.params);
      return;
    case "initialized":
      return;
    case "shutdown":
      shutdownRequested = true;
      sendResult(message.id, null);
      return;
    case "exit":
      process.exit(shutdownRequested ? 0 : 1);
      return;
    case "textDocument/didOpen":
      handleDidOpen(message.params);
      return;
    case "textDocument/didChange":
      handleDidChange(message.params);
      return;
    case "textDocument/didClose":
      handleDidClose(message.params);
      return;
    case "textDocument/documentSymbol":
      handleDocumentSymbol(message.id, message.params);
      return;
    case "textDocument/foldingRange":
      handleFoldingRange(message.id, message.params);
      return;
    case "textDocument/hover":
      handleHover(message.id, message.params);
      return;
    case "textDocument/completion":
      handleCompletion(message.id, message.params);
      return;
    case "textDocument/definition":
      handleDefinition(message.id, message.params);
      return;
    case "textDocument/references":
      handleReferences(message.id, message.params);
      return;
    case "textDocument/documentHighlight":
      handleDocumentHighlight(message.id, message.params);
      return;
    case "textDocument/prepareRename":
      handlePrepareRename(message.id, message.params);
      return;
    case "textDocument/rename":
      handleRename(message.id, message.params);
      return;
    case "textDocument/signatureHelp":
      handleSignatureHelp(message.id, message.params);
      return;
    case "workspace/symbol":
      handleWorkspaceSymbol(message.id, message.params);
      return;
    case "textDocument/prepareCallHierarchy":
      handlePrepareCallHierarchy(message.id, message.params);
      return;
    case "callHierarchy/incomingCalls":
      handleIncomingCalls(message.id, message.params);
      return;
    case "callHierarchy/outgoingCalls":
      handleOutgoingCalls(message.id, message.params);
      return;
    case "textDocument/documentColor":
      handleDocumentColor(message.id, message.params);
      return;
    case "textDocument/colorPresentation":
      handleColorPresentation(message.id, message.params);
      return;
    case "textDocument/semanticTokens/full":
      handleSemanticTokens(message.id, message.params);
      return;
    // Notifications we can safely ignore.
    case "$/cancelRequest":
    case "$/setTrace":
    case "workspace/didChangeConfiguration":
    case "workspace/didChangeWatchedFiles":
      return;
    default:
      if (message.id !== undefined) {
        sendError(message.id, -32601, `method not found: ${method}`);
      }
  }
}

export function runServer(): void {
  const reader = new MessageBuffer();

  process.stdin.on("data", (chunk: Buffer) => {
    for (const message of reader.push(chunk)) dispatch(message);
  });

  process.stdin.on("end", () => process.exit(0));

  log(`started (pid ${process.pid}); waiting for initialize`);
}

runServer();
