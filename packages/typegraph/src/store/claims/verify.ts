/**
 * The read-only fence diagnostic: which claim axes are ALREADY contended.
 *
 * A claim relation refuses a second claimant from the first post-upgrade write
 * onward, but it repairs nothing that is already there. A database that carried
 * two live siblings sharing a scoped key, or two live `cardinality: "one"` edges
 * from one source, keeps carrying them — the next write that touches such an
 * axis is refused with the ordinary typed error naming the incumbent, and until
 * then nothing says so out loud. This module is what says so.
 *
 * It reports; it never repairs. Choosing which of two live claimants keeps the
 * axis is a data-loss decision that belongs to the operator, not to a
 * diagnostic.
 *
 * Every axis and key it names is built by the SAME function the fence writes
 * with — {@link uniquenessClaimTarget}, {@link disjointnessClaimAxis},
 * {@link edgeCardinalityClaimTarget} — so a report row names the row a writer
 * would actually contend for. A second spelling here would produce a report
 * about axes the fence does not use.
 */
import type {
  ConstraintFenceViolationRows,
  ContendedEdgeRow,
  ContendedUniqueRow,
  DisjointOverlapRow,
  EdgeCardinalityDeclaration,
  GraphBackend,
  ReadConstraintFenceViolationsParams,
} from "../../backend/types";
import { subClassComponent } from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";
import { compareStrings } from "../../utils/compare";
import {
  type ClaimOwner,
  type ClaimTarget,
  compareClaimTargets,
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
  isSameClaimOwner,
  uniquenessClaimTarget,
} from "./axis";
import { edgeCardinalityClaimTarget } from "./edge-claims";

/**
 * One claim axis more than one live claimant holds.
 *
 * Discriminated on the family because the two claim relations record their
 * holders differently: a `uniques` axis is held by an OWNER PAIR (ids are
 * unique only per kind), an edge-claim axis by an edge id. `target` is the
 * claim row itself, so a reader can go straight to the row a writer contends
 * for rather than reconstructing it from the family's own vocabulary.
 */
export type ConstraintFenceViolation =
  | Readonly<{
      family: "nodeUniqueness" | "nodeDisjointness";
      target: ClaimTarget;
      owners: readonly ClaimOwner[];
    }>
  | Readonly<{
      family: "edgeCardinality";
      target: ClaimTarget;
      edgeIds: readonly string[];
    }>;

/** What the audit needs to know: the graph, its registry, and where to read. */
export type VerifyConstraintFencesContext = Readonly<{
  graph: GraphDef;
  registry: KindRegistry;
  graphId: string;
  backend: GraphBackend;
}>;

/**
 * One `(constraint name, axis)` a declared uniqueness constraint claims at, and
 * the kinds whose claim rows fold onto it.
 *
 * The covered set is what maps a row written at a LEGACY axis — its own
 * concrete kind, which is where every pre-upgrade row sits — onto the axis this
 * version writes at. Without it the report would group a pre-upgrade duplicate
 * into two groups of one and find nothing.
 */
type UniquenessAxisGroup = Readonly<{
  constraintName: string;
  axis: string;
  coveredKinds: ReadonlySet<string>;
}>;

/** The uniqueness axes the graph's own declarations produce. */
function uniquenessAxisGroups(
  graph: GraphDef,
  registry: KindRegistry,
): readonly UniquenessAxisGroup[] {
  const groups = new Map<string, UniquenessAxisGroup>();
  for (const [kind, registration] of Object.entries(graph.nodes)) {
    for (const constraint of registration.unique ?? []) {
      const target = uniquenessClaimTarget(kind, constraint.scope, registry);
      const coveredKinds =
        constraint.scope === "kind" ?
          [kind]
        : subClassComponent(kind, registry);
      const identity = `${constraint.name}\u0000${target.axis}`;
      const existing = groups.get(identity);
      groups.set(identity, {
        constraintName: constraint.name,
        axis: target.axis,
        coveredKinds: new Set([
          ...(existing?.coveredKinds ?? []),
          ...coveredKinds,
        ]),
      });
    }
  }
  return [...groups.values()];
}

/**
 * WHICH axis a live `uniques` row is read at.
 *
 * A row whose `node_kind` no declared group covers is left at its own
 * `node_kind`: the relation's primary key already makes it the only row there,
 * so it can contend with nothing and is reported by no group.
 *
 * A row covered by more than one group — possible only when one constraint name
 * is declared at two different scopes over one hierarchy — folds onto the
 * WIDEST of them, then onto the lowest axis. Widest, because that is where the
 * strictest fence sits: merging is what can reveal a contention, so the tie is
 * broken toward reporting rather than toward silence.
 */
function uniquenessAxisFor(
  row: ContendedUniqueRow,
  groups: readonly UniquenessAxisGroup[],
): string {
  const covering = groups
    .filter(
      (group) =>
        group.constraintName === row.constraintName &&
        group.coveredKinds.has(row.nodeKind),
    )
    .toSorted(
      (left, right) =>
        right.coveredKinds.size - left.coveredKinds.size ||
        compareStrings(left.axis, right.axis),
    );
  return covering[0]?.axis ?? row.nodeKind;
}

/** Owners in one deterministic order, so two runs report one shape. */
function sortedOwners(owners: readonly ClaimOwner[]): readonly ClaimOwner[] {
  return owners.toSorted(
    (left, right) =>
      compareStrings(left.concreteKind, right.concreteKind) ||
      compareStrings(left.nodeId, right.nodeId),
  );
}

/** A claim target keyed as one map entry, for grouping rows onto axes. */
function targetIdentity(target: ClaimTarget): string {
  return [
    target.relation,
    target.axis,
    target.constraintName ?? "",
    target.key,
  ].join("\u0000");
}

/**
 * Live `uniques` rows folded onto their axes, reported where an axis carries
 * more than one DISTINCT owner.
 *
 * Distinctness is {@link isSameClaimOwner}, not id equality and not row count:
 * one node legitimately holds rows at two axes at once (a claim written before
 * the axis moved plus the one written after), and counting rows would report
 * that as a violation of a constraint it does not violate.
 */
function uniquenessViolations(
  rows: readonly ContendedUniqueRow[],
  groups: readonly UniquenessAxisGroup[],
  graphId: string,
): readonly ConstraintFenceViolation[] {
  const byAxis = new Map<
    string,
    Readonly<{ target: ClaimTarget; owners: ClaimOwner[] }>
  >();
  for (const row of rows) {
    const target: ClaimTarget = {
      relation: "uniques",
      graphId,
      axis: uniquenessAxisFor(row, groups),
      constraintName: row.constraintName,
      key: row.key,
    };
    const identity = targetIdentity(target);
    const entry = byAxis.get(identity) ?? { target, owners: [] };
    const owner: ClaimOwner = {
      concreteKind: row.concreteKind,
      nodeId: row.nodeId,
    };
    if (!entry.owners.some((held) => isSameClaimOwner(held, owner)))
      entry.owners.push(owner);
    byAxis.set(identity, entry);
  }
  return [...byAxis.values()]
    .filter((entry) => entry.owners.length > 1)
    .map((entry) => ({
      family: "nodeUniqueness" as const,
      target: entry.target,
      owners: sortedOwners(entry.owners),
    }));
}

/**
 * Each id live under both kinds of a declared disjoint pair, at the pair axis
 * the claim uses and keyed — as the claim is — on the id itself.
 */
function disjointnessViolations(
  overlaps: readonly DisjointOverlapRow[],
  registry: KindRegistry,
  graphId: string,
): readonly ConstraintFenceViolation[] {
  return overlaps.map((overlap) => ({
    family: "nodeDisjointness" as const,
    target: {
      relation: "uniques" as const,
      graphId,
      axis: disjointnessClaimAxis(overlap.kinds[0], overlap.kinds[1], registry),
      constraintName: DISJOINT_CONSTRAINT_NAME,
      key: overlap.nodeId,
    },
    owners: sortedOwners([
      { concreteKind: overlap.kinds[0], nodeId: overlap.nodeId },
      { concreteKind: overlap.kinds[1], nodeId: overlap.nodeId },
    ]),
  }));
}

/**
 * Live edges folded onto the cardinality axis each one would claim, reported
 * where an axis carries more than one holder.
 */
function edgeCardinalityViolations(
  rows: readonly ContendedEdgeRow[],
  graphId: string,
): readonly ConstraintFenceViolation[] {
  const byAxis = new Map<
    string,
    Readonly<{ target: ClaimTarget; edgeIds: string[] }>
  >();
  for (const row of rows) {
    const target = edgeCardinalityClaimTarget({ ...row, graphId });
    const identity = targetIdentity(target);
    const entry = byAxis.get(identity) ?? { target, edgeIds: [] };
    entry.edgeIds.push(row.edgeId);
    byAxis.set(identity, entry);
  }
  return [...byAxis.values()]
    .filter((entry) => entry.edgeIds.length > 1)
    .map((entry) => ({
      family: "edgeCardinality" as const,
      target: entry.target,
      edgeIds: entry.edgeIds.toSorted((left, right) =>
        compareStrings(left, right),
      ),
    }));
}

/** The declarations the audit reads, one list per family. */
function fenceDeclarations(
  graph: GraphDef,
  registry: KindRegistry,
  graphId: string,
): ReadConstraintFenceViolationsParams {
  const uniqueConstraintNames = new Set(
    Object.values(graph.nodes).flatMap((registration) =>
      (registration.unique ?? []).map((constraint) => constraint.name),
    ),
  );
  const edgeCardinalities = Object.entries(graph.edges).flatMap(
    ([edgeKind, registration]): readonly EdgeCardinalityDeclaration[] => {
      const cardinality = registration.cardinality ?? "many";
      return cardinality === "many" ? [] : [{ edgeKind, cardinality }];
    },
  );
  return {
    graphId,
    uniqueConstraintNames: [...uniqueConstraintNames],
    disjointKindPairs: registry.disjointKindPairs(),
    edgeCardinalities,
  };
}

/**
 * THE fence audit. Reads only; reports every claim axis whose population
 * already carries more than one live claimant.
 *
 * @throws ConfigurationError (`CONSTRAINT_FENCE_AUDIT_UNSUPPORTED`) when the
 *   backend cannot run the audit. Returning an empty report would be
 *   indistinguishable from a clean database, which is the one answer a
 *   diagnostic must never fabricate.
 */
export async function verifyConstraintFences(
  context: VerifyConstraintFencesContext,
): Promise<readonly ConstraintFenceViolation[]> {
  const audit = context.backend.readConstraintFenceViolations;
  if (audit === undefined) {
    throw new ConfigurationError(
      "This backend cannot audit constraint fences: it does not implement " +
        "`readConstraintFenceViolations`.",
      { code: "CONSTRAINT_FENCE_AUDIT_UNSUPPORTED" },
      {
        suggestion:
          "Run the audit through a backend built by `createSqliteBackend` or " +
          "`createPostgresBackend`, or implement the member.",
      },
    );
  }
  const declarations = fenceDeclarations(
    context.graph,
    context.registry,
    context.graphId,
  );
  const rows: ConstraintFenceViolationRows = await audit(declarations);
  const groups = uniquenessAxisGroups(context.graph, context.registry);
  return [
    ...uniquenessViolations(rows.contendedUniqueRows, groups, context.graphId),
    ...disjointnessViolations(
      rows.disjointOverlaps,
      context.registry,
      context.graphId,
    ),
    ...edgeCardinalityViolations(rows.contendedEdgeRows, context.graphId),
  ].toSorted((left, right) => compareClaimTargets(left.target, right.target));
}
