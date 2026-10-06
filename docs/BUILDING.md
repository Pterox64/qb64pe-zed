# Сборка и установка

> Обзор расширения и его возможностей — в [`README.ru.md`](../README.ru.md).

> **⚠️ Внимание:** Весь проект целиком написан ИИ. Автор его не проверял и
> вряд ли когда-нибудь проверит. Используйте на свой страх и риск.

Инструкция по сборке расширения и запуску всех его частей в Zed. В этом
репозитории есть четыре независимые части:

| Часть | Чем является | Чем запускается |
| --- | --- | --- |
| Грамматика | Tree-sitter-парсер (`tree-sitter/qb64/`) | Zed компилирует в wasm сам (wasi-sdk) |
| Расширение (Rust) | wasm-компонент (`src/lib.rs`) | Zed компилирует в `wasm32-wasip2` |
| Языковой сервер (LSP) | Node-процесс (`server/src/server.ts`) | запускает Rust-расширение |
| Отладчик (DAP) | Node-процесс (`server/src/dap/dapServer.ts`) | запускает Rust-расширение |

Rust-часть — только «пускач»: она сообщает Zed, чем запускать LSP и DAP. Сами
серверы — это обычные host-процессы (их нельзя собрать в wasm).

---

## 1. Требования

- **Zed** — версия, поддерживающая Dev Extensions и DAP
  (`zed: install dev extension`).
- **Rust** с целью `wasm32-wasip2`:

  ```sh
  rustup target add wasm32-wasip2
  ```

  > Zed использует именно `wasm32-wasip2`. Если Rust поставлен не через
  > `rustup` (например, из дистрибутива/Nix), цель нужно добавить вручную.
  > В этом репозитории есть `flake.nix`, где цель уже включена: см. §7.
- **wasi-sdk** — для сборки грамматики. Zed скачивает его сам; чтобы указать
  существующую установку, задайте `WASI_SDK_PATH` на её корень (тот, где лежит
  `bin/clang`).
- **Node 24+** (или ≥ 22.18) — серверы выполняют свои TypeScript-исходники
  напрямую через type-stripping, поэтому более старый Node не подойдёт.
  Проверить: `node --version`.
- **QB64PE** — для отладчика, задач сборки и hover-справки. Путь к компилятору
  (`.../qb64pe`) задаётся в конфигурации отладки или переменной окружения.

---

## 2. Настройка перед установкой

### 2.1. Источник грамматики

`extension.toml` берёт грамматику из публичного репозитория проекта:

```toml
[grammars.qb64]
repository = "https://github.com/Pterox64/qb64pe-zed"
rev = "main"
path = "tree-sitter/qb64"
```

Поле `path` указывает, что грамматика лежит в подкаталоге `tree-sitter/qb64`.
`rev` может быть веткой (`main` — удобно при правке грамматики) или коммитом
(надёжнее для воспроизводимости). Если вы форкнули репозиторий, замените
`repository` на URL своего форка.

Чтобы собирать грамматику из локальной копии без пуша, укажите абсолютный путь:

```toml
repository = "file:///абсолютный/путь/к/qb64pe-zed"
```

> Zed всегда клонирует грамматику в `<расширение>/grammars/qb64` и собирает
> `qb64.wasm` рядом. Этот каталог создаётся Zed при сборке и в репозитории не
> хранится (он в `.gitignore`); исходники грамматики лежат в `tree-sitter/qb64`.

### 2.2. Коммит и пуш грамматики

Zed собирает парсер из зафиксированной ревизии удалённого репозитория, поэтому
изменения грамматики нужно закоммитить **и** запушить в него:

```sh
git add tree-sitter/qb64 && git commit -m "Update grammar" && git push
```

Незакоммиченные (или незапушенные) правки `grammar.js`/`src/parser.c` Zed не
увидит. При работе через `file://`-путь из §2.1 достаточно локального коммита.

### 2.3. Метаданные расширения

В `extension.toml` поля `authors`, `repository` и `version` — заглушки; при
публикации их нужно заменить.

### 2.4. Проверка окружения сборки

```sh
cd server && npm run smoke      # серверы: Node 24+, без зависимостей
cd .. && node --version         # должно быть >= 24
```

---

## 3. Установка Dev Extension

1. Откройте палитру команд Zed и выполните **`zed: install dev extension`**.
2. Выберите **корень расширения** — каталог с `extension.toml`
   (не `tree-sitter/qb64`).
3. Zed сам соберёт Rust в wasm (`wasm32-wasip2`) и компилирует грамматику через
   wasi-sdk. Откройте `.bas` — должна появиться подсветка.

Zed документирует это здесь:
<https://zed.dev/docs/extensions/developing-extensions>

### Диагностика

- Логи: **`zed: open log`**. Подробнее — запустить Zed из терминала:
  `zed --foreground`.
- Если грамматика не подхватилась — почти всегда неверный `repository`/`path`
  в `extension.toml` или незакоммиченная ревизия в `tree-sitter/qb64`.
- Можно проверить Rust отдельно (без Zed):

  ```sh
  cargo check --target wasm32-wasip2
  ```

---

## 4. Настройка Zed

### 4.1. Пути к серверам

Rust-пускач находит серверы так:

1. бинарь `qb64pe-lsp` / `qb64pe-dap` в `$PATH` (self-contained вариант);
2. иначе — Node (сначала `QB64PE_NODE`, потом встроенный в Zed, потом `node` из
   `$PATH`) и скрипт из переменной окружения;
3. если переменная не задана, а в рабочей области открыта копия этого
   репозитория (`extension.toml` с `id = "qb64"`), берётся её скрипт
   `server/src/server.ts` или `server/src/dap/dapServer.ts`. Так серверы
   стартуют прямо из исходников — достаточно открыть этот репозиторий в Zed.

Для запуска из исходников, когда репозиторий не открыт как рабочая область,
задайте в окружении, из которого стартует Zed:

```sh
export QB64PE_LSP_SERVER=/абсолютный/путь/qb64pe-zed/server/src/server.ts
export QB64PE_DAP_SERVER=/абсолютный/путь/qb64pe-zed/server/src/dap/dapServer.ts
# если встроенный Node в Zed старее 24:
export QB64PE_NODE=/путь/к/node
# компилятор QB64PE (для отладчика):
export QB64PE_COMPILER=/путь/к/QB64pe/qb64pe
```

### 4.2. Путь к справке (hover)

Hover по встроенным именам конвертирует вики-справку из установленного QB64PE.
Источники (по приоритету): `initialization_options`, затем переменные окружения:

```sh
export QB64PE_HELP_PATH=/путь/к/QB64pe/internal/help
# либо, чтобы вывести <install>/internal/help:
export QB64PE_INSTALL_PATH=/путь/к/QB64pe
```

### 4.3. `settings.json`

```jsonc
{
  "lsp": {
    "qb64pe": {
      "initialization_options": {
        "helpPath": "/путь/к/QB64pe/internal/help"
      }
    }
  },
  "languages": {
    "QB64-PE": {
      // Семантические токены для пользовательских имён поверх tree-sitter.
      "semantic_tokens": "combined",
      // Внешний форматтер (см. scripts/qb64pe-fmt.mjs).
      "formatter": {
        "external": {
          "command": "node",
          "arguments": ["/абсолютный/путь/qb64pe-zed/scripts/qb64pe-fmt.mjs"]
        }
      }
    }
  }
}
```

### 4.4. Запуск отладчика

Добавьте сценарий в `.zed/debug.json` (палитра: **`zed: open debug`**):

```jsonc
[
  {
    "label": "Debug current file",
    "adapter": "QB64PE",
    "request": "launch",
    "program": "$ZED_FILE",
    "compilerPath": "/путь/к/QB64pe/qb64pe"
  }
]
```

Схема всех параметров —
[`debug_adapter_schemas/QB64PE.json`](../debug_adapter_schemas/QB64PE.json):
`program`, `compilerPath`, `port`, `stopOnEntry`, `autoAddDebug`, `timeoutMs`.
`compilerPath` можно не указывать, если задан `QB64PE_COMPILER`.

---

## 5. Проверка

```sh
# Rust-расширение компилируется (host-проверка API):
cargo check

# Языковой сервер: юнит- и интеграционные тесты (JSON-RPC, 80 проверок):
cd server && npm run smoke

# Отладчик: юнит-тесты кодека + живая сессия с реальным компилятором (30 проверок):
QB64PE_COMPILER=/путь/к/QB64pe/qb64pe npm run dap:smoke
```

Живой DAP-тест компилирует и запускает программу, поэтому без переменной
`QB64PE_COMPILER` он пропускается (кодек при этом всё равно проверяется).

### Известное ограничение отладчика

Путь **останова** (breakpoint / `stopOnEntry`) требует графического окружения:
`vwatch` вызывает `set_foreground_window`, и в headless-сессии остановка может
зависнуть. Путь запуска, `run`, call stack и `quit` при этом работают. Проверку
останова и живых значений переменных стоит делать в обычной графической сессии.

---

## 6. Правка грамматики

Источник истины — `tree-sitter/qb64/grammar.js`. После правки:

```sh
cd tree-sitter/qb64
tree-sitter generate        # обновляет src/parser.c и src/node-types.json
cd ../..
git add tree-sitter/qb64 && git commit -m "..."
```

Сгенерированный `src/grammar.json` не должен попадать в коммит (он в
`.gitignore`).

---

## 7. Nix / NixOS

В репозитории есть `flake.nix` с готовым окружением: Rust stable, цель
`wasm32-wasip2`, Node 24, `git`, `tree-sitter` и Zed.

```sh
nix develop
zed .
```

Zed запускает `rustc` и `cargo` из своего `PATH`, поэтому его нужно запускать
**из этого шелла** (ранее запущенный экземпляр — закрыть). Если хотите
остаться на системном Zed, уберите `zed-editor` из `packages` в `flake.nix` и
запускайте свой бинарь внутри `nix develop`.

Zed скачивает готовый `wasi-sdk` и вызывает его `clang`, чтобы собрать
грамматику в wasm (`tree-sitter/qb64` → `grammars/qb64/qb64.wasm`). Этот бинарь
рассчитан на обычный FHS-дистрибутив и подгружает `libtinfo.so.6` и
`libstdc++.so.6`, которых нет в путях загрузчика NixOS. Без них шаг сборки
грамматики падает с `error while loading shared libraries: libtinfo.so.6:
cannot open shared object file`. `flake.nix` уже добавляет эти библиотеки в
`LD_LIBRARY_PATH`, поэтому Zed нужно запускать именно из `nix develop`.

Альтернатива: собрать грамматику через wasi-sdk из Nix. Zed понимает
переменную `WASI_SDK_PATH` (корень с `bin/clang`); можно задать её вместо
`LD_LIBRARY_PATH`:

```sh
WASI_SDK_PATH=$(nix build --no-link --print-out-paths nixpkgs#wasi-sdk) zed .
```

Если Rust ставится из Nix иначе, цель `wasm32-wasip2` нужно добавить в тулчейн
(rust-overlay / fenix) или использовать `rustup`.

Если `qb64pe` и Node 24 доступны в shell, из которого запускается Zed,
серверы и задачи сборки находят их через `$PATH`.

---

## 8. Что проверено в этом окружении

- Rust-расширение собирается в wasm-компонент (Zed выполняет
  `cargo build --target wasm32-wasip2` при установке Dev Extension);
- грамматика `tree-sitter/qb64` компилируется в wasm встроенным wasi-sdk
  (см. §7), `grammars/qb64/qb64.wasm` получается успешно;
- поведение LSP и DAP проверено сквозными тестами против реального QB64PE 4.7.0.

Сам GUI-сценарий `zed: install dev extension` требует графической сессии и
выполняется вручную один раз (§3).
