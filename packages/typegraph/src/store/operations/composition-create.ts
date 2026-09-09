/**
 * Item E.2 — `existence: "required"`: a composition part that cannot exist
 * without a live whole.
 *
 * THE two owners this lane adds, in one module because both directions of
 * the same rule ("a required part always has a live whole") belong beside
 * each other:
 *
 * - {@link resolveCompositionCreate} — every node-create path's ONE answer
 *   to "given this kind's declared existence and the caller's stated
 *   `partOf`, what composition edge does this create owe, and is the pair
 *   legal". Reached by `create`, `bulkCreate`, and both get-or-create
 *   entries (`src/store/operations/node-operations.ts`).
 * - {@link assertCompositionExistencePreserved} — the refusal every path
 *   that would separate a live required part from its whole raises: ending
 *   a composition edge's window, soft-deleting it, or hard-deleting it. The
 *   three call sites live in `src/store/operations/edge-operations.ts`,
 *   at the work-assembly sites that feed `edge-write-pipeline.ts`'s
 *   pipeline entries — never inside those entries, which deliberately
 *   resolve no schema and no constraints (see that module's docblock).
 *
 * Neither function issues a claim: `edgeInsertClaims`
 * (`src/store/claims/composition-claims.ts`) remains the one owner of R4's
 * "at most one whole" claim, unchanged by this lane.
 */
import { type EdgeRow, type GraphReadBackend } from "../../backend/types";
import { CompositionExistenceError, ConfigurationError } from "../../errors";
import { type CompositionPair } from "../../registry/composition-relation";
import { type KindRegistry } from "../../registry/kind-registry";
import { requireDefined } from "../../utils/presence";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  type CompositionWholeRef,
  type CreateEdgeInput,
  type CreateNodeInput,
} from "../types";
import { compositionEdgeCounts } from "./composition-cascade";

/**
 * What one node create owes on the composition axis: the declared pair and
 * the whole the caller named, plus the concrete part kind (which may be a
 * subclass of `pair.partKind`) — everything {@link buildCompositionCreateEdgeInput}
 * needs to build the `CreateEdgeInput` once the part's id is actually known.
 *
 * Deliberately carries no id and no `CreateEdgeInput`: a batch create only
 * learns each item's real id from `finishNodeCreatePreparation` (a
 * caller-supplied id is distinguished from a GENERATED one by whether
 * `CreateNodeInput.id` was ever set — `draftNodeCreate`'s `idProvided`
 * reads that field directly — so resolving one here and writing it back
 * onto the input would corrupt that distinction for every batch member,
 * regardless of composition). One node, one composition edge, one write
 * plan still holds: the edge is built and issued inside the SAME frame,
 * after the row's real id is known.
 *
 * `undefined` means this create owes no composition edge at all (an
 * optional-existence kind with no `partOf`) — the common case, which every
 * caller must be able to tell apart from "the edge is not built yet".
 */
export type CompositionCreateWork = Readonly<{
  pair: CompositionPair;
  whole: CompositionWholeRef;
  /** The concrete part kind this create declared — `input.kind`, verbatim. */
  partKind: string;
}>;

/**
 * THE decision every node-create path asks: given the declared existence of
 * this kind and the caller's stated `partOf`, what composition edge does
 * this create owe — and is the pair legal? Refuses; never returns a silent
 * "nothing to do" for a required kind with no `partOf`, and never silently
 * drops a `partOf` naming an undeclared pair.
 *
 * Pure and synchronous — no I/O, no claim, no endpoint-liveness read, and no
 * id needed: the composition CLAIM and the whole's liveness are both the
 * edge insert's own concern (`edgeInsertClaims`, `assertLiveEdgeEndpoints`),
 * and re-checking either here would be a second spelling of that decision.
 */
export function resolveCompositionCreate(
  registry: KindRegistry,
  input: Pick<CreateNodeInput, "kind" | "id" | "partOf">,
): CompositionCreateWork | undefined {
  const partKind = input.kind;
  const partOf = input.partOf;
  const existence = registry.compositionExistence(partKind);

  if (partOf === undefined) {
    if (existence === "required") {
      throw new CompositionExistenceError({
        partKind,
        ...(input.id === undefined ? {} : { partId: input.id }),
        situation: "create",
      });
    }
    return undefined;
  }

  const pair = registry.getCompositionEdge(partKind, partOf.kind);
  if (pair === undefined) {
    throw new ConfigurationError(
      `Node kind "${partKind}" declares no composition pair to whole kind "${partOf.kind}".`,
      {
        code: "COMPOSITION_WHOLE_NOT_DECLARED",
        partKind,
        wholeKind: partOf.kind,
      },
      {
        suggestion:
          `Declare \`partOf(${partKind}, ${partOf.kind}, { via: ... })\` (or the mirrored \`hasPart\`) in the ontology, ` +
          `or pass \`partOf\` naming a whole kind this part is actually declared under.`,
      },
    );
  }

  return { pair, whole: partOf, partKind };
}

/**
 * Materializes {@link resolveCompositionCreate}'s work into a fully-formed
 * `CreateEdgeInput` — oriented per `pair.partSide` — once the part's REAL id
 * is known. The one place the from/to orientation is spelled; every
 * attach-edge call site (single create, both batch shapes, the
 * get-or-create resurrection leg) reaches it through here.
 */
export function buildCompositionCreateEdgeInput(
  work: CompositionCreateWork,
  partId: string,
  temporal: Readonly<{ validFrom?: string | null; validTo?: string }> = {},
): CreateEdgeInput {
  const { pair, whole, partKind } = work;
  const [fromKind, fromId, toKind, toId] =
    pair.partSide === "from" ?
      ([partKind, partId, whole.kind, whole.id] as const)
    : ([whole.kind, whole.id, partKind, partId] as const);

  return {
    kind: pair.viaEdgeKind,
    fromKind,
    fromId,
    toKind,
    toId,
    props: {},
    ...(temporal.validFrom === undefined ?
      {}
    : { validFrom: temporal.validFrom }),
    ...(temporal.validTo === undefined ? {} : { validTo: temporal.validTo }),
  };
}

/**
 * Whether `edgeKind` realizes a composition pair whose part kind is
 * `existence: "required"` for ANY of its declared pairs. Used to decline a
 * composition edge from a fused/read-free delete or update program: those
 * commands cannot express {@link assertCompositionExistencePreserved}'s
 * held-lock part read, so a kind this returns `true` for must take the
 * portable path for its delete/end mutations.
 */
export function compositionEdgeHasRequiredExistencePart(
  registry: KindRegistry,
  edgeKind: string,
): boolean {
  if (!registry.isCompositionEdge(edgeKind)) return false;
  return registry
    .compositionRelation()
    .pairs.some(
      (pair) =>
        pair.viaEdgeKind === edgeKind &&
        registry.compositionExistence(pair.partKind) === "required",
    );
}

/**
 * THE answer to "does this composition edge row attach its part to a live
 * whole AT THE CURRENT READ INSTANT" — ignoring `deleted_at`, valid-time is
 * everything `assertCompositionExistencePreserved`, `findLiveCompositionWhole`
 * (and, through it, the import assertion and `verifyConstraintFences`'s
 * `compositionExistence` audit) share, so none of them re-spell it apart and
 * drift. `attachCompositionCreateEdge` (`node-operations.ts`) also reuses it
 * ahead of the write, against the not-yet-persisted edge's own
 * `kind`/`validTo` — the CREATE-time mirror of the same question, refusing a
 * required part's composition edge that would be born already unattaching.
 *
 * Reuses {@link compositionEdgeCounts} (`./composition-cascade.ts`), the one
 * owner of "does a composition edge row still count as a live membership
 * under its pair's declared whole-side population" — that predicate already
 * IS the temporal notion this one needs: a `population: "one"` binding
 * persists for the row's entire life (ended or not), while a
 * `population: "oneActive"` binding ends the moment the window closes. This
 * function adds only the `deleted_at` gate `compositionEdgeCounts`'s callers
 * are each individually documented to apply themselves.
 */
export function edgeCurrentlyAttachesPart(
  registry: KindRegistry,
  partKind: string,
  edge: Pick<EdgeRow, "kind" | "deleted_at" | "valid_to">,
): boolean {
  if (edge.deleted_at !== undefined) return false;
  const partSide = registry.compositionPartSide(edge.kind);
  if (partSide === undefined) return false;
  const population = requireDefined(
    registry.compositionPopulation(partKind),
    `compositionPopulation(${partKind}) is undefined for a row on a known composition edge kind`,
  );
  return compositionEdgeCounts({ partSide, population }, edge);
}

/**
 * THE refusal every path that would separate a live required part from its
 * whole raises: ending a composition edge's open window, soft-deleting it,
 * or hard-deleting it.
 *
 * Fast path first (no read at all) when `edge.kind` is not a composition
 * edge, or its declared pair's existence is `"optional"`. Only then does it
 * read the part row — under the held write lock, so a concurrent write
 * cannot land between the read and this write's own row change — and
 * refuses only when the part is LIVE. A part that is already retired
 * (soft-deleted or gone) is not orphaned by losing its edge: refusing that
 * would make a soft-deleted part's composition edge permanently
 * undeletable-from.
 *
 * `lock: GraphWriteLock` in the parameter is compile-time evidence that this
 * read cannot precede the per-graph write lock — the same device
 * `planCompositionCascade` uses.
 */
export async function assertCompositionExistencePreserved(
  ctx: Readonly<{
    graphId: string;
    registry: KindRegistry;
    lock: GraphWriteLock;
  }>,
  edge: EdgeRow,
  backend: GraphReadBackend,
): Promise<void> {
  // `compositionPartSide` is total per edge KIND (a second, contradicting
  // orientation for one edge kind is itself refused at registry-build time,
  // `ONTOLOGY_COMPOSITION_VIA_MIXED`) even for a heterogeneous composition
  // edge kind realizing more than one `(partKind, wholeKind)` pair — so the
  // part endpoint is resolved from the ROW's own concrete kinds, never from
  // a pair looked up by edge kind alone, which could pick the wrong
  // declared `partKind` for this row's actual part.
  const partSide = ctx.registry.compositionPartSide(edge.kind);
  if (partSide === undefined) return;

  const part =
    partSide === "from" ?
      { kind: edge.from_kind, id: edge.from_id }
    : { kind: edge.to_kind, id: edge.to_id };

  if (ctx.registry.compositionExistence(part.kind) !== "required") return;

  // A row that no longer currently attaches (an already-ended
  // `population: "oneActive"` window) has nothing left to detach: the
  // moment of detachment already passed when the window closed, so this
  // write — ending an already-ended window again, or soft-/hard-deleting a
  // row that is no longer an attachment — cannot be what orphans the part.
  // Reads the SAME predicate `findLiveCompositionWhole` reads, so a row this
  // refusal protects is never invisible to `verifyConstraintFences`, and a
  // row that audit already reports unattached is never refused here.
  if (!edgeCurrentlyAttachesPart(ctx.registry, part.kind, edge)) return;

  const partRow = await backend.getNode(ctx.graphId, part.kind, part.id);
  const partIsLive = partRow !== undefined && partRow.deleted_at === undefined;
  if (!partIsLive) return;

  throw new CompositionExistenceError({
    partKind: part.kind,
    partId: part.id,
    situation: "detach",
    edgeKind: edge.kind,
    edgeId: edge.id,
  });
}

/**
 * The live whole a composition part currently holds, if any — read to name
 * it in `CompositionExistenceError`'s `situation: "existing"` message (the
 * ruling that `partOf` stated against an already-existing node found by
 * `getOrCreateByConstraint` is refused, naming the node's current whole).
 * `undefined` when `concreteKind` is not a composition part at all, or the
 * part currently has no live whole.
 *
 * `excludeEdgeIds` (default none) skips a connected edge by id regardless of
 * its own liveness — item E.2's merge plan-time preview
 * (`unattachedRequiredPartOrphansAmong`, `src/graph-merge/merge.ts`) uses it
 * to ask "does this part have a live whole AFTER this merge's own planned
 * edge deletions land", against a backend that still shows those edges as
 * live (nothing has been written yet at plan time), without a second,
 * plan-aware spelling of this predicate.
 */
export async function findLiveCompositionWhole(
  registry: KindRegistry,
  backend: GraphReadBackend,
  graphId: string,
  concreteKind: string,
  concreteId: string,
  excludeEdgeIds?: ReadonlySet<string>,
): Promise<CompositionWholeRef | undefined> {
  if (!registry.isCompositionPart(concreteKind)) return undefined;
  const connected = await backend.findEdgesConnectedTo({
    graphId,
    nodeKind: concreteKind,
    nodeId: concreteId,
  });
  for (const edge of connected) {
    if (excludeEdgeIds?.has(edge.id) === true) continue;
    const partSide = registry.compositionPartSide(edge.kind);
    if (partSide === undefined) continue;
    const isPartHere =
      partSide === "from" ?
        edge.from_kind === concreteKind && edge.from_id === concreteId
      : edge.to_kind === concreteKind && edge.to_id === concreteId;
    if (!isPartHere) continue;
    if (!edgeCurrentlyAttachesPart(registry, concreteKind, edge)) continue;
    return partSide === "from" ?
        { kind: edge.to_kind, id: edge.to_id }
      : { kind: edge.from_kind, id: edge.from_id };
  }
  return undefined;
}

/**
 * Every concrete node kind the proposed/live registry declares a
 * required-existence composition part — expanded through
 * `expandSubClasses` so a SUBCLASS of a declared required part kind (which
 * `resolveCompositionCreate` already refuses to create without a whole, via
 * `isAssignableTo`) is scanned too. A pair's `partKind` names the kind the
 * ontology was declared against; a live row of a subclass never declared
 * directly is exactly as required-and-orphanable as one of the declared
 * kind itself.
 */
export function requiredCompositionPartKinds(
  registry: KindRegistry,
): readonly string[] {
  const partKinds = new Set<string>();
  for (const pair of registry.compositionRelation().pairs) {
    if (registry.compositionExistence(pair.partKind) === "required") {
      for (const concreteKind of registry.expandSubClasses(pair.partKind)) {
        partKinds.add(concreteKind);
      }
    }
  }
  return [...partKinds];
}

const UNATTACHED_PARTS_PAGE_SIZE = 500;

/**
 * Every LIVE node of a required-existence part kind that currently has no
 * live whole. Reused by `store.verifyConstraintFences()`'s
 * `compositionExistence` family (graph-wide) and by
 * `prepareSchemaTighteningPreflight`'s third composition check
 * (delta-scoped to the part kinds a commit newly requires a whole for).
 *
 * A portable, non-pushdown scan — `findNodesByKind` paged, each row checked
 * through {@link findLiveCompositionWhole}, the SAME predicate the write-path
 * detach refusal reads — rather than a dedicated backend SQL audit member:
 * this runs at schema-tightening-commit time and at an explicit operator
 * diagnostic call, never on a write's hot path, so the O(live parts) cost is
 * the right trade against a second, dialect-specific SQL implementation of
 * "does this row have a live whole" alongside `assertCompositionExistencePreserved`'s
 * TypeScript one.
 */
export async function readCompositionUnattachedParts(
  registry: KindRegistry,
  backend: GraphReadBackend,
  graphId: string,
  partKinds: readonly string[],
): Promise<readonly CompositionWholeRef[]> {
  const unattached: CompositionWholeRef[] = [];
  for (const partKind of partKinds) {
    let after: string | undefined;
    for (;;) {
      const rows = await backend.findNodesByKind({
        graphId,
        kind: partKind,
        excludeDeleted: true,
        orderBy: "id",
        limit: UNATTACHED_PARTS_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      for (const row of rows) {
        const whole = await findLiveCompositionWhole(
          registry,
          backend,
          graphId,
          row.kind,
          row.id,
        );
        if (whole === undefined) {
          unattached.push({ kind: row.kind, id: row.id });
        }
      }
      if (rows.length < UNATTACHED_PARTS_PAGE_SIZE) break;
      after = requireDefined(
        rows.at(-1),
        "findNodesByKind returned a full page with no last row",
      ).id;
    }
  }
  return unattached;
}
