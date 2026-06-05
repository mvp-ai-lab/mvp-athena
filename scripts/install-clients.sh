#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Install MVP Athena CLI and MCP server from source.

Required:
  ATHENA_REPO_URL   Git repository URL, for example https://github.com/acme/mvp-athena.git

Optional:
  ATHENA_REF        Git branch, tag, or commit to install. Defaults to main.
  ATHENA_INSTALL_DIR  Source checkout directory. Defaults to ~/.mvp-athena/source.

Example:
  curl -fsSL https://raw.githubusercontent.com/acme/mvp-athena/main/scripts/install-clients.sh \
    | ATHENA_REPO_URL=https://github.com/acme/mvp-athena.git sh
EOF
}

die() {
  printf 'mvp-athena install: %s\n' "$*" >&2
  exit 1
}

info() {
  printf 'mvp-athena install: %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

repo_url="${ATHENA_REPO_URL:-}"
ref="${ATHENA_REF:-main}"
install_dir="${ATHENA_INSTALL_DIR:-"$HOME/.mvp-athena/source"}"

[ -n "$repo_url" ] || die "ATHENA_REPO_URL is required. Run with --help for an example."

require_command git
require_command node
require_command npm

if ! command -v pnpm >/dev/null 2>&1; then
  require_command corepack
  info "enabling pnpm with corepack"
  corepack enable
fi

command -v pnpm >/dev/null 2>&1 || die "pnpm is unavailable after corepack enable"

parent_dir=$(dirname "$install_dir")
mkdir -p "$parent_dir"

if [ -d "$install_dir/.git" ]; then
  info "updating source checkout at $install_dir"
  git -C "$install_dir" fetch --tags origin
else
  if [ -e "$install_dir" ]; then
    die "$install_dir exists but is not a git checkout"
  fi
  info "cloning $repo_url into $install_dir"
  git clone "$repo_url" "$install_dir"
fi

info "checking out $ref"
git -C "$install_dir" checkout "$ref"

if git -C "$install_dir" symbolic-ref -q HEAD >/dev/null 2>&1; then
  git -C "$install_dir" pull --ff-only origin "$ref" || true
fi

info "installing dependencies"
pnpm -C "$install_dir" install --frozen-lockfile

info "building clients"
pnpm -C "$install_dir" build

pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/mvp-athena-install.XXXXXX")
trap 'rm -rf "$pack_dir"' EXIT

info "packing CLI and MCP server"
pnpm -C "$install_dir" --filter @mvp-athena/cli pack --pack-destination "$pack_dir" >/dev/null
pnpm -C "$install_dir" --filter @mvp-athena/mcp-server pack --pack-destination "$pack_dir" >/dev/null

info "installing global commands with npm"
npm install -g "$pack_dir"/*.tgz

info "installed commands: mvp-athena, athena, mvp-athena-mcp, athena-mcp"
info "configure ATHENA_API_URL and ATHENA_TOKEN before use"
