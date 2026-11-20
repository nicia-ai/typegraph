import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  benchDatabaseName,
  EXTERNAL_POSTGRES_URL_ENV,
  readExternalPostgresUrl,
  withDatabase,
} from "./postgres-server";

describe("readExternalPostgresUrl", () => {
  it("selects the container path when the variable is unset or blank", () => {
    assert.equal(readExternalPostgresUrl({}), undefined);
    assert.equal(
      readExternalPostgresUrl({ [EXTERNAL_POSTGRES_URL_ENV]: "  " }),
      undefined,
    );
  });

  it("returns the trimmed external server URL when set", () => {
    assert.equal(
      readExternalPostgresUrl({
        [EXTERNAL_POSTGRES_URL_ENV]: " postgresql://u:p@127.0.0.1:5496/db ",
      }),
      "postgresql://u:p@127.0.0.1:5496/db",
    );
  });
});

describe("withDatabase", () => {
  it("replaces only the database, keeping credentials, host, port and query", () => {
    assert.equal(
      withDatabase(
        "postgresql://typegraph:secret@127.0.0.1:5496/typegraph_test?sslmode=disable",
        "typegraph_bench_snb_1_2",
      ),
      "postgresql://typegraph:secret@127.0.0.1:5496/typegraph_bench_snb_1_2?sslmode=disable",
    );
  });

  it("adds a database to a server URL that has none", () => {
    assert.equal(
      withDatabase("postgresql://u:p@localhost:5432", "bench"),
      "postgresql://u:p@localhost:5432/bench",
    );
  });
});

describe("benchDatabaseName", () => {
  it("is a plain lowercase identifier unique per process and start time", () => {
    const name = benchDatabaseName(4321, 1_700_000_000_000);
    assert.equal(name, "typegraph_bench_snb_4321_1700000000000");
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    assert.notEqual(name, benchDatabaseName(4321, 1_700_000_000_001));
  });
});
