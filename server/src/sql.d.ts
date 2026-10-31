// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Migrations are imported as text (`with { type: 'text' }`).
declare module '*.sql' {
  const sql: string;
  export default sql;
}
