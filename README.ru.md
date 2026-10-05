# Поддержка QB64-PE (Phoenix Edition) для Zed

Расширение Zed для языка QB64-PE, построенное по образцу эталонного расширения
для VS Code — [`grymmjack/qb64pe-vscode`](https://github.com/grymmjack/qb64pe-vscode).

**Документация на других языках:** [English](README.md)

## Что входит

- Привязка файлов `.bas`, `.bi`, `.bm`.
- Грамматика Tree-sitter с полным словарём ключевых слов, встроенных функций и
  типов данных QB64-PE, плюс обработка метакоманд (`$CONSOLE`) и `'$INCLUDE`.
- Подсветка синтаксиса (ключевые слова, встроенные функции, типы, метакоманды,
  метки, операторы, скобки, doc-комментарии).
- Структура (outline) и хлебные крошки для `SUB`, `FUNCTION`, `TYPE`, `CONST` и
  прототипов `DECLARE SUB/FUNCTION`.
- Автоотступы с учётом блоков (`IF`/`FOR`/`DO`/`WHILE`/`SELECT CASE`/`TYPE`/
  `SUB`/`FUNCTION`/`DECLARE LIBRARY`/`$IF`) — как «Auto Indent» и «Indent SUBs
  and FUNCTIONs» в IDE QB64-PE.
- Сниппеты для типовых конструкций QBasic/QB64.
- Шаблоны задач `QB64-PE: Build` и `QB64-PE: Build and Run`.
- Автономный форматтер (`scripts/qb64pe-fmt.mjs`), переносящий безопасные
  автоотступы и опциональный регистр ключевых слов из расширения VS Code.
- Языковой сервер (`server/`): структура, сворачивание, диагностики, справка по
  hover, автодополнение, навигация (переход к определению, ссылки,
  переименование, подсказки сигнатур, символы workspace), иерархия вызовов,
  свотчи цветов и семантические токены по LSP. Запускается Rust-пускачом
  (`src/lib.rs`). См. [`docs/LSP_PLAN.md`](docs/LSP_PLAN.md).
- Отладчик исходного уровня (`server/src/dap/`): мост DAP к отладчику `vwatch`
  из QB64PE (точки останова, пошаговое выполнение, стек вызовов, живые значения
  переменных) с поддержкой `$INCLUDE` в нескольких файлах.

## Установка как Dev Extension

В Zed:

1. Откройте палитру команд.
2. Выполните `zed: install dev extension`.
3. Укажите этот каталог.

Документация Zed по Dev Extensions:
<https://zed.dev/docs/extensions/developing-extensions>

> Полный список требований, путь к грамматике, который нужно поправить в
> `extension.toml`, а также переменные окружения и `settings.json` для запуска
> языкового сервера и отладчика — в [`docs/BUILDING.md`](docs/BUILDING.md).
> Коротко: Rust с целью `wasm32-wasip2`, Node 24+ и установленный QB64PE.

> Грамматика загружается из вложенного git-репозитория `grammars/qb64`. После
> правки `grammars/qb64/grammar.js` выполните там `tree-sitter generate` и
> закоммитьте `src/parser.c` / `src/node-types.json`, чтобы Zed собрал
> обновлённый парсер. (Сам wasm Zed собирает через `wasi-sdk`.)

## Подсветка, структура и сворачивание

`languages/qb64/highlights.scm` покрывает комментарии (включая doc-комментарии
`' @param`), строки, числа, ключевые слова, встроенные функции (`_NEWIMAGE`,
`_RGB32`, …), типы данных, метакоманды (`$CONSOLE`, `$IF`, `'$INCLUDE:'…'`),
метки, операторы и скобки.

`languages/qb64/outline.scm` даёт элементы структуры (а значит и сворачивание)
для процедур и объявлений типов. `languages/qb64/brackets.scm` включает
«радужные» скобки.

## Автоотступы

Отступы реализованы паттернами уровня языка в `languages/qb64/config.toml`
(`increase_indent_pattern` / `decrease_indent_pattern`). Они вкладывают:

- блочные `IF` / `ELSE` / `ELSEIF` / `END IF` (однострочный `IF … THEN x` не
  трогается),
- `FOR` / `NEXT`, `DO` / `LOOP`, `WHILE` / `WEND`,
- `SELECT` / `CASE` / `END SELECT`,
- `TYPE` / `END TYPE`,
- `SUB` / `FUNCTION` / `END SUB` / `END FUNCTION`,
- `DECLARE LIBRARY` / `END DECLARE`,
- блоки условной компиляции `$IF` / `$ELSE` / `$END IF`.

`tab_size` равен `4`, `hard_tabs` — `false`; меняйте их в
`languages/qb64/config.toml`, если в вашем проекте другой стиль.

## Форматирование

Zed поддерживает внешние форматтеры. Укажите в настройках путь к
`scripts/qb64pe-fmt.mjs` (см. также документацию Zed про ключ `formatter`):

```json
{
  "languages": {
    "QB64-PE": {
      "formatter": {
        "external": {
          "command": "node",
          "arguments": ["/absolute/path/to/qb64-zed/scripts/qb64pe-fmt.mjs"]
        }
      }
    }
  }
}
```

Форматтер читает буфер со stdin и пишет результат в stdout. Его можно запускать
и напрямую:

```sh
node scripts/qb64pe-fmt.mjs --case upper program.bas
```

Параметры:

| Флаг | Что делает | По умолчанию |
| --- | --- | --- |
| `--indent-size N` | Пробелов на уровень отступа. | `4` |
| `--no-indent` | Отключить переотступы. | выкл. |
| `--no-indent-subs` | Не делать отступ в телах `SUB`/`FUNCTION`. | выкл. |
| `--case upper\|lower\|mixed\|none` | Регистр ключевых слов (аналог «Show Keywords as…» в QB64-PE). | `none` |
| `--normalize` | Переписать склеенные блочные ключевые слова (`ENDIF` → `END IF`, …). | выкл. |

Переотступы меняют только ведущие пробелы, поэтому их безопасно применять к
существующему коду. Регистр ключевых слов и `--normalize` переписывают текст
кода и включаются отдельно.

## Сниппеты

Сниппеты лежат в `snippets/qb64-pe.json` (зарегистрированы в `extension.toml`).
Покрыты `PRINT`, блочный `IF`, `FOR`/`NEXT`, `DO`/`LOOP`, `WHILE`/`WEND`,
`SELECT CASE`, `SUB`, `FUNCTION`, `TYPE`, `DECLARE LIBRARY`, `DIM`, `CONST` и
метакоманды `$CONSOLE` / `$INCLUDE` / `$IF`.

## Задачи

Zed автоматически подхватывает `languages/qb64/tasks.json`: через окно задач
(`task: spawn`) запускаются **QB64-PE: Build** и **QB64-PE: Build and Run**. Обе
вызывают `qb64pe` из `$PATH`; поправьте, если ваш исполняемый файл называется
иначе или лежит в другом месте. Также можно добавлять задачи проекта в
`.zed/tasks.json`.

## Настройки языка

`languages/qb64/config.toml` задаёт:

- `line_comments = ["' ", "REM "]` — используется действием «переключить
  комментарий».
- ``word_characters = ["$", "%", "&", "!", "#", "~", "@", "`"]`` — типовые сиглы
  входят в идентификаторы для выделения двойным щелчком и перемещения по словам.
- `tab_size = 4`, `hard_tabs = false`.

## Языковой сервер

`server/` содержит языковой сервер QB64-PE. Он использует вендоренные модули
`core/` из эталонного расширения (без зависимости от `vscode`): `lexer`,
`symbols`, `parser`, `index`, `queries`, `diagnostics`, `folding`, `keywords`,
`condCompile`, `format`, `wikitext`, `helpFiles`, `rename`, `callHierarchy`,
`colors`, `semantic`, `flatten`, `vwatch*`. По LSP/stdio сервер предоставляет:

- иерархическую структуру `textDocument/documentSymbol`;
- сворачивание с учётом блоков `textDocument/foldingRange`;
- живые диагностики `textDocument/publishDiagnostics` (дубли объявлений,
  неопределённые метки `GOTO`/`GOSUB`, вызовы несуществующих `SUB`, непрочитанные
  локальные переменные, неразрешённые `$INCLUDE`) на основе индекса символов
  `SymbolIndex`, который обходит граф `$INCLUDE`;
- `textDocument/hover` для пользовательских символов и встроенных ключевых слов;
- `textDocument/completion` — символы в области видимости, встроенные ключевые
  слова, дополнение полей `TYPE` после `owner.` и метакоманд после `$`;
- навигацию — `definition` (включая переход в цель `$INCLUDE`), `references`,
  `documentHighlight`, `rename` (с проверкой типового сигла), `signatureHelp` и
  `workspace/symbol` (Ctrl+T);
- `callHierarchy` (prepare / incoming / outgoing);
- `documentColor` / `colorPresentation` — встроенные свотчи для вызовов
  `_RGB32`/`_RGBA32`/`_RGB`/`_RGBA` и `_HSB*`/`_HSBA*` с литеральными
  аргументами, редактируемые из палитры;
- `semanticTokens/full` для пользовательских имён (включается в Zed настройкой
  `"semantic_tokens": "combined"`).

При старте сервер сканирует workspace на файлы `.bas`/`.bi`/`.bm` (с
ограничением и пропуском каталогов, начинающихся с точки), поэтому навигация
работает и по файлам, которые ещё не открывались. Синхронизация документа —
**инкрементальная**: правки `didChange` с диапазонами применяются к
отслеживаемому тексту.

У сервера нет зависимостей, он запускается напрямую под Node 24
(type-stripping):

```sh
cd server
node src/server.ts --stdio    # говорить по LSP через stdin/stdout
node test/smoke.mjs           # сквозной smoke-тест по JSON-RPC
```

### Справка по ключевым словам

Hover по встроенному ключевому слову показывает справку, сконвертированную на
лету из установленного вики QB64PE (`<install>/internal/help/*.txt`), а если
страница не найдена — краткое встроенное описание. Укажите каталог справки
переменной окружения или настройками LSP Zed:

```sh
# переменные окружения
export QB64PE_HELP_PATH=/path/to/QB64pe/internal/help
# либо, чтобы вывести <install>/internal/help:
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

Порядок такой: `initialization_options.helpPath`, затем
`initialization_options.installPath` + `/internal/help`, затем две переменные
окружения. Если ничего не задано, hover всё равно описывает встроенные имена.

Rust-пускач (`src/lib.rs`) находит сервер в таком порядке: бинарь `qb64pe-lsp` в
`$PATH`; иначе — Node, запускающий скрипт из переменной окружения
`QB64PE_LSP_SERVER`. Сам Node берётся из `QB64PE_NODE`, затем встроенный в Zed
(`node_binary_path`), затем `node` из `$PATH` — **нужен Node 24+ (или ≥ 22.18)**
для type-stripping TypeScript.

## Отладчик (`vwatch`)

`server/src/dap/dapServer.ts` — отладчик исходного уровня, который связывает DAP
с отладчиком `vwatch` из QB64PE, в точности как эталонное расширение для VS Code:
точки останова, пошаговое выполнение, стек вызовов и живые значения переменных
(локальные, модуль/глобальные, константы, массивы и поля `TYPE`). Он разворачивает
граф `$INCLUDE`, поэтому код в `.bi`/`.bm` тоже можно отлаживать, и сопоставляет
каждый останов с реальным файлом исходника.

Запускается под Node 24 (без зависимостей):

```sh
cd server
node src/dap/dapServer.ts --stdio   # говорить по DAP через stdin/stdout
# или: npm run dap
```

Rust-пускач находит адаптер в том же порядке, что и языковой сервер: бинарь
`qb64pe-dap` в `$PATH`, иначе — Node, запускающий скрипт из переменной окружения
`QB64PE_DAP_SERVER`. Путь к компилятору берётся из `compilerPath` конфигурации
запуска, а если его нет — из переменной окружения `QB64PE_COMPILER`. Конфигурация
запуска выглядит так:

```jsonc
{
  "label": "debug main.bas",
  "adapter": "QB64PE",
  "request": "launch",
  "program": "/absolute/path/to/main.bas",
  "compilerPath": "/absolute/path/to/QB64pe/qb64pe"
}
```

Все параметры описаны схемой `debug_adapter_schemas/QB64PE.json` (`program`,
`compilerPath`, `port`, `stopOnEntry`, `autoAddDebug`, `timeoutMs`).

> Кодек протокола и путь останова на точке останова покрыты тестом
> `server/test/dap-smoke.mjs` (юнит-тесты кодека плюс опциональная живая сессия,
> которая компилирует и запускает реальную программу, если задан
> `QB64PE_COMPILER`).

> Для сборки самого расширения нужна цель Rust `wasm32-wasip2` (Zed компилирует
> Rust расширения в wasm). Код проверен `cargo check` против
> `zed_extension_api` 0.7.0 и собственным smoke-тестом сервера; стандартной
> библиотеки для цели wasm в окружении автора не было.

## Статус относительно расширения для VS Code

Эталонное расширение `qb64pe-vscode` реализовано как extension host VS Code, а не
как переиспользуемый языковой сервер. Здесь его возможности перенесены в Zed
двумя host-процессами на Node:

- **редакторная часть** — грамматика, подсветка, структура/сворачивание,
  автоотступы, сниппеты, задачи сборки и форматтер;
- **языковой интеллект** — языковой сервер (`server/`): диагностики, hover со
  справкой, автодополнение, переход к определению/ссылки/переименование,
  подсказки сигнатур, иерархия вызовов, свотчи цветов и семантические токены;
- **отладчик** — адаптер DAP (`server/src/dap/`) поверх `vwatch` из QB64PE.

План работ и статус по этапам — в [`docs/LSP_PLAN.md`](docs/LSP_PLAN.md).

### Известное ограничение отладчика

Путь **останова** (точка останова / `stopOnEntry`) требует графического
окружения: `vwatch` вызывает `set_foreground_window`, и в headless-сессии
остановка может зависнуть. Путь запуска, `run`, стек вызовов и `quit` при этом
работают. Живые значения переменных и останов на точке останова стоит проверять в
обычной графической сессии.

## NixOS

Если `qb64pe` доступен в shell, из которого запускается Zed, задачи сборки
смогут вызвать его напрямую.

## Пересборка грамматики

Источник истины для грамматики — `grammars/qb64/grammar.js`. После правки:

```sh
cd grammars/qb64
npx tree-sitter-cli generate        # обновляет src/parser.c, src/node-types.json
```

## Лицензия

MIT — как и у эталонного расширения для VS Code.
