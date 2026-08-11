/**
 * The construction seam (`src/backend/derive-backend.ts`) and the write-once
 * resource audit it carries.
 *
 * #435: a derived backend built by spreading a projection into a fresh object
 * dropped the serialized-resource mark, so the import/clone guards saw an
 * unowned backend and let a read-and-write-through-one-connection stream
 * proceed into a deadlock. Every constructor in the seam carries the verdict,
 * and the verdict is fixed at construction so a lease cannot have the premise
 * it claimed changed underneath it.
 */
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  deriveBackend,
  projectBackend,
  projectBackendWithout,
  projectGraphBackend,
  wrapWithManagedClose,
} from "../src/backend/derive-backend";
import { type AnySqliteDatabase } from "../src/backend/drizzle/execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  acquireSerializedStreamLease,
  auditBackendResource,
  type BackendResourceAudit,
  resolveBackendAudit,
  sharesSerializedTransactionResource,
} from "../src/backend/transaction-resource";
import { type GraphBackend, SQLITE_CAPABILITIES } from "../src/backend/types";
import { createTestBackend, makeUnauditedBackend } from "./test-utils";

type BaseVerdict = "serialized" | "independent" | "unaudited";

/** A base backend carrying exactly the verdict named, plus that verdict. */
function createAuditedBase(verdict: BaseVerdict): Readonly<{
  backend: GraphBackend;
  audit: BackendResourceAudit | undefined;
}> {
  const backend = makeUnauditedBackend();
  if (verdict === "unaudited") return { backend, audit: undefined };
  const audit: BackendResourceAudit =
    verdict === "serialized" ?
      { kind: "serialized", resource: {} }
    : { kind: "independent" };
  auditBackendResource(backend, audit);
  return { backend, audit };
}

const SEAM_CONSTRUCTORS = [
  ["deriveBackend", (base: GraphBackend): object => deriveBackend(base, {})],
  [
    "projectBackend",
    (base: GraphBackend): object =>
      projectBackend(base, ["dialect", "capabilities"]),
  ],
  [
    "projectBackendWithout",
    (base: GraphBackend): object =>
      projectBackendWithout(base, ["capabilities"]),
  ],
  [
    "wrapWithManagedClose",
    (base: GraphBackend): object =>
      wrapWithManagedClose(base, () => {
        // No managed resource: this fixture asserts the carry, not teardown.
      }),
  ],
] as const satisfies readonly (readonly [
  string,
  (base: GraphBackend) => object,
])[];

const BASE_VERDICTS = [
  "serialized",
  "independent",
  "unaudited",
] as const satisfies readonly BaseVerdict[];

describe("seam constructors carry the base's resource audit", () => {
  // Every constructor × every verdict: the #435 regression net. A constructor
  // that stops carrying fails its three rows and nothing else, so the report
  // names which seam broke.
  it.each(
    SEAM_CONSTRUCTORS.flatMap(([name, derive]) =>
      BASE_VERDICTS.map((verdict) => [name, verdict, derive] as const),
    ),
  )("%s over a %s base", (_name, verdict, derive) => {
    const { backend, audit } = createAuditedBase(verdict);

    const derived = derive(backend);

    expect(derived).not.toBe(backend);
    expect(resolveBackendAudit(derived)).toEqual(audit);
  });

  it("carries the verdict through a three-deep projection/overlay/close chain", () => {
    const { backend } = createAuditedBase("serialized");

    const chained = wrapWithManagedClose(
      deriveBackend(projectGraphBackend(backend), {}),
      () => {
        // See above: teardown is not what this asserts.
      },
    );

    expect(sharesSerializedTransactionResource(chained, backend)).toBe(true);
  });
});

describe("a backend's resource verdict is written once", () => {
  it("keeps a derived backend unaudited when its base is audited afterwards", () => {
    // The lease reads this value and closes over the resource it claimed. A
    // verdict that appeared later would let a second stream find the registry
    // free and acquire — two long-lived streams on one connection.
    const base = makeUnauditedBackend();
    const derived = deriveBackend(base, {});

    expect(resolveBackendAudit(derived)).toBeUndefined();

    auditBackendResource(base, { kind: "serialized", resource: {} });

    expect(resolveBackendAudit(derived)).toBeUndefined();
    expect(sharesSerializedTransactionResource(derived, base)).toBe(false);
  });

  it("accepts a repeated audit naming the same resource", () => {
    const backend = makeUnauditedBackend();
    const resource = {};

    auditBackendResource(backend, { kind: "serialized", resource });
    auditBackendResource(backend, { kind: "serialized", resource });

    expect(resolveBackendAudit(backend)).toEqual({
      kind: "serialized",
      resource,
    });
  });

  it("accepts a repeated independent audit", () => {
    const backend = makeUnauditedBackend();

    auditBackendResource(backend, { kind: "independent" });
    auditBackendResource(backend, { kind: "independent" });

    expect(resolveBackendAudit(backend)).toEqual({ kind: "independent" });
  });

  // The message names BOTH verdicts: this is an internal invariant assertion,
  // so the only thing a maintainer reading the stack gets is what was recorded
  // and what was attempted.
  it.each([
    [
      "another connection",
      { kind: "serialized", resource: {} } satisfies BackendResourceAudit,
      { kind: "serialized", resource: {} } satisfies BackendResourceAudit,
      /"serialized".+"serialized" naming a different connection/s,
    ],
    [
      "independent over serialized",
      { kind: "serialized", resource: {} } satisfies BackendResourceAudit,
      { kind: "independent" } satisfies BackendResourceAudit,
      /"serialized".+"independent"/s,
    ],
    [
      "serialized over independent",
      { kind: "independent" } satisfies BackendResourceAudit,
      { kind: "serialized", resource: {} } satisfies BackendResourceAudit,
      /"independent".+"serialized"/s,
    ],
  ])(
    "refuses a second audit naming %s",
    (_name, recorded, conflicting, message) => {
      const backend = makeUnauditedBackend();
      auditBackendResource(backend, recorded);

      expect(() => {
        auditBackendResource(backend, conflicting);
      }).toThrow(TypeError);
      expect(() => {
        auditBackendResource(backend, conflicting);
      }).toThrow(message);
      expect(resolveBackendAudit(backend)).toEqual(recorded);
    },
  );
});

describe("shared serialized resources", () => {
  it("compares the resource, not the audit record", () => {
    const resource = {};
    const first = makeUnauditedBackend();
    const second = makeUnauditedBackend();
    const elsewhere = makeUnauditedBackend();
    auditBackendResource(first, { kind: "serialized", resource });
    auditBackendResource(elsewhere, { kind: "serialized", resource: {} });
    // A SEPARATE record naming the SAME client object: the two backends really
    // do serialize on one connection, however their verdicts were recorded.
    auditBackendResource(second, { kind: "serialized", resource });

    expect(
      sharesSerializedTransactionResource(deriveBackend(first, {}), first),
    ).toBe(true);
    expect(sharesSerializedTransactionResource(first, elsewhere)).toBe(false);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
  });

  it("answers false for an independent and for an unaudited backend", () => {
    const { backend: independent } = createAuditedBase("independent");
    const { backend: unaudited } = createAuditedBase("unaudited");

    expect(sharesSerializedTransactionResource(independent, independent)).toBe(
      false,
    );
    expect(sharesSerializedTransactionResource(unaudited, unaudited)).toBe(
      false,
    );
  });

  it("answers false in BOTH directions against a serialized backend", () => {
    // The right-hand side is read after the left narrows, so it must tolerate
    // a backend carrying no record at all.
    const { backend: serialized } = createAuditedBase("serialized");
    const { backend: independent } = createAuditedBase("independent");
    const { backend: unaudited } = createAuditedBase("unaudited");

    expect(sharesSerializedTransactionResource(serialized, independent)).toBe(
      false,
    );
    expect(sharesSerializedTransactionResource(serialized, unaudited)).toBe(
      false,
    );
  });
});

describe("factories audit unconditionally", () => {
  // Abstention is a VERDICT, not the absence of one: after this, a
  // factory-built backend reading as unaudited proves the factory did not
  // audit it.
  it("audits a SQLite backend over an unrecognized client independent", () => {
    const db: AnySqliteDatabase = drizzleSqliteProxy(() =>
      Promise.resolve({ rows: [] }),
    );

    const backend = createSqliteBackend(db);

    expect(resolveBackendAudit(backend)).toEqual({ kind: "independent" });
  });

  it("audits a pooled Postgres backend independent", async () => {
    // A default-size pool hands out an independent connection per checkout, so
    // "independent" is the correct verdict. No connection is opened here.
    const pool = new Pool({
      connectionString: "postgres://user@127.0.0.1:1/typegraph_derivation",
    });

    try {
      const backend = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
      });

      expect(resolveBackendAudit(backend)).toEqual({ kind: "independent" });
    } finally {
      await pool.end();
    }
  });
});

describe("the serialized stream lease", () => {
  it("is a synchronous claim that names the resource it registered under", () => {
    const resource = {};
    const backend = makeUnauditedBackend();
    auditBackendResource(backend, { kind: "serialized", resource });

    const lease = acquireSerializedStreamLease(backend, "import-stream");

    // No `await` between the registry read and the write, so the section
    // cannot be interleaved: a thenable return would break that.
    expect(lease).not.toHaveProperty("then");
    if (!lease.acquired) {
      throw new Error(`Expected a free lease, but a ${lease.heldBy} holds it.`);
    }
    expect(lease.resource).toBe(resource);
    lease.release();
  });

  it.each(["independent", "unaudited"] as const)(
    "reports no resource on the arm that registers nothing, for a %s backend",
    (verdict) => {
      const { backend } = createAuditedBase(verdict);

      const lease = acquireSerializedStreamLease(backend, "export-snapshot");

      if (!lease.acquired) {
        throw new Error(
          `Expected a free lease, but a ${lease.heldBy} holds it.`,
        );
      }
      expect(lease.resource).toBeUndefined();
      lease.release();
    },
  );
});

describe("projectBackendWithout narrows off the source's own keys", () => {
  it("retains the adapter members a GraphBackend-fixed allowlist would strip", () => {
    // The omission sites feed their result to createStore, which picks its
    // construction path off transactionWithNative / adoptTransaction. Projecting
    // over the portable GraphBackend allowlist would silently change which path
    // runs.
    const adapter = createTestBackend();

    const narrowed = projectBackendWithout(adapter, ["executeRaw"]);

    expect("executeRaw" in narrowed).toBe(false);
    expect(narrowed.transactionWithNative).toBeInstanceOf(Function);
    expect(narrowed.adoptTransaction).toBeInstanceOf(Function);
    expect(
      sharesSerializedTransactionResource(narrowed as GraphBackend, adapter),
    ).toBe(true);
  });

  it("retains members a class-implemented backend keeps on its prototype", () => {
    // A rest destructure copies only own ENUMERABLE keys, so a class-based
    // GraphBackend — a supported shape — would lose every method. The declared
    // Omit promises they survive.
    class PrototypeBackend {
      readonly dialect = "sqlite" as const;
      readonly capabilities = SQLITE_CAPABILITIES;
      close(): Promise<void> {
        return Promise.resolve();
      }
      executeRaw(): Promise<readonly never[]> {
        return Promise.resolve([]);
      }
    }
    const base = new PrototypeBackend();

    const narrowed = projectBackendWithout(base, ["executeRaw"]);

    expect("executeRaw" in narrowed).toBe(false);
    expect(narrowed.close).toBeInstanceOf(Function);
    expect(narrowed.dialect).toBe("sqlite");
    // The walk stops BELOW Object.prototype: a projection that copied its
    // members would publish `hasOwnProperty` and friends as backend members.
    expect(Object.hasOwn(narrowed, "hasOwnProperty")).toBe(false);
  });

  it("narrows a null-prototype source", () => {
    // The walk's other terminator: a chain that ends at `null` rather than at
    // Object.prototype.
    const base: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    base["dialect"] = "sqlite";
    base["executeRaw"] = () => Promise.resolve([]);

    const narrowed = projectBackendWithout(base, ["executeRaw"]);

    expect(Object.keys(narrowed)).toEqual(["dialect"]);
  });
});
