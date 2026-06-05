create extension if not exists vector;

create table if not exists users (
  id text primary key,
  github_id text unique,
  github_login text not null unique,
  github_email text not null,
  display_name text not null,
  created_at timestamptz not null default now()
);

alter table users add column if not exists github_id text;
create unique index if not exists users_github_id_key on users(github_id) where github_id is not null;

create table if not exists spaces (
  id text primary key,
  name text not null,
  description text,
  root_path text not null unique,
  created_at timestamptz not null default now()
);

do $$
begin
  create type space_role as enum ('owner', 'editor', 'viewer');
exception
  when duplicate_object then null;
end $$;

create table if not exists space_memberships (
  user_id text not null references users(id) on delete cascade,
  space_id text not null references spaces(id) on delete cascade,
  role space_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, space_id)
);

create table if not exists documents (
  space_id text not null references spaces(id) on delete cascade,
  path text not null,
  title text not null,
  tags text[] not null default '{}',
  visibility text not null default 'internal',
  sha text,
  updated_at timestamptz not null,
  indexed_at timestamptz,
  embedding vector(1536),
  primary key (space_id, path)
);

create table if not exists audit_logs (
  id text primary key,
  actor_user_id text not null references users(id),
  space_id text references spaces(id),
  action text not null,
  path text,
  commit_sha text,
  source text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create table if not exists api_tokens (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_tokens_user_id_idx on api_tokens(user_id);
