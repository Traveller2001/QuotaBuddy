import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Session {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** API key fingerprint -> key id on that Sub2API instance */
  keyIds: Record<string, number>;
}

/** Encrypts with the OS keychain (Electron safeStorage); injectable for tests. */
export interface Cipher {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

export class SessionExpiredError extends Error {}

export const fingerprint = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex').slice(0, 16);

/**
 * Sub2API logins per origin. Tokens are stored encrypted with the OS keychain; when no keychain
 * is available they are kept in memory only.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private refreshing = new Map<string, Promise<Session>>();
  private persist = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private file: string,
    private cipher: Cipher,
  ) {}

  get persistent(): boolean {
    return this.persist;
  }

  async load(): Promise<void> {
    this.persist = await this.cipher.available().catch(() => false);
    if (!this.persist) return;
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // no file yet
    }
    for (const [origin, entry] of Object.entries<any>(raw.sessions ?? {})) {
      try {
        this.sessions.set(origin, JSON.parse(await this.cipher.decrypt(entry.blob)));
      } catch {
        // undecryptable (e.g. keychain changed): drop it
      }
    }
  }

  /** Writes are serialised so a slow encrypt never lets an older snapshot overwrite a newer one. */
  private save(): void {
    if (!this.persist) return;
    const snapshot = [...this.sessions.entries()];
    this.writing = this.writing
      .then(async () => {
        const sessions: Record<string, { blob: string }> = {};
        for (const [origin, s] of snapshot) sessions[origin] = { blob: await this.cipher.encrypt(JSON.stringify(s)) };
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify({ version: 1, sessions }, null, 2), { mode: 0o600 });
      })
      .catch((e) => console.error('could not save sessions', e));
  }

  /** Resolves once pending writes are on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  get(origin: string): Session | undefined {
    return this.sessions.get(origin);
  }

  set(origin: string, session: Session): void {
    this.sessions.set(origin, session);
    this.save();
  }

  delete(origin: string): void {
    this.sessions.delete(origin);
    this.save();
  }

  rememberKeyId(origin: string, apiKey: string, id: number): void {
    const s = this.sessions.get(origin);
    if (!s) return;
    s.keyIds = { ...s.keyIds, [fingerprint(apiKey)]: id };
    this.save();
  }

  /**
   * Returns a session with a usable access token, refreshing it when needed. Refresh tokens
   * rotate, so concurrent callers for the same origin share one refresh.
   */
  async fresh(
    origin: string,
    refresh: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>,
    force = false,
  ): Promise<Session> {
    const s = this.sessions.get(origin);
    if (!s) throw new SessionExpiredError('not logged in');
    if (!force && s.expiresAt - 60_000 > Date.now()) return s;
    const pending = this.refreshing.get(origin);
    if (pending) return pending;
    const job = (async () => {
      try {
        const pair = await refresh(s.refreshToken);
        const next: Session = { ...s, ...pair, refreshToken: pair.refreshToken || s.refreshToken };
        this.set(origin, next);
        return next;
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 400 || e?.status === 403) {
          this.delete(origin);
          throw new SessionExpiredError('session expired');
        }
        throw e;
      } finally {
        this.refreshing.delete(origin);
      }
    })();
    this.refreshing.set(origin, job);
    return job;
  }
}
