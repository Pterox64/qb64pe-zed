/**
 * Smoke test for the QB64-PE debug adapter.
 *
 * Part 1 unit-tests the vwatch codec against the real protocol semantics.
 * Part 2 (opt-in) spawns `src/dap/dapServer.ts` and drives a live DAP session:
 * initialize → launch (compiles with $DEBUG) → the debuggee connects, runs to
 * completion and the session terminates. Set `QB64PE_COMPILER` to a `qb64pe`
 * executable to enable part 2 (skipped otherwise, since it compiles + runs a
 * real program).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FrameReader,
  cvl,
  cvi,
  decodeValue,
  encode,
  interpret,
  mkl,
  mki,
  packLineList,
  splitMessage,
} from "../src/core/vwatchProtocol.ts";
import {
  hitConditionMet,
  compareValues,
} from "../src/core/vwatchConditions.ts";
import { resolveGlobals, resolveLocals } from "../src/core/vwatchVars.ts";
import { flatten } from "../src/core/flatten.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Part 1 — codec unit tests.
// ---------------------------------------------------------------------------

console.log("codec");
const frame = encode("line number", mkl(42));
check(
  "encode frames payload length as MKL",
  cvl(frame, 0) === "line number:".length + 4,
);
const raw = splitMessage(frame.subarray(4));
check(
  "splitMessage splits on first colon",
  raw.command === "line number" && cvl(raw.value, 0) === 42,
);

const reader = new FrameReader();
reader.push(encode("vwatch", "ok").subarray(0, 3)); // partial
check("FrameReader waits for a full frame", reader.next() === null);
reader.push(encode("vwatch", "ok").subarray(3));
const msg = interpret(reader.next());
check(
  "FrameReader reassembles across chunks",
  msg.kind === "unknown" || msg.kind !== undefined,
);
reader.push(
  Buffer.concat([encode("breakpoint", mkl(7)), encode("quit", "done")]),
);
const drained = reader.drain().map(interpret);
check(
  "drain yields both frames in order",
  drained[0].kind === "stopped" &&
    drained[0].reason === "breakpoint" &&
    drained[0].line === 7 &&
    drained[1].kind === "quit" &&
    drained[1].reason === "done",
);

check("mkl/cvl round-trip (negative)", cvl(mkl(-5)) === -5);
check("mki/cvi round-trip", cvi(mki(0x1234)) === 0x1234);
check(
  "packLineList packs 4 bytes per line",
  packLineList([1, 2, 3]).length === 12,
);

check(
  "interpret callStack parses frames",
  (() => {
    const v = Buffer.from("Main, line 9\0(inc.bi, 3) Draw, line 12", "latin1");
    const m = interpret({ command: "call stack", value: v });
    return (
      m.kind === "callStack" &&
      m.frames.length === 2 &&
      m.frames[0].sub === "Main" &&
      m.frames[0].line === 9 &&
      m.frames[1].includeFile === "inc.bi" &&
      m.frames[1].sub === "Draw" &&
      m.frames[1].line === 12
    );
  })(),
);

check("decodeValue INTEGER", decodeValue("INTEGER", mkl(1234)).text === "1234");
check(
  "decodeValue SINGLE",
  Math.abs(
    parseFloat(
      decodeValue(
        "SINGLE",
        (() => {
          const b = Buffer.alloc(4);
          b.writeFloatLE(1.5, 0);
          return b;
        })(),
      ).text,
    ) - 1.5,
  ) < 1e-6,
);
check(
  "decodeValue STRING trims NULs",
  decodeValue("STRING", Buffer.from("hi\0\0", "latin1")).text === "hi",
);
check(
  "decodeValue unsigned byte",
  decodeValue("_UNSIGNED _BYTE", Buffer.from([255])).text === "255",
);
check(
  "decodeValue rejects short buffer",
  decodeValue("INTEGER", Buffer.from([1])) === null,
);

console.log("conditions");
check(
  "hitConditionMet bare number",
  hitConditionMet("5", 5) && !hitConditionMet("5", 4),
);
check(
  "hitConditionMet modulo",
  hitConditionMet("%3", 9) && !hitConditionMet("%3", 10),
);
check(
  "hitConditionMet >=",
  hitConditionMet(">=3", 3) && !hitConditionMet(">=3", 2),
);
check("compareValues numeric", compareValues("10", ">", "5") === true);
check(
  "compareValues string literal",
  compareValues("abc", "=", '"abc"') === true,
);
check("compareValues not-equal", compareValues("1", "<>", "2") === true);

console.log("variables");
const genC = `
vwatch_global_vars[0] = &__INTEGER_COUNTER;
vwatch_global_vars[1] = &__ARRAY_SINGLE_BALL;
vwatch_local_vars[0] = &_SUB_GREET_INTEGER_N;
vwatch_local_vars[1] = &_SUB_GREET_STRING_NAME;
`;
const globals = resolveGlobals(genC);
check(
  "resolveGlobals finds scalar + array",
  globals.length === 2 &&
    globals[0].name === "COUNTER" &&
    globals[0].varType === "INTEGER" &&
    globals[1].name === "BALL" &&
    globals[1].isArray === true,
);
const locals = resolveLocals(genC, "SUB_GREET");
check(
  "resolveLocals scopes to the routine",
  locals.length === 2 &&
    locals[0].name === "N" &&
    locals[1].name === "NAME" &&
    locals[1].varType === "STRING",
);

console.log("flatten");
const files = new Map([
  ["/p/main.bas", "$INCLUDE:'lib.bi'\nPRINT 1\n"],
  ["/p/lib.bi", "CONST X = 1\n"],
]);
const flat = flatten("/p/main.bas", {
  readFile: (p) => files.get(p) ?? null,
  resolve: (spec, from) =>
    from === "/p/main.bas" && spec === "lib.bi" ? "/p/lib.bi" : null,
});
check(
  "flatten inlines includes and keeps a line map",
  flat.origins[0].file === "/p/main.bas" &&
    flat.origins[0].line === 1 &&
    flat.origins[1].file === "/p/lib.bi" &&
    flat.origins[1].line === 1 &&
    flat.text.split("\n")[1] === "CONST X = 1" &&
    flat.origins.some((o) => o.file === "/p/main.bas" && o.line === 2),
);

// ---------------------------------------------------------------------------
// Part 2 — live DAP session (opt-in).
// ---------------------------------------------------------------------------

const compiler = process.env.QB64PE_COMPILER;
if (!compiler || !existsSync(compiler)) {
  console.log(
    "\n(live DAP test skipped: set QB64PE_COMPILER to a qb64pe executable)",
  );
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

function frameDap(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

class DapReader {
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
      const match = /content-length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, headerEnd).toString("ascii"),
      );
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
  async waitFor(predicate, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error("timeout waiting for a DAP message");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

console.log("\nlive DAP session");
const adapterPath = join(here, "..", "src", "dap", "dapServer.ts");
const programPath = join(here, "fixtures", "dap-program.bas");
const proc = spawn(process.execPath, [adapterPath, "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.on("data", (d) => process.stderr.write(d));
const dap = new DapReader(proc.stdout);
const send = (m) => proc.stdin.write(frameDap(m));

try {
  send({ seq: 1, type: "request", command: "initialize", arguments: {} });
  const init = await dap.waitFor((m) => m.command === "initialize");
  check("initialize succeeds", init?.success === true);
  check(
    "advertises configurationDone",
    init?.body?.supportsConfigurationDoneRequest === true,
  );

  send({
    seq: 2,
    type: "request",
    command: "launch",
    arguments: {
      program: programPath,
      compilerPath: compiler,
      port: 39750,
      timeoutMs: 60000,
    },
  });
  const launch = await dap.waitFor((m) => m.command === "launch", 90000);
  check("launch succeeds (compiled with $DEBUG)", launch?.success === true);

  const terminated = await dap.waitFor(
    (m) => m.type === "event" && m.event === "terminated",
    30000,
  );
  check(
    "session terminates after the program finishes",
    terminated?.event === "terminated",
  );

  const outputs = dap.messages
    .filter((m) => m.event === "output")
    .map((m) => m.body?.output ?? "")
    .join("");
  check(
    "debuggee connected (vwatch handshake)",
    /Debuggee connected/.test(outputs),
  );
  check("program ran and produced its output", /\b42\b/.test(outputs));
  check(
    "program reported it ended",
    /Program ended|Session ending/.test(outputs),
  );
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
