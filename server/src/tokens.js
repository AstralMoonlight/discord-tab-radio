import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (token) => createHash('sha256').update(token).digest('hex');

/**
 * Guarda un token por usuario de Discord. En disco solo queda el hash,
 * asi que si alguien lee el archivo no puede usar los tokens.
 */
export class TokenStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'tokens.json');
    this.byUser = new Map(); // userId -> { hash, createdAt }
    this.byHash = new Map(); // hash -> userId
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const data = JSON.parse(raw);
    for (const [userId, entry] of Object.entries(data.users ?? {})) {
      this.byUser.set(userId, entry);
      this.byHash.set(entry.hash, userId);
    }
  }

  async save() {
    const data = { users: Object.fromEntries(this.byUser) };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Crea un token nuevo para el usuario (invalida el anterior). */
  async issue(userId) {
    this.#drop(userId);
    const token = randomBytes(24).toString('base64url');
    const entry = { hash: hash(token), createdAt: new Date().toISOString() };
    this.byUser.set(userId, entry);
    this.byHash.set(entry.hash, userId);
    await this.save();
    return token;
  }

  async revoke(userId) {
    const existed = this.#drop(userId);
    if (existed) await this.save();
    return existed;
  }

  /** Devuelve el userId dueno del token, o null. */
  resolve(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    return this.byHash.get(hash(token)) ?? null;
  }

  #drop(userId) {
    const entry = this.byUser.get(userId);
    if (!entry) return false;
    this.byHash.delete(entry.hash);
    this.byUser.delete(userId);
    return true;
  }
}
