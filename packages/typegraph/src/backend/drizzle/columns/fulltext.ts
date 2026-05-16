/**
 * Custom Drizzle column types for the PostgreSQL `tsvectorStrategy`
 * fulltext table (`tsvector` + `regconfig`). Lets drizzle-kit
 * introspect the typed fulltext table the same way it introspects
 * `nodes`, `edges`, etc. Alternate strategies (pg_trgm, ParadeDB,
 * pgroonga) carry their own DDL via `FulltextStrategy.ownedTables()`
 * and don't use these columns.
 */
import { customType } from "drizzle-orm/pg-core";

/**
 * PostgreSQL `regconfig` column type — a registered text-search
 * configuration name (e.g. `'english'::regconfig`). Identical wire
 * format to `text`, but the `regconfig` SQL type lets a generated
 * column reference it inside `to_tsvector("language", "content")`
 * as an immutable expression.
 */
export const regconfig = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "regconfig",
});

/**
 * PostgreSQL `tsvector` column type. Represents a parsed,
 * dictionary-normalized document; the GIN index that
 * `tsvectorFulltextTable` declares makes `@@ tsquery` lookups cheap.
 *
 * The on-the-wire driver representation is the canonical text form
 * (`'word1':1 'word2':2`); this type is read-only in practice — the
 * value is computed by a `GENERATED ALWAYS AS (...) STORED` clause —
 * so no `toDriver` mapping is provided.
 */
export const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "tsvector",
});
