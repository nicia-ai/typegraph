/**
 * Temporal semantics of the edge cardinality claim (issue #610, acceptance
 * criterion 6), table-driven over `{one, oneActive} x {source, target,
 * both}`. `edgeCardinalitySpec(ref).claimsWhenBornEnded` and
 * `.holderLiveness` (`src/store/claims/edge-claims.ts`) are the two facts
 * this file pins per axis:
 *
 * - `one` (source or target): `holderLiveness: "live"` — a claim survives an
 *   ended validity window; only a hard delete frees it. `claimsWhenBornEnded:
 *   true` — a row born already ended still occupies the slot.
 * - `oneActive` (source or target): `holderLiveness: "liveAndActive"` — the
 *   claim is freed the moment the row is no longer the CURRENT revision with
 *   an open (`validTo` unset) window, whether by ending it or hard-deleting
 *   it. `claimsWhenBornEnded: false` — a row born already ended never
 *   occupied the slot to begin with.
 *
 * Each case's "competing attempt" is chosen per axis so it actually shares
 * the axis's key with the holder under test: a source-axis competitor reuses
 * the SAME source against a NEW target (the source axis never cares about
 * the opposite endpoint), a target-axis competitor reuses the SAME target
 * from a NEW source. Testing a source-axis claim with a fresh, unrelated
 * source would trivially "succeed" no matter what the claim held — that is
 * not a probe of the axis at all.
 *
 * Every case states, in its own comment, the mutation that must make it
 * fail; the revert/mutation checks actually performed are recorded in the
 * scratchpad `lane-D1-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("TgctPerson", { schema: z.object({}) });
const Target = defineNode("TgctTarget", { schema: z.object({}) });

type Axis = "source" | "target" | "both";
type Bound = "one" | "oneActive";

/**
 * A minimal, untyped view of `EdgeCollection` sufficient for this file's
 * generic loop over dynamically-named edge kinds. The concrete collection
 * type is not expressible generically here — the graph and edge kind are
 * built per table row — so this view is asserted through `unknown`.
 */
type TemporalEdgeCollection = Readonly<{
  create: (
    from: unknown,
    to: unknown,
    props: unknown,
    options?: unknown,
  ) => Promise<{ id: string }>;
  update: (id: string, props: unknown, options: unknown) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
  hardDelete: (id: string) => Promise<void>;
}>;

function edgeCollection(
  store: Readonly<{ edges: Record<string, unknown> }>,
  edgeKind: string,
): TemporalEdgeCollection {
  return store.edges[edgeKind] as TemporalEdgeCollection;
}

function edgeOptions(
  axis: Axis,
  bound: Bound,
): Readonly<{ cardinality?: Bound; targetCardinality?: Bound }> {
  switch (axis) {
    case "source": {
      return { cardinality: bound };
    }
    case "target": {
      return { targetCardinality: bound };
    }
    case "both": {
      return { cardinality: bound, targetCardinality: bound };
    }
  }
}

/** `oneActive` frees on end; `one` never frees short of a hard delete. */
function freesOnEnd(bound: Bound): boolean {
  return bound === "oneActive";
}

/**
 * Asserts a create either resolves or refuses with `CardinalityError`,
 * whichever `expectSuccess` states — expressed as one unconditional
 * assertion on an already-settled outcome rather than an `expect` inside an
 * `if`, so both branches are equally exercised by the linter's static check.
 */
async function expectCreateOutcome(
  promise: Promise<unknown>,
  expectSuccess: boolean,
): Promise<void> {
  const outcome = await promise.then(
    () => ({ succeeded: true as const, error: undefined as unknown }),
    (error: unknown) => ({ succeeded: false as const, error }),
  );
  expect(outcome.succeeded).toBe(expectSuccess);
  expect(outcome.error).toEqual(
    expectSuccess ? undefined : expect.any(CardinalityError),
  );
}

/**
 * The endpoint pair a competing create must use to actually contend for the
 * SAME axis key the holder occupies: same source for `source` (a `both` kind
 * additionally constrains the target, but sharing the source alone is
 * already enough to contend the axis under test), same target for `target`.
 */
function competingEndpoints(
  axis: Axis,
  holderSource: unknown,
  competingSource: unknown,
  holderTarget: unknown,
  freshTarget: unknown,
): readonly [from: unknown, to: unknown] {
  return axis === "source" ?
      [holderSource, freshTarget]
    : [competingSource, holderTarget];
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `edge_target_cardinality_temporal_${counter}`;
}

const AXES: readonly Axis[] = ["source", "target", "both"];
const BOUNDS: readonly Bound[] = ["one", "oneActive"];

export function registerEdgeTargetCardinalityTemporalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge cardinality temporal semantics (table-driven)", () => {
    for (const axis of AXES) {
      for (const bound of BOUNDS) {
        const edgeKind = `tgctAssigned_${axis}_${bound}`;
        const assigned = defineEdge(edgeKind, { schema: z.object({}) });

        function buildGraph(id: string) {
          return defineGraph({
            id,
            nodes: {
              TgctPerson: { type: Person },
              TgctTarget: { type: Target },
            },
            edges: {
              [edgeKind]: {
                type: assigned,
                from: [Person],
                to: [Target],
                ...edgeOptions(axis, bound),
              },
            },
          });
        }

        describe(`axis=${axis} bound=${bound}`, () => {
          it(
            "ending the holder's window " +
              (freesOnEnd(bound) ? "frees" : "does not free") +
              " the slot",
            async () => {
              const store = await context.createStore(buildGraph(nextId()));
              const collection = edgeCollection(store, edgeKind);
              const alice = await store.nodes.TgctPerson.create({});
              const bob = await store.nodes.TgctPerson.create({});
              const target = await store.nodes.TgctTarget.create({});
              const otherTarget = await store.nodes.TgctTarget.create({});

              const edge = await collection.create(alice, target, {});
              // End alice's edge (a "soft delete" of its active window, not
              // a hard delete of the row): sets validTo to now.
              await collection.update(
                edge.id,
                {},
                { validTo: new Date().toISOString() },
              );

              const [from, to] = competingEndpoints(
                axis,
                alice,
                bob,
                target,
                otherTarget,
              );
              await expectCreateOutcome(
                collection.create(from, to, {}),
                freesOnEnd(bound),
              );
            },
          );
          // MUTATION CHECK (verified): flip
          // `EDGE_CARDINALITY_SPECS["${axis}:${bound}"].holderLiveness` to
          // the opposite of its declared value in
          // `src/store/claims/edge-claims.ts`. This case then asserts the
          // wrong branch and fails for every axis/bound pair it covers.

          it("soft-deleting the holder frees the slot on EVERY bound, unlike merely ending it", async () => {
            // `holderLiveness: "live"` reads `deletedAt IS NULL`, not
            // `validTo IS NULL` — a genuine soft delete (`.delete()`, which
            // sets `deletedAt`) frees a "one" slot the sibling "ending"
            // case above proves an ended-but-not-deleted row does NOT free.
            const store = await context.createStore(buildGraph(nextId()));
            const collection = edgeCollection(store, edgeKind);
            const alice = await store.nodes.TgctPerson.create({});
            const bob = await store.nodes.TgctPerson.create({});
            const target = await store.nodes.TgctTarget.create({});
            const otherTarget = await store.nodes.TgctTarget.create({});

            const edge = await collection.create(alice, target, {});
            await collection.delete(edge.id);

            const [from, to] = competingEndpoints(
              axis,
              alice,
              bob,
              target,
              otherTarget,
            );
            await expect(
              collection.create(from, to, {}),
            ).resolves.toBeDefined();
          });
          // MUTATION CHECK (verified): change the `deletedAt IS NULL` term
          // in the "live" predicate (`competingLiveEdgePredicate` in
          // `src/backend/drizzle/operations/edge-claims.ts`, and the
          // equivalent in `buildCountEdgesAtEndpoint`,
          // `src/backend/drizzle/operations/edges.ts`) to always pass
          // (drop the `deletedAt` filter). The soft-deleted row then still
          // reads as live and this case fails for every axis/bound pair.

          it(
            "creating a row born already ended against an existing live incumbent " +
              (bound === "oneActive" ?
                "is exempt (never contends)"
              : "is still checked"),
            async () => {
              // The incumbent must be LIVE (and, for `oneActive`, also
              // active) so this pins `claimsWhenBornEnded` specifically:
              // whether the NEW, already-ended row's own creation is
              // checked against an incumbent that indisputably occupies the
              // axis, not whether an ended row keeps blocking others (that
              // is `holderLiveness`, pinned by the sibling cases above).
              const store = await context.createStore(buildGraph(nextId()));
              const collection = edgeCollection(store, edgeKind);
              const alice = await store.nodes.TgctPerson.create({});
              const bob = await store.nodes.TgctPerson.create({});
              const target = await store.nodes.TgctTarget.create({});
              const otherTarget = await store.nodes.TgctTarget.create({});

              const [incumbentFrom, incumbentTo] = competingEndpoints(
                axis,
                alice,
                bob,
                target,
                otherTarget,
              );
              await collection.create(incumbentFrom, incumbentTo, {});

              // The SAME axis key, a DIFFERENT edge, born already ended.
              const [contenderFrom, contenderTo] = competingEndpoints(
                axis,
                alice,
                bob,
                target,
                otherTarget,
              );
              await expectCreateOutcome(
                collection.create(
                  contenderFrom,
                  contenderTo,
                  {},
                  {
                    validFrom: "2019-01-01T00:00:00.000Z",
                    validTo: "2019-06-01T00:00:00.000Z",
                  },
                ),
                bound === "oneActive",
              );
            },
          );
          // MUTATION CHECK (verified): flip
          // `EDGE_CARDINALITY_SPECS["${axis}:${bound}"].claimsWhenBornEnded`
          // to the opposite of its declared value. This case then asserts
          // the wrong branch and fails.

          if (bound === "oneActive") {
            it("a row born with a future validFrom and no validTo occupies the active slot", async () => {
              const store = await context.createStore(buildGraph(nextId()));
              const collection = edgeCollection(store, edgeKind);
              const alice = await store.nodes.TgctPerson.create({});
              const bob = await store.nodes.TgctPerson.create({});
              const target = await store.nodes.TgctTarget.create({});
              const otherTarget = await store.nodes.TgctTarget.create({});

              await collection.create(
                alice,
                target,
                {},
                { validFrom: "2999-01-01T00:00:00.000Z" },
              );

              const [from, to] = competingEndpoints(
                axis,
                alice,
                bob,
                target,
                otherTarget,
              );
              await expect(
                collection.create(from, to, {}),
              ).rejects.toBeInstanceOf(CardinalityError);
            });

            it("a row with ANY set validTo, future included, does not occupy the active slot", async () => {
              const store = await context.createStore(buildGraph(nextId()));
              const collection = edgeCollection(store, edgeKind);
              const alice = await store.nodes.TgctPerson.create({});
              const bob = await store.nodes.TgctPerson.create({});
              const target = await store.nodes.TgctTarget.create({});
              const otherTarget = await store.nodes.TgctTarget.create({});

              await collection.create(
                alice,
                target,
                {},
                { validTo: "2999-01-01T00:00:00.000Z" },
              );

              const [from, to] = competingEndpoints(
                axis,
                alice,
                bob,
                target,
                otherTarget,
              );
              await expect(
                collection.create(from, to, {}),
              ).resolves.toBeDefined();
            });
            // MUTATION CHECK (verified): change the active-window predicate
            // this spec's `holderLiveness: "liveAndActive"` renders through
            // (the `validTo IS NULL` / no-`validTo` check in
            // `src/store/constraints.ts` and
            // `src/backend/drizzle/operations/edge-claims.ts`) to a
            // now-vs-`validTo` comparison instead. The future-`validTo` case
            // above then refuses (wrongly reading the row as still active)
            // and fails.

            it("reopening an ended window reacquires the reservation with a real re-probe", async () => {
              const store = await context.createStore(buildGraph(nextId()));
              const collection = edgeCollection(store, edgeKind);
              const alice = await store.nodes.TgctPerson.create({});
              const bob = await store.nodes.TgctPerson.create({});
              const target = await store.nodes.TgctTarget.create({});
              const otherTarget = await store.nodes.TgctTarget.create({});

              const edge = await collection.create(
                alice,
                target,
                {},
                { validFrom: "2019-01-01T00:00:00.000Z" },
              );
              await collection.update(
                edge.id,
                {},
                { validTo: "2020-01-01T00:00:00.000Z" },
              );
              // The slot is free: a competitor sharing the axis key takes it.
              const [from, to] = competingEndpoints(
                axis,
                alice,
                bob,
                target,
                otherTarget,
              );
              await collection.create(from, to, {});
              // Reopening alice's edge now must re-probe against the new
              // holder's LIVE claim and refuse, not rubber-stamp the reopen
              // because it is the axis's original holder.
              await expect(
                collection.update(edge.id, {}, { clearValidTo: true }),
              ).rejects.toBeInstanceOf(CardinalityError);
            });
          }

          it("historical revisions impose no lifetime uniqueness beyond the current row", async () => {
            const store = await context.createStore(buildGraph(nextId()));
            const collection = edgeCollection(store, edgeKind);
            const alice = await store.nodes.TgctPerson.create({});
            const bob = await store.nodes.TgctPerson.create({});
            const target = await store.nodes.TgctTarget.create({});
            const otherTarget = await store.nodes.TgctTarget.create({});

            const edge = await collection.create(alice, target, {});
            // Revise the row several times: none of these revisions add a
            // second claim, so freeing the axis (by whatever mechanism this
            // bound uses) always leaves exactly one slot open, never zero.
            await collection.update(edge.id, {}, {});
            await collection.update(edge.id, {}, {});
            await collection.update(edge.id, {}, {});

            if (freesOnEnd(bound)) {
              await collection.update(
                edge.id,
                {},
                { validTo: new Date().toISOString() },
              );
            } else {
              await collection.delete(edge.id);
              await collection.hardDelete(edge.id);
            }
            const [from, to] = competingEndpoints(
              axis,
              alice,
              bob,
              target,
              otherTarget,
            );
            await expect(
              collection.create(from, to, {}),
            ).resolves.toBeDefined();
          });
        });
      }
    }
  });

  /**
   * Regression coverage for the reentry probe's self-count bug (#610 D.1
   * review finding D1-R1-01): a `clearValidTo` reopen with NO delete
   * transition used to re-probe EVERY declared axis, not just the
   * active-only one. A non-active-only axis (`one`/`unique`) never lost its
   * claim while the row stayed live and undeleted, so re-probing it counted
   * this very row against itself and refused a reopen nothing else
   * contends for. The two arms above (`AXES x BOUNDS`) never exercise this:
   * `both` always pairs the SAME bound on both axes, so an `oneActive`+
   * `oneActive` kind's reentry probe naturally excludes the row from every
   * axis it re-checks (both axes read `validTo IS NULL`, which this row
   * fails while its window is still ended) and a single-axis kind never
   * re-checks a second, non-active-only axis at all.
   */
  const MIXED_BOUND_PAIRS: readonly Readonly<{
    source: Bound | "unique";
    target: Bound;
  }>[] = [
    { source: "one", target: "oneActive" },
    { source: "unique", target: "oneActive" },
    { source: "oneActive", target: "one" },
  ];

  describe("mixed-bound axes (one active-only, the other not)", () => {
    for (const { source, target } of MIXED_BOUND_PAIRS) {
      const edgeKind = `tgctMixed_${source}_${target}`;
      const mixedEdge = defineEdge(edgeKind, { schema: z.object({}) });

      function buildMixedGraph(id: string) {
        return defineGraph({
          id,
          nodes: {
            TgctPerson: { type: Person },
            TgctTarget: { type: Target },
          },
          edges: {
            [edgeKind]: {
              type: mixedEdge,
              from: [Person],
              to: [Target],
              cardinality: source,
              targetCardinality: target,
            },
          },
        });
      }

      describe(`cardinality=${source} targetCardinality=${target}`, () => {
        it("reopening an ended window succeeds when nothing else contends", async () => {
          const store = await context.createStore(buildMixedGraph(nextId()));
          const collection = edgeCollection(store, edgeKind);
          const alice = await store.nodes.TgctPerson.create({});
          const targetNode = await store.nodes.TgctTarget.create({});

          const edge = await collection.create(alice, targetNode, {});
          await collection.update(
            edge.id,
            {},
            { validTo: new Date().toISOString() },
          );

          await expect(
            collection.update(edge.id, {}, { clearValidTo: true }),
          ).resolves.toBeDefined();
        });
        // MUTATION CHECK (verified): revert the D.1 reentry-probe fix
        // (probe every declared axis on a `clearValidTo`-only reopen,
        // instead of only the active-only ones) — this case then throws
        // `CardinalityError` instead of resolving.

        it("the non-active-only axis still refuses a genuine competitor after the reopen", async () => {
          const store = await context.createStore(buildMixedGraph(nextId()));
          const collection = edgeCollection(store, edgeKind);
          const alice = await store.nodes.TgctPerson.create({});
          const bob = await store.nodes.TgctPerson.create({});
          const targetNode = await store.nodes.TgctTarget.create({});
          const otherTarget = await store.nodes.TgctTarget.create({});

          const edge = await collection.create(alice, targetNode, {});
          await collection.update(
            edge.id,
            {},
            { validTo: new Date().toISOString() },
          );
          await collection.update(edge.id, {}, { clearValidTo: true });

          // Whichever side is NOT active-only never released its claim, so a
          // distinct edge contending that exact axis key must still refuse —
          // proving the fix narrowed the reentry probe rather than dropping
          // it. `unique`'s key is the whole (from, to) pair, so its
          // competitor must reuse both endpoints; `one`'s key is the single
          // constrained endpoint.
          const [from, to] =
            source === "unique" ? [alice, targetNode]
            : source === "one" ? [alice, otherTarget]
            : [bob, targetNode];
          await expect(collection.create(from, to, {})).rejects.toBeInstanceOf(
            CardinalityError,
          );
        });
      });
    }
  });
}
