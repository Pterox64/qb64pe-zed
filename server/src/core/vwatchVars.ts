/**
 * Decode the QB64PE compiler's generated variable table so the debugger can
 * request live values.
 *
 * Vendored verbatim from grymmjack/qb64pe-vscode (MIT),
 * `src/core/vwatchVars.ts`. Only this header note was added; the code is
 * unchanged (it has no imports).
 *
 * When a program is compiled with `$DEBUG`, the compiler emits, into its
 * generated C (`internal/temp/maindata.txt` for module-level variables and the
 * per-routine `dataN.txt` files for locals), a table mapping each variable to
 * its slot in `vwatch_global_vars[]` / `vwatch_local_vars[]`:
 *
 *     vwatch_global_vars[12] = &__SINGLE_X;
 *     vwatch_local_vars[0]   = &_SUB_GREET_INTEGER_N;
 *
 * That slot index is the `localIndex` the vwatch protocol needs for a
 * `get global var` / `get local var` request.
 */

export interface VarSlot {
  index: number;
  cname: string;
}

export interface ResolvedVar {
  index: number;
  name: string;
  varType: string;
  size: number;
  isArray: boolean;
  isUDT?: boolean;
}

const TYPE_TOKENS: Array<{ token: string; varType: string; size: number }> = [
  { token: "_UNSIGNED_INTEGER64", varType: "_UNSIGNED _INTEGER64", size: 8 },
  { token: "_UNSIGNED_INTEGER", varType: "_UNSIGNED INTEGER", size: 2 },
  { token: "_UNSIGNED_OFFSET", varType: "_UNSIGNED _OFFSET", size: 8 },
  { token: "_UNSIGNED_LONG", varType: "_UNSIGNED LONG", size: 4 },
  { token: "_UNSIGNED_BYTE", varType: "_UNSIGNED _BYTE", size: 1 },
  { token: "_INTEGER64", varType: "_INTEGER64", size: 8 },
  { token: "_OFFSET", varType: "_OFFSET", size: 8 },
  { token: "_FLOAT", varType: "_FLOAT", size: 32 },
  { token: "_BYTE", varType: "_BYTE", size: 1 },
  { token: "INTEGER", varType: "INTEGER", size: 2 },
  { token: "SINGLE", varType: "SINGLE", size: 4 },
  { token: "DOUBLE", varType: "DOUBLE", size: 8 },
  { token: "STRING", varType: "STRING", size: 12 },
  { token: "LONG", varType: "LONG", size: 4 },
];

const GLOBAL_RE = /vwatch_global_vars\[\s*(\d+)\s*\]\s*=\s*&([A-Za-z0-9_]+)\s*;/g;
const LOCAL_RE = /vwatch_local_vars\[\s*(\d+)\s*\]\s*=\s*&([A-Za-z0-9_]+)\s*;/g;

export function parseGlobalSlots(text: string): VarSlot[] {
  return matchAll(text, GLOBAL_RE);
}

export function parseLocalSlots(text: string): VarSlot[] {
  return matchAll(text, LOCAL_RE);
}

function matchAll(text: string, re: RegExp): VarSlot[] {
  const out: VarSlot[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: parseInt(m[1], 10), cname: m[2] });
  }
  return out;
}

export function resolveGlobal(slot: VarSlot): ResolvedVar | null {
  if (!slot.cname.startsWith("__")) return null;
  return resolveRemainder(slot.index, slot.cname.slice(2));
}

export function resolveLocal(
  slot: VarSlot,
  subInternalName: string
): ResolvedVar | null {
  const prefix = "_" + subInternalName + "_";
  if (!slot.cname.startsWith(prefix)) return null;
  return resolveRemainder(slot.index, slot.cname.slice(prefix.length));
}

function resolveRemainder(index: number, remainder: string): ResolvedVar | null {
  let isArray = false;
  if (remainder.startsWith("ARRAY_")) {
    isArray = true;
    remainder = remainder.slice("ARRAY_".length);
  }
  if (remainder.startsWith("UDT_")) {
    const name = remainder.slice("UDT_".length);
    if (!name) return null;
    return { index, name, varType: "UDT", size: 0, isArray, isUDT: true };
  }
  for (const t of TYPE_TOKENS) {
    if (remainder.startsWith(t.token + "_")) {
      const name = remainder.slice(t.token.length + 1);
      if (!name) return null;
      return { index, name, varType: t.varType, size: t.size, isArray };
    }
  }
  return null;
}

export function resolveGlobals(text: string): ResolvedVar[] {
  const out: ResolvedVar[] = [];
  for (const slot of parseGlobalSlots(text)) {
    const r = resolveGlobal(slot);
    if (r) out.push(r);
  }
  return out;
}

export function resolveLocals(
  text: string,
  subInternalName: string
): ResolvedVar[] {
  const out: ResolvedVar[] = [];
  for (const slot of parseLocalSlots(text)) {
    const r = resolveLocal(slot, subInternalName);
    if (r) out.push(r);
  }
  return out;
}
