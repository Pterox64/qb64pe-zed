//! QB64-PE Zed extension entry point.
//!
//! The declarative parts of the extension (grammar, queries, snippets, tasks)
//! need no code. This Rust module exists for one reason: to tell Zed how to
//! launch the QB64-PE language server, which runs as an ordinary host process
//! and speaks LSP over stdio (a wasm component cannot host an LSP server).
//!
//! Resolution order for the server:
//!
//! 1. `qb64pe-lsp` on the user's `$PATH` — a self-contained binary, the
//!    intended distribution once binaries are published.
//! 2. Zed's bundled Node (`zed::node_binary_path`) or a `node` from `$PATH`,
//!    running the server script named by the `QB64PE_LSP_SERVER` environment
//!    variable. This is the development / bring-your-own-server path.

use zed_extension_api::{self as zed, Result};

/// Name of the standalone server binary looked up on `$PATH`.
const SERVER_BINARY: &str = "qb64pe-lsp";

/// Name of the standalone DAP adapter binary looked up on `$PATH`.
const DAP_BINARY: &str = "qb64pe-dap";

/// Environment variable holding an absolute path to the server entry script.
const SERVER_SCRIPT_ENV: &str = "QB64PE_LSP_SERVER";

/// Environment variable holding an absolute path to the DAP adapter script.
const DAP_SCRIPT_ENV: &str = "QB64PE_DAP_SERVER";

/// Environment variable overriding the Node executable used to run the servers.
const NODE_ENV: &str = "QB64PE_NODE";

struct Qb64Extension;

impl Qb64Extension {
    /// A command that starts `node <script> --stdio`.
    ///
    /// Resolution order for the Node binary: `QB64PE_NODE`, then Zed's bundled
    /// runtime (`zed::node_binary_path`), then a `node` from the worktree
    /// `$PATH`. The servers run their TypeScript sources directly, so Node 24+
    /// (or ≥22.18) is required for type-stripping.
    fn node_command(worktree: &zed::Worktree, script: &str) -> Result<zed::Command> {
        let node = Self::env_var(worktree, NODE_ENV)
            .or_else(|| zed::node_binary_path().ok())
            .or_else(|| worktree.which("node"))
            .ok_or_else(|| {
                format!(
                    "QB64-PE extension: no Node runtime found. The language server and \
                     debug adapter need Node 24+ (TypeScript type-stripping); install it, \
                     or set {NODE_ENV} to the Node executable."
                )
            })?;

        Ok(zed::Command {
            command: node,
            args: vec![script.to_string(), "--stdio".to_string()],
            env: Vec::new(),
        })
    }

    /// The value of an environment variable from the user's shell environment.
    fn env_var(worktree: &zed::Worktree, name: &str) -> Option<String> {
        worktree
            .shell_env()
            .into_iter()
            .find_map(|(key, value)| (key == name).then_some(value))
    }
}

impl zed::Extension for Qb64Extension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // 1. A standalone server binary on $PATH wins.
        if let Some(binary) = worktree.which(SERVER_BINARY) {
            return Ok(zed::Command {
                command: binary,
                args: vec!["--stdio".to_string()],
                env: Vec::new(),
            });
        }

        // 2. Otherwise run the TypeScript server with Node.
        let script = Self::env_var(worktree, SERVER_SCRIPT_ENV).ok_or_else(|| {
            format!(
                "QB64-PE language server not found. Install `{SERVER_BINARY}` on your \
                 $PATH, or set {SERVER_SCRIPT_ENV} to the path of `server/src/server.ts`."
            )
        })?;

        Self::node_command(worktree, &script)
    }

    fn get_dap_binary(
        &mut self,
        _adapter_name: String,
        config: zed::DebugTaskDefinition,
        _user_provided_debug_adapter_path: Option<String>,
        worktree: &zed::Worktree,
    ) -> Result<zed::DebugAdapterBinary, String> {
        // 1. A standalone DAP adapter binary on $PATH wins.
        let command = if let Some(binary) = worktree.which(DAP_BINARY) {
            (binary, vec!["--stdio".to_string()])
        } else {
            let script = Self::env_var(worktree, DAP_SCRIPT_ENV).ok_or_else(|| {
                format!(
                    "QB64-PE debug adapter not found. Install `{DAP_BINARY}` on your \
                     $PATH, or set {DAP_SCRIPT_ENV} to the path of `server/src/dap/dapServer.ts`."
                )
            })?;
            let node = zed::node_binary_path().map_err(|e| e.to_string())?;
            (node, vec![script, "--stdio".to_string()])
        };

        Ok(zed::DebugAdapterBinary {
            command: Some(command.0),
            arguments: command.1,
            envs: Vec::new(),
            cwd: None,
            connection: None,
            request_args: zed::StartDebuggingRequestArguments {
                configuration: config.config,
                request: zed::StartDebuggingRequestArgumentsRequest::Launch,
            },
        })
    }

    fn dap_request_kind(
        &mut self,
        _adapter_name: String,
        _config: zed::serde_json::Value,
    ) -> Result<zed::StartDebuggingRequestArgumentsRequest, String> {
        // The QB64-PE debugger always launches the program itself.
        Ok(zed::StartDebuggingRequestArgumentsRequest::Launch)
    }

    fn dap_config_to_scenario(
        &mut self,
        _adapter_name: zed::DebugConfig,
    ) -> Result<zed::DebugScenario, String> {
        let mut config: zed::serde_json::Map<String, zed::serde_json::Value> =
            match _adapter_name.request {
                zed::DebugRequest::Launch(launch) => {
                    let mut map = zed::serde_json::Map::new();
                    map.insert("program".into(), launch.program.into());
                    if let Some(cwd) = launch.cwd {
                        map.insert("cwd".into(), cwd.into());
                    }
                    if let Some(stop) = _adapter_name.stop_on_entry {
                        map.insert("stopOnEntry".into(), stop.into());
                    }
                    map
                }
                zed::DebugRequest::Attach(_) => {
                    return Err("QB64-PE debugging only supports launch requests.".into());
                }
            };
        // The compiler path is passed through an env var the adapter reads.
        if let Ok(value) = std::env::var("QB64PE_COMPILER") {
            config.insert("compilerPath".into(), value.into());
        }
        Ok(zed::DebugScenario {
            label: _adapter_name.label,
            adapter: _adapter_name.adapter,
            build: None,
            config: zed::serde_json::Value::Object(config).to_string(),
            tcp_connection: None,
        })
    }
}

zed::register_extension!(Qb64Extension);
