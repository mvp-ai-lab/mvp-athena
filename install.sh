#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Install MVP Athena CLI and MCP server prebuilt binaries.

Optional:
  ATHENA_REPO       GitHub repository in owner/name form. Defaults to mvp-ai-lab/mvp-athena.
  ATHENA_VERSION    Release tag. Defaults to latest.
  ATHENA_INSTALL_BIN_DIR  Install directory. Defaults to ~/.local/bin.
  ATHENA_RELEASE_BASE_URL Override release asset base URL.

Example:
  curl -fsSL https://raw.githubusercontent.com/mvp-ai-lab/mvp-athena/main/install.sh | sh
EOF
}

die() {
  printf 'athena install: %s\n' "$*" >&2
  exit 1
}

info() {
  printf 'athena install: %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

repo="${ATHENA_REPO:-mvp-ai-lab/mvp-athena}"
version="${ATHENA_VERSION:-latest}"
bin_dir="${ATHENA_INSTALL_BIN_DIR:-"$HOME/.local/bin"}"

require_command awk
require_command curl
require_command install
require_command mktemp
require_command tar
require_command uname

if command -v sha256sum >/dev/null 2>&1; then
  checksum_command="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  checksum_command="shasum -a 256"
else
  die "missing required command: sha256sum or shasum"
fi

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) cpu="x64" ;;
  arm64 | aarch64) cpu="arm64" ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

target="${os}-${cpu}"
asset="athena-${target}.tar.gz"

if [ -n "${ATHENA_RELEASE_BASE_URL:-}" ]; then
  url="${ATHENA_RELEASE_BASE_URL%/}/${asset}"
elif [ "$version" = "latest" ]; then
  url="https://github.com/${repo}/releases/latest/download/${asset}"
else
  url="https://github.com/${repo}/releases/download/${version}/${asset}"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/athena-bin.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

info "detected platform: $target"
info "downloading $url"
curl -fL "$url" -o "$tmp_dir/$asset"
curl -fL "$url.sha256" -o "$tmp_dir/$asset.sha256"

info "verifying $asset"
expected_sha=$(awk '{print $1}' "$tmp_dir/$asset.sha256")
actual_sha=$($checksum_command "$tmp_dir/$asset" | awk '{print $1}')
[ "$expected_sha" = "$actual_sha" ] || die "checksum mismatch for $asset"

info "extracting $asset"
tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"

mkdir -p "$bin_dir"
install -m 0755 "$tmp_dir/athena-${target}/athena" "$bin_dir/athena"
install -m 0755 "$tmp_dir/athena-${target}/athena-mcp" "$bin_dir/athena-mcp"

info "installed $bin_dir/athena"
info "installed $bin_dir/athena-mcp"
info "make sure $bin_dir is on PATH, then run: athena login --api-url <athena-api-url>"
