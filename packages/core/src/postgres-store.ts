import pg from "pg";
import type {
  ApiToken,
  AuditLogEntry,
  KnowledgeStore,
  Role,
  Space,
  SpaceMembership,
  User
} from "./types.js";

const { Pool } = pg;

export interface PostgresKnowledgeStoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
}

interface UserRow {
  id: string;
  github_id: string | null;
  github_login: string;
  github_email: string;
  display_name: string;
}

interface SpaceRow {
  id: string;
  name: string;
  root_path: string;
  description: string | null;
}

interface MembershipRow {
  user_id: string;
  space_id: string;
  role: Role;
}

interface SpaceForUserRow extends SpaceRow {
  role: Role;
}

interface AuditLogRow {
  id: string;
  actor_user_id: string;
  space_id: string | null;
  action: AuditLogEntry["action"];
  path: string | null;
  commit_sha: string | null;
  source: AuditLogEntry["source"];
  summary: string;
  created_at: Date | string;
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  private readonly pool: pg.Pool;

  constructor(options: PostgresKnowledgeStoreOptions = {}) {
    if (!options.pool && !options.connectionString) {
      throw new Error("PostgresKnowledgeStore requires a connectionString or pool");
    }
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString });
  }

  async getUser(userId: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      "select id, github_id, github_login, github_email, display_name from users where id = $1",
      [userId]
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByApiTokenHash(tokenHash: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `
        select u.id, u.github_id, u.github_login, u.github_email, u.display_name
        from api_tokens t
        join users u on u.id = t.user_id
        where t.token_hash = $1
          and t.revoked_at is null
          and (t.expires_at is null or t.expires_at > now())
      `,
      [tokenHash]
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async upsertUser(user: User): Promise<void> {
    await this.pool.query(
      `
        insert into users (id, github_id, github_login, github_email, display_name)
        values ($1, $2, $3, $4, $5)
        on conflict (id) do update set
          github_id = excluded.github_id,
          github_login = excluded.github_login,
          github_email = excluded.github_email,
          display_name = excluded.display_name
      `,
      [user.id, user.githubId ?? null, user.githubLogin, user.githubEmail, user.displayName]
    );
  }

  async upsertMembership(membership: SpaceMembership): Promise<void> {
    await this.pool.query(
      `
        insert into space_memberships (user_id, space_id, role)
        values ($1, $2, $3)
        on conflict (user_id, space_id) do update set
          role = excluded.role
      `,
      [membership.userId, membership.spaceId, membership.role]
    );
  }

  async createApiToken(token: ApiToken): Promise<void> {
    await this.pool.query(
      `
        insert into api_tokens (token_hash, user_id, name, created_at, last_used_at, expires_at, revoked_at)
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        token.tokenHash,
        token.userId,
        token.name,
        token.createdAt,
        token.lastUsedAt ?? null,
        token.expiresAt ?? null,
        token.revokedAt ?? null
      ]
    );
  }

  async markApiTokenUsed(tokenHash: string): Promise<void> {
    await this.pool.query("update api_tokens set last_used_at = now() where token_hash = $1", [tokenHash]);
  }

  async listSpacesForUser(userId: string): Promise<Array<Space & { role: Role }>> {
    const result = await this.pool.query<SpaceForUserRow>(
      `
        select s.id, s.name, s.root_path, s.description, m.role
        from spaces s
        join space_memberships m on m.space_id = s.id
        where m.user_id = $1
        order by s.name, s.id
      `,
      [userId]
    );
    return result.rows.map((row) => ({ ...mapSpace(row), role: row.role }));
  }

  async getSpace(spaceId: string): Promise<Space | null> {
    const result = await this.pool.query<SpaceRow>(
      "select id, name, root_path, description from spaces where id = $1",
      [spaceId]
    );
    return result.rows[0] ? mapSpace(result.rows[0]) : null;
  }

  async getMembership(userId: string, spaceId: string): Promise<SpaceMembership | null> {
    const result = await this.pool.query<MembershipRow>(
      "select user_id, space_id, role from space_memberships where user_id = $1 and space_id = $2",
      [userId, spaceId]
    );
    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  async appendAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.pool.query(
      `
        insert into audit_logs (
          id, actor_user_id, space_id, action, path, commit_sha, source, summary, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        entry.id,
        entry.actorUserId,
        entry.spaceId ?? null,
        entry.action,
        entry.path ?? null,
        entry.commitSha ?? null,
        entry.source,
        entry.summary,
        entry.createdAt
      ]
    );
  }

  async listAuditLogs(spaceId: string): Promise<AuditLogEntry[]> {
    const result = await this.pool.query<AuditLogRow>(
      `
        select id, actor_user_id, space_id, action, path, commit_sha, source, summary, created_at
        from audit_logs
        where space_id = $1
        order by created_at desc
      `,
      [spaceId]
    );
    return result.rows.map(mapAuditLog);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.github_id ?? undefined,
    githubLogin: row.github_login,
    githubEmail: row.github_email,
    displayName: row.display_name
  };
}

function mapSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    description: row.description ?? undefined
  };
}

function mapMembership(row: MembershipRow): SpaceMembership {
  return {
    userId: row.user_id,
    spaceId: row.space_id,
    role: row.role
  };
}

function mapAuditLog(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    spaceId: row.space_id ?? undefined,
    action: row.action,
    path: row.path ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    source: row.source,
    summary: row.summary,
    createdAt: toIsoString(row.created_at)
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
