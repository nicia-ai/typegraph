/**
 * T9d — the member-drop-matrix runner. For each of the pilot's 15 members,
 * drops it from the current lane's backend via
 * `projectBackendWithout(backend, [member])` and checks two things:
 *
 * 1. REGISTRY CONSISTENCY (every pilot member, every affected operation
 *    row): `resolveBundle` reports the member missing, the bundle/extra
 *    verdict carries the row's OWN disposition, and every operation row that
 *    names neither the dropped member nor a member of the same `requires`
 *    set is unaffected — checked PER ROW, not just per bundle: for every
 *    operation row (across all six bundles) whose own `sites` do not name
 *    the dropped member, `rowSatisfied` (the row's `requires`-extras-present
 *    predicate for a graduated bundle, or the bundle's own `supported` flag
 *    for a gated one) is asserted equal against the dropped backend and the
 *    original one. This also covers rows in the SAME bundle as the dropped
 *    member but unrelated to it (e.g. dropping `insertUniqueBatch` must
 *    leave `uniqueSidecarBatch`'s `checkUniqueBatch`-only and
 *    `hardDeleteUniquesByNodeIds`-only rows unaffected), not only rows in
 *    other bundles — disjointness across bundles is a separate, compile-time
 *    proof (`_bundleDisjoint1`-`5`), not what this runtime check is for.
 * 2. REALITY CROSS-CHECK, on the two members whose real behavior is callable
 *    without a full `Store`/schema fixture (`hardDeleteUniquesByNodeIds` via
 *    `hardDeleteClaimsByNodeIds`, `ensureRevisionOriginsTable` via
 *    `ensureRevisionOrigin`): the registry's claimed disposition must match
 *    what the REAL function actually does when the member is absent. This is
 *    the check Mutations D and E exercise — a registry row can drift from
 *    the code it describes, and (1) alone cannot catch that.
 *
 * Non-pilot members (66 of the 81) are REPORT-ONLY: set
 * `WS5_SWEEP_ALL_MEMBERS=1` when running this suite to print each deferred/
 * reasoned member's registry classification for WS5b's own drop-matrix
 * round — this file does not (and per §7 must not) assert behavior for them.
 *
 *   WS5_SWEEP_ALL_MEMBERS=1 pnpm vitest run tests/backends/integration
 */
import { describe, expect, it } from "vitest";

import { defineGraph } from "../../../src";
import {
  BATCH_POINT_READ,
  CAPABILITY_BUNDLES,
  type CapabilityBundleOperation,
  CLAIMS,
  CONTRIBUTION_HEALTH,
  type OptionalGraphBackendMember,
  RECORDED_REVISION_ORIGINS,
  STATEMENT_EXECUTION,
  UNBUNDLED_OPTIONAL_MEMBERS,
  UNIQUE_SIDECAR_BATCH,
} from "../../../src/backend/capabilities/bundle-registry";
import { resolveBundle } from "../../../src/backend/capabilities/resolve";
import { projectBackendWithout } from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { buildKindRegistry } from "../../../src/registry/builders";
import {
  createUniquenessContext,
  hardDeleteClaimsByNodeIds,
} from "../../../src/store/claims/node-claims";
import { ensureRevisionOrigin } from "../../../src/store/recorded-capture/clock";
import { type IntegrationTestContext } from "./test-context";

const PILOT_MEMBERS: readonly OptionalGraphBackendMember[] = [
  "claimEdgeCardinality",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "hardDeleteUniquesByConcreteKind",
  "insertUniqueBatch",
  "checkUniqueBatch",
  "hardDeleteUniquesByNodeIds",
  "getNodes",
  "getEdges",
  "executeStatement",
  "verifyContributions",
  "repairContributions",
  "rebuildContribution",
  "probeContributions",
  "ensureRevisionOriginsTable",
];

function resolveAll(backend: GraphBackend): readonly unknown[] {
  return [
    resolveBundle(backend, CLAIMS),
    resolveBundle(backend, UNIQUE_SIDECAR_BATCH),
    resolveBundle(backend, BATCH_POINT_READ),
    resolveBundle(backend, STATEMENT_EXECUTION),
    resolveBundle(backend, CONTRIBUTION_HEALTH),
    resolveBundle(backend, RECORDED_REVISION_ORIGINS),
  ];
}

/**
 * One operation row's own outcome, read off a resolved verdict: a GATED
 * bundle's rows have no `requires` (there is no per-row decision below the
 * bundle's own core), so the row's outcome IS the bundle's `supported` flag;
 * a GRADUATED bundle's row names the extras it `requires`, and the outcome
 * is whether every one of them is present. This is the one predicate both
 * the "affected" and "unaffected" halves of the drop matrix read, so the two
 * halves cannot silently disagree about what a row's outcome means.
 */
function rowSatisfied(
  bundle: (typeof CAPABILITY_BUNDLES)[number],
  verdict: unknown,
  row: CapabilityBundleOperation,
): boolean {
  if (bundle.kind === "gated") {
    return (verdict as { supported: boolean }).supported;
  }
  const extras = (verdict as { extras: Record<string, { present: boolean }> })
    .extras;
  return (row.requires ?? []).every((id) => extras[id]?.present === true);
}

export function registerCapabilityMemberDropMatrixIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("capability member drop matrix (T9d)", () => {
    it("dropping each pilot member matches the registry's own claim, for every other pilot member unaffected", () => {
      const backend = context.getBackend();
      const baseline = resolveAll(backend);

      for (const member of PILOT_MEMBERS) {
        const dropped = projectBackendWithout(backend, [member]);

        // Registry consistency: some bundle must now report this member
        // missing (core) or absent (extra) — a pilot member with no such
        // bundle would be a registry bug this loop would silently miss.
        // Every check below is computed as plain data FIRST, with no
        // `expect` inside a conditional; each is asserted once, unconditionally.
        let sawAbsence = false;
        for (const bundle of CAPABILITY_BUNDLES) {
          const coreNamesMember =
            "core" in bundle &&
            (bundle.core as readonly string[]).includes(member);

          if (coreNamesMember && bundle.crossCheck === "bidirectional") {
            // `claims` keeps its declaration (`constraintClaims: true`), so
            // dropping one of its four core members is a DECLARED-BUT-
            // MISSING disagreement — the bidirectional cross-check throws,
            // it does not resolve `supported: false` (that arm is reserved
            // for the undeclared-and-absent state).
            const caught = ((): unknown => {
              try {
                resolveBundle(
                  dropped,
                  bundle as (typeof CAPABILITY_BUNDLES)[number],
                );
                return undefined;
              } catch (error) {
                return error;
              }
            })();
            const code =
              caught instanceof Error ?
                (
                  caught as Error & {
                    details: Readonly<Record<string, unknown>>;
                  }
                ).details["code"]
              : undefined;
            if (!(caught instanceof Error) || code !== bundle.portSurfaceCode) {
              throw new Error(
                `${bundle.id} core member "${member}" dropped should throw ${bundle.portSurfaceCode}, got ${String(caught)}`,
              );
            }
            sawAbsence = true;
            continue;
          }

          const verdict = resolveBundle(dropped, bundle);
          if (coreNamesMember) {
            const supported = (verdict as { supported: boolean }).supported;
            if (supported) {
              throw new Error(
                `${bundle.id} core member "${member}" dropped should resolve unsupported`,
              );
            }
            sawAbsence = true;
          }
          if ("extras" in bundle) {
            for (const extra of bundle.extras) {
              if (!(extra.members as readonly string[]).includes(member)) {
                continue;
              }
              const extraVerdict = (
                verdict as {
                  extras: Record<string, { present: boolean }>;
                }
              ).extras[extra.id];
              if (extraVerdict?.present !== false) {
                throw new Error(
                  `${bundle.id}/${extra.id} member "${member}" dropped should be absent`,
                );
              }
              sawAbsence = true;
            }
          }

          // Unaffected rows: every operation row (in THIS bundle or any
          // other) whose own `sites` do not name the dropped member must
          // resolve exactly as it does against the undropped backend — the
          // per-row predicate, not the whole-bundle verdict object, because
          // a graduated bundle can have one extra affected and its siblings
          // untouched by the very same drop.
          const baselineVerdict = resolveBundle(backend, bundle);
          for (const row of bundle.operations as readonly CapabilityBundleOperation[]) {
            const rowMembers = new Set(row.sites.map((site) => site.member));
            if (rowMembers.has(member)) continue;
            const droppedOutcome = rowSatisfied(bundle, verdict, row);
            const baselineOutcome = rowSatisfied(bundle, baselineVerdict, row);
            if (droppedOutcome !== baselineOutcome) {
              throw new Error(
                `${bundle.id} operation "${row.operation}" changed (${String(baselineOutcome)} -> ${String(droppedOutcome)}) when unrelated member "${member}" was dropped`,
              );
            }
          }
        }
        if (!sawAbsence) {
          throw new Error(`no bundle observed "${member}" dropped`);
        }
      }

      // Unaffected rows: re-resolving against the ORIGINAL (undropped)
      // backend still matches the very first baseline — resolveBundle is
      // pure over its arguments, so this also witnesses that no dropped-copy
      // call above mutated the shared backend object.
      expect(resolveAll(backend)).toEqual(baseline);
    });

    it("REALITY CROSS-CHECK: hardDeleteUniquesByNodeIds absence throws through requireDefined, matching the registry's `refuse`", async () => {
      const backend = context.getBackend();
      const dropped = projectBackendWithout(backend, [
        "hardDeleteUniquesByNodeIds",
      ]);
      const registryRow = UNIQUE_SIDECAR_BATCH.operations.find(
        (operation) => operation.operation === "unique reap by node ids",
      );
      expect(registryRow?.disposition.kind).toBe("refuse");

      const ctx = createUniquenessContext(
        "test-graph",
        buildKindRegistry(
          defineGraph({ id: "test-graph", nodes: {}, edges: {} }),
        ),
        dropped,
      );
      await expect(
        hardDeleteClaimsByNodeIds(ctx, "SomeKind", ["id-1"]),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it("REALITY CROSS-CHECK: ensureRevisionOriginsTable absence throws, matching the registry's `refuse`", async () => {
      const backend = context.getBackend();
      const dropped = projectBackendWithout(backend, [
        "ensureRevisionOriginsTable",
      ]);
      const registryRow = RECORDED_REVISION_ORIGINS.operations.find(
        (operation) => operation.operation === "revision origin bootstrap",
      );
      expect(registryRow?.disposition.kind).toBe("refuse");

      await expect(
        ensureRevisionOrigin(dropped, createSqlSchema(), "test-graph"),
      ).rejects.toThrow(/revision origin/i);
    });

    if (process.env["WS5_SWEEP_ALL_MEMBERS"] === "1") {
      it("report-only: every non-pilot member's registry classification", () => {
        console.log(JSON.stringify(UNBUNDLED_OPTIONAL_MEMBERS, undefined, 2));
      });
    }
  });
}
