/**
 * #528: Drizzle's root `db.transaction()` does not nest through the transaction
 * handle the caller received. A managed write through a root TypeGraph Store
 * consequently emits BEGIN/COMMIT on a single PostgreSQL connection and the
 * COMMIT ends the caller's frame. PostgreSQL exposes no complete, non-mutating
 * SQL probe for an already-open but not-yet-written transaction, so this is a
 * documented adoption contract rather than a partial runtime detector.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STORE_SOURCE = path.join(PACKAGE_ROOT, "src", "store", "store.ts");
const RECIPES_DOCUMENT = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "apps",
  "docs",
  "src",
  "content",
  "docs",
  "recipes.md",
);

describe("caller-owned Drizzle transaction adoption (#528)", () => {
  it("warns that root-store writes can commit a caller-owned PostgreSQL transaction", () => {
    const recipes = fs.readFileSync(RECIPES_DOCUMENT, "utf8");
    const storeSource = fs.readFileSync(STORE_SOURCE, "utf8");

    expect(recipes).toContain(
      ":::caution[Do not use the root store inside a caller-owned transaction]",
    );
    expect(recipes).toContain("store.withTransaction(sqlTx)");
    expect(recipes).toContain("the `COMMIT` ends the caller's transaction");
    expect(storeSource).toContain(
      "Do not call a managed write on this root Store from inside the caller's",
    );
    expect(storeSource).toContain("withRecordedTransaction");
  });
});
