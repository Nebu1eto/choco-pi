/**
 * Tool definition types and the TOOLS catalog of install recipes.
 */

// --- Tool Definitions ---

interface GitHubAssetSpec {
  /** owner/repo on GitHub */
  repo: string;
  /**
   * Return the asset filename substring to match for this platform/arch,
   * or undefined if the platform is unsupported.
   * platform: "linux" | "darwin" | "win32"
   * arch:     "x64" | "arm64" | "ia32" | ...
   */
  assetMatch: (platform: string, arch: string) => string | undefined;
  /**
   * If the asset is an archive, the name of the binary inside it.
   * For bare .gz files (e.g. rust-analyzer) leave undefined — the asset IS the binary.
   */
  binaryInArchive?: string;
  hashiCorpReleaseProduct?: string;
  /**
   * Additional release assets (EXACT names) to download as bare files alongside
   * the primary binary. Needed when the primary is a wrapper that references a
   * sibling file — e.g. ktlint's Windows `ktlint.bat` runs `java -jar %~dp0ktlint`,
   * so the `ktlint` jar must land next to it (#218).
   */
  extraAssets?: (platform: string, arch: string) => string[];
}

/**
 * A tool distributed as a runnable fat JAR on a Maven repository (default Maven
 * Central). Installed by downloading the JAR into the managed bin and writing a
 * `java -jar` launcher next to it, so it resolves like any other managed binary.
 * Requires a JRE at run time.
 */
export interface MavenJarSpec {
  groupId: string;
  artifactId: string;
  version: string;
  /** Classifier for the runnable fat jar, e.g. "with-dependencies". */
  classifier?: string;
  /** Maven repo base URL (default Maven Central). */
  repoBaseUrl?: string;
}

export interface ArchiveSpec {
  /**
   * Download URL for the distribution archive (.tgz/.zip). Either a single
   * platform-agnostic string (e.g. PowerShell Editor Services, a .NET bundle) or
   * a resolver `(platform, arch) => url | undefined` for servers that ship a
   * per-platform (and sometimes per-arch) archive — clangd, lua-language-server,
   * etc. Returning `undefined` marks the current platform/arch unsupported, and
   * the install degrades to "unavailable" (never a hard failure).
   *   platform: "linux" | "darwin" | "win32"
   *   arch:     "x64" | "arm64" | ...
   */
  url: string | ((platform: string, arch: string) => string | undefined);
  /** Archive kind — both extracted via `tar` (Windows bsdtar handles zip too). */
  kind: "tgz" | "zip";
  /**
   * Launcher path relative to the archive's top-level dir (which is stripped on
   * extraction), e.g. "bin/spotbugs". On win32 the installer resolves the
   * sibling `.bat`. OMIT for a TREE BUNDLE (a multi-folder module distribution
   * with no single launcher binary, e.g. PowerShellEditorServices) — the whole
   * extracted tree is the artifact and the install resolves to the extract dir
   * (`~/.choco-pi-lsp/tools/<id>`) rather than a shim. The consuming server then
   * launches a runtime (pwsh/java/node) against a bootstrap inside the tree.
   */
  launcher?: string;
  /**
   * Components to strip on extraction. Default 1: drops a single versioned
   * top-level dir so launcher paths are stable (spotbugs-X.Y.Z/bin → bin). Set 0
   * for a multi-folder bundle that has NO wrapping dir (PSES extracts several
   * sibling module folders at the root — stripping would flatten/merge them).
   */
  stripComponents?: number;
  /**
   * For a tree bundle (no launcher), a path relative to the extract dir that must
   * exist after extraction to confirm success, e.g.
   * "PowerShellEditorServices/Start-EditorServices.ps1". Used in place of the
   * launcher-existence check.
   */
  treeMarker?: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  checkCommand: string;
  checkArgs: string[];
  installStrategy: "npm" | "pip" | "gem" | "github" | "maven" | "archive";
  packageName?: string;
  binaryName?: string;
  github?: GitHubAssetSpec;
  maven?: MavenJarSpec;
  archive?: ArchiveSpec;
  /**
   * For npm tools whose runnable binary ships in a per-platform
   * optional-dependency package (e.g. `@ast-grep/cli-<platform>`,
   * `@biomejs/cli-<platform>`). Under pnpm/bun the main package's JS launcher
   * frequently can't locate that binary (symlink store / skipped postinstall),
   * but the binary itself IS installed — so resolve it directly. The general
   * mechanism for any npm/pnpm/bun-distributed platform-CLI tool.
   */
  platformPackage?: PlatformPackageSpec;
}

export interface PlatformPackageSpec {
  /** Base name; the platform package is `${base}-${suffix}`. Defaults to `packageName`. */
  base?: string;
  /** node `${platform}-${arch}` → npm package-name suffix. */
  suffixes: Record<string, string>;
  /** Candidate binary filenames at the platform package root (first existing wins). */
  binaries: string[];
}

/**
 * Build a GitHub-release `assetMatch` from a small per-platform table, replacing
 * the copy-pasted `if (platform === "linux") return arch === "arm64" ? … : …`
 * ladder that several release entries repeat verbatim. Each platform maps to its
 * `x64` (default) and optional `arm64` asset substring; a missing platform or
 * arch ⇒ unsupported (`undefined`). Arches outside x64/arm64 (ia32, ppc64, …)
 * are unsupported too — no release entry ships a 32-bit or exotic asset, and
 * handing back the x64 substring there would install an unrunnable binary.
 */
function archAssetMatch(table: {
  linux?: { x64?: string; arm64?: string };
  darwin?: { x64?: string; arm64?: string };
  win32?: { x64?: string; arm64?: string };
}): (platform: string, arch: string) => string | undefined {
  return (platform, arch) => {
    if (arch !== "x64" && arch !== "arm64") return undefined;
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    return table[platform as "linux" | "darwin" | "win32"]?.[arch];
  };
}

// Go-style `<os>_<arch>.zip` release assets, shared verbatim by tflint and
// terraform-ls — both entries carried byte-identical ladders, down to the asset
// strings themselves.
const OS_ARCH_ZIP_ASSETS = {
  linux: { x64: "linux_amd64.zip", arm64: "linux_arm64.zip" },
  darwin: { x64: "darwin_amd64.zip", arm64: "darwin_arm64.zip" },
  win32: { x64: "windows_amd64.zip", arm64: "windows_arm64.zip" },
};

export const TOOLS: ToolDefinition[] = [
  // Core LSP servers
  {
    id: "typescript-language-server",
    name: "TypeScript Language Server",
    checkCommand: "typescript-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "typescript-language-server",
    binaryName: "typescript-language-server",
  },
  {
    id: "typescript",
    name: "TypeScript",
    checkCommand: "tsc",
    checkArgs: ["--version"],
    installStrategy: "npm",
    // The managed compiler serves the classic typescript-language-server
    // fallback. TypeScript 7 removed lib/tsserver.js and is selected only from
    // project-local installs through the native `tsc --lsp --stdio` path.
    // Revisit when typescript-language-server supports TS 7 — refs #1436.
    packageName: "typescript@5.9.3",
    binaryName: "tsc",
  },
  {
    id: "pyright",
    name: "Pyright",
    checkCommand: "pyright",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "pyright",
    binaryName: "pyright",
  },
  // Linting/formatting tools
  {
    id: "prettier",
    name: "Prettier",
    checkCommand: "prettier",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "prettier",
    binaryName: "prettier",
  },
  {
    id: "ruff",
    name: "Ruff",
    checkCommand: "ruff",
    checkArgs: ["--version"],
    installStrategy: "pip",
    packageName: "ruff",
    binaryName: "ruff",
  },
  {
    // Alternate Python LSP (fallback when pyright/the `python` server is
    // unavailable or disabled). Used as a managedToolId by PythonJediServer.
    id: "jedi-language-server",
    name: "Jedi Language Server",
    checkCommand: "jedi-language-server",
    checkArgs: ["--version"],
    installStrategy: "pip",
    packageName: "jedi-language-server",
    binaryName: "jedi-language-server",
  },
  {
    id: "biome",
    name: "Biome",
    checkCommand: "biome",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "@biomejs/biome",
    binaryName: "biome",
    platformPackage: {
      base: "@biomejs/cli",
      suffixes: {
        "linux-x64": "linux-x64",
        "linux-arm64": "linux-arm64",
        "darwin-x64": "darwin-x64",
        "darwin-arm64": "darwin-arm64",
        "win32-x64": "win32-x64",
        "win32-arm64": "win32-arm64",
      },
      binaries: ["biome"],
    },
  },
  // Analysis tools (run at session start / turn end)
  // Structural search and dead code detection
  {
    id: "ast-grep",
    name: "ast-grep CLI",
    checkCommand: "ast-grep",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "@ast-grep/cli",
    binaryName: "ast-grep",
    platformPackage: {
      suffixes: {
        "linux-x64": "linux-x64-gnu",
        "linux-arm64": "linux-arm64-gnu",
        "darwin-x64": "darwin-x64",
        "darwin-arm64": "darwin-arm64",
        "win32-x64": "win32-x64-msvc",
        "win32-arm64": "win32-arm64-msvc",
        "win32-ia32": "win32-ia32-msvc",
      },
      binaries: ["ast-grep", "sg"],
    },
  },
  {
    id: "yamllint",
    name: "yamllint",
    checkCommand: "yamllint",
    checkArgs: ["--version"],
    installStrategy: "pip",
    packageName: "yamllint",
    binaryName: "yamllint",
  },
  {
    id: "sqlfluff",
    name: "sqlfluff",
    checkCommand: "sqlfluff",
    checkArgs: ["--version"],
    installStrategy: "pip",
    packageName: "sqlfluff",
    binaryName: "sqlfluff",
  },
  {
    id: "bash-language-server",
    name: "Bash Language Server",
    checkCommand: "bash-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "bash-language-server",
    binaryName: "bash-language-server",
  },
  {
    id: "fish-lsp",
    name: "Fish Language Server",
    checkCommand: "fish-lsp",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "fish-lsp",
    binaryName: "fish-lsp",
  },
  {
    id: "cmake-language-server",
    name: "CMake Language Server",
    checkCommand: "cmake-language-server",
    checkArgs: ["--version"],
    installStrategy: "pip",
    packageName: "cmake-language-server",
    binaryName: "cmake-language-server",
  },
  {
    id: "yaml-language-server",
    name: "YAML Language Server",
    checkCommand: "yaml-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "yaml-language-server",
    binaryName: "yaml-language-server",
  },
  {
    id: "vscode-json-language-server",
    name: "VSCode JSON Language Server",
    checkCommand: "vscode-json-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "vscode-langservers-extracted",
    binaryName: "vscode-json-language-server",
  },
  {
    id: "vscode-html-languageserver-bin",
    name: "VSCode HTML Language Server",
    checkCommand: "vscode-html-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "vscode-html-languageserver-bin",
    binaryName: "vscode-html-language-server",
  },
  {
    id: "htmlhint",
    name: "HTMLHint",
    checkCommand: "htmlhint",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "htmlhint",
    binaryName: "htmlhint",
  },
  {
    id: "hadolint",
    name: "Hadolint",
    checkCommand: "hadolint",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "hadolint",
    github: {
      repo: "hadolint/hadolint",
      assetMatch: (platform, arch) => {
        if (platform === "linux") return arch === "arm64" ? "linux.aarch64" : "linux.x86_64";
        if (platform === "darwin") return arch === "arm64" ? "macos-arm64" : "macos-x86_64";
        if (platform === "win32") return "windows-x86_64.exe";
        return undefined;
      },
    },
  },
  {
    id: "helm",
    name: "Helm",
    checkCommand: "helm",
    checkArgs: ["version", "--short"],
    installStrategy: "github",
    binaryName: "helm",
    github: {
      repo: "helm/helm",
      assetMatch: (platform, arch) => {
        // helm publishes per-OS archives: tar.gz for POSIX, zip for Windows.
        const cpu = arch === "arm64" ? "arm64" : "amd64";
        if (platform === "linux") return `linux-${cpu}.tar.gz`;
        if (platform === "darwin") return `darwin-${cpu}.tar.gz`;
        if (platform === "win32") return `windows-${cpu}.zip`;
        return undefined;
      },
      // Release archives nest the executable under an OS/arch directory;
      // the installer searches recursively and adds the Windows suffix.
      binaryInArchive: "helm",
    },
  },
  {
    // Opengrep: a single standalone binary per platform on GitHub releases —
    // no login, no telemetry (the reason for switching off Semgrep, #111).
    id: "opengrep",
    name: "Opengrep",
    checkCommand: "opengrep",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "opengrep",
    github: {
      repo: "opengrep/opengrep",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "opengrep_manylinux_aarch64" : "opengrep_manylinux_x86";
        if (platform === "darwin")
          return arch === "arm64" ? "opengrep_osx_arm64" : "opengrep_osx_x86";
        // One x86 Windows build; runs on arm64 Windows via emulation.
        if (platform === "win32") return "opengrep_windows_x86.exe";
        return undefined;
      },
    },
  },
  {
    id: "vscode-css-languageserver",
    name: "VSCode CSS Language Server",
    checkCommand: "vscode-css-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "vscode-css-languageserver",
    binaryName: "vscode-css-language-server",
  },
  {
    id: "dockerfile-language-server-nodejs",
    name: "Dockerfile Language Server",
    checkCommand: "docker-langserver",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "dockerfile-language-server-nodejs",
    binaryName: "docker-langserver",
  },
  {
    id: "intelephense",
    name: "Intelephense",
    checkCommand: "intelephense",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "intelephense",
    binaryName: "intelephense",
  },
  {
    id: "@prisma/language-server",
    name: "Prisma Language Server",
    checkCommand: "prisma-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "@prisma/language-server",
    binaryName: "prisma-language-server",
  },
  {
    id: "@vue/language-server",
    name: "Vue Language Server",
    checkCommand: "vue-language-server",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "@vue/language-server",
    binaryName: "vue-language-server",
  },
  {
    id: "svelte-language-server",
    name: "Svelte Language Server",
    checkCommand: "svelteserver",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "svelte-language-server",
    binaryName: "svelteserver",
  },
  {
    id: "markdownlint",
    name: "markdownlint-cli2",
    checkCommand: "markdownlint-cli2",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "markdownlint-cli2",
    binaryName: "markdownlint-cli2",
  },
  {
    id: "mypy",
    name: "mypy",
    checkCommand: "mypy",
    checkArgs: ["--version"],
    installStrategy: "pip",
    packageName: "mypy",
    binaryName: "mypy",
  },
  {
    id: "rubocop",
    name: "RuboCop",
    checkCommand: "rubocop",
    checkArgs: ["--version"],
    installStrategy: "gem",
    packageName: "rubocop",
    binaryName: "rubocop",
  },
  {
    id: "stylelint",
    name: "Stylelint",
    checkCommand: "stylelint",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "stylelint",
    binaryName: "stylelint",
  },
  {
    id: "oxlint",
    name: "Oxlint",
    checkCommand: "oxlint",
    checkArgs: ["--version"],
    installStrategy: "npm",
    packageName: "oxlint",
    binaryName: "oxlint",
  },
  // GitHub release binaries
  {
    id: "shellcheck",
    name: "ShellCheck",
    checkCommand: "shellcheck",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "shellcheck",
    github: {
      repo: "koalaman/shellcheck",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "linux.aarch64.tar.xz" : "linux.x86_64.tar.xz";
        if (platform === "darwin")
          return arch === "arm64" ? "darwin.aarch64.tar.xz" : "darwin.x86_64.tar.xz";
        if (platform === "win32") return "zip";
        return undefined;
      },
      binaryInArchive: "shellcheck",
    },
  },
  {
    id: "shfmt",
    name: "shfmt",
    checkCommand: "shfmt",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "shfmt",
    github: {
      repo: "mvdan/sh",
      assetMatch: (platform, arch) => {
        if (platform === "linux") return arch === "arm64" ? "linux_arm64" : "linux_amd64";
        if (platform === "darwin") return arch === "arm64" ? "darwin_arm64" : "darwin_amd64";
        if (platform === "win32")
          return arch === "arm64" ? "windows_arm64.exe" : "windows_amd64.exe";
        return undefined;
      },
      // bare binary, no archive
    },
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    checkCommand: "rust-analyzer",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "rust-analyzer",
    github: {
      repo: "rust-lang/rust-analyzer",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "aarch64-unknown-linux-gnu.gz" : "x86_64-unknown-linux-gnu.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "aarch64-apple-darwin.gz" : "x86_64-apple-darwin.gz";
        if (platform === "win32") return "x86_64-pc-windows-msvc.zip";
        return undefined;
      },
      // Linux/macOS: bare .gz; Windows: .zip archive containing rust-analyzer.exe
    },
  },
  {
    // Alternate JS/TS LSP (fallback when the `typescript` server is unavailable
    // or disabled — e.g. Deno projects). Used as a managedToolId by DenoServer.
    // Every platform ships a .zip containing the `deno` binary (the github
    // strategy extracts it, as it does for rust-analyzer's Windows .zip).
    id: "deno",
    name: "Deno",
    checkCommand: "deno",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "deno",
    github: {
      repo: "denoland/deno",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64"
            ? "deno-aarch64-unknown-linux-gnu.zip"
            : "deno-x86_64-unknown-linux-gnu.zip";
        if (platform === "darwin")
          return arch === "arm64"
            ? "deno-aarch64-apple-darwin.zip"
            : "deno-x86_64-apple-darwin.zip";
        // Windows ships only x86_64 (runs under emulation on arm64).
        if (platform === "win32") return "deno-x86_64-pc-windows-msvc.zip";
        return undefined;
      },
    },
  },
  {
    id: "golangci-lint",
    name: "golangci-lint",
    checkCommand: "golangci-lint",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "golangci-lint",
    github: {
      repo: "golangci/golangci-lint",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "linux-arm64.tar.gz" : "linux-amd64.tar.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "darwin-arm64.tar.gz" : "darwin-amd64.tar.gz";
        if (platform === "win32")
          return arch === "arm64" ? "windows-arm64.zip" : "windows-amd64.zip";
        return undefined;
      },
      binaryInArchive: "golangci-lint",
    },
  },
  {
    id: "ktlint",
    name: "ktlint",
    checkCommand: "ktlint",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "ktlint",
    github: {
      // ktlint ships a self-executable `ktlint` (a JAR with a shell preamble)
      // for Linux/macOS, plus a `ktlint.bat` wrapper for Windows that runs
      // `java -jar %~dp0ktlint`. On Windows BOTH files are needed: the .bat AND
      // the `ktlint` jar it wraps (#218). No arm64-specific asset.
      repo: "pinterest/ktlint",
      assetMatch: (platform, _arch) => {
        if (platform === "linux") return "ktlint";
        if (platform === "darwin") return "ktlint";
        if (platform === "win32") return "ktlint.bat";
        return undefined;
      },
      extraAssets: (platform) => (platform === "win32" ? ["ktlint"] : []),
    },
  },
  {
    // ktfmt (Meta's opinionated Kotlin formatter) ships only as a Maven-Central
    // fat JAR — no native binary, no npm package — so it uses the maven strategy
    // (#129). Run via a `java -jar` launcher; requires a JRE.
    id: "ktfmt",
    name: "ktfmt",
    checkCommand: "ktfmt",
    checkArgs: ["--version"],
    installStrategy: "maven",
    binaryName: "ktfmt",
    maven: {
      groupId: "com.facebook",
      artifactId: "ktfmt",
      version: "0.63",
      classifier: "with-dependencies",
    },
  },
  {
    // SpotBugs (bytecode bug-pattern analyzer for Java/Kotlin/Scala/Groovy)
    // ships as a distribution archive — a lib/ of many JARs + bin/ launchers,
    // NOT a runnable fat JAR — so it uses the archive strategy, not maven
    // (refs #133). Requires a JRE (gated by the runner, not the install).
    id: "spotbugs",
    name: "SpotBugs",
    checkCommand: "spotbugs",
    checkArgs: ["-version"],
    installStrategy: "archive",
    binaryName: "spotbugs",
    archive: {
      url: "https://github.com/spotbugs/spotbugs/releases/download/4.10.2/spotbugs-4.10.2.tgz",
      kind: "tgz",
      launcher: "bin/spotbugs",
    },
  },
  {
    // PowerShell Editor Services (#278). NOT a single binary — a multi-folder
    // PowerShell MODULE BUNDLE launched via `pwsh Start-EditorServices.ps1
    // -Stdio` (see PowerShellServer.spawn). archive TREE BUNDLE: the release zip
    // extracts sibling module dirs (PowerShellEditorServices/, PSReadLine/,
    // PSScriptAnalyzer/) at the root with no wrapping dir, so stripComponents:0
    // + no launcher — the whole tree is kept and resolved to its extract dir.
    // checkCommand "pwsh" documents the runtime but is unused for resolution
    // (tree bundles resolve only via the extract dir + treeMarker).
    id: "powershell-editor-services",
    name: "PowerShell Editor Services",
    checkCommand: "pwsh",
    checkArgs: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    installStrategy: "archive",
    binaryName: "powershell-editor-services",
    archive: {
      url: "https://github.com/PowerShell/PowerShellEditorServices/releases/download/v4.6.0/PowerShellEditorServices.zip",
      kind: "zip",
      stripComponents: 0,
      treeMarker: "PowerShellEditorServices/Start-EditorServices.ps1",
    },
  },
  {
    // clangd (C/C++/Obj-C LSP, #241) — a self-contained native TREE BUNDLE: the
    // release zip wraps `clangd_<ver>/{bin,lib}` (bin/clangd[.exe] + the bundled
    // libclang headers under lib/), so stripComponents:1 drops the version dir and
    // the whole tree is kept (no launcher). Unlike PSES there is no external
    // runtime — CppServer launches `<bundle>/bin/clangd` directly. checkCommand
    // documents the binary but is unused for resolution (tree bundles resolve only
    // via the extract dir + treeMarker). Platform-matched url: clangd ships x64
    // prebuilts; arm runs the x64 build under Rosetta/emulation (darwin/win32),
    // while linux/arm64 has no official build → undefined (graceful unavailable).
    id: "clangd",
    name: "clangd",
    checkCommand: "clangd",
    checkArgs: ["--version"],
    installStrategy: "archive",
    binaryName: "clangd",
    archive: {
      url: (platform, arch) => {
        const version = "22.1.0";
        const base = `https://github.com/clangd/clangd/releases/download/${version}`;
        if (platform === "linux")
          return arch === "x64" ? `${base}/clangd-linux-${version}.zip` : undefined;
        if (platform === "darwin") return `${base}/clangd-mac-${version}.zip`;
        if (platform === "win32") return `${base}/clangd-windows-${version}.zip`;
        return undefined;
      },
      kind: "zip",
      stripComponents: 1,
      treeMarker: "bin",
    },
  },
  {
    // lua-language-server (#564, split from #241) — same self-contained native
    // TREE BUNDLE shape as clangd: bin/lua-language-server[.exe] + bundled
    // locale/meta files, no external runtime. UNLIKE clangd, the release
    // archive has NO wrapping version dir (verified by inspecting the actual
    // 3.18.2 linux-x64 .tar.gz and win32-x64 .zip contents: `bin/`, `LICENSE`,
    // `locale/`, … sit at archive root) — so stripComponents:0, not 1.
    // LuaServer launches `<bundle>/bin/lua-language-server` directly.
    // checkCommand documents the binary but is unused for resolution (tree
    // bundles resolve only via the extract dir + treeMarker). Platform-matched
    // url: LuaLS publishes darwin/linux x64+arm64 and win32 x64 (no win32/arm64
    // build as of 3.18.2 → undefined, graceful unavailable); asset naming
    // verified against the live GitHub release listing, not guessed.
    id: "lua-language-server",
    name: "lua-language-server",
    checkCommand: "lua-language-server",
    checkArgs: ["--version"],
    installStrategy: "archive",
    binaryName: "lua-language-server",
    archive: {
      url: (platform, arch) => {
        const version = "3.18.2";
        const base = `https://github.com/LuaLS/lua-language-server/releases/download/${version}`;
        if (platform === "linux")
          return arch === "arm64"
            ? `${base}/lua-language-server-${version}-linux-arm64.tar.gz`
            : `${base}/lua-language-server-${version}-linux-x64.tar.gz`;
        if (platform === "darwin")
          return arch === "arm64"
            ? `${base}/lua-language-server-${version}-darwin-arm64.tar.gz`
            : `${base}/lua-language-server-${version}-darwin-x64.tar.gz`;
        if (platform === "win32")
          return arch === "arm64"
            ? undefined
            : `${base}/lua-language-server-${version}-win32-x64.zip`;
        return undefined;
      },
      kind: "zip",
      stripComponents: 0,
      treeMarker: "bin",
    },
  },
  {
    id: "actionlint",
    name: "actionlint",
    checkCommand: "actionlint",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "actionlint",
    github: {
      repo: "rhysd/actionlint",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "linux_arm64.tar.gz" : "linux_amd64.tar.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "darwin_arm64.tar.gz" : "darwin_amd64.tar.gz";
        if (platform === "win32")
          return arch === "arm64" ? "windows_arm64.zip" : "windows_amd64.zip";
        return undefined;
      },
      binaryInArchive: "actionlint",
    },
  },
  {
    // zizmor: GitHub Actions workflow security scanner that speaks LSP (#272).
    // cargo-dist release archives, one per target triple, each holding a single
    // `zizmor` binary (extracted via the recursive binary find). Online audits
    // (known-vulnerable-actions, unpinned-uses, …) need a GitHub token — the LSP
    // spawn forwards one via resolveZizmorGitHubToken (clients/zizmor-config.ts).
    id: "zizmor",
    name: "zizmor",
    checkCommand: "zizmor",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "zizmor",
    github: {
      repo: "zizmorcore/zizmor",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64"
            ? "aarch64-unknown-linux-gnu.tar.gz"
            : "x86_64-unknown-linux-gnu.tar.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "aarch64-apple-darwin.tar.gz" : "x86_64-apple-darwin.tar.gz";
        // One x86 Windows build; arm64 Windows runs it under emulation.
        if (platform === "win32") return "x86_64-pc-windows-msvc.zip";
        return undefined;
      },
      binaryInArchive: "zizmor",
    },
  },
  {
    // typos-lsp: source-code spell checker that speaks LSP (#283). cargo-dist
    // release archives, one per target triple, each holding a single `typos-lsp`
    // binary (extracted via the recursive binary find). NO token / network — the
    // dictionary is compiled in. The binary takes no `--version` (it ignores args
    // and serves the LSP on stdin/stdout); the PATH probe ignores checkArgs and
    // verifyToolBinary runs with stdin:ignore so the server gets EOF and exits.
    id: "typos-lsp",
    name: "typos-lsp",
    checkCommand: "typos-lsp",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "typos-lsp",
    github: {
      repo: "tekumara/typos-lsp",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64"
            ? "aarch64-unknown-linux-gnu.tar.gz"
            : "x86_64-unknown-linux-gnu.tar.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "aarch64-apple-darwin.tar.gz" : "x86_64-apple-darwin.tar.gz";
        if (platform === "win32")
          // Native win-arm64 build (one better than zizmor, which emulates).
          return arch === "arm64" ? "aarch64-pc-windows-msvc.zip" : "x86_64-pc-windows-msvc.zip";
        return undefined;
      },
      binaryInArchive: "typos-lsp",
    },
  },
  {
    id: "tflint",
    name: "tflint",
    checkCommand: "tflint",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "tflint",
    github: {
      repo: "terraform-linters/tflint",
      assetMatch: archAssetMatch(OS_ARCH_ZIP_ASSETS),
      binaryInArchive: "tflint",
    },
  },
  {
    // Terragrunt ships a bare native binary per platform on GitHub releases.
    // Windows arm64 uses the x64 binary through Windows' built-in emulation —
    // there is no terragrunt_windows_arm64.exe upstream.
    id: "terragrunt",
    name: "terragrunt",
    checkCommand: "terragrunt",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "terragrunt",
    github: {
      repo: "gruntwork-io/terragrunt",
      assetMatch: archAssetMatch({
        linux: {
          x64: "terragrunt_linux_amd64",
          arm64: "terragrunt_linux_arm64",
        },
        darwin: {
          x64: "terragrunt_darwin_amd64",
          arm64: "terragrunt_darwin_arm64",
        },
        win32: {
          x64: "terragrunt_windows_amd64.exe",
          arm64: "terragrunt_windows_amd64.exe",
        },
      }),
      // bare binary — no binaryInArchive
    },
  },
  {
    id: "swiftlint",
    name: "SwiftLint",
    checkCommand: "swiftlint",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "swiftlint",
    github: {
      repo: "realm/SwiftLint",
      assetMatch: (platform, arch) => {
        if (platform === "darwin") return "portable_swiftlint.zip";
        if (platform === "linux")
          return arch === "arm64" ? "swiftlint_linux_arm64.zip" : "swiftlint_linux_amd64.zip";
        return undefined;
      },
      binaryInArchive: "swiftlint",
    },
  },
  {
    id: "taplo",
    name: "taplo",
    checkCommand: "taplo",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "taplo",
    github: {
      repo: "tamasfe/taplo",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "taplo-linux-aarch64.gz" : "taplo-linux-x86_64.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "taplo-darwin-aarch64.gz" : "taplo-darwin-x86_64.gz";
        if (platform === "win32") return "taplo-windows-x86_64.gz";
        return undefined;
      },
    },
  },
  {
    id: "vale",
    name: "Vale",
    checkCommand: "vale",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "vale",
    github: {
      repo: "vale-cli/vale",
      assetMatch: (platform, arch) => {
        const version = "3.14.2";
        if (platform === "linux")
          return arch === "arm64"
            ? `vale_${version}_Linux_arm64.tar.gz`
            : `vale_${version}_Linux_64-bit.tar.gz`;
        if (platform === "darwin")
          return arch === "arm64"
            ? `vale_${version}_macOS_arm64.tar.gz`
            : `vale_${version}_macOS_64-bit.tar.gz`;
        if (platform === "win32") return `vale_${version}_Windows_64-bit.zip`;
        return undefined;
      },
      binaryInArchive: "vale",
    },
  },
  {
    id: "terraform-ls",
    name: "terraform-ls",
    checkCommand: "terraform-ls",
    checkArgs: ["version"],
    installStrategy: "github",
    binaryName: "terraform-ls",
    github: {
      repo: "hashicorp/terraform-ls",
      hashiCorpReleaseProduct: "terraform-ls",
      assetMatch: archAssetMatch(OS_ARCH_ZIP_ASSETS),
      binaryInArchive: "terraform-ls",
    },
  },
  {
    id: "zls",
    name: "zls",
    checkCommand: "zls",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "zls",
    github: {
      repo: "zigtools/zls",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "aarch64-linux.tar.xz" : "x86_64-linux.tar.xz";
        if (platform === "darwin")
          return arch === "arm64" ? "aarch64-macos.tar.xz" : "x86_64-macos.tar.xz";
        if (platform === "win32")
          return arch === "arm64" ? "aarch64-windows.zip" : "x86_64-windows.zip";
        return undefined;
      },
      binaryInArchive: "zls",
    },
  },
  {
    // clojure-lsp ships a self-contained native (GraalVM) binary per platform
    // on GitHub releases — no JVM needed. Used as managedToolId by ClojureServer.
    // The .zip carries the bare binary (located recursively on extract).
    id: "clojure-lsp",
    name: "clojure-lsp",
    checkCommand: "clojure-lsp",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "clojure-lsp",
    github: {
      repo: "clojure-lsp/clojure-lsp",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "native-linux-aarch64.zip" : "native-linux-amd64.zip";
        if (platform === "darwin")
          return arch === "arm64" ? "native-macos-aarch64.zip" : "native-macos-amd64.zip";
        // Only an x86_64 Windows native build; runs on arm64 via emulation.
        if (platform === "win32") return "native-windows-amd64.zip";
        return undefined;
      },
      binaryInArchive: "clojure-lsp",
    },
  },
  {
    // CUE ships a single native binary per platform on GitHub releases;
    // the LSP runs via `cue lsp serve`. Used as managedToolId by CueServer.
    id: "cue",
    name: "CUE",
    checkCommand: "cue",
    checkArgs: ["version"],
    installStrategy: "github",
    binaryName: "cue",
    github: {
      repo: "cue-lang/cue",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "linux_arm64.tar.gz" : "linux_amd64.tar.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "darwin_arm64.tar.gz" : "darwin_amd64.tar.gz";
        if (platform === "win32")
          return arch === "arm64" ? "windows_arm64.zip" : "windows_amd64.zip";
        return undefined;
      },
      binaryInArchive: "cue",
    },
  },
  {
    // gleam ships a single static binary per platform on GitHub releases; the
    // LSP runs via `gleam lsp`. Used as managedToolId by GleamServer. The linux
    // build is a FLAT musl tarball (a bare `gleam`), handled by the recursive
    // tar-binary lookup in installGitHubTool.
    id: "gleam",
    name: "Gleam",
    checkCommand: "gleam",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "gleam",
    github: {
      repo: "gleam-lang/gleam",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64"
            ? "aarch64-unknown-linux-musl.tar.gz"
            : "x86_64-unknown-linux-musl.tar.gz";
        if (platform === "darwin")
          return arch === "arm64" ? "aarch64-apple-darwin.tar.gz" : "x86_64-apple-darwin.tar.gz";
        if (platform === "win32")
          return arch === "arm64" ? "aarch64-pc-windows-msvc.zip" : "x86_64-pc-windows-msvc.zip";
        return undefined;
      },
      binaryInArchive: "gleam",
    },
  },
  {
    // marksman ships a single BARE (uncompressed) binary per platform on GitHub
    // releases — no archive, so it lands via the bare-binary branch of
    // installGitHubTool (the `else` that writes the asset directly, like shfmt).
    // Used as managedToolId by MarksmanServer; LSP entrypoint is `marksman
    // server` (stdio). macOS ships a universal binary; Windows has only x64
    // (runs on arm64 via emulation) — so all six platform/arch combos resolve.
    id: "marksman",
    name: "Marksman",
    checkCommand: "marksman",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "marksman",
    github: {
      repo: "artempyanykh/marksman",
      assetMatch: (platform, arch) => {
        if (platform === "linux")
          return arch === "arm64" ? "marksman-linux-arm64" : "marksman-linux-x64";
        if (platform === "darwin") return "marksman-macos";
        if (platform === "win32") return "marksman.exe";
        return undefined;
      },
      // bare binary — no binaryInArchive
    },
  },
  {
    // Expert ships a bare native binary per platform on GitHub releases. Its
    // `--stdio` flag is required to start the LSP transport. Windows arm64 uses
    // the x64 binary through Windows' built-in x64 emulation.
    id: "expert",
    name: "Expert",
    checkCommand: "expert",
    checkArgs: ["--version"],
    installStrategy: "github",
    binaryName: "expert",
    github: {
      repo: "expert-lsp/expert",
      assetMatch: (platform, arch) => {
        if (arch !== "x64" && arch !== "arm64") return undefined;
        if (platform === "linux")
          return arch === "arm64" ? "expert_linux_arm64" : "expert_linux_amd64";
        if (platform === "darwin")
          return arch === "arm64" ? "expert_darwin_arm64" : "expert_darwin_amd64";
        if (platform === "win32") return "expert_windows_amd64.exe";
        return undefined;
      },
      // bare binary — no binaryInArchive
    },
  },
];
