//! QB64-PE Zed extension entry point.
//!
//! The declarative parts of the extension (grammar, queries, snippets, tasks)
//! need no code. This Rust module exists for one reason: to tell Zed how to
//! launch the QB64-PE language server and debug adapter, which run as ordinary
//! host processes and speak LSP/DAP over stdio (a wasm component cannot host
//! such a server).
//!
//! Resolution order for each server:
//!
//! 1. `qb64pe-lsp` / `qb64pe-dap` on the user's `$PATH` — a self-contained
//!    binary, for users who build or install one themselves.
//! 2. The script named by `QB64PE_LSP_SERVER` / `QB64PE_DAP_SERVER`, an explicit
//!    override for development.
//! 3. The script inside a checkout of this very repository, when that checkout
//!    is the opened worktree. This lets developers run their local edits without
//!    any configuration.
//! 4. The server bundled with the latest GitHub release of this repository,
//!    downloaded on demand. This is what makes a registry/published install
//!    work with no local checkout and no environment variables.
//!
//! Steps 2–4 run the TypeScript sources with Node, which strips the types, so
//! they need Node 24+ (or ≥ 22.18). The Node binary is taken from `QB64PE_NODE`,
//! then Zed's managed runtime (`zed::node_binary_path`), then a `node` from the
//! worktree `$PATH`.

use std::fs;

use zed_extension_api::{
    self as zed, DownloadedFileType, GithubReleaseOptions, LanguageServerId,
    LanguageServerInstallationStatus, Result,
};

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

/// Extension manifest, used to recognize a checkout of this repository.
const MANIFEST_PATH: &str = "extension.toml";

/// Value that identifies this extension in [`MANIFEST_PATH`].
const EXTENSION_ID: &str = "id = \"qb64\"";

/// Server entry script, relative to the repository root.
const SERVER_SCRIPT_PATH: &str = "server/src/server.ts";

/// DAP adapter entry script, relative to the repository root.
const DAP_SCRIPT_PATH: &str = "server/src/dap/dapServer.ts";

/// GitHub repository whose releases carry the prebuilt server sources.
const RELEASE_REPOSITORY: &str = "Pterox64/qb64pe-zed";

/// Release asset holding the server sources (a gzipped tarball of `server/`).
const SERVER_ASSET: &str = "qb64pe-server.tar.gz";

/// Prefix of the per-version directory the release asset is unpacked into.
const SERVER_DIR_PREFIX: &str = "qb64pe-server";

struct Qb64Extension {
    /// Extension-relative directory of the unpacked server, once resolved.
    cached_server_dir: Option<String>,
}

impl Qb64Extension {
    /// A command that starts `node <script> --stdio`.
    ///
    /// `script` must be an absolute path. Resolution order for the Node binary:
    /// `QB64PE_NODE`, then Zed's managed runtime (`zed::node_binary_path`), then
    /// a `node` from the worktree `$PATH`. The servers run their TypeScript
    /// sources directly, so Node 24+ (or ≥ 22.18) is required for type-stripping.
    fn node_command(worktree: &zed::Worktree, script: &str) -> Result<zed::Command> {
        Ok(zed::Command {
            command: Self::node_binary(worktree)?,
            args: vec![script.to_string(), "--stdio".to_string()],
            env: Vec::new(),
        })
    }

    /// Locates the Node executable used to run the servers.
    fn node_binary(worktree: &zed::Worktree) -> Result<String> {
        Self::env_var(worktree, NODE_ENV)
            .or_else(|| zed::node_binary_path().ok())
            .or_else(|| worktree.which("node"))
            .ok_or_else(|| {
                format!(
                    "QB64-PE extension: no Node runtime found. The language server and \
                     debug adapter need Node 24+ (TypeScript type-stripping); install it, \
                     or set {NODE_ENV} to the Node executable."
                )
            })
    }

    /// The value of an environment variable from the user's shell environment.
    fn env_var(worktree: &zed::Worktree, name: &str) -> Option<String> {
        worktree
            .shell_env()
            .into_iter()
            .find_map(|(key, value)| (key == name).then_some(value))
    }

    /// Resolves a path relative to the extension's own working directory.
    fn extension_absolute(relative: &str) -> Result<String> {
        let cwd = std::env::current_dir().map_err(|error| {
            format!("QB64-PE extension: cannot resolve its working directory: {error}")
        })?;
        Ok(cwd.join(relative).to_string_lossy().into_owned())
    }

    /// Locates a server script inside the opened worktree.
    ///
    /// This lets the servers run straight from a checkout of this extension's
    /// own repository, so opening it in Zed works without any environment
    /// variables. The worktree is only treated as that repository when its
    /// manifest carries this extension's id, so unrelated projects are never
    /// misdetected.
    fn worktree_script(worktree: &zed::Worktree, relative: &str) -> Option<String> {
        let manifest = worktree.read_text_file(MANIFEST_PATH).ok()?;
        if !manifest.contains(EXTENSION_ID) {
            return None;
        }
        // Confirm the entry script actually exists before handing it to Node.
        worktree.read_text_file(relative).ok()?;
        let root = worktree.root_path();
        Some(format!("{}/{}", root.trim_end_matches('/'), relative))
    }

    /// Whether `dir` already holds an unpacked server bundle.
    fn server_dir_ready(dir: &str) -> bool {
        fs::metadata(format!("{dir}/{SERVER_SCRIPT_PATH}")).is_ok_and(|stat| stat.is_file())
            && fs::metadata(format!("{dir}/{DAP_SCRIPT_PATH}")).is_ok_and(|stat| stat.is_file())
    }

    /// Ensures the release server bundle is present, downloading it if needed.
    ///
    /// Returns the extension-relative directory holding `server/src/...`.
    fn ensure_server(&mut self, language_server_id: Option<&LanguageServerId>) -> Result<String> {
        if let Some(dir) = self.cached_server_dir.as_ref() {
            if Self::server_dir_ready(dir) {
                return Ok(dir.clone());
            }
        }

        if let Some(id) = language_server_id {
            zed::set_language_server_installation_status(
                id,
                &LanguageServerInstallationStatus::CheckingForUpdate,
            );
        }

        let release = zed::latest_github_release(
            RELEASE_REPOSITORY,
            GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )
        .map_err(|error| {
            format!(
                "QB64-PE server not found, and the latest release of {RELEASE_REPOSITORY} \
                 could not be resolved: {error}. Install `{SERVER_BINARY}` on your $PATH, \
                 or set {SERVER_SCRIPT_ENV} to the path of `{SERVER_SCRIPT_PATH}`."
            )
        })?;

        let dir = format!("{SERVER_DIR_PREFIX}-{}", release.version);
        if Self::server_dir_ready(&dir) {
            if let Some(id) = language_server_id {
                zed::set_language_server_installation_status(
                    id,
                    &LanguageServerInstallationStatus::None,
                );
            }
            self.cached_server_dir = Some(dir.clone());
            return Ok(dir);
        }

        let asset = release
            .assets
            .into_iter()
            .find(|asset| asset.name == SERVER_ASSET)
            .ok_or_else(|| {
                format!(
                    "QB64-PE extension: release {} of {RELEASE_REPOSITORY} has no asset \
                     named `{SERVER_ASSET}`.",
                    release.version
                )
            })?;

        if let Some(id) = language_server_id {
            zed::set_language_server_installation_status(
                id,
                &LanguageServerInstallationStatus::Downloading,
            );
        }

        zed::download_file(&asset.download_url, &dir, DownloadedFileType::GzipTar).map_err(
            |error| {
                format!(
                    "QB64-PE extension: failed to download the server bundle from {}: {error}",
                    asset.download_url
                )
            },
        )?;

        if !Self::server_dir_ready(&dir) {
            return Err(format!(
                "QB64-PE extension: the downloaded archive from {} did not contain \
                 `{SERVER_SCRIPT_PATH}` and `{DAP_SCRIPT_PATH}`.",
                asset.download_url
            ));
        }

        remove_outdated_versions(&dir);

        if let Some(id) = language_server_id {
            zed::set_language_server_installation_status(
                id,
                &LanguageServerInstallationStatus::None,
            );
        }

        self.cached_server_dir = Some(dir.clone());
        Ok(dir)
    }
}

/// Removes server directories left by previously downloaded releases.
fn remove_outdated_versions(version_dir: &str) {
    let Ok(entries) = fs::read_dir(".") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(SERVER_DIR_PREFIX) && name != version_dir {
            fs::remove_dir_all(entry.path()).ok();
        }
    }
}

impl zed::Extension for Qb64Extension {
    fn new() -> Self {
        Self {
            cached_server_dir: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
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

        // 2. Otherwise run the TypeScript server with Node, either from the
        //    path in the environment or from this repository's own checkout.
        if let Some(script) = Self::env_var(worktree, SERVER_SCRIPT_ENV)
            .or_else(|| Self::worktree_script(worktree, SERVER_SCRIPT_PATH))
        {
            return Self::node_command(worktree, &script);
        }

        // 3. Last resort: download the server bundled with the latest release.
        let dir = self.ensure_server(Some(language_server_id))?;
        let script = Self::extension_absolute(&format!("{dir}/{SERVER_SCRIPT_PATH}"))?;
        Self::node_command(worktree, &script)
    }

    fn get_dap_binary(
        &mut self,
        _adapter_name: String,
        config: zed::DebugTaskDefinition,
        _user_provided_debug_adapter_path: Option<String>,
        worktree: &zed::Worktree,
    ) -> Result<zed::DebugAdapterBinary> {
        // 1. A standalone DAP adapter binary on $PATH wins.
        if let Some(binary) = worktree.which(DAP_BINARY) {
            return Ok(Self::dap_binary(
                binary,
                vec!["--stdio".to_string()],
                config.config,
            ));
        }

        // 2. Otherwise run the TypeScript adapter with Node, resolving the Node
        //    binary exactly like the language server does.
        if let Some(script) = Self::env_var(worktree, DAP_SCRIPT_ENV)
            .or_else(|| Self::worktree_script(worktree, DAP_SCRIPT_PATH))
        {
            let command = Self::node_command(worktree, &script)?;
            return Ok(Self::dap_binary(
                command.command,
                command.args,
                config.config,
            ));
        }

        // 3. Last resort: download the adapter bundled with the latest release.
        let dir = self.ensure_server(None)?;
        let script = Self::extension_absolute(&format!("{dir}/{DAP_SCRIPT_PATH}"))?;
        let command = Self::node_command(worktree, &script)?;
        Ok(Self::dap_binary(
            command.command,
            command.args,
            config.config,
        ))
    }

    fn dap_request_kind(
        &mut self,
        _adapter_name: String,
        _config: zed::serde_json::Value,
    ) -> Result<zed::StartDebuggingRequestArgumentsRequest> {
        // The QB64-PE debugger always launches the program itself.
        Ok(zed::StartDebuggingRequestArgumentsRequest::Launch)
    }

    fn dap_config_to_scenario(
        &mut self,
        _adapter_name: zed::DebugConfig,
    ) -> Result<zed::DebugScenario> {
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

impl Qb64Extension {
    /// Builds the `DebugAdapterBinary` returned to Zed.
    fn dap_binary(
        command: String,
        arguments: Vec<String>,
        configuration: String,
    ) -> zed::DebugAdapterBinary {
        zed::DebugAdapterBinary {
            command: Some(command),
            arguments,
            envs: Vec::new(),
            cwd: None,
            connection: None,
            request_args: zed::StartDebuggingRequestArguments {
                configuration,
                request: zed::StartDebuggingRequestArgumentsRequest::Launch,
            },
        }
    }
}

zed::register_extension!(Qb64Extension);
