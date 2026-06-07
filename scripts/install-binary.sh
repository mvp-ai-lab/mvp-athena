#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Install MVP Athena CLI and MCP server prebuilt binaries.

Required:
  ATHENA_REPO       GitHub repository in owner/name form, for example acme/mvp-athena.

Optional:
  ATHENA_VERSION    Release tag. Defaults to latest.
  ATHENA_INSTALL_BIN_DIR  Install directory. Defaults to ~/.local/bin.
  ATHENA_RELEASE_BASE_URL Override release asset base URL.

Example:
  curl -fsSL https://raw.githubusercontent.com/acme/mvp-athena/main/scripts/install-binary.sh \
    | ATHENA_REPO=acme/mvp-athena sh
EOF
}

die() {
  printf 'mvp-athena binary install: %s\n' "$*" >&2
  exit 1
}

info() {
  printf 'mvp-athena binary install: %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

repo="${ATHENA_REPO:-}"
version="${ATHENA_VERSION:-latest}"
bin_dir="${ATHENA_INSTALL_BIN_DIR:-"$HOME/.local/bin"}"

[ -n "$repo" ] || die "ATHENA_REPO is required. Run with --help for an example."

require_command curl
require_command tar
require_command uname
require_command install
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

asset="mvp-athena-${os}-${cpu}.tar.gz"

if [ -n "${ATHENA_RELEASE_BASE_URL:-}" ]; then
  url="${ATHENA_RELEASE_BASE_URL%/}/${asset}"
elif [ "$version" = "latest" ]; then
  url="https://github.com/${repo}/releases/latest/download/${asset}"
else
  url="https://github.com/${repo}/releases/download/${version}/${asset}"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/mvp-athena-bin.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

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
install -m 0755 "$tmp_dir/mvp-athena-${os}-${cpu}/mvp-athena" "$bin_dir/mvp-athena"
install -m 0755 "$tmp_dir/mvp-athena-${os}-${cpu}/athena" "$bin_dir/athena"
install -m 0755 "$tmp_dir/mvp-athena-${os}-${cpu}/mvp-athena-mcp" "$bin_dir/mvp-athena-mcp"
install -m 0755 "$tmp_dir/mvp-athena-${os}-${cpu}/athena-mcp" "$bin_dir/athena-mcp"

info "installed $bin_dir/mvp-athena"
info "installed $bin_dir/athena"
info "installed $bin_dir/mvp-athena-mcp"
info "installed $bin_dir/athena-mcp"
info "make sure $bin_dir is on PATH, then set ATHENA_API_URL and ATHENA_TOKEN"
