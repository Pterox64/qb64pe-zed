/**
 * Smoke test for the QB64-PE language server.
 *
 * Spawns `src/server.ts` exactly as Zed's extension would (`node … --stdio`),
 * drives a full LSP session over JSON-RPC, and asserts the `documentSymbol`
 * outline, `foldingRange` and `publishDiagnostics`. Run with:
 * `npm run smoke` inside `server/`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.ts");
const fixtures = join(here, "fixtures");
const samplePath = join(fixtures, "sample.bas");
const diagPath = join(fixtures, "diag.bas");
const metaPath = join(fixtures, "meta.bas");
const navPath = join(fixtures, "nav.bas");
const callsPath = join(fixtures, "calls.bas");
const colorsPath = join(fixtures, "colors.bas");
const incPath = join(fixtures, "inc.bas");
const sampleUri = `file://${samplePath}`;
const diagUri = `file://${diagPath}`;
const metaUri = `file://${metaPath}`;
const navUri = `file://${navPath}`;
const callsUri = `file://${callsPath}`;
const colorsUri = `file://${colorsPath}`;
const incUri = `file://${incPath}`;

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

class Reader {
  constructor(stream) {
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    stream.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      this.messages.push(
        JSON.parse(
          this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"),
        ),
      );
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
  }

  async waitFor(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error("timeout waiting for a message");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Wait for a `publishDiagnostics` notification for `uri` after `mark`. */
  async waitForDiagnostics(uri, mark, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const after = this.messages.slice(mark);
      const found = after.find(
        (m) =>
          m.method === "textDocument/publishDiagnostics" &&
          m.params?.uri === uri,
      );
      if (found) return found.params.diagnostics ?? [];
      if (Date.now() > deadline)
        throw new Error("timeout waiting for publishDiagnostics");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

const proc = spawn(process.execPath, [serverPath, "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
const reader = new Reader(proc.stdout);
const send = (message) => proc.stdin.write(frame(message));

function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

const hasRange = (ranges, start, end, kind) =>
  ranges.some(
    (r) =>
      r.startLine === start &&
      r.endLine === end &&
      (kind === undefined || r.kind === kind),
  );

try {
  console.log("initialize");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: `file://${fixtures}`,
      initializationOptions: { helpPath: join(fixtures, "help") },
      capabilities: {},
    },
  });
  const init = await reader.waitFor((m) => m.id === 1);
  check(
    "capabilities.documentSymbolProvider",
    init.result?.capabilities?.documentSymbolProvider === true,
  );
  check(
    "capabilities.foldingRangeProvider",
    init.result?.capabilities?.foldingRangeProvider === true,
  );
  check(
    "capabilities.hoverProvider",
    init.result?.capabilities?.hoverProvider === true,
  );
  check(
    "capabilities.completionProvider",
    init.result?.capabilities?.completionProvider?.triggerCharacters?.includes(
      ".",
    ) === true,
  );
  check(
    "capabilities.definitionProvider",
    init.result?.capabilities?.definitionProvider === true,
  );
  check(
    "capabilities.referencesProvider",
    init.result?.capabilities?.referencesProvider === true,
  );
  check(
    "capabilities.documentHighlightProvider",
    init.result?.capabilities?.documentHighlightProvider === true,
  );
  check(
    "capabilities.renameProvider (prepare)",
    init.result?.capabilities?.renameProvider?.prepareProvider === true,
  );
  check(
    "capabilities.signatureHelpProvider",
    init.result?.capabilities?.signatureHelpProvider?.triggerCharacters?.includes(
      "(",
    ) === true,
  );
  check(
    "capabilities.workspaceSymbolProvider",
    init.result?.capabilities?.workspaceSymbolProvider === true,
  );
  check(
    "capabilities.callHierarchyProvider",
    init.result?.capabilities?.callHierarchyProvider === true,
  );
  check(
    "capabilities.colorProvider",
    init.result?.capabilities?.colorProvider === true,
  );
  check(
    "capabilities.semanticTokensProvider (full + legend)",
    init.result?.capabilities?.semanticTokensProvider?.full === true &&
      Array.isArray(
        init.result?.capabilities?.semanticTokensProvider?.legend?.tokenTypes,
      ),
  );
  check(
    "capabilities.textDocumentSync is incremental (2)",
    init.result?.capabilities?.textDocumentSync === 2,
  );
  check("serverInfo.name", init.result?.serverInfo?.name === "qb64pe-lsp");
  check("serverInfo.version", init.result?.serverInfo?.version === "0.5.0");

  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  // ---- documentSymbol ----------------------------------------------------
  console.log("documentSymbol");
  const sampleText = readFileSync(samplePath, "utf8");
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: sampleUri,
        languageId: "qb64pe",
        version: 1,
        text: sampleText,
      },
    },
  });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/documentSymbol",
    params: { textDocument: { uri: sampleUri } },
  });

  const symbols = (await reader.waitFor((m) => m.id === 2)).result ?? [];
  const all = flatten(symbols);
  const byName = new Map(all.map((s) => [s.name, s]));

  check("$INCLUDE node present", byName.get("lib.bi")?.detail === "$INCLUDE");
  const vec = byName.get("Vec2");
  check("TYPE Vec2 is a struct (kind 23)", vec?.kind === 23);
  check(
    "Vec2 fields x,y",
    JSON.stringify((vec?.children ?? []).map((c) => c.name).sort()) ===
      JSON.stringify(["x", "y"]),
  );
  const move = byName.get("MoveX%");
  check("FUNCTION MoveX% (kind 12)", move?.kind === 12);
  check(
    "MoveX% returns INTEGER in detail",
    /→\s*INTEGER/.test(move?.detail ?? ""),
  );
  check(
    "MoveX% has parameters p,dx",
    ["p", "dx"].every((n) => (move?.children ?? []).some((c) => c.name === n)),
  );
  check("SUB Greet (kind 6)", byName.get("Greet")?.kind === 6);
  check("CONST MAX_ITEMS (kind 14)", byName.get("MAX_ITEMS")?.kind === 14);
  check("label retry (kind 20)", byName.get("retry")?.kind === 20);
  check(
    "local 'total' nested under MoveX%",
    !symbols.map((s) => s.name).includes("total") && byName.has("total"),
  );

  // ---- foldingRange ------------------------------------------------------
  console.log("foldingRange");
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/foldingRange",
    params: { textDocument: { uri: sampleUri } },
  });
  const folds = (await reader.waitFor((m) => m.id === 3)).result ?? [];
  check("TYPE Vec2 folds (3-5)", hasRange(folds, 3, 5));
  check("FUNCTION MoveX% folds (13-16)", hasRange(folds, 13, 16));
  check("SUB Greet folds (19-20)", hasRange(folds, 19, 20));
  check("doc comment block folds (10-12)", hasRange(folds, 10, 12, "comment"));

  // ---- hover -------------------------------------------------------------
  console.log("hover");
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "textDocument/hover",
    params: {
      textDocument: { uri: sampleUri },
      position: { line: 16, character: 6 }, // MoveX% return assignment
    },
  });
  const userHover = (await reader.waitFor((m) => m.id === 5)).result;
  const userHoverText = userHover?.contents?.value ?? "";
  check(
    "hover on user FUNCTION shows signature",
    /FUNCTION MoveX% \(/.test(userHoverText),
  );
  check(
    "hover on user FUNCTION shows return type",
    /\*\*Returns\*\* INTEGER/.test(userHoverText),
  );
  check("hover carries a range", userHover?.range?.start?.line === 16);

  send({
    jsonrpc: "2.0",
    id: 6,
    method: "textDocument/hover",
    params: {
      textDocument: { uri: sampleUri },
      position: { line: 24, character: 2 }, // PRINT "done"
    },
  });
  const kwHoverText =
    (await reader.waitFor((m) => m.id === 6)).result?.contents?.value ?? "";
  check(
    "hover on PRINT uses converted wiki help",
    /#\s*\[PRINT\]/.test(kwHoverText),
  );
  check(
    "help page body rendered",
    /writes text to the screen/.test(kwHoverText),
  );
  check(
    "help SYNTAX section rendered",
    /PRINT \[expression\]/.test(kwHoverText),
  );

  // ---- completion --------------------------------------------------------
  console.log("completion");
  send({
    jsonrpc: "2.0",
    id: 7,
    method: "textDocument/completion",
    params: {
      textDocument: { uri: sampleUri },
      position: { line: 15, character: 14 }, // after `p.` in `total = p.x + dx`
    },
  });
  const member = (await reader.waitFor((m) => m.id === 7)).result ?? {};
  check(
    "member completion lists Vec2 fields",
    JSON.stringify(member.items?.map((i) => i.label)) ===
      JSON.stringify(["x", "y"]),
  );
  check(
    "member items are Field kind",
    member.items?.every((i) => i.kind === 5) === true,
  );

  send({
    jsonrpc: "2.0",
    id: 8,
    method: "textDocument/completion",
    params: {
      textDocument: { uri: sampleUri },
      position: { line: 24, character: 0 },
    },
  });
  const general = (await reader.waitFor((m) => m.id === 8)).result ?? {};
  const byLabel = new Map((general.items ?? []).map((i) => [i.label, i]));
  check(
    "completion is complete (isIncomplete=false)",
    general.isIncomplete === false,
  );
  check("completion offers user FUNCTION", byLabel.get("MoveX%")?.kind === 3);
  check(
    "user FUNCTION completion carries docs",
    /FUNCTION MoveX%/.test(byLabel.get("MoveX%")?.documentation?.value ?? ""),
  );
  check("completion offers built-in PRINT", byLabel.get("PRINT")?.kind === 14);
  check("completion offers TYPE Vec2", byLabel.get("Vec2")?.kind === 22);
  check("completion offers CONST", byLabel.get("MAX_ITEMS")?.kind === 21);
  check(
    "user symbols sort before keywords",
    (byLabel.get("MoveX%")?.sortText ?? "9") <
      (byLabel.get("PRINT")?.sortText ?? "0"),
  );

  // Metacommand completion swallows the typed `$…`.
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: metaUri,
        languageId: "qb64pe",
        version: 1,
        text: readFileSync(metaPath, "utf8"),
      },
    },
  });
  send({
    jsonrpc: "2.0",
    id: 9,
    method: "textDocument/completion",
    params: {
      textDocument: { uri: metaUri },
      position: { line: 0, character: 4 }, // after `$CON`
    },
  });
  const metaItems =
    (await reader.waitFor((m) => m.id === 9)).result?.items ?? [];
  check(
    "metacommand completion lists only $ names",
    metaItems.length > 0 && metaItems.every((i) => i.label.startsWith("$")),
  );
  check(
    "metacommand completion includes $CONSOLE",
    metaItems.some((i) => i.label === "$CONSOLE"),
  );
  check(
    "metacommand textEdit swallows the typed $CON",
    metaItems[0]?.textEdit?.range?.start?.character === 0 &&
      metaItems[0]?.textEdit?.range?.end?.character === 4,
  );

  // ---- navigation --------------------------------------------------------
  // nav.bas was never opened, so these rely on the workspace scan at startup.
  console.log("navigation");
  const short = (loc) => (loc ? loc.uri.split("/").pop() : null);

  send({
    jsonrpc: "2.0",
    id: 20,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: navUri },
      position: { line: 1, character: 2 }, // `Navigator 5` call
    },
  });
  const defSub = (await reader.waitFor((m) => m.id === 20)).result;
  check(
    "definition resolves SUB call to its declaration",
    defSub?.length === 1 &&
      short(defSub[0]) === "navlib.bi" &&
      defSub[0].range.start.line === 1,
  );

  send({
    jsonrpc: "2.0",
    id: 21,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: navUri },
      position: { line: 2, character: 7 }, // NAV_VERSION
    },
  });
  const defConst = (await reader.waitFor((m) => m.id === 21)).result;
  check(
    "definition resolves CONST to its declaration",
    short(defConst?.[0]) === "navlib.bi" &&
      defConst?.[0]?.range?.start?.line === 0,
  );

  send({
    jsonrpc: "2.0",
    id: 22,
    method: "textDocument/definition",
    params: {
      textDocument: { uri: navUri },
      position: { line: 0, character: 13 }, // inside '$INCLUDE:'navlib.bi'
    },
  });
  const defInclude = (await reader.waitFor((m) => m.id === 22)).result;
  check(
    "definition jumps to the $INCLUDE target file",
    short(defInclude?.[0]) === "navlib.bi",
  );

  send({
    jsonrpc: "2.0",
    id: 23,
    method: "textDocument/references",
    params: {
      textDocument: { uri: navUri },
      position: { line: 1, character: 2 },
      context: { includeDeclaration: true },
    },
  });
  const refs = (await reader.waitFor((m) => m.id === 23)).result;
  check(
    "references include declaration and call across files",
    refs?.length === 2 &&
      refs.some((r) => short(r) === "navlib.bi") &&
      refs.some((r) => short(r) === "nav.bas"),
  );

  send({
    jsonrpc: "2.0",
    id: 24,
    method: "textDocument/references",
    params: {
      textDocument: { uri: navUri },
      position: { line: 1, character: 2 },
      context: { includeDeclaration: false },
    },
  });
  const refsNoDecl = (await reader.waitFor((m) => m.id === 24)).result;
  check(
    "references omit the declaration when asked",
    refsNoDecl?.length === 1 && short(refsNoDecl[0]) === "nav.bas",
  );

  send({
    jsonrpc: "2.0",
    id: 25,
    method: "textDocument/documentHighlight",
    params: {
      textDocument: { uri: navUri },
      position: { line: 4, character: 0 }, // `counter = counter + 1`
    },
  });
  const highlights = (await reader.waitFor((m) => m.id === 25)).result;
  check(
    "documentHighlight marks declaration + write + read",
    highlights?.length === 3 &&
      highlights.filter((h) => h.kind === 2).length === 1 &&
      highlights.filter((h) => h.kind === 3).length === 2,
  );

  send({
    jsonrpc: "2.0",
    id: 26,
    method: "textDocument/prepareRename",
    params: {
      textDocument: { uri: navUri },
      position: { line: 1, character: 2 },
    },
  });
  const prepared = (await reader.waitFor((m) => m.id === 26)).result;
  check(
    "prepareRename returns the word and its range",
    prepared?.placeholder === "Navigator" &&
      prepared?.range?.start?.character === 0 &&
      prepared?.range?.end?.character === 9,
  );

  send({
    jsonrpc: "2.0",
    id: 27,
    method: "textDocument/rename",
    params: {
      textDocument: { uri: navUri },
      position: { line: 1, character: 2 },
      newName: "NavFn",
    },
  });
  const renameEdit = (await reader.waitFor((m) => m.id === 27)).result;
  const renameUris = Object.keys(renameEdit?.changes ?? {});
  const renameEditsCount = Object.values(renameEdit?.changes ?? {}).flat()
    .length;
  check(
    "rename edits the declaration and the call across files",
    renameUris.length === 2 && renameEditsCount === 2,
  );
  check(
    "rename inserts the new name",
    Object.values(renameEdit?.changes ?? {})
      .flat()
      .every((e) => e.newText === "NavFn"),
  );

  send({
    jsonrpc: "2.0",
    id: 28,
    method: "textDocument/rename",
    params: {
      textDocument: { uri: navUri },
      position: { line: 6, character: 8 }, // NavAdd%
      newName: "NewAdd",
    },
  });
  const badRename = await reader.waitFor((m) => m.id === 28);
  check(
    "rename rejects a dropped type sigil",
    typeof badRename.error?.message === "string" &&
      /sigil/.test(badRename.error.message),
  );

  send({
    jsonrpc: "2.0",
    id: 29,
    method: "textDocument/signatureHelp",
    params: {
      textDocument: { uri: navUri },
      position: { line: 6, character: 19 }, // inside `NavAdd%(3, |4)`
    },
  });
  const sig = (await reader.waitFor((m) => m.id === 29)).result;
  check(
    "signatureHelp describes the callee and active parameter",
    /FUNCTION NavAdd% \(/.test(sig?.signatures?.[0]?.label ?? "") &&
      sig?.activeParameter === 1,
  );
  check(
    "signatureHelp lists parameters",
    sig?.signatures?.[0]?.parameters?.length === 2,
  );

  send({
    jsonrpc: "2.0",
    id: 30,
    method: "workspace/symbol",
    params: { query: "Nav" },
  });
  const ws = (await reader.waitFor((m) => m.id === 30)).result ?? [];
  const wsNames = ws.map((s) => s.name);
  check(
    "workspace/symbol finds routines from unopened files",
    wsNames.includes("Navigator") && wsNames.includes("NavAdd%"),
  );
  check(
    "workspace/symbol reports location and kind",
    ws.find((s) => s.name === "Navigator")?.kind === 6 &&
      /navlib\.bi$/.test(
        ws.find((s) => s.name === "Navigator")?.location?.uri ?? "",
      ),
  );

  // ---- call hierarchy ----------------------------------------------------
  console.log("callHierarchy");
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: callsUri,
        languageId: "qb64pe",
        version: 1,
        text: readFileSync(callsPath, "utf8"),
      },
    },
  });
  send({
    jsonrpc: "2.0",
    id: 50,
    method: "textDocument/prepareCallHierarchy",
    params: {
      textDocument: { uri: callsUri },
      position: { line: 0, character: 4 }, // Outer header
    },
  });
  const outerItem = (await reader.waitFor((m) => m.id === 50)).result?.[0];
  check(
    "prepareCallHierarchy names the routine (SUB -> Method kind)",
    outerItem?.name === "Outer" && outerItem?.kind === 6,
  );

  send({
    jsonrpc: "2.0",
    id: 51,
    method: "callHierarchy/outgoingCalls",
    params: { item: outerItem },
  });
  const outgoing = (await reader.waitFor((m) => m.id === 51)).result;
  check(
    "outgoingCalls finds the callee and its call sites",
    outgoing?.length === 1 &&
      outgoing[0].to.name === "Inner" &&
      outgoing[0].fromRanges.length === 2,
  );

  send({
    jsonrpc: "2.0",
    id: 52,
    method: "textDocument/prepareCallHierarchy",
    params: {
      textDocument: { uri: callsUri },
      position: { line: 6, character: 4 }, // Inner header
    },
  });
  const innerItem = (await reader.waitFor((m) => m.id === 52)).result?.[0];
  send({
    jsonrpc: "2.0",
    id: 53,
    method: "callHierarchy/incomingCalls",
    params: { item: innerItem },
  });
  const incoming = (await reader.waitFor((m) => m.id === 53)).result;
  check(
    "incomingCalls finds the caller and its call sites",
    incoming?.length === 1 &&
      incoming[0].from.name === "Outer" &&
      incoming[0].fromRanges.length === 2,
  );

  // ---- document colour ---------------------------------------------------
  console.log("documentColor");
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: colorsUri,
        languageId: "qb64pe",
        version: 1,
        text: readFileSync(colorsPath, "utf8"),
      },
    },
  });
  send({
    jsonrpc: "2.0",
    id: 54,
    method: "textDocument/documentColor",
    params: { textDocument: { uri: colorsUri } },
  });
  const colorInfos = (await reader.waitFor((m) => m.id === 54)).result ?? [];
  check("documentColor finds all three colour calls", colorInfos.length === 3);
  check(
    "documentColor reports 0..1 channels + range",
    colorInfos[1]?.color?.red === 0 &&
      Math.abs(colorInfos[1].color.green - 128 / 255) < 1e-9 &&
      colorInfos[1].range.start.line === 2,
  );

  send({
    jsonrpc: "2.0",
    id: 55,
    method: "textDocument/colorPresentation",
    params: {
      textDocument: { uri: colorsUri },
      range: colorInfos[0].range,
      color: { red: 0, green: 1, blue: 0, alpha: 1 },
    },
  });
  const presentations = (await reader.waitFor((m) => m.id === 55)).result ?? [];
  check(
    "colorPresentation rewrites the call preserving its name",
    presentations.length === 1 &&
      presentations[0].label === "_RGB32(0, 255, 0)" &&
      presentations[0].textEdit?.newText === "_RGB32(0, 255, 0)",
  );

  // ---- semantic tokens ---------------------------------------------------
  console.log("semanticTokens");
  send({
    jsonrpc: "2.0",
    id: 56,
    method: "textDocument/semanticTokens/full",
    params: { textDocument: { uri: navUri } },
  });
  const tokens = (await reader.waitFor((m) => m.id === 56)).result;
  check(
    "semanticTokens/full returns delta-encoded data",
    Array.isArray(tokens?.data) &&
      tokens.data.length > 0 &&
      tokens.data.length % 5 === 0,
  );

  // ---- incremental sync --------------------------------------------------
  console.log("incremental sync");
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: incUri,
        languageId: "qb64pe",
        version: 1,
        text: readFileSync(incPath, "utf8"),
      },
    },
  });
  // Insert a new SUB right after `PRINT 1` (a zero-width edit at end of line 0).
  send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: incUri, version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 7 },
          },
          text: "\nSUB Added\nEND SUB\n",
        },
      ],
    },
  });
  send({
    jsonrpc: "2.0",
    id: 57,
    method: "textDocument/documentSymbol",
    params: { textDocument: { uri: incUri } },
  });
  const incSymbols = flatten(
    (await reader.waitFor((m) => m.id === 57)).result ?? [],
  );
  check(
    "incremental didChange inserted the new SUB into the outline",
    incSymbols.some((s) => s.name === "Added"),
  );

  // ---- publishDiagnostics: clean file ------------------------------------
  console.log("publishDiagnostics (sample.bas)");
  const sampleDiag = await reader.waitForDiagnostics(sampleUri, 0);
  check("resolved $INCLUDE produces no diagnostics", sampleDiag.length === 0);

  // ---- publishDiagnostics: problems --------------------------------------
  console.log("publishDiagnostics (diag.bas)");
  const mark = reader.messages.length;
  const diagText = readFileSync(diagPath, "utf8");
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: diagUri,
        languageId: "qb64pe",
        version: 1,
        text: diagText,
      },
    },
  });
  const diagnostics = await reader.waitForDiagnostics(diagUri, mark);
  const byCode = (code) => diagnostics.find((d) => d.code === code);

  check("missing-include reported", byCode("missing-include")?.severity === 2);
  check("duplicate reported", byCode("duplicate")?.severity === 1);
  check(
    "duplicate message names the file",
    /already defined \(diag\.bas:\d+\)/.test(
      byCode("duplicate")?.message ?? "",
    ),
  );
  check("unused-local reported", byCode("unused-local")?.severity === 4);
  check(
    "unused-local is tagged Unnecessary",
    JSON.stringify(byCode("unused-local")?.tags) === JSON.stringify([1]),
  );
  check("undefined-label reported", byCode("undefined-label")?.severity === 1);
  check(
    "undefined-label message",
    /Label 'nowhere' is not defined in this file\./.test(
      byCode("undefined-label")?.message ?? "",
    ),
  );
  check(
    "diagnostics carry the source",
    diagnostics.every((d) => d.source === "qb64pe-lsp"),
  );

  console.log("shutdown");
  send({ jsonrpc: "2.0", id: 60, method: "shutdown", params: null });
  const shutdown = await reader.waitFor((m) => m.id === 60);
  check("shutdown returns null", shutdown.result === null);
  send({ jsonrpc: "2.0", method: "exit", params: null });
} catch (error) {
  failures++;
  console.error(`  FAIL ${String(error)}`);
} finally {
  proc.stdin.end();
  setTimeout(() => proc.kill("SIGKILL"), 500).unref?.();
}

await new Promise((resolve) => proc.on("exit", resolve));
console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
