/**
 * Help service: keyword help converted from the installed QB64PE wiki source.
 *
 * QB64PE ships its help as MediaWiki source under `<install>/internal/help/`.
 * This service indexes those `*.txt` pages by keyword (see `core/helpFiles.ts`
 * for the filename mangling) and converts a page to Markdown on demand with
 * `core/wikitext.ts`, caching the result. When no help directory is available
 * it degrades gracefully: `getHoverHelp` returns null and the caller falls back
 * to a short built-in description.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  helpKeys,
  keywordFromHelpFileName,
  lookupVariants,
} from "./core/helpFiles.ts";
import { wikitextToMarkdown } from "./core/wikitext.ts";

export class HelpService {
  private readonly dirs: string[];
  /** KEY (upper-case) -> absolute path of the help page. Built lazily. */
  private index: Map<string, string> | null = null;
  /** token (upper-case) -> Markdown or null. */
  private readonly cache = new Map<string, string | null>();

  constructor(dirs: string[]) {
    this.dirs = dirs;
  }

  private ensureIndex(): void {
    if (this.index) return;
    this.index = new Map();
    for (const dir of this.dirs) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue; // missing/unreadable help directory
      }
      for (const file of entries) {
        if (!/\.txt$/i.test(file)) continue;
        const keyword = keywordFromHelpFileName(file);
        if (!keyword) continue;
        const full = path.join(dir, file);
        for (const key of helpKeys(keyword)) {
          if (!this.index.has(key)) this.index.set(key, full);
        }
      }
    }
  }

  get available(): boolean {
    this.ensureIndex();
    return (this.index?.size ?? 0) > 0;
  }

  /** Markdown help for a hovered token, or null when no page is found. */
  getHoverHelp(token: string): string | null {
    const cacheKey = token.toUpperCase();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    this.ensureIndex();
    let result: string | null = null;
    for (const variant of lookupVariants(token)) {
      const file = this.index?.get(variant);
      if (!file) continue;
      try {
        result = wikitextToMarkdown(fs.readFileSync(file, "utf8"), {
          title: variant,
        });
      } catch {
        result = null;
      }
      break;
    }

    this.cache.set(cacheKey, result);
    return result;
  }
}
