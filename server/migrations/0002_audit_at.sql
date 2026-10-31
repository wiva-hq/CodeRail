-- Copyright 2026 Wiva, Inc.
-- SPDX-License-Identifier: Apache-2.0

-- The audit log's daily trim deletes by age (how long it keeps an entry is settings.audit_days).
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
