/**
 * QB64-PE Debug Adapter Protocol server (DAP over stdio).
 *
 * We are the `vwatch` host: listen on a TCP port, compile the flattened program
 * with `$DEBUG`, spawn it with `QB64DEBUGPORT`, and translate the length-framed
 * vwatch protocol (see `core/vwatchProtocol.ts`) to/from DAP. The line map from
 * `core/flatten.ts` turns flattened lines back into real `(file, line)`.
 *
 * Dependency-free: speaks DAP over stdio with `Content-Length` framing, reusing
 * the vendored `core/` modules. Run with `node src/dap/dapServer.ts --stdio`.
 *
 * Scope: launch, breakpoints (with hit-condition), stop/continue, step
 * in/over/out, pause, call stack, scopes, locals/globals/constants, evaluate and
 * disconnect.
 */
import * as net from "node:net";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  FrameReader,
  VWatchOut,
  decodeValue,
  encode,
  interpret,
  mkl,
  packLineList,
} from "../core/vwatchProtocol.ts";
import type { CallStackFrame } from "../core/vwatchProtocol.ts";
import { hitConditionMet } from "../core/vwatchConditions.ts";
import { absolutizeMetaPaths, buildReverseMap, flatten } from "../core/flatten.ts";
import type { LineOrigin } from "../core/flatten.ts";
import { createIncludeResolver, normalizePath } from "../core/index.ts";
import { parseContent } from "../core/parser.ts";
import { resolveGlobals, resolveLocals } from "../core/vwatchVars.ts";
import type { ResolvedVar } from "../core/vwatchVars.ts";

const THREAD_ID = 1;
const THREAD_NAME = "QB64PE program";

// ---------------------------------------------------------------------------
// DAP framing over stdio (same shape as LSP).
// ---------------------------------------------------------------------------

interface DapMessage {
  seq?: number;
  type?: "request" | "response" | "event";
  request_seq?: number;
  success?: boolean;
  command?: string;
  arguments?: any;
  event?: string;
  body?: any;
  message?: string;
}

class MessageBuffer {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): DapMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: DapMessage[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const match = /content-length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, headerEnd).toString("ascii"),
      );
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body) as DapMessage);
      } catch {
        /* ignore malformed */
      }
    }
    return out;
  }
}

function log(message: string): void {
  process.stderr.write(`[qb64pe-dap] ${message}\n`);
}

let seq = 1;

function send(message: DapMessage): void {
  const body = Buffer.from(JSON.stringify({ ...message, seq: seq++ }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResponse(request: DapMessage, body?: any): void {
  send({ type: "response", request_seq: request.seq, success: true, command: request.command, body });
}

function sendError(request: DapMessage, message: string): void {
  send({ type: "response", request_seq: request.seq, success: false, command: request.command, message });
}

function sendEvent(event: string, body?: any): void {
  send({ type: "event", event, body });
}

function output(text: string): void {
  sendEvent("output", { category: "console", output: text.endsWith("\n") ? text : text + "\n" });
}

// ---------------------------------------------------------------------------
// Session.
// ---------------------------------------------------------------------------

interface BpInfo {
  line: number;
  condition?: string;
  hitCondition?: string;
  hits: number;
}

interface LaunchArgs {
  program: string;
  compilerPath?: string;
  port?: number;
  stopOnEntry?: boolean;
  autoAddDebug?: boolean;
  timeoutMs?: number;
}

interface PendingRead {
  name: string;
  varType: string;
  /** Variables-panel batch this read belongs to. */
  batch?: { into: any[]; remaining: number; flush: () => void };
  /** Evaluate callback (hover/watch). */
  evaluate?: (text: string) => void;
}

class DebugSession {
  private server?: net.Server;
  private socket?: net.Socket;
  private child?: cp.ChildProcess;
  private readonly reader = new FrameReader();
  private port = 9000;

  private args!: LaunchArgs;
  private program = "";
  private compiledProgram = "";
  private flatText = "";
  private origins: LineOrigin[] = [];
  private flatByFile = new Map<string, Map<number, number>>();
  private generatedC = "";
  private globals: ResolvedVar[] = [];
  private lineCount = 1;

  private readonly breakpoints = new Map<string, BpInfo[]>();
  private launched = false;
  private stopOnEntry = false;
  private timeoutTimer?: ReturnType<typeof setTimeout>;

  private currentLine = 0;
  private currentFile = "";
  private currentSub = "";
  private callStack: CallStackFrame[] = [];
  private callStackReady = false;
  private readonly pendingStack: DapMessage[] = [];

  private varSeq = 0;
  private readonly pendingReads = new Map<number, PendingRead>();
  private readonly scopes = new Map<number, { kind: "locals" | "globals" | "constants" }>();
  private scopeSeq = 0;
  private terminated = false;

  // ---- lifecycle ---------------------------------------------------------

  initialize(request: DapMessage): void {
    sendResponse(request, {
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: true,
      supportsEvaluateForHovers: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
    });
    sendEvent("initialized");
  }

  async launch(request: DapMessage): Promise<void> {
    const args = (request.arguments ?? {}) as LaunchArgs;
    this.args = args;
    this.program = args.program;
    this.stopOnEntry = !!args.stopOnEntry;
    this.port = args.port ?? 9000;

    if (!this.program || !fs.existsSync(this.program)) {
      sendError(request, `Program not found: ${this.program}`);
      this.terminate("launch failed");
      return;
    }
    const compilerPath = args.compilerPath?.trim();
    if (!compilerPath || !fs.existsSync(compilerPath)) {
      sendError(request, `No QB64PE compiler found at: ${compilerPath ?? "(unset)"}`);
      this.terminate("launch failed");
      return;
    }

    try {
      this.prepareCompiledProgram(args);
    } catch (e) {
      sendError(request, `Could not prepare source: ${e}`);
      this.terminate("launch failed");
      return;
    }
    this.lineCount = this.origins.length + 2;

    try {
      this.port = await this.startServer(this.port);
    } catch (e) {
      sendError(request, `Could not open debug port: ${e}`);
      this.terminate("launch failed");
      return;
    }

    const exePath = this.exePathFor();
    fs.writeFileSync(this.compiledProgram, this.flatText, "latin1");
    const ok = await this.compile(compilerPath, this.compiledProgram, exePath);
    if (!ok) {
      sendError(request, "Compilation failed — see the Debug Console.");
      this.terminate("compile failed");
      return;
    }
    this.loadVariableManifest(compilerPath);
    const exe = this.findProducedExe(exePath);
    if (!exe) {
      sendError(request, `Compiler reported success but no executable found near ${exePath}.`);
      this.terminate("no executable");
      return;
    }

    const timeoutMs = args.timeoutMs ?? 15000;
    this.timeoutTimer = setTimeout(() => {
      if (!this.launched) {
        output(`Debuggee did not connect within ${timeoutMs}ms (is $DEBUG present, and port ${this.port} free?).`);
        this.terminate("connect timeout");
      }
    }, timeoutMs);

    this.spawnDebuggee(exe);
    sendResponse(request);
  }

  configurationDone(request: DapMessage): void {
    sendResponse(request);
  }

  setBreakpoints(request: DapMessage): void {
    const source = request.arguments?.source ?? {};
    const file = source.path ?? "";
    const requested = request.arguments?.breakpoints ?? [];
    const key = normalizePath(file);

    this.breakpoints.set(
      key,
      requested
        .filter((b: any) => this.toFlat(file, b.line) !== undefined)
        .map((b: any) => ({ line: b.line, condition: b.condition, hitCondition: b.hitCondition, hits: 0 })),
    );
    if (this.launched && this.socket) {
      this.send(VWatchOut.ClearAllBreakpoints);
      for (const line of this.allBreakpointLines()) this.send(VWatchOut.SetBreakpoint, mkl(line));
    }

    sendResponse(request, {
      breakpoints: requested.map((b: any) => {
        const flat = this.toFlat(file, b.line);
        return flat !== undefined
          ? { verified: true, line: b.line }
          : { verified: false, line: b.line, message: "Not part of the compiled program." };
      }),
    });
  }

  threads(request: DapMessage): void {
    sendResponse(request, { threads: [{ id: THREAD_ID, name: THREAD_NAME }] });
  }

  stackTrace(request: DapMessage): void {
    if (this.callStackReady) this.respondStackTrace(request);
    else this.pendingStack.push(request);
  }

  private respondStackTrace(request: DapMessage): void {
    const frames: any[] = [];
    const here = {
      source: { name: path.basename(this.currentFile || this.program), path: this.currentFile || this.program },
      line: this.currentLine,
      column: 1,
    };
    if (this.callStack.length === 0) {
      frames.push({ id: 0, name: this.currentSub || "(main)", ...here });
    } else {
      [...this.callStack].reverse().forEach((frame, i) => {
        if (i === 0) {
          frames.push({ id: 0, name: frame.sub || this.currentSub || "(main)", ...here });
        } else {
          const origin = frame.line ? this.fromFlat(frame.line) : undefined;
          const file = origin?.file ?? this.program;
          frames.push({
            id: i,
            name: frame.sub || "(main)",
            source: { name: path.basename(file), path: file },
            line: origin?.line ?? frame.line ?? 1,
            column: 1,
          });
        }
      });
    }
    sendResponse(request, { stackFrames: frames, totalFrames: frames.length });
  }

  scopesRequest(request: DapMessage): void {
    const ref = (kind: "locals" | "globals" | "constants") => {
      const id = ++this.scopeSeq;
      this.scopes.set(id, { kind });
      return id;
    };
    sendResponse(request, {
      scopes: [
        { name: "Locals", variablesReference: ref("locals"), expensive: false },
        { name: "Module & Globals", variablesReference: ref("globals"), expensive: false },
        { name: "Constants", variablesReference: ref("constants"), expensive: false },
      ],
    });
  }

  variables(request: DapMessage): void {
    const target = this.scopes.get(request.arguments?.variablesReference);
    if (!target || target.kind === "constants") {
      sendResponse(request, { variables: this.constantVariables() });
      return;
    }
    const isLocal = target.kind === "locals";
    const vars = isLocal ? this.currentLocalVars() : this.globals;
    const scope = isLocal ? this.currentSub : "";
    const into: any[] = [];
    const batch = {
      into,
      remaining: 0,
      flush: () =>
        sendResponse(request, { variables: into.sort((a, b) => a.name.localeCompare(b.name)) }),
    };

    for (const v of vars) {
      if (v.isUDT || v.isArray) {
        into.push({
          name: v.isArray ? `${v.name}()` : v.name,
          value: v.isArray ? `<array of ${v.isUDT ? "TYPE" : v.varType}>` : `{${v.varType === "UDT" ? "TYPE" : v.varType}}`,
          variablesReference: 0,
        });
        continue;
      }
      batch.remaining++;
      const tempIndex = ++this.varSeq;
      this.pendingReads.set(tempIndex, { name: v.name, varType: v.varType, batch });
      this.issueGetVar({ isLocal, scope, localIndex: v.index, varType: v.varType, varSize: v.size, tempIndex });
    }

    if (batch.remaining === 0) batch.flush();
    else setTimeout(() => { if (batch.remaining > 0) { batch.remaining = 0; batch.flush(); } }, 700);
  }

  evaluate(request: DapMessage): void {
    const expr = (request.arguments?.expression ?? "").trim();
    const hover = request.arguments?.context === "hover";
    const found = this.findVar(expr.replace(/[%&!#$~`]+$/, "").toUpperCase());
    if (!found || found.v.isUDT || found.v.isArray) {
      if (hover) sendError(request, "not a scalar variable");
      else sendResponse(request, { result: found ? "<use name(index) / name.field>" : "<not in scope>", variablesReference: 0 });
      return;
    }
    const tempIndex = ++this.varSeq;
    this.pendingReads.set(tempIndex, {
      name: found.v.name,
      varType: found.v.varType,
      evaluate: (text) => sendResponse(request, { result: text, variablesReference: 0 }),
    });
    this.issueGetVar({
      isLocal: found.isLocal,
      scope: found.isLocal ? this.currentSub : "",
      localIndex: found.v.index,
      varType: found.v.varType,
      varSize: found.v.size,
      tempIndex,
    });
    setTimeout(() => {
      if (this.pendingReads.delete(tempIndex)) {
        if (hover) sendError(request, "no reply");
        else sendResponse(request, { result: "<no reply>", variablesReference: 0 });
      }
    }, 700);
  }

  continue(request: DapMessage): void {
    this.send(VWatchOut.Run);
    sendResponse(request, { allThreadsContinued: true });
  }

  next(request: DapMessage): void {
    this.send(VWatchOut.StepOver);
    sendResponse(request);
  }

  stepIn(request: DapMessage): void {
    this.send(VWatchOut.Step);
    sendResponse(request);
  }

  stepOut(request: DapMessage): void {
    this.send(VWatchOut.StepOut);
    sendResponse(request);
  }

  pause(request: DapMessage): void {
    this.send(VWatchOut.Break);
    sendResponse(request);
  }

  disconnect(request: DapMessage): void {
    this.terminate("disconnect");
    sendResponse(request);
  }

  terminateRequest(request: DapMessage): void {
    this.terminate("terminate");
    sendResponse(request);
  }

  // ---- vwatch host -------------------------------------------------------

  private startServer(basePort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      let port = basePort;
      const tryListen = () => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && port < basePort + 50) {
            port += 1;
            setImmediate(tryListen);
          } else reject(err);
        });
        server.listen(port, "127.0.0.1", () => resolve(port));
      };
      tryListen();
    });
  }

  private onConnection(socket: net.Socket): void {
    if (this.socket) { socket.destroy(); return; }
    this.socket = socket;
    output("Debuggee connected.");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => { /* handled by close */ });
    socket.on("close", () => { if (this.socket === socket) this.terminate("socket close"); });
  }

  private onData(chunk: Buffer): void {
    this.reader.push(chunk);
    let raw;
    while ((raw = this.reader.next()) !== null) {
      try { this.dispatch(interpret(raw)); } catch (e) { output(`[dispatch] ${e}`); }
    }
  }

  private dispatch(msg: ReturnType<typeof interpret>): void {
    switch (msg.kind) {
      case "me": this.onHandshake(); break;
      case "hwnd": break;
      case "stopped": this.onStop(msg.line, msg.reason); break;
      case "currentSub": this.currentSub = msg.name; break;
      case "callStackSize": break;
      case "callStack":
        this.callStack = msg.frames;
        this.callStackReady = true;
        this.flushPendingStackTrace();
        break;
      case "addressRead": this.onAddressRead(msg.read); break;
      case "error": output(`Runtime error at line ${msg.line}.`); this.reportStop(msg.line, "exception"); break;
      case "enterInput": output("(program is waiting for input)"); break;
      case "quit": output(msg.reason); this.terminate("quit: " + msg.reason); break;
      default: break;
    }
  }

  private onHandshake(): void {
    if (this.launched) return;
    this.launched = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.send(VWatchOut.Vwatch, "ok");
    this.send(VWatchOut.LineCount, mkl(this.lineCount));
    const lines = this.allBreakpointLines();
    this.send(VWatchOut.BreakpointCount, mkl(lines.length));
    this.send(VWatchOut.BreakpointList, packLineList(lines));
    this.send(VWatchOut.SkipCount, mkl(0));
    this.send(VWatchOut.SkipList, Buffer.alloc(0));
    output(`Handshake complete; breakpoints at [${lines.join(", ") || "none"}].`);
    this.send(this.stopOnEntry ? VWatchOut.Break : VWatchOut.Run);
  }

  private onStop(line: number, reason: "step" | "breakpoint"): void {
    if (reason === "breakpoint") {
      const bp = this.breakpointAt(line);
      if (bp?.hitCondition) {
        bp.hits += 1;
        if (!hitConditionMet(bp.hitCondition, bp.hits)) {
          this.send(VWatchOut.Run);
          return;
        }
      }
    }
    this.reportStop(line, reason);
  }

  private reportStop(flatLine: number, reason: string): void {
    const origin = this.fromFlat(flatLine);
    this.currentFile = origin?.file ?? this.program;
    this.currentLine = origin?.line ?? flatLine;
    this.callStackReady = false;
    this.callStack = [];
    this.scopes.clear();
    this.send(VWatchOut.CallStack);
    sendEvent("stopped", {
      reason: reason === "exception" ? "exception" : reason,
      threadId: THREAD_ID,
      allThreadsStopped: true,
    });
  }

  private flushPendingStackTrace(): void {
    const pending = this.pendingStack;
    this.pendingStack.length = 0;
    for (const request of pending) this.respondStackTrace(request);
  }

  // ---- variables ---------------------------------------------------------

  private loadVariableManifest(compilerPath: string): void {
    try {
      const tempDir = path.join(path.dirname(compilerPath), "internal", "temp");
      if (!fs.existsSync(tempDir)) return;
      const since = Date.now() - 120000;
      const parts: string[] = [];
      for (const name of fs.readdirSync(tempDir)) {
        if (!name.toLowerCase().endsWith(".txt")) continue;
        const full = path.join(tempDir, name);
        try {
          if (fs.statSync(full).mtimeMs < since) continue;
          parts.push(fs.readFileSync(full, "latin1"));
        } catch { /* skip */ }
      }
      this.generatedC = parts.join("\n");
      this.globals = resolveGlobals(this.generatedC);
      output(`Loaded variable manifest: ${this.globals.length} global(s).`);
    } catch (e) {
      output(`Could not read variable manifest: ${e}`);
    }
  }

  private currentLocalVars(): ResolvedVar[] {
    if (!this.currentSub) return [];
    return resolveLocals(this.generatedC, this.currentSub);
  }

  private findVar(upper: string): { v: ResolvedVar; isLocal: boolean } | undefined {
    const local = this.currentLocalVars().find((v) => v.name === upper);
    if (local) return { v: local, isLocal: true };
    const global = this.globals.find((v) => v.name === upper);
    if (global) return { v: global, isLocal: false };
    return undefined;
  }

  private issueGetVar(o: {
    isLocal: boolean;
    scope: string;
    localIndex: number;
    varType: string;
    varSize: number;
    tempIndex: number;
  }): void {
    const scopeBuf = Buffer.from(o.scope, "latin1");
    const typeBuf = Buffer.from(o.varType, "latin1");
    const len = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
    const payload = Buffer.concat([
      mkl(o.tempIndex),
      Buffer.from([0]),
      mkl(0),
      mkl(o.localIndex),
      mkl(0),
      mkl(0),
      mkl(0),
      mkl(0),
      mkl(o.varSize),
      mkl(o.tempIndex),
      len(scopeBuf.length),
      scopeBuf,
      len(typeBuf.length),
      typeBuf,
    ]);
    this.send(o.isLocal ? VWatchOut.GetLocalVar : VWatchOut.GetGlobalVar, payload);
  }

  private onAddressRead(read: { tempIndex: number; bytes: Buffer }): void {
    const info = this.pendingReads.get(read.tempIndex);
    if (!info) return;
    this.pendingReads.delete(read.tempIndex);
    const decoded = decodeValue(info.varType, read.bytes);
    const text = decoded ? decoded.text + (decoded.approximate ? " (approx)" : "") : "<unreadable>";
    if (info.evaluate) {
      info.evaluate(text);
      return;
    }
    if (info.batch) {
      info.batch.into.push({ name: info.name, value: text, variablesReference: 0 });
      if (--info.batch.remaining <= 0) info.batch.flush();
    }
  }

  private constantVariables(): any[] {
    const seen = new Set<string>();
    const consts = this.programSyms().filter((s) => {
      if (s.type !== "CONST") return false;
      const k = s.name.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return consts.map((s) => ({ name: s.name, value: s.value ?? "<const>", variablesReference: 0 }));
  }

  private parsedProgram?: ReturnType<typeof parseContent>;
  private programSyms(): ReturnType<typeof parseContent> {
    if (!this.parsedProgram) {
      try { this.parsedProgram = parseContent(this.flatText, this.program); }
      catch { this.parsedProgram = []; }
    }
    return this.parsedProgram;
  }

  // ---- compile + spawn ---------------------------------------------------

  private prepareCompiledProgram(args: LaunchArgs): void {
    const resolver = createIncludeResolver([path.dirname(this.program)]);
    const result = flatten(normalizePath(this.program), {
      readFile: (p) => { try { return fs.readFileSync(p, "latin1"); } catch { return null; } },
      resolve: (spec, from) => resolver(from, spec),
    });
    this.origins = result.origins;
    this.flatByFile = buildReverseMap(result.origins, normalizePath);
    const hasDebug = /^[ \t]*\$DEBUG\b/im.test(result.text);
    if (!hasDebug && args.autoAddDebug === false) {
      throw new Error("Program has no $DEBUG and autoAddDebug is off.");
    }
    const text = absolutizeMetaPaths(result.text, result.origins);
    this.flatText = hasDebug ? text : text + os.EOL + "$DEBUG" + os.EOL;

    const base = path.basename(this.program, path.extname(this.program));
    const id = createHash("sha1").update(normalizePath(this.program)).digest("hex").slice(0, 10);
    const dir = path.join(os.tmpdir(), "qb64pe-zed", `${base}-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    this.compiledProgram = path.join(dir, `.${base}.debug${path.extname(this.program)}`);
    output(`Flattened ${this.flatByFile.size} file(s) into ${this.origins.length} lines.`);
  }

  private toFlat(file: string, line: number): number | undefined {
    return this.flatByFile.get(normalizePath(file))?.get(line);
  }

  private fromFlat(flatLine: number): LineOrigin | undefined {
    return this.origins[flatLine - 1];
  }

  private allBreakpointLines(): number[] {
    const set = new Set<number>();
    for (const [key, bps] of this.breakpoints) {
      const byLine = this.flatByFile.get(key);
      for (const b of bps) {
        const flat = byLine?.get(b.line);
        if (flat !== undefined) set.add(flat);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  private breakpointAt(flatLine: number): BpInfo | undefined {
    const origin = this.fromFlat(flatLine);
    if (!origin) return undefined;
    return this.breakpoints.get(normalizePath(origin.file))?.find((b) => b.line === origin.line);
  }

  private exePathFor(): string {
    const dir = path.dirname(this.program);
    const base = path.basename(this.program, path.extname(this.program));
    return path.join(dir, base + (process.platform === "win32" ? ".exe" : ".run"));
  }

  private findProducedExe(exePath: string): string | undefined {
    const stem = exePath.replace(/\.(run|exe)$/i, "");
    const isFile = (p: string) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
    const named = [exePath, stem + ".run", stem + ".exe", stem].find(isFile);
    if (named) return named;
    try {
      const dir = path.dirname(stem);
      const base = path.basename(stem).toLowerCase();
      const skip = /\.(bas|bi|bm|o|a|h|c|cpp|txt|md|manifest|map|obj|lib)$/i;
      return fs.readdirSync(dir)
        .filter((n) => n.toLowerCase().startsWith(base) && !skip.test(n))
        .map((n) => path.join(dir, n))
        .filter(isFile)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    } catch { return undefined; }
  }

  private compile(compilerPath: string, sourceFile: string, exePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const procs = Math.max(1, os.cpus().length || 1);
      const args = ["-c", sourceFile, "-o", exePath, "-x", `-f:MaxCompilerProcesses=${procs}`];
      output(`Compiling ${path.basename(sourceFile)} with $DEBUG...`);
      const proc = cp.spawn(compilerPath, args, { cwd: path.dirname(this.program) });
      proc.stdout?.on("data", (d) => output(d.toString()));
      proc.stderr?.on("data", (d) => output(d.toString()));
      proc.on("error", (err) => { output(`Failed to run compiler: ${err.message}`); resolve(false); });
      proc.on("close", (code) => {
        output(code === 0 ? "Compile succeeded." : `Compile FAILED (exit ${code}).`);
        resolve(code === 0);
      });
    });
  }

  private spawnDebuggee(exePath: string): void {
    output(`Launching (QB64DEBUGPORT=${this.port})...`);
    const child = cp.spawn(exePath, [], {
      cwd: path.dirname(exePath),
      env: { ...process.env, QB64DEBUGPORT: String(this.port) },
    });
    this.child = child;
    child.stdout?.on("data", (d) => output(d.toString()));
    child.stderr?.on("data", (d) => output(d.toString()));
    child.on("error", (err) => { output(`Failed to launch program: ${err.message}`); this.terminate("child error"); });
    child.on("close", () => this.terminate("child close"));
  }

  // ---- teardown ----------------------------------------------------------

  private terminate(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    output(`Session ending (${reason}).`);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    try { if (this.socket) { this.send(VWatchOut.Free); this.socket.destroy(); } } catch { /* ignore */ }
    try { this.child?.kill(); } catch { /* ignore */ }
    try { this.server?.close(); } catch { /* ignore */ }
    sendEvent("terminated");
  }

  private send(command: string, value?: Buffer | string): void {
    if (!this.socket) return;
    this.socket.write(encode(command, value));
  }
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

const session = new DebugSession();

const HANDLERS: Record<string, (request: DapMessage) => void> = {
  initialize: (r) => session.initialize(r),
  launch: (r) => void session.launch(r),
  configurationDone: (r) => session.configurationDone(r),
  setBreakpoints: (r) => session.setBreakpoints(r),
  threads: (r) => session.threads(r),
  stackTrace: (r) => session.stackTrace(r),
  scopes: (r) => session.scopesRequest(r),
  variables: (r) => session.variables(r),
  evaluate: (r) => session.evaluate(r),
  continue: (r) => session.continue(r),
  next: (r) => session.next(r),
  stepIn: (r) => session.stepIn(r),
  stepOut: (r) => session.stepOut(r),
  pause: (r) => session.pause(r),
  disconnect: (r) => session.disconnect(r),
  terminate: (r) => session.terminateRequest(r),
};

function dispatch(message: DapMessage): void {
  if (message.type !== "request" || !message.command) return;
  const handler = HANDLERS[message.command];
  if (handler) handler(message);
  else sendResponse(message);
}

export function runDapServer(): void {
  const reader = new MessageBuffer();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const message of reader.push(chunk)) dispatch(message);
  });
  process.stdin.on("end", () => process.exit(0));
  log(`started (pid ${process.pid}); waiting for initialize`);
}

runDapServer();
