{
  description = "QB64-PE Zed extension development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;

    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };

          # Rust stable with the target Zed uses to compile the extension's
          # Rust part to WebAssembly. Zed runs `rustc` and `cargo` from PATH,
          # so they must be visible to the Zed process itself.
          rust = pkgs.rust-bin.stable.latest.default.override {
            targets = [ "wasm32-wasip2" ];
            extensions = [
              "rust-src"
              "rust-analyzer"
            ];
          };

          # Zed downloads a prebuilt wasi-sdk and runs its clang to compile
          # grammars to WebAssembly. That binary is built for a standard FHS
          # distro and dynamically links libtinfo.so.6 and libstdc++.so.6,
          # which are not on the NixOS loader path. Exposing them through
          # LD_LIBRARY_PATH lets the bundled clang load when Zed is started
          # from this shell.
          wasiSdkLibs = with pkgs; [
            ncurses
            stdenv.cc.cc.lib
          ];
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              rust

              # Node 24+ is required: the language server and debug adapter run
              # their TypeScript sources directly via type-stripping.
              nodejs_24

              # Zed shells out to git to check out the grammar, and
              # tree-sitter regenerates the parser.
              git
              tree-sitter

              # Start Zed from this shell so it inherits rustc/cargo above.
              zed-editor
            ];

            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath wasiSdkLibs}:$LD_LIBRARY_PATH"

              echo "QB64-PE Zed extension development environment"
              echo "rustc:  $(rustc --version)"
              echo "cargo:  $(cargo --version)"
              echo "node:   $(node --version)"
              echo
              echo "Launch Zed from this shell, then run 'zed: install dev extension'"
              echo "and pick this directory. Zed must see rustc/cargo in its PATH and"
              echo "wasi-sdk's clang must find libtinfo.so.6 / libstdc++.so.6."
            '';
          };
        }
      );
    };
}
