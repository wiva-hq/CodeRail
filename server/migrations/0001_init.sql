-- Copyright 2026 Wiva, Inc.
-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  online INTEGER NOT NULL DEFAULT 0,
  info TEXT
);

CREATE TABLE grants (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  folders TEXT,
  harnesses TEXT,
  terminal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, user_id)
);
CREATE INDEX grants_user ON grants(user_id);

CREATE TABLE pair_requests (
  code TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  info TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  machine_id TEXT,
  token TEXT
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT,
  username TEXT,
  machine_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX audit_machine ON audit(machine_id, at);

CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subs_user ON push_subs(user_id);

CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
