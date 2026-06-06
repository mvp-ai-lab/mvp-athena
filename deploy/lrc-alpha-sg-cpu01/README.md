# lrc-alpha-sg-cpu01 Deployment

This deployment runs MVP Athena server-side services with Docker Compose and exposes the API only through host nginx:

```text
https://athena.mvp-lab.ai
  -> nginx
  -> http://127.0.0.1:13000
  -> api container :3000
```

## Paths

```text
/mnt/data-alpha-sg-01/services/mvp-athena/
  repo/
  data/postgres/
  data/redis/
  backups/
  nginx/
  logs/
```

## First Deploy

```sh
sudo mkdir -p /mnt/data-alpha-sg-01/services/mvp-athena/{repo,data/postgres,data/redis,backups,nginx,logs}
sudo chown -R "$USER":"$USER" /mnt/data-alpha-sg-01/services/mvp-athena

cd /mnt/data-alpha-sg-01/services/mvp-athena/repo
git clone git@github.com:GeoffreyChen777/mvp-arthena.git .

cp deploy/lrc-alpha-sg-cpu01/env.example deploy/lrc-alpha-sg-cpu01/.env
vim deploy/lrc-alpha-sg-cpu01/.env
```

Before starting, verify the private knowledge repo token:

```sh
set -a
. deploy/lrc-alpha-sg-cpu01/.env
set +a
GITHUB_TOKEN="$GITHUB_TOKEN" gh repo view GeoffreyChen777/athena-data --json name,isPrivate,defaultBranchRef
```

Start:

```sh
docker compose \
  --env-file deploy/lrc-alpha-sg-cpu01/.env \
  -f deploy/lrc-alpha-sg-cpu01/docker-compose.yml \
  up -d --build
```

Check:

```sh
docker compose --env-file deploy/lrc-alpha-sg-cpu01/.env -f deploy/lrc-alpha-sg-cpu01/docker-compose.yml ps
curl http://127.0.0.1:13000/healthz
```

## Nginx

```sh
cp deploy/lrc-alpha-sg-cpu01/nginx/athena.mvp-lab.ai.conf /mnt/data-alpha-sg-01/services/mvp-athena/nginx/athena.mvp-lab.ai.conf
sudo ln -sf /mnt/data-alpha-sg-01/services/mvp-athena/nginx/athena.mvp-lab.ai.conf /etc/nginx/sites-enabled/athena.mvp-lab.ai.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d athena.mvp-lab.ai
curl https://athena.mvp-lab.ai/healthz
```

## Update

```sh
cd /mnt/data-alpha-sg-01/services/mvp-athena/repo
git pull --ff-only
docker compose \
  --env-file deploy/lrc-alpha-sg-cpu01/.env \
  -f deploy/lrc-alpha-sg-cpu01/docker-compose.yml \
  up -d --build
```

## Client Smoke Test

```sh
mvp-athena login --api-url https://athena.mvp-lab.ai
mvp-athena create team deploy-check.md --title "Deploy Check" --body "Athena is live."
mvp-athena read team deploy-check.md
gh api repos/GeoffreyChen777/athena-data/contents/spaces/team/docs/deploy-check.md
```
