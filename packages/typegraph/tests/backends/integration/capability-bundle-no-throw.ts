/**
 * T9b (I16) — construction-only factory matrix: for every combination of
 * {fulltext default|explicit} × {executionProfile.transactionMode
 * default|"none"} × {capabilities.windowFunctions true|false} × {override
 * none|{fulltext:undefined}|{vector:undefined}|{contributions:undefined}},
 * all six pilot bundles resolve against the constructed backend WITHOUT
 * throwing on the non-override rows, and either don't throw or throw a
 * `ConfigurationError` whose `code` the registry declares on the override
 * rows.
 *
 * Construction only — no query runs — so a `drizzle-orm/sqlite-proxy` stub
 * suffices for SQLite and one shared PGlite client (no Docker lane) for
 * PostgreSQL, chosen off `context.getBackend().dialect`. The precedent and
 * its justification are `tests/capability-declaration-validation.test.ts:1-38`.
 *
 * SCOPE NOTE: the `vector` dimension is fixed at each dialect's DEFAULT
 * (unset for SQLite, `pgvectorStrategy` for PostgreSQL) rather than swept —
 * constructing a lightweight, query-free `VectorStrategy` stub for the
 * SQLite lane would exercise the strategy's own shape rather than the bundle
 * model this test targets, and no pilot bundle reads `capabilities.vector`.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";

import {
  BATCH_POINT_READ,
  CAPABILITY_BUNDLES,
  CLAIMS,
  CONTRIBUTION_HEALTH,
  RECORDED_REVISION_ORIGINS,
  STATEMENT_EXECUTION,
  UNIQUE_SIDECAR_BATCH,
} from "../../../src/backend/capabilities/bundle-registry";
import { resolveBundle } from "../../../src/backend/capabilities/resolve";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import {
  type BackendCapabilities,
  type GraphBackend,
} from "../../../src/backend/types";
import { ConfigurationError } from "../../../src/errors";
import {
  fts5Strategy,
  tsvectorStrategy,
} from "../../../src/query/dialect/fulltext-strategy";
import { type IntegrationTestContext } from "./test-context";

type CapabilityOverrideKey = "none" | "fulltext" | "vector" | "contributions";
const OVERRIDES: readonly CapabilityOverrideKey[] = [
  "none",
  "fulltext",
  "vector",
  "contributions",
];

function overrideFor(key: CapabilityOverrideKey): Partial<BackendCapabilities> {
  switch (key) {
    case "none": {
      return {};
    }
    case "fulltext": {
      return { fulltext: undefined };
    }
    case "vector": {
      return { vector: undefined };
    }
    case "contributions": {
      return { contributions: undefined };
    }
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}

function buildSqliteBackends(): readonly Readonly<{
  label: string;
  overrideKey: CapabilityOverrideKey;
  backend: GraphBackend;
}>[] {
  const rows: Readonly<{
    label: string;
    overrideKey: CapabilityOverrideKey;
    backend: GraphBackend;
  }>[] = [];
  for (const fulltext of [undefined, fts5Strategy]) {
    for (const transactionMode of [undefined, "none" as const]) {
      for (const windowFunctions of [true, false]) {
        for (const overrideKey of OVERRIDES) {
          const base = createSqliteBackend(
            drizzleSqliteProxy(() => Promise.resolve({ rows: [] })),
            {
              ...(fulltext === undefined ? {} : { fulltext }),
              ...(transactionMode === undefined ?
                {}
              : { executionProfile: { transactionMode } }),
            },
          );
          const capabilities = {
            ...base.capabilities,
            windowFunctions,
            ...overrideFor(overrideKey),
          };
          const backend = deriveBackend(base, { capabilities });
          rows.push({
            label: `sqlite fulltext=${fulltext === undefined ? "default" : "explicit"} transactionMode=${transactionMode ?? "default"} windowFunctions=${windowFunctions} override=${overrideKey}`,
            overrideKey,
            backend,
          });
        }
      }
    }
  }
  return rows;
}

function buildPostgresBackends(pgliteClient: PGlite): readonly Readonly<{
  label: string;
  overrideKey: CapabilityOverrideKey;
  backend: GraphBackend;
}>[] {
  const rows: Readonly<{
    label: string;
    overrideKey: CapabilityOverrideKey;
    backend: GraphBackend;
  }>[] = [];
  for (const fulltext of [undefined, tsvectorStrategy]) {
    for (const windowFunctions of [true, false]) {
      for (const overrideKey of OVERRIDES) {
        const base = createPostgresBackend(drizzlePglite(pgliteClient), {
          vector: false,
          ...(fulltext === undefined ? {} : { fulltext }),
        });
        const capabilities = {
          ...base.capabilities,
          windowFunctions,
          ...overrideFor(overrideKey),
        };
        const backend = deriveBackend(base, { capabilities });
        rows.push({
          label: `postgres fulltext=${fulltext === undefined ? "default" : "explicit"} windowFunctions=${windowFunctions} override=${overrideKey}`,
          overrideKey,
          backend,
        });
      }
    }
  }
  return rows;
}

const DECLARED_PORT_SURFACE_CODES = new Set<string>(
  CAPABILITY_BUNDLES.map((bundle) => bundle.portSurfaceCode),
);

function resolveAllSixBundles(backend: GraphBackend): void {
  resolveBundle(backend, CLAIMS);
  resolveBundle(backend, UNIQUE_SIDECAR_BATCH);
  resolveBundle(backend, BATCH_POINT_READ);
  resolveBundle(backend, STATEMENT_EXECUTION);
  resolveBundle(backend, CONTRIBUTION_HEALTH);
  resolveBundle(backend, RECORDED_REVISION_ORIGINS);
}

export function registerCapabilityBundleNoThrowIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("capability bundle construction never throws unexpectedly (T9b)", () => {
    it("resolves all six bundles against the factory matrix", async () => {
      const dialect = context.getBackend().dialect;
      const rows =
        dialect === "sqlite" ?
          buildSqliteBackends()
        : await (async () => {
            const pgliteClient = await PGlite.create();
            try {
              return buildPostgresBackends(pgliteClient);
            } finally {
              await pgliteClient.close();
            }
          })();

      const decisions: Readonly<{ label: string; outcome: string }>[] = [];
      for (const row of rows) {
        const caught = ((): unknown => {
          try {
            resolveAllSixBundles(row.backend);
            return undefined;
          } catch (error) {
            return error;
          }
        })();

        // Never call `expect` inside a conditional: compute the verdict as
        // plain data first, then assert it once, unconditionally, below —
        // a plain `throw` (not `expect`) reports a bad verdict, since
        // `no-conditional-expect` only governs `expect` calls.
        const describe = (value: unknown): string =>
          value instanceof Error ? value.message : JSON.stringify(value);
        const verdict: Readonly<{
          ok: boolean;
          message: string;
          outcome: string;
        }> =
          caught === undefined ? { ok: true, message: "", outcome: "no-throw" }
          : row.overrideKey === "none" ?
            {
              ok: false,
              message: `Non-override row "${row.label}" threw: ${describe(caught)}`,
              outcome: "no-throw",
            }
          : (
            caught instanceof ConfigurationError &&
            DECLARED_PORT_SURFACE_CODES.has(caught.details["code"] as string)
          ) ?
            {
              ok: true,
              message: "",
              outcome: `throw:${String(caught.details["code"])}`,
            }
          : {
              ok: false,
              message: `${row.label} threw an undeclared or non-ConfigurationError outcome: ${describe(caught)}`,
              outcome: `throw:${describe(caught)}`,
            };

        if (!verdict.ok) throw new Error(verdict.message);
        decisions.push({ label: row.label, outcome: verdict.outcome });
      }
      // Snapshot every decision (the spec's own requirement).
      expect(decisions).toMatchSnapshot();
    });
  });
}
