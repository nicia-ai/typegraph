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
 *
 * `auditConstraintFences` is the reader: declarations in, violations out. It
 * is the ONE implementation of every violation predicate, shared by
 * `verifyConstraintFences` (the graph-wide audit below) and by the
 * ontology-tightening commit preflight (`src/schema/ontology-tightening-preflight.ts`),
 * so a live-graph audit and a proposed-schema probe can never disagree about
 * what counts as a violation.
 */
import type {
  ConstraintFenceViolationRows,
  ContendedEdgeRow,
  ContendedUniqueRow,
  DisjointOverlapRow,
  EdgeCardinalityDeclaration,
  EdgeEndpointAllowance,
  GraphBackend,
  MisassignedEdgeEndpointRow,
  ReadConstraintFenceViolationsParams,
} from "../../backend/types";
import { subClassComponent } from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import { buildGraphEdgeEndpointKinds } from "../../registry/builders";
import { expandEdgeEndpointAllowance } from "../../registry/edge-endpoint-allowance";
import { type KindRegistry } from "../../registry/kind-registry";
import { groupBy } from "../../utils/array";
import { compareStrings } from "../../utils/compare";
import {
  type ClaimOwner,
  type ClaimTarget,
  compareClaimTargets,
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
  isSameClaimOwner,
  uniquenessAxisOfKinds,
  uniquenessClaimTarget,
} from "./axis";
import { edgeCardinalityClaimTarget } from "./edge-claims";

/**
 * One claim axis more than one live claimant holds, OR one edge kind whose
 * live edges sit outside every declared endpoint pair.
 *
 * Discriminated on the family because the claim relations record their
 * holders differently: a `uniques` axis is held by an OWNER PAIR (ids are
 * unique only per kind), an edge-claim axis by an edge id, and endpoint
 * assignability by nothing claim-shaped at all — there is no claim row for
 * "this edge's endpoints are still admitted", so this member carries no
 * `target`. `target` on the other members is the claim row itself, so a
 * reader can go straight to the row a writer contends for rather than
 * reconstructing it from the family's own vocabulary.
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
    }>
  | Readonly<{
      family: "edgeEndpointAssignability";
      edgeKind: string;
      /** The concrete endpoint pairs the declaration still admits. */
      allowedPairs: readonly (readonly [string, string])[];
      /** Live edges sitting outside all of them. */
      edges: readonly MisassignedEdgeEndpointRow[];
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
export type UniquenessAxisGroup = Readonly<{
  constraintName: string;
  axis: string;
  coveredKinds: readonly string[];
}>;

/**
 * THE fold from "a constraint name plus the kinds its scope covers" onto a
 * claim axis. The graph-side {@link uniquenessAxisGroups} and the
 * serialized-schema-side ontology-tightening probe both build a
 * `UniquenessAxisGroup` through this one constructor, so they cannot disagree
 * about which axis a covered set folds onto.
 */
export function uniquenessAxisGroupFor(
  constraintName: string,
  coveredKinds: readonly string[],
): UniquenessAxisGroup {
  return {
    constraintName,
    axis: uniquenessAxisOfKinds(coveredKinds) ?? constraintName,
    coveredKinds,
  };
}

/** The uniqueness axes the graph's own declarations produce. */
function uniquenessAxisGroups(
  graph: GraphDef,
  registry: KindRegistry,
): readonly UniquenessAxisGroup[] {
  const coveredByIdentity = new Map<
    string,
    Readonly<{ constraintName: string; coveredKinds: Set<string> }>
  >();
  for (const [kind, registration] of Object.entries(graph.nodes)) {
    for (const constraint of registration.unique ?? []) {
      const target = uniquenessClaimTarget(kind, constraint.scope, registry);
      const coveredKinds =
        constraint.scope === "kind" ?
          [kind]
        : subClassComponent(kind, registry);
      const identity = `${constraint.name}\u0000${target.axis}`;
      const existing =
        coveredByIdentity.get(identity)?.coveredKinds ?? new Set<string>();
      for (const coveredKind of coveredKinds) existing.add(coveredKind);
      coveredByIdentity.set(identity, {
        constraintName: constraint.name,
        coveredKinds: existing,
      });
    }
  }
  return [...coveredByIdentity.values()].map((entry) =>
    uniquenessAxisGroupFor(
      entry.constraintName,
      [...entry.coveredKinds].toSorted((left, right) =>
        compareStrings(left, right),
      ),
    ),
  );
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
        group.coveredKinds.includes(row.nodeKind),
    )
    .toSorted(
      (left, right) =>
        right.coveredKinds.length - left.coveredKinds.length ||
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

/** Live edges grouped per edge kind, reported where the kind carries any. */
function edgeEndpointViolations(
  rows: readonly MisassignedEdgeEndpointRow[],
  allowances: readonly EdgeEndpointAllowance[],
): readonly ConstraintFenceViolation[] {
  const allowedPairsByKind = new Map(
    allowances.map((allowance) => [allowance.edgeKind, allowance.allowedPairs]),
  );
  const rowsByKind = groupBy(rows, (row) => row.edgeKind);
  return [...rowsByKind.entries()]
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([edgeKind, edgeRows]) => ({
      family: "edgeEndpointAssignability" as const,
      edgeKind,
      allowedPairs: allowedPairsByKind.get(edgeKind) ?? [],
      edges: edgeRows.toSorted((left, right) =>
        compareStrings(left.edgeId, right.edgeId),
      ),
    }));
}

/**
 * THE canonical order violations are reported in: claim families first
 * (their existing {@link compareClaimTargets} order), then
 * `edgeEndpointAssignability` ordered by edge kind.
 */
function compareConstraintFenceViolations(
  left: ConstraintFenceViolation,
  right: ConstraintFenceViolation,
): number {
  if (
    left.family === "edgeEndpointAssignability" &&
    right.family === "edgeEndpointAssignability"
  ) {
    return compareStrings(left.edgeKind, right.edgeKind);
  }
  if (left.family === "edgeEndpointAssignability") return 1;
  if (right.family === "edgeEndpointAssignability") return -1;
  return compareClaimTargets(left.target, right.target);
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
  const edgeEndpointKinds = buildGraphEdgeEndpointKinds(graph.edges);
  const edgeEndpointAllowances = [...edgeEndpointKinds.entries()]
    .map(([edgeKind, endpoints]) =>
      expandEdgeEndpointAllowance(edgeKind, endpoints, registry),
    )
    .toSorted((left, right) => compareStrings(left.edgeKind, right.edgeKind));
  return {
    graphId,
    uniqueConstraintNames: [...uniqueConstraintNames],
    disjointKindPairs: registry.disjointKindPairs(),
    edgeCardinalities,
    edgeEndpointAllowances,
  };
}

/**
 * What the audit reads and how it folds the rows.
 *
 * No top-level `graphId`: `declarations.graphId` is the only spelling of
 * which graph this plan reads, so a caller cannot author two graph ids that
 * silently drift out of agreement — the failure mode a second `graphId`
 * field invites the moment a caller sets one and not the other.
 */
export type ConstraintFenceAuditPlan = Readonly<{
  declarations: ReadConstraintFenceViolationsParams;
  uniquenessGroups: readonly UniquenessAxisGroup[];
  /** The registry the verdict is computed against — the PROPOSED one for a probe. */
  registry: KindRegistry;
}>;

/** The narrow backend surface `auditConstraintFences` needs. */
export type ConstraintFenceAuditBackend = Readonly<{
  readConstraintFenceViolations?: GraphBackend["readConstraintFenceViolations"];
}>;

/**
 * THE reader. Declarations in, violations out. One implementation of every
 * violation predicate, shared by `verifyConstraintFences` and by the
 * ontology-tightening commit preflight.
 *
 * @throws ConfigurationError (`CONSTRAINT_FENCE_AUDIT_UNSUPPORTED`) when the
 *   backend cannot run the audit at all, and
 *   (`CONSTRAINT_FENCE_AUDIT_FAMILY_UNSUPPORTED`) when it ran the audit but
 *   the family was asked for and it answered nothing — an empty report there
 *   would be indistinguishable from a clean database, which is the one
 *   answer a diagnostic must never fabricate.
 */
export async function auditConstraintFences(
  backend: ConstraintFenceAuditBackend,
  plan: ConstraintFenceAuditPlan,
): Promise<readonly ConstraintFenceViolation[]> {
  const audit = backend.readConstraintFenceViolations;
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
  const rows: ConstraintFenceViolationRows = await audit(plan.declarations);

  if (
    (plan.declarations.edgeEndpointAllowances ?? []).length > 0 &&
    rows.misassignedEdgeEndpointRows === undefined
  ) {
    throw new ConfigurationError(
      "This backend's constraint-fence audit does not answer the edge " +
        "endpoint assignability family.",
      {
        code: "CONSTRAINT_FENCE_AUDIT_FAMILY_UNSUPPORTED",
        family: "edgeEndpointAssignability",
      },
      {
        suggestion:
          "Implement `misassignedEdgeEndpointRows` in `readConstraintFenceViolations`, " +
          "or drop the edgeEndpointAllowances declaration if the family is not needed.",
      },
    );
  }

  return [
    ...uniquenessViolations(
      rows.contendedUniqueRows,
      plan.uniquenessGroups,
      plan.declarations.graphId,
    ),
    ...disjointnessViolations(
      rows.disjointOverlaps,
      plan.registry,
      plan.declarations.graphId,
    ),
    ...edgeCardinalityViolations(
      rows.contendedEdgeRows,
      plan.declarations.graphId,
    ),
    ...edgeEndpointViolations(
      rows.misassignedEdgeEndpointRows ?? [],
      plan.declarations.edgeEndpointAllowances ?? [],
    ),
  ].toSorted(compareConstraintFenceViolations);
}

/**
 * THE fence audit. Reads only; reports every claim axis whose population
 * already carries more than one live claimant, and every edge kind whose live
 * rows sit outside every declared endpoint pair.
 */
export async function verifyConstraintFences(
  context: VerifyConstraintFencesContext,
): Promise<readonly ConstraintFenceViolation[]> {
  return auditConstraintFences(context.backend, {
    declarations: fenceDeclarations(
      context.graph,
      context.registry,
      context.graphId,
    ),
    uniquenessGroups: uniquenessAxisGroups(context.graph, context.registry),
    registry: context.registry,
  });
}
