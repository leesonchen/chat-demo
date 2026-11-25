import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const migrateDatabase = (db) => {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      openid TEXT NOT NULL,
      unionid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(provider, openid)
    );
    CREATE INDEX IF NOT EXISTS oauth_identities_user_idx ON oauth_identities(user_id);
    CREATE INDEX IF NOT EXISTS oauth_identities_unionid_idx ON oauth_identities(provider, unionid);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_secrets (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_backups (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS membership_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('wechat', 'alipay')),
      plan TEXT NOT NULL,
      amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
      provider_transaction_id TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      period_starts_at INTEGER,
      paid_until INTEGER,
      billing_day INTEGER,
      UNIQUE(provider, provider_transaction_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS membership_paid_by_user
      ON membership_orders(user_id, paid_until DESC) WHERE status = 'paid';

    CREATE TABLE IF NOT EXISTS delegated_wechat_attempts (
      state_hash TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delegated_wechat_attempts_expiry_idx ON delegated_wechat_attempts(expires_at);
  `)
}

export const createDatabase = (filename) => {
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(filename)
  if (filename !== ':memory:') {
    chmodSync(filename, 0o600)
    db.exec('PRAGMA journal_mode = WAL;')
  }
  migrateDatabase(db)
  return db
}
