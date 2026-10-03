import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class TechnicalStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY, micro_usd INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits(bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);`);
    this.cleanup();
  }
  cleanup(now = Date.now()) {
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(now);
    this.db.prepare("DELETE FROM limits WHERE expires < ?").run(now);
    this.db
      .prepare("DELETE FROM budget WHERE day < date('now', '-32 days')")
      .run();
  }
  close() {
    this.db.close();
  }
  reserve(
    microUsd: number,
    limitUsd: number,
    day = new Date().toISOString().slice(0, 10),
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO budget(day,micro_usd) VALUES(?,0)")
        .run(day);
      const row = this.db
        .prepare("SELECT micro_usd FROM budget WHERE day=?")
        .get(day) as { micro_usd: number };
      if (row.micro_usd + microUsd > Math.floor(limitUsd * 1_000_000)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare("UPDATE budget SET micro_usd=micro_usd+? WHERE day=?")
        .run(microUsd, day);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settle(reservation: number, actual: number, day: string) {
    // Unknown provider failures retain their full reservation. Successful calls release only the known excess.
    if (!Number.isFinite(actual) || actual < 0) return;
    this.db
      .prepare("UPDATE budget SET micro_usd=MAX(0,micro_usd-?) WHERE day=?")
      .run(Math.max(0, reservation - Math.ceil(actual)), day);
  }
  consumed(day = new Date().toISOString().slice(0, 10)): number {
    const row = this.db
      .prepare("SELECT micro_usd FROM budget WHERE day=?")
      .get(day) as { micro_usd: number } | undefined;
    return (row?.micro_usd || 0) / 1_000_000;
  }
  rateLimit(
    key: string,
    limit: number,
    seconds: number,
    now = Date.now(),
  ): boolean {
    const window = Math.floor(now / (seconds * 1000));
    const bucket = `${key}:${window}`;
    const row = this.db
      .prepare(
        `INSERT INTO limits(bucket,count,expires) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count`,
      )
      .get(bucket, (window + 1) * seconds * 1000) as { count: number };
    return row.count <= limit;
  }
  createSession() {
    const record = {
      id: randomBytes(24).toString("base64url"),
      csrf: randomBytes(24).toString("base64url"),
      expires: Date.now() + 86400000,
    };
    this.db
      .prepare("INSERT INTO sessions(id,csrf,expires) VALUES(?,?,?)")
      .run(record.id, record.csrf, record.expires);
    return record;
  }
  session(id: string) {
    return this.db
      .prepare("SELECT id,csrf,expires FROM sessions WHERE id=? AND expires>?")
      .get(id, Date.now()) as
      { id: string; csrf: string; expires: number } | undefined;
  }
}

export class Sessions {
  private readonly secret: string;
  constructor(
    secret: string,
    readonly store: TechnicalStore,
  ) {
    this.secret = secret || randomBytes(32).toString("base64url");
  }
  hash(value: string) {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
  sign(id: string) {
    return `${id}.${this.hash(id)}`;
  }
  read(cookie = "") {
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("planb_session="))
      ?.slice(14);
    if (!token || token.length > 200) return undefined;
    const [id, signature] = token.split(".");
    if (!id || !signature || !safeEqual(signature, this.hash(id)))
      return undefined;
    return this.store.session(id);
  }
}
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
