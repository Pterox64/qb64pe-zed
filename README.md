# QB64-PE (Phoenix Edition) support for Zed

A Zed language extension for QB64-PE, modelled on the reference VS Code
extension [`grymmjack/qb64pe-vscode`](https://github.com/grymmjack/qb64pe-vscode).

**Read this in other languages:** [Русский](README.ru.md)

> **⚠️ Warning:** This entire project was written by AI. The author has not
> reviewed it and is unlikely to ever review it. Use it at your own risk.

## Included

- `.bas`, `.bi`, `.bm` file association.
- Tree-sitter grammar with the full QB64-PE keyword, built-in and data-type
  vocabulary, plus `$metacommand` / `'$INCLUDE` handling.
- Syntax highlighting (keywords, built-ins, types, metacommands, labels,
  operators, brackets, doc comments).
- Outline / breadcrumbs for `SUB`, `FUNCTION`, `TYPE`, `CONST` and
  `DECLARE SUB/FUNCTION` prototypes.
- Block-aware auto-indentation (`IF`/`FOR`/`DO`/`WHILE`/`SELECT CASE`/
  `TYPE`/`SUB`/`FUNCTION`/`DECLARE LIBRARY`/`$IF`), matching the QB64-PE IDE's
  "Auto Indent" and "Indent SUBs and FUNCTIONs" behaviour.
- Snippets for the common QBasic/QB64 constructs.
- `QB64-PE: Build` and `QB64-PE: Build and Run` task templates.
- A standalone formatter (`scripts/qb64pe-fmt.mjs`) that ports the VS Code
  extension's safe re-indentation and optional keyword casing.
- An experimental language server (`server/`) providing outline, folding,
  diagnostics, hover help, completion, navigation (definition, references,
  rename, signature help, workspace symbols), call hierarchy, colour swatches
  and semantic tokens via LSP; a Rust launcher (`src/lib.rs`) starts it. See
  [`docs/LSP_PLAN.md`](docs/LSP_PLAN.md).
- A source-level debugger (`server/src/dap/`) bridging DAP to QB64PE's `vwatch`
  (breakpoints, stepping, call stack, live variables), with multi-file
  `$INCLUDE` support.

## Install as a Dev Extension

In Zed:

1. Open the Command Palette.
2. Run `zed: install dev extension`.
3. Select this directory.

Zed documents Dev Extensions here:
<https://zed.dev/docs/extensions/developing-extensions>

> Full prerequisites, how the grammar is fetched in `extension.toml`, and the
> environment variables / `settings.json` needed to run the language server and
> debugger are in [`docs/BUILDING.md`](docs/BUILDING.md). In short: Rust with the
> `wasm32-wasip2` target, Node 24+, and a QB64PE install.

> The grammar lives in this repository under `tree-sitter/qb64` and is fetched
> from the public GitHub repository. After changing `tree-sitter/qb64/grammar.js`,
> run `tree-sitter generate` there and commit **and push** `src/parser.c` /
> `src/node-types.json` so Zed builds the updated parser. (Zed compiles the
> grammar to WebAssembly itself via `wasi-sdk`.)

## Syntax highlighting, outline and folding

`languages/qb64/highlights.scm` covers comments (including `' @param`
documentation comments), strings, numbers, keywords, built-in procedures
(`_NEWIMAGE`, `_RGB32`, …), data types, metacommands (`$CONSOLE`, `$IF`,
`'$INCLUDE:'…'`), labels, operators and brackets.

`languages/qb64/outline.scm` provides outline items (and therefore folding)
for routine and type declarations. `languages/qb64/brackets.scm` enables
rainbow brackets.

## Auto-indentation

Indentation is implemented with the language-level patterns in
`languages/qb64/config.toml` (`increase_indent_pattern` /
`decrease_indent_pattern`). It nests:

- block `IF` / `ELSE` / `ELSEIF` / `END IF` (single-line `IF … THEN x` is left alone),
- `FOR` / `NEXT`, `DO` / `LOOP`, `WHILE` / `WEND`,
- `SELECT` / `CASE` / `END SELECT`,
- `TYPE` / `END TYPE`,
- `SUB` / `FUNCTION` / `END SUB` / `END FUNCTION`,
- `DECLARE LIBRARY` / `END DECLARE`,
- `$IF` / `$ELSE` / `$END IF` conditional-compilation blocks.

`tab_size` is `4` and `hard_tabs` is `false`; change them in
`languages/qb64/config.toml` if your project uses a different style.

## Formatting

Zed supports external formatters. Point Zed at `scripts/qb64pe-fmt.mjs` in your
settings (see also the extension's own docs for the `formatter` key):

```json
{
  "languages": {
    "QB64-PE": {
      "formatter": {
        "external": {
          "command": "node",
          "arguments": ["/absolute/path/to/qb64pe-zed/scripts/qb64pe-fmt.mjs"]
        }
      }
    }
  }
}
```

The formatter reads the buffer on stdin and writes the result to stdout. It can
also be run directly:

```sh
node scripts/qb64pe-fmt.mjs --case upper program.bas
```

Options:

| Flag | Description | Default |
| --- | --- | --- |
| `--indent-size N` | Spaces per indent level. | `4` |
| `--no-indent` | Disable re-indentation. | off |
| `--no-indent-subs` | Do not indent `SUB`/`FUNCTION` bodies. | off |
| `--case upper\|lower\|mixed\|none` | Keyword casing (QB64-PE "Show Keywords as…"). | `none` |
| `--normalize` | Rewrite glued block keywords (`ENDIF` → `END IF`, …). | off |

Re-indentation only ever changes leading whitespace, so it is safe to run on
existing code. Keyword casing and `--normalize` rewrite code text and are
opt-in.

## Snippets

Snippets live in `snippets/qb64-pe.json` (registered in `extension.toml`). They
cover `PRINT`, block `IF`, `FOR`/`NEXT`, `DO`/`LOOP`, `WHILE`/`WEND`,
`SELECT CASE`, `SUB`, `FUNCTION`, `TYPE`, `DECLARE LIBRARY`, `DIM`, `CONST` and
the `$CONSOLE` / `$INCLUDE` / `$IF` metacommands.

## Tasks

Zed picks up `languages/qb64/tasks.json` automatically: use the task modal
(`task: spawn`) to run **QB64-PE: Build** or **QB64-PE: Build and Run**. Both
invoke `qb64pe` from your `PATH`; adjust if your executable has another name or
location. You can also add project-local tasks in `.zed/tasks.json`.

## Language settings

`languages/qb64/config.toml` sets:

- `line_comments = ["' ", "REM "]` — used by the toggle-comment action.
- ``word_characters = ["$", "%", "&", "!", "#", "~", "@", "`"]`` — type sigils are
  part of identifiers for double-click selection and word motions.
- `tab_size = 4`, `hard_tabs = false`.

## Language server (experimental)

`server/` holds the beginnings of a QB64-PE language server: it vendors the
reference extension's `vscode`-free `core/` modules (`lexer`, `symbols`,
`parser`, `index`, `queries`, `diagnostics`, `folding`, `keywords`,
`condCompile`, `format`, `wikitext`, `helpFiles`) and serves, over LSP/stdio:

- a hierarchical `textDocument/documentSymbol` outline;
- block-aware `textDocument/foldingRange`;
- live `textDocument/publishDiagnostics` (duplicate definitions, undefined
  `GOTO`/`GOSUB` labels, undefined `SUB` calls, unread locals, unresolved
  `$INCLUDE`), driven by a workspace `SymbolIndex` that follows the `$INCLUDE`
  graph;
- `textDocument/hover` for user symbols and built-in keywords;
- `textDocument/completion` — symbols in scope, built-in keywords, `TYPE`
  member completion after `owner.`, and metacommand completion after `$`;
- navigation — `definition` (including jumping into `$INCLUDE` targets),
  `references`, `documentHighlight`, `rename` (with type-sigil validation),
  `signatureHelp`, and `workspace/symbol` (Ctrl+T);
- `callHierarchy` (prepare / incoming / outgoing);
- `documentColor` / `colorPresentation` — inline swatches for
  `_RGB32`/`_RGBA32`/`_RGB`/`_RGBA` and `_HSB*`/`_HSBA*` calls with literal args,
  rewritable from the picker;
- `semanticTokens/full` for user-defined names (enable in Zed with
  `"semantic_tokens": "combined"`).

At startup the server scans the workspace for `.bas`/`.bi`/`.bm` files (bounded,
skipping dot-directories) so navigation works across files that have not been
opened. Document sync is **incremental** (`didChange` ranged edits are applied
to the tracked text).

It has no dependencies and runs directly under Node 24 (type-stripping):

```sh
cd server
node src/server.ts --stdio    # speak LSP on stdin/stdout
node test/smoke.mjs           # end-to-end JSON-RPC smoke test
```

### Keyword help

Hover on a built-in keyword shows help converted live from the installed QB64PE
wiki (`<install>/internal/help/*.txt`), falling back to a short built-in
description when no help is found. Point the server at a help directory with
either an environment variable or Zed's LSP settings:

```sh
# shell environment
export QB64PE_HELP_PATH=/path/to/QB64pe/internal/help
# or, deriving <install>/internal/help:
export QB64PE_INSTALL_PATH=/path/to/QB64pe
```

```jsonc
// Zed settings.json
{
  "lsp": {
    "qb64pe": {
      "initialization_options": { "helpPath": "/path/to/QB64pe/internal/help" }
    }
  }
}
```

The order is: `initialization_options.helpPath`, then
`initialization_options.installPath` + `/internal/help`, then the two
environment variables. Without any of them, hover still describes built-ins.

The Rust launcher (`src/lib.rs`) resolves the server in this order: a
`qb64pe-lsp` binary on `$PATH`; otherwise Node running the script named by the
`QB64PE_LSP_SERVER` environment variable. The Node binary itself is taken from
`QB64PE_NODE`, then Zed's bundled runtime (`node_binary_path`), then `node` on
`$PATH` — **Node 24+ (or ≥ 22.18) is required** for TypeScript type-stripping.

## Debugger (`vwatch`)

`server/src/dap/dapServer.ts` is a source-level debug adapter that bridges DAP to
QB64PE's own `vwatch` debugger, exactly like the reference VS Code extension:
breakpoints, stepping, call stack, and live variables (locals, module/globals,
constants, arrays and TYPE members). It flattens the `$INCLUDE` graph so code in
`.bi`/`.bm` files is breakpointable, and maps every stop back to its real source
file.

It runs under Node 24 (no dependencies):

```sh
cd server
node src/dap/dapServer.ts --stdio   # speak DAP on stdin/stdout
# or: npm run dap
```

The Rust launcher resolves the adapter in the same order as the language server:
a `qb64pe-dap` binary on `$PATH`, otherwise Node running the script named by the
`QB64PE_DAP_SERVER` environment variable. The compiler path is taken from the
launch config's `compilerPath`, falling back to the `QB64PE_COMPILER`
environment variable. A launch configuration looks like:

```jsonc
{
  "label": "debug main.bas",
  "adapter": "QB64PE",
  "request": "launch",
  "program": "/absolute/path/to/main.bas",
  "compilerPath": "/absolute/path/to/QB64pe/qb64pe"
}
```

The `debug_adapter_schemas/QB64PE.json` schema documents every option
(`program`, `compilerPath`, `port`, `stopOnEntry`, `autoAddDebug`, `timeoutMs`).

> The protocol codec and the stop-on-breakpoint path are covered by
> `server/test/dap-smoke.mjs` (codec unit tests, plus an opt-in live session
> that compiles and runs a real program when `QB64PE_COMPILER` is set).

> Building the extension itself needs the `wasm32-wasip2` Rust target (Zed
> compiles extension Rust to wasm). The code is validated by `cargo check`
> against `zed_extension_api` 0.7.0 and by the server's own smoke test; the
> wasm target's standard library was not available in the authoring
> environment.

## Status vs. the VS Code extension

`qb64pe-vscode` is implemented as a VS Code extension host, not as a reusable
language server. Its capabilities are brought to Zed here by two Node host
processes:

- **editing** — grammar, highlighting, outline/folding, auto-indentation,
  snippets, build tasks and formatting;
- **language intelligence** — the language server (`server/`): diagnostics, hover
  help, completion, go-to-definition / references / rename, signature help, call
  hierarchy, colour swatches and semantic tokens;
- **debugger** — the DAP adapter (`server/src/dap/`) over QB64PE's `vwatch`.

The plan and per-stage status live in [`docs/LSP_PLAN.md`](docs/LSP_PLAN.md).

### Known debugger limitation

The **stop** path (breakpoint / `stopOnEntry`) needs a graphical environment:
`vwatch` calls `set_foreground_window`, so in a headless session a stop can hang.
Launching, `run`, the call stack and `quit` work regardless. Live variable values
and breakpoint stops are best verified in a normal graphical session.

## Nix / NixOS

The repository ships a `flake.nix` with a ready environment: Rust stable with
the `wasm32-wasip2` target, Node 24, `git`, `tree-sitter` and Zed.

```sh
nix develop
zed .
```

Zed resolves `rustc`/`cargo` from its own `PATH`, so launch it **from that
shell** (close any already-running instance first). To stay on your system Zed,
drop `zed-editor` from `packages` in `flake.nix` and run your own binary inside
`nix develop`.

Zed downloads a prebuilt `wasi-sdk` and runs its `clang` to compile the grammar
to wasm. That binary targets a plain FHS distribution and loads
`libtinfo.so.6` and `libstdc++.so.6`, which are absent from the NixOS loader
path, so the **compiling grammar `qb64`** step fails with
`libtinfo.so.6: cannot open shared object file`. `flake.nix` already forwards
those libraries via `LD_LIBRARY_PATH`, so launch Zed from `nix develop`.

If `qb64pe` is available in the shell from which Zed is launched, the build
tasks can invoke it directly.

## Regenerating the grammar

The grammar source of truth is `tree-sitter/qb64/grammar.js`. After editing it:

```sh
cd tree-sitter/qb64
npx tree-sitter-cli generate        # updates src/parser.c, src/node-types.json
git add src && git commit -m "Update grammar" && git push
```

`extension.toml` fetches the grammar from the public repository, so the change is
only picked up once it is pushed.

## License

MIT, mirroring the upstream VS Code extension.
