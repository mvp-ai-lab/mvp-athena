#!/usr/bin/env sh
set -eu

SERVICE_ROOT=${SERVICE_ROOT:-/mnt/data-alpha-sg-01/services/mvp-athena}
REPO_DIR="$SERVICE_ROOT/repo"
DEPLOY_DIR="$REPO_DIR/deploy/lrc-alpha-sg-cpu01"
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
NGINX_SOURCE="$DEPLOY_DIR/nginx/athena.mvp-lab.ai.conf"
NGINX_TARGET="$SERVICE_ROOT/nginx/athena.mvp-lab.ai.conf"

info() {
  printf 'mvp-athena deploy: %s\n' "$*"
}

die() {
  printf 'mvp-athena deploy: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_command docker
require_command git
require_command curl

mkdir -p \
  "$SERVICE_ROOT/repo" \
  "$SERVICE_ROOT/data/postgres" \
  "$SERVICE_ROOT/data/redis" \
  "$SERVICE_ROOT/backups" \
  "$SERVICE_ROOT/nginx" \
  "$SERVICE_ROOT/logs"

if [ ! -d "$REPO_DIR/.git" ]; then
  if [ "$(find "$REPO_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
    die "$REPO_DIR is not empty and is not a git checkout"
  fi
  info "cloning application repo"
  git clone git@github.com:GeoffreyChen777/mvp-arthena.git "$REPO_DIR"
else
  info "updating application repo"
  git -C "$REPO_DIR" pull --ff-only
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$DEPLOY_DIR/env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  die "created $ENV_FILE; fill secrets and rerun this script"
fi

cp "$NGINX_SOURCE" "$NGINX_TARGET"

info "starting docker services"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

info "local health check"
curl -fsS http://127.0.0.1:13000/healthz >/dev/null

info "done. Install nginx config with:"
printf 'sudo ln -sf %s /etc/nginx/sites-enabled/athena.mvp-lab.ai.conf\n' "$NGINX_TARGET"
printf 'sudo nginx -t && sudo systemctl reload nginx\n'
printf 'sudo certbot --nginx -d athena.mvp-lab.ai\n'
