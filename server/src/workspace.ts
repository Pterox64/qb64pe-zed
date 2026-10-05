/**
 * Workspace scanning: index every QB64-PE file under the workspace root so that
 * navigation (find-references, rename, workspace/symbol) works across files
 * that have not been opened. Bounded and defensive — a large or unreadable tree
 * degrades to indexing what it can.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SymbolIndex } from "./core/index.ts";
import { diskLoader } from "./core/index.ts";

const QB64_EXT = /\.(bas|bi|bm|inc)$/i;

/** Directories never traversed (dot-directories are skipped unconditionally). */
const SKIP_DIRS = new Set(["node_modules", "target"]);

/** Recursively finds QB64-PE source files under `root`, up to `limit` files. */
export function discoverQb64Files(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory
    }

    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && QB64_EXT.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }

  return out;
}

/** Indexes every discoverable QB64-PE file under `root`. Returns the count added. */
export function indexWorkspace(
  index: SymbolIndex,
  root: string,
  limit = 5000
): number {
  let added = 0;
  for (const file of discoverQb64Files(root, limit)) {
    if (index.has(file)) continue; // already indexed (e.g. via $INCLUDE)
    const content = diskLoader(file);
    if (content === null) continue;
    index.setFile(file, content);
    added++;
  }
  return added;
}
