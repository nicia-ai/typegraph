import { entityKind } from "drizzle-orm";
import { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import { BaseSQLiteDatabase, SQLiteTransaction } from "drizzle-orm/sqlite-core";

/**
 * Drizzle classes as another loaded copy of Drizzle defines them: the same
 * entity kinds, different classes, so `instanceof` fails where Drizzle's own
 * `is()` brand check passes.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- A Drizzle entity class is identified by its static entity kind alone.
class ForeignSqliteDatabase {
  static readonly [entityKind] = BaseSQLiteDatabase[entityKind];
}
class ForeignSqliteTransaction extends ForeignSqliteDatabase {
  static override readonly [entityKind] = SQLiteTransaction[entityKind];
}
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- A Drizzle entity class is identified by its static entity kind alone.
class ForeignPgDatabase {
  static readonly [entityKind] = PgDatabase[entityKind];
}
export class ForeignPgTransaction extends ForeignPgDatabase {
  static override readonly [entityKind] = PgTransaction[entityKind];
}

/** `transaction` as a handle of another loaded copy of Drizzle sees it. */
export function asForeignTransaction<T extends object>(
  transaction: T,
  foreignClass: object = ForeignSqliteTransaction,
): T {
  return new Proxy(transaction, {
    getPrototypeOf: () => (foreignClass as { prototype: object }).prototype,
  });
}
