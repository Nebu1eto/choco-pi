#!/bin/sh
# choco-pi standalone installer, stage 0.
#
#   sh install.sh [--home DIR] [--bin-dir DIR] [--source URL|PATH] [--ref REF]
#
# Defaults: --home ~/.choco-pi, --bin-dir ~/.local/bin,
# --source https://github.com/Nebu1eto/choco-pi.git, --ref the default branch.
# REF must be a branch or tag name.
#
# Stage 0 (this script) checks the tools it needs, clones the app into
# <home>/app, and finds Node.js >= 24 or downloads the pinned Node into
# <home>/runtime/node, verifying its sha256 against
# scripts/standalone/runtime-pins.txt before extracting anything. Stage 1 is
# scripts/standalone/manage.ts install (pnpm, dependencies, profile, link).
# Never uses sudo or a global npm install. Re-running is idempotent.
#
# Mirrors (downloads are still verified against the pins):
#   CHOCO_PI_NODE_MIRROR   default https://nodejs.org/dist
#   CHOCO_PI_NPM_REGISTRY  default https://registry.npmjs.org (stage 1)
set -eu

DEFAULT_SOURCE=https://github.com/Nebu1eto/choco-pi.git

say() { printf 'choco-pi install: %s\n' "$*"; }
die() {
  printf 'choco-pi install: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
}

home= bin_dir= source= ref=
while [ "$#" -gt 0 ]; do
  case $1 in
    --home | --bin-dir | --source | --ref)
      [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
      case $1 in
        --home) home=$2 ;;
        --bin-dir) bin_dir=$2 ;;
        --source) source=$2 ;;
        --ref) ref=$2 ;;
      esac
      shift 2 ;;
    --home=* ) home=${1#*=}; shift ;;
    --bin-dir=*) bin_dir=${1#*=}; shift ;;
    --source=*) source=${1#*=}; shift ;;
    --ref=*) ref=${1#*=}; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

os=$(uname -s)
case $os in
  MINGW* | MSYS* | CYGWIN* | Windows*)
    die "Windows is not supported by the standalone installer; use WSL2 with a glibc Linux distribution." ;;
esac

if [ -z "$home" ] || [ -z "$bin_dir" ]; then
  [ -n "${HOME:-}" ] || die "HOME is not set; pass --home and --bin-dir"
fi
home=${home:-$HOME/.choco-pi}
bin_dir=${bin_dir:-$HOME/.local/bin}
source=${source:-$DEFAULT_SOURCE}
case $home in /*) ;; *) home=$PWD/$home ;; esac
case $bin_dir in /*) ;; *) bin_dir=$PWD/$bin_dir ;; esac

git_guidance() {
  printf '%s\n' "choco-pi install: git is required but was not found (or does not run)." >&2
  case $os in
    Darwin)
      printf '%s\n' \
        "  Install it with the Xcode Command Line Tools: xcode-select --install" \
        "  or with Homebrew: brew install git" >&2 ;;
    Linux)
      id=
      if [ -r /etc/os-release ]; then
        id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
      fi
      case $id in
        debian | ubuntu | linuxmint | pop) hint="apt-get install git" ;;
        fedora | rhel | centos | rocky | almalinux) hint="dnf install git" ;;
        arch | manjaro) hint="pacman -S git" ;;
        opensuse* | sles) hint="zypper install git" ;;
        *) hint="your distribution's package manager" ;;
      esac
      printf '%s\n' "  Install it as an administrator with: $hint" >&2 ;;
    *)
      printf '%s\n' "  Install git with your system's package manager." >&2 ;;
  esac
  printf '%s\n' "  This installer does not elevate privileges; re-run it once git works." >&2
}

# Stage 0 requirements.
if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  git_guidance
  exit 1
fi
missing=
command -v tar >/dev/null 2>&1 || missing="$missing tar"
if command -v curl >/dev/null 2>&1; then
  downloader=curl
elif command -v wget >/dev/null 2>&1; then
  downloader=wget
else
  missing="$missing curl-or-wget"
fi
if command -v shasum >/dev/null 2>&1; then
  sha256_tool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_tool=sha256sum
elif command -v openssl >/dev/null 2>&1; then
  sha256_tool=openssl
else
  missing="$missing sha256-tool(shasum|sha256sum|openssl)"
fi
[ -z "$missing" ] || die "missing required tools:$missing"

sha256_of() {
  case $sha256_tool in
    shasum) set -- $(shasum -a 256 <"$1") ;;
    sha256sum) set -- $(sha256sum <"$1") ;;
    openssl) set -- $(openssl dgst -sha256 -r <"$1") ;;
  esac
  printf '%s' "$1"
}

fetch() {
  case $downloader in
    curl) curl -fsSL --retry 2 -o "$2" "$1" ;;
    wget) wget -q -O "$2" "$1" ;;
  esac
}

# Clone the app (or keep an existing checkout; stage 1 fast-forwards it).
case $source in
  file://* | *://*) ;;
  *@*:*) ;;
  *)
    [ -d "$source" ] || die "--source $source is neither a URL nor a directory"
    source=$(cd -P -- "$source" && pwd -P) ;;
esac
local_clone=
case $source in
  file://* | /*) local_clone=--no-hardlinks ;;
esac

mkdir -p "$home"
home=$(cd -P -- "$home" && pwd -P)
app=$home/app
if [ -e "$app/.git" ]; then
  say "using the existing app checkout in $app"
elif [ -e "$app" ]; then
  die "$app exists but is not a git checkout; move it away or use manage.ts install --local-app"
else
  say "cloning $source${ref:+ ($ref)} into $app"
  set -- clone --quiet
  [ -z "$local_clone" ] || set -- "$@" "$local_clone"
  [ -z "$ref" ] || set -- "$@" --branch "$ref"
  git "$@" -- "$source" "$app"
fi

pins_file=$app/scripts/standalone/runtime-pins.txt
[ -f "$pins_file" ] || die "$pins_file is missing; the source is not a standalone-capable choco-pi"
pin() {
  while read -r key value rest; do
    if [ "$key" = "$1" ]; then
      printf '%s' "$value"
      return 0
    fi
  done <"$pins_file"
  die "runtime pin $1 is missing in $pins_file"
}

node_major() {
  major=$("$1" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  case $major in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' "$major"
}

node_qualifies() {
  [ -x "$1" ] || return 1
  major=$(node_major "$1") || return 1
  [ "$major" -ge 24 ]
}

is_musl() {
  for loader in /lib/ld-musl-*; do
    [ -e "$loader" ] && return 0
  done
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi
  return 1
}

node_platform() {
  arch=$(uname -m)
  case $os in
    Darwin)
      case $arch in
        arm64) printf 'darwin-arm64' ;;
        x86_64) printf 'darwin-x64' ;;
        *) return 1 ;;
      esac ;;
    Linux)
      if is_musl; then
        die "musl-based Linux (e.g. Alpine) is not supported: there is no official Node.js musl build. Install Node.js 24+ yourself and re-run."
      fi
      case $arch in
        x86_64 | amd64) printf 'linux-x64' ;;
        aarch64 | arm64) printf 'linux-arm64' ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

staging=
archive=
cleanup() {
  [ -z "$archive" ] || rm -f "$archive"
  [ -z "$staging" ] || rm -rf "$staging"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

provision_node() {
  platform=$(node_platform) ||
    die "no pinned Node.js build for $os $(uname -m); install Node.js 24+ yourself and re-run."
  version=$(pin node_version)
  expected=$(pin "node_sha256_$platform")
  name=node-v$version-$platform
  mirror=${CHOCO_PI_NODE_MIRROR:-https://nodejs.org/dist}
  runtime=$home/runtime
  mkdir -p "$runtime"
  archive=$runtime/.$name.tar.gz.$$
  say "downloading Node.js $version ($platform)"
  fetch "$mirror/v$version/$name.tar.gz" "$archive" || die "download failed: $mirror/v$version/$name.tar.gz"
  actual=$(sha256_of "$archive")
  if [ "$actual" != "$expected" ]; then
    rm -f "$archive"
    die "checksum mismatch for $name.tar.gz: expected sha256 $expected, got $actual; nothing was extracted"
  fi
  staging=$runtime/.node-staging.$$
  rm -rf "$staging"
  mkdir "$staging"
  tar -xzf "$archive" -C "$staging"
  rm -f "$archive"
  archive=
  [ -x "$staging/$name/bin/node" ] || die "$name.tar.gz has no bin/node"
  rm -rf "$runtime/node"
  mv "$staging/$name" "$runtime/node"
  rmdir "$staging"
  staging=
  node_qualifies "$runtime/node/bin/node" || die "the downloaded Node.js does not run on this system"
}

NODE=
if path_node=$(command -v node 2>/dev/null) && node_qualifies "$path_node"; then
  NODE=$("$path_node" -e 'process.stdout.write(process.execPath)')
elif node_qualifies "$home/runtime/node/bin/node"; then
  NODE=$home/runtime/node/bin/node
else
  say "no Node.js >= 24 on PATH; provisioning the pinned Node.js into $home/runtime/node"
  provision_node
  NODE=$home/runtime/node/bin/node
fi
say "using Node.js $("$NODE" --version) at $NODE"

set -- install --home "$home" --bin-dir "$bin_dir" --source "$source"
[ -z "$ref" ] || set -- "$@" --ref "$ref"
trap - EXIT
cleanup
exec "$NODE" "$app/scripts/standalone/manage.ts" "$@"
