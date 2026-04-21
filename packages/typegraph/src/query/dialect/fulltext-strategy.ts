/**
 * Fulltext Strategy — pluggable DDL + SQL generation for a dialect's
 * fulltext stack. A strategy owns every SQL statement that touches its
 * backing table: DDL, upsert (single + batch), delete (single + batch),
 * MATCH condition, rank expression, and snippet expression.
 *
 * A dialect picks one as its default; `createPostgresBackend` /
 * `createSqliteBackend` accept an override for alternate Postgres stacks
 * (pg_trgm, ParadeDB/pg_search, pgroonga) to swap the entire fulltext
 * pipeline without forking TypeGraph.
 */
import { type SQL, sql } from "drizzle-orm";

import { quotedTableName } from "../../backend/drizzle/operations/shared";
import {
  type DeleteFulltextBatchParams,
  type DeleteFulltextParams,
  type FulltextBatchRow,
  type FulltextCapabilities,
  type FulltextQueryMode,
  type UpsertFulltextBatchParams,
  type UpsertFulltextParams,
} from "../../backend/types";

/**
 * Every `FulltextQueryMode` both shipped strategies accept.
 */
export const ALL_FULLTEXT_MODES: readonly FulltextQueryMode[] = [
  "websearch",
  "phrase",
  "plain",
  "raw",
] as const;

/**
 * Derives the `FulltextCapabilities` backends advertise from the active
 * strategy, so the two never drift.
 */
export function buildFulltextCapabilities(
  strategy: FulltextStrategy,
): FulltextCapabilities {
  return {
    supported: true,
    languages: strategy.languages,
    phraseQueries: strategy.supportedModes.includes("phrase"),
    prefixQueries: strategy.supportsPrefix,
    highlighting: strategy.supportsSnippets,
  };
}

/**
 * A pluggable fulltext implementation. Each strategy is expected to be
 * self-contained: given a table name, a query string, and a parse mode,
 * it emits every SQL statement the compiler and backend need — DDL,
 * reads, and writes. No out-of-band conventions across layers.
 */
export interface FulltextStrategy {
  /** Human-readable identifier used in error messages and telemetry. */
  readonly name: string;

  /**
   * Parse modes this strategy can translate. Callers validate against
   * this list before emitting SQL; a mode outside the set means the
   * strategy rejects the query at compile time.
   */
  readonly supportedModes: readonly FulltextQueryMode[];

  /**
   * Whether the strategy can emit a per-row highlighted snippet. When
   * false, `snippetExpression` returns a literal `NULL` so callers can
   * leave the `snippet` column in place without a branch.
   */
  readonly supportsSnippets: boolean;

  /**
   * Whether the strategy supports prefix queries (`foo*`). Used to
   * populate `BackendCapabilities.fulltext.prefixQueries`. A strategy
   * may support prefix queries via dedicated syntax without advertising
   * "raw" mode (and vice-versa).
   */
  readonly supportsPrefix: boolean;

  /**
   * Whether a per-query `language` override is honored. Postgres' tsvector
   * accepts any installed regconfig at query time; SQLite FTS5's tokenizer
   * is fixed at table-create time, so the override is silently ignored.
   * Callers may surface a warning when the user passes `language` to a
   * strategy that doesn't honor it.
   */
  readonly supportsLanguageOverride: boolean;

  /**
   * Languages / tokenizer names understood by the strategy. Advisory — a
   * runtime backend like Postgres may accept other installed regconfigs.
   * Used to populate `BackendCapabilities.fulltext.languages`.
   */
  readonly languages: readonly string[];

  /**
   * Emits the WHERE-side MATCH expression.
   *
   * @example
   * tsvector: `"typegraph_node_fulltext"."tsv" @@ websearch_to_tsquery('english', 'cats')`
   * fts5:     `"typegraph_node_fulltext" MATCH '"cats"'`
   */
  matchCondition(
    tableName: string,
    query: string,
    mode: FulltextQueryMode,
    language?: string,
  ): SQL;

  /**
   * Emits the relevance expression. Higher values = more relevant. The
   * compiler orders by this expression DESC, and both builder and
   * backend-direct paths use the same form so their top-k results agree.
   */
  rankExpression(
    tableName: string,
    query: string,
    mode: FulltextQueryMode,
    language?: string,
  ): SQL;

  /**
   * Emits a per-row highlighted snippet expression, or `NULL` when
   * `supportsSnippets` is false. Snippet markup is `<mark>…</mark>` in
   * both shipped strategies so consumers can apply one stylesheet.
   */
  snippetExpression(
    tableName: string,
    query: string,
    mode: FulltextQueryMode,
    language?: string,
  ): SQL;

  /**
   * DDL statements to create the backing table and any supporting
   * indexes. Idempotent (`CREATE ... IF NOT EXISTS`). Called once from
   * `bootstrapTables()` on a fresh database.
   */
  generateDdl(tableName: string): readonly string[];

  /**
   * Emits the statements that upsert a single fulltext row. Returns one
   * or more statements — some backends (SQLite FTS5) cannot emulate
   * upsert in a single statement and need DELETE + INSERT.
   */
  buildUpsert(
    tableName: string,
    params: UpsertFulltextParams,
    timestamp: string,
  ): readonly SQL[];

  /**
   * Emits the statements that upsert many fulltext rows at once. Input
   * rows are expected to be de-duplicated last-write-wins by the
   * strategy if the underlying SQL statement cannot tolerate duplicate
   * conflict keys. Returns `[]` when `params.rows` is empty.
   */
  buildBatchUpsert(
    tableName: string,
    params: UpsertFulltextBatchParams,
    timestamp: string,
  ): readonly SQL[];

  /**
   * Emits the statements that delete a single fulltext row. Normally a
   * single PK-scoped DELETE, but strategies that maintain auxiliary
   * indexes (delete-triggered external stores, ParadeDB-style secondary
   * structures) may need more.
   */
  buildDelete(tableName: string, params: DeleteFulltextParams): readonly SQL[];

  /**
   * Emits the statements that delete many fulltext rows at once. Returns
   * `[]` when `params.nodeIds` is empty.
   */
  buildBatchDelete(
    tableName: string,
    params: DeleteFulltextBatchParams,
  ): readonly SQL[];
}

// ============================================================
// Internal helpers
// ============================================================

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function tsvectorColumn(tableName: string): SQL {
  return sql`${quotedTableName(tableName)}."tsv"`;
}

/**
 * Dedupes batch rows last-write-wins by nodeId. Returns a plain array
 * in insertion order of the last occurrence of each id. Shared by both
 * shipped strategies.
 */
function dedupeFulltextBatchRows(
  rows: readonly FulltextBatchRow[],
): FulltextBatchRow[] {
  const seen = new Map<string, FulltextBatchRow>();
  for (const row of rows) seen.set(row.nodeId, row);
  return [...seen.values()];
}

function buildPkScopedDelete(
  tableName: string,
  params: DeleteFulltextParams,
): SQL {
  const table = quotedTableName(tableName);
  return sql`
    DELETE FROM ${table}
    WHERE "graph_id" = ${params.graphId}
      AND "node_kind" = ${params.nodeKind}
      AND "node_id" = ${params.nodeId}
  `;
}

function buildPkScopedBatchDelete(
  tableName: string,
  params: DeleteFulltextBatchParams,
): SQL | undefined {
  if (params.nodeIds.length === 0) return undefined;
  const unique = [...new Set(params.nodeIds)];
  const table = quotedTableName(tableName);
  return sql`
    DELETE FROM ${table}
    WHERE "graph_id" = ${params.graphId}
      AND "node_kind" = ${params.nodeKind}
      AND "node_id" IN (${sql.join(
        unique.map((id) => sql`${id}`),
        sql`, `,
      )})
  `;
}

// ============================================================
// tsvector strategy (PostgreSQL built-in)
// ============================================================

function postgresTsquery(
  mode: FulltextQueryMode,
  query: string,
  language: string | undefined,
): SQL {
  // The `language` column is already `regconfig`, so the non-override
  // path references the column directly. The per-query override path
  // still arrives as a bound text parameter and needs the cast.
  const langExpr: SQL =
    language === undefined ? sql`"language"` : sql`${language}::regconfig`;
  switch (mode) {
    case "websearch": {
      return sql`websearch_to_tsquery(${langExpr}, ${query})`;
    }
    case "phrase": {
      return sql`phraseto_tsquery(${langExpr}, ${query})`;
    }
    case "plain": {
      return sql`plainto_tsquery(${langExpr}, ${query})`;
    }
    case "raw": {
      return sql`to_tsquery(${langExpr}, ${query})`;
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported fulltext mode: ${String(_exhaustive)}`);
    }
  }
}

export const tsvectorStrategy: FulltextStrategy = {
  name: "tsvector",
  supportedModes: ALL_FULLTEXT_MODES,
  supportsSnippets: true,
  // `raw` mode exposes `foo:*` prefix-match syntax to callers.
  supportsPrefix: true,
  supportsLanguageOverride: true,
  // Canonical Postgres stemmers; every stock install ships these plus a
  // few others. Runtime `to_tsvector` accepts any installed regconfig
  // name — this list is advisory for capability discovery.
  languages: [
    "simple",
    "english",
    "french",
    "german",
    "italian",
    "portuguese",
    "russian",
    "spanish",
    "swedish",
  ] as const,

  matchCondition(tableName, query, mode, language) {
    const q = postgresTsquery(mode, query, language);
    return sql`${tsvectorColumn(tableName)} @@ ${q}`;
  },

  rankExpression(tableName, query, mode, language) {
    const q = postgresTsquery(mode, query, language);
    return sql`ts_rank_cd(${tsvectorColumn(tableName)}, ${q})`;
  },

  snippetExpression(_tableName, query, mode, language) {
    const langExpr: SQL =
      language === undefined ? sql`"language"` : sql`${language}::regconfig`;
    const q = postgresTsquery(mode, query, language);
    return sql`ts_headline(${langExpr}, "content", ${q}, 'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MinWords=5,MaxWords=30,ShortWord=3')`;
  },

  generateDdl(tableName) {
    const name = quoteIdentifier(tableName);
    const gin = quoteIdentifier(`${tableName}_tsv_idx`);
    const kind = quoteIdentifier(`${tableName}_kind_idx`);
    // `language` is `regconfig` so `to_tsvector("language", "content")`
    // is an immutable expression — Postgres can then compute `tsv` as a
    // GENERATED STORED column and own the `content → tsv` invariant.
    // (The text→regconfig cast happens once at INSERT time against the
    // bound parameter, which is fine because it's not inside the
    // generated expression.)
    return [
      `CREATE TABLE IF NOT EXISTS ${name} (
  "graph_id" TEXT NOT NULL,
  "node_kind" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "language" regconfig NOT NULL,
  "tsv" tsvector NOT NULL
    GENERATED ALWAYS AS (to_tsvector("language", "content")) STORED,
  "updated_at" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("graph_id", "node_kind", "node_id")
);`,
      `CREATE INDEX IF NOT EXISTS ${gin} ON ${name} USING GIN ("tsv");`,
      `CREATE INDEX IF NOT EXISTS ${kind} ON ${name} ("graph_id", "node_kind");`,
    ];
  },

  buildUpsert(tableName, params, timestamp) {
    const table = quotedTableName(tableName);
    // `tsv` is a GENERATED STORED column — Postgres computes it from
    // `content` + `language`, so it must not appear in the column list
    // or the ON CONFLICT update set.
    return [
      sql`
        INSERT INTO ${table} ("graph_id", "node_kind", "node_id", "content", "language", "updated_at")
        VALUES (
          ${params.graphId}, ${params.nodeKind}, ${params.nodeId},
          ${params.content}, ${params.language}::regconfig,
          ${timestamp}
        )
        ON CONFLICT ("graph_id", "node_kind", "node_id")
        DO UPDATE SET
          "content" = EXCLUDED."content",
          "language" = EXCLUDED."language",
          "updated_at" = EXCLUDED."updated_at"
      `,
    ];
  },

  buildBatchUpsert(tableName, params, timestamp) {
    const rows = dedupeFulltextBatchRows(params.rows);
    if (rows.length === 0) return [];

    const table = quotedTableName(tableName);
    const valueTuples = rows.map(
      (row) => sql`
        (
              ${params.graphId}, ${params.nodeKind}, ${row.nodeId},
              ${row.content}, ${row.language}::regconfig,
              ${timestamp}
            )
      `,
    );

    return [
      sql`
        INSERT INTO ${table} ("graph_id", "node_kind", "node_id", "content", "language", "updated_at")
        VALUES ${sql.join(valueTuples, sql`, `)}
        ON CONFLICT ("graph_id", "node_kind", "node_id")
        DO UPDATE SET
          "content" = EXCLUDED."content",
          "language" = EXCLUDED."language",
          "updated_at" = EXCLUDED."updated_at"
      `,
    ];
  },

  buildDelete(tableName, params) {
    return [buildPkScopedDelete(tableName, params)];
  },

  buildBatchDelete(tableName, params) {
    const stmt = buildPkScopedBatchDelete(tableName, params);
    return stmt === undefined ? [] : [stmt];
  },
};

// ============================================================
// FTS5 strategy (SQLite)
// ============================================================

function translateToFts5Query(query: string, mode: FulltextQueryMode): string {
  switch (mode) {
    case "phrase": {
      return `"${query.replaceAll('"', '""')}"`;
    }
    case "plain": {
      return query
        .trim()
        .split(/\s+/u)
        .filter((token) => token.length > 0)
        .map((token) => `"${token.replaceAll('"', '""')}"`)
        .join(" ");
    }
    case "websearch": {
      return translateWebsearchToFts5(query);
    }
    case "raw": {
      return query;
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported fulltext mode: ${String(_exhaustive)}`);
    }
  }
}

function translateWebsearchToFts5(query: string): string {
  const tokens: string[] = [];
  let index = 0;

  function skipWhitespace(): void {
    while (index < query.length && /\s/u.test(query[index] ?? "")) {
      index += 1;
    }
  }

  function readPhrase(): string {
    index += 1;
    let content = "";
    while (index < query.length && query[index] !== '"') {
      content += query[index] ?? "";
      index += 1;
    }
    if (query[index] === '"') index += 1;
    return `"${content.replaceAll('"', '""')}"`;
  }

  function readBareTerm(): string {
    let term = "";
    while (index < query.length && !/\s/u.test(query[index] ?? "")) {
      term += query[index] ?? "";
      index += 1;
    }
    return term;
  }

  while (index < query.length) {
    skipWhitespace();
    if (index >= query.length) break;
    const ch = query[index];
    if (ch === '"') {
      tokens.push(readPhrase());
      continue;
    }
    if (ch === "-") {
      index += 1;
      const term =
        query[index] === '"' ?
          readPhrase()
        : `"${readBareTerm().replaceAll('"', '""')}"`;
      tokens.push(`NOT ${term}`);
      continue;
    }
    if (ch === "+") {
      index += 1;
      continue;
    }
    const bare = readBareTerm();
    if (bare.length === 0) continue;
    if (bare.toUpperCase() === "OR") {
      tokens.push("OR");
      continue;
    }
    tokens.push(`"${bare.replaceAll('"', '""')}"`);
  }

  if (tokens.length > 0 && tokens[0]?.startsWith("NOT ")) {
    tokens.shift();
  }

  return tokens.join(" ");
}

export const fts5Strategy: FulltextStrategy = {
  name: "fts5",
  supportedModes: ALL_FULLTEXT_MODES,
  supportsSnippets: true,
  // FTS5 supports `foo*` prefix matching natively.
  supportsPrefix: true,
  // FTS5 tokenizer is fixed at table-create time; per-row / per-query
  // language metadata is stored but not consulted.
  supportsLanguageOverride: false,
  // The built-in tokenizer is `porter unicode61 remove_diacritics 2`; the
  // `language` field on searchable() is recorded for future use but not
  // applied at query time.
  languages: ["porter", "unicode61", "trigram"] as const,

  matchCondition(tableName, query, mode, _language) {
    const matchExpression = translateToFts5Query(query, mode);
    return sql`${quotedTableName(tableName)} MATCH ${matchExpression}`;
  },

  rankExpression(tableName, _query, _mode, _language) {
    // FTS5 bm25() returns a negative score where lower = more relevant.
    // Negate so callers see higher = better (uniform with tsvector).
    return sql`-bm25(${quotedTableName(tableName)})`;
  },

  snippetExpression(tableName, _query, _mode, _language) {
    return sql`snippet(${quotedTableName(tableName)}, -1, '<mark>', '</mark>', '…', 20)`;
  },

  generateDdl(tableName) {
    const name = quoteIdentifier(tableName);
    return [
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(
  graph_id UNINDEXED,
  node_kind UNINDEXED,
  node_id UNINDEXED,
  language UNINDEXED,
  updated_at UNINDEXED,
  content,
  tokenize='porter unicode61 remove_diacritics 2'
);`,
    ];
  },

  buildUpsert(tableName, params, timestamp) {
    const table = quotedTableName(tableName);
    // FTS5 virtual tables don't support ON CONFLICT — emulate with
    // DELETE + INSERT, atomic under the caller's outer transaction.
    return [
      sql`
        DELETE FROM ${table}
        WHERE "graph_id" = ${params.graphId}
          AND "node_kind" = ${params.nodeKind}
          AND "node_id" = ${params.nodeId}
      `,
      sql`
        INSERT INTO ${table} (graph_id, node_kind, node_id, content, language, updated_at)
        VALUES (${params.graphId}, ${params.nodeKind}, ${params.nodeId}, ${params.content}, ${params.language}, ${timestamp})
      `,
    ];
  },

  buildBatchUpsert(tableName, params, timestamp) {
    const rows = dedupeFulltextBatchRows(params.rows);
    if (rows.length === 0) return [];

    const table = quotedTableName(tableName);
    const nodeIds = rows.map((row) => row.nodeId);

    const deleteStmt = sql`
      DELETE FROM ${table}
      WHERE "graph_id" = ${params.graphId}
        AND "node_kind" = ${params.nodeKind}
        AND "node_id" IN (${sql.join(
          nodeIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    `;

    const valueTuples = rows.map(
      (row) => sql`
        (
              ${params.graphId}, ${params.nodeKind}, ${row.nodeId},
              ${row.content}, ${row.language}, ${timestamp}
            )
      `,
    );

    const insertStmt = sql`
      INSERT INTO ${table} (graph_id, node_kind, node_id, content, language, updated_at)
      VALUES ${sql.join(valueTuples, sql`, `)}
    `;

    return [deleteStmt, insertStmt];
  },

  buildDelete(tableName, params) {
    return [buildPkScopedDelete(tableName, params)];
  },

  buildBatchDelete(tableName, params) {
    const stmt = buildPkScopedBatchDelete(tableName, params);
    return stmt === undefined ? [] : [stmt];
  },
};
