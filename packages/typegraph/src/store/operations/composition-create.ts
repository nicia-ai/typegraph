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
 *
 * Alongside them, the DISPOSITION owner every attachment against an
 * already-existing row runs through:
 * {@link resolveCompositionAttachmentRequest} builds the request read-free,
 * and {@link decideCompositionAttachmentUnderFence} re-reads the incumbent on
 * the frame's own fenced target and answers with the decision itself —
 * "satisfied", "attach" or "replace" — or refuses. The write half of that
 * decision (`applyCompositionAttachmentDecision`, `node-operations.ts`) takes
 * the answer as a parameter, which is what lets a frame that owes other
 * statements decide BEFORE its first one. These functions are here rather than
 * beside the write plan because the decision is pure: the write plan owns the
 * lock and the statements, this module owns what they mean.
 */
import {
  type EdgeRow,
  type GraphReadBackend,
  type NodeRow,
  rowPropsToObject,
} from "../../backend/types";
import {
  CompositionExistenceError,
  ConfigurationError,
  EndpointNotFoundError,
} from "../../errors";
import { validateEdgeProps } from "../../errors/validation";
import { type CompositionPair } from "../../registry/composition-relation";
import { type KindRegistry } from "../../registry/kind-registry";
import { canonicalEqual } from "../../schema/canonical";
import { requireDefined } from "../../utils/presence";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  type CompositionAttachment,
  type CompositionNodeRef,
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
  /**
   * The realizing edge's own properties, as the caller stated them
   * (`partOf.props`) or `{}`. Carried verbatim: validation against the edge
   * kind's schema is `validateAndPrepareEdgeCreate`'s, exactly as it is for a
   * caller's own `store.edges.<via>.create(...)` — a second Zod parse here
   * would be a second spelling of that decision.
   */
  props: Record<string, unknown>;
}>;

/**
 * THE decision every attachment surface asks: given this part kind and the
 * whole (and, optionally, the realizing edge) the caller named, WHICH
 * declared composition pair does this attachment realize?
 *
 * The one owner of both `via` refusals — `create`, `bulkCreate`, both
 * get-or-create entries, and `reparent` all reach it, so none of them can
 * resolve an ambiguous attachment by sort order the way the removed
 * `getCompositionEdge` did:
 *
 * - no declared pair at all between the two kinds — `ConfigurationError`
 *   (`COMPOSITION_WHOLE_NOT_DECLARED`);
 * - `via` named, but it realizes no declared pair between them —
 *   `ConfigurationError` (`COMPOSITION_VIA_NOT_DECLARED`);
 * - `via` omitted while more than one pair is declared between them —
 *   `ConfigurationError` (`COMPOSITION_VIA_AMBIGUOUS`).
 *
 * Pure and synchronous — no I/O and no claim.
 */
function resolveCompositionAttachment(
  registry: KindRegistry,
  partKind: string,
  attachment: CompositionAttachment,
): CompositionPair {
  const declared = registry.compositionPairsBetween(partKind, attachment.kind);
  if (declared.length === 0) {
    throw new ConfigurationError(
      `Node kind "${partKind}" declares no composition pair to whole kind "${attachment.kind}".`,
      {
        code: "COMPOSITION_WHOLE_NOT_DECLARED",
        partKind,
        wholeKind: attachment.kind,
      },
      {
        suggestion:
          `Declare \`partOf(${partKind}, ${attachment.kind}, { via: ... })\` (or the mirrored \`hasPart\`) in the ontology, ` +
          `or pass \`partOf\` naming a whole kind this part is actually declared under.`,
      },
    );
  }

  const viaEdgeKinds = declared.map((pair) => pair.viaEdgeKind);
  const via = attachment.via;
  if (via !== undefined) {
    const pair = declared.find((candidate) => candidate.viaEdgeKind === via);
    if (pair === undefined) {
      throw new ConfigurationError(
        `Edge kind "${via}" realizes no declared composition pair between "${partKind}" and "${attachment.kind}".`,
        {
          code: "COMPOSITION_VIA_NOT_DECLARED",
          partKind,
          wholeKind: attachment.kind,
          via,
          declaredVia: viaEdgeKinds,
        },
        {
          suggestion: `Pass \`via\` naming one of the declared realizing edges: ${viaEdgeKinds.join(", ")}.`,
        },
      );
    }
    return pair;
  }

  if (declared.length > 1) {
    throw new ConfigurationError(
      `Attaching "${partKind}" to "${attachment.kind}" is ambiguous: ${declared.length} declared composition pairs realize it.`,
      {
        code: "COMPOSITION_VIA_AMBIGUOUS",
        partKind,
        wholeKind: attachment.kind,
        declaredVia: viaEdgeKinds,
      },
      {
        suggestion: `Pass \`partOf: { kind, id, via }\` naming the realizing edge: ${viaEdgeKinds.join(", ")}.`,
      },
    );
  }

  return requireDefined(
    declared[0],
    "compositionPairsBetween returned a non-empty list with no first pair",
  );
}

/**
 * THE decision every node-create path asks: given the declared existence of
 * this kind and the caller's stated `partOf`, what composition edge does
 * this create owe — and is the pair legal? Refuses; never returns a silent
 * "nothing to do" for a required kind with no `partOf`, and never silently
 * drops a `partOf` naming an undeclared or ambiguous pair.
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

  return {
    pair: resolveCompositionAttachment(registry, partKind, partOf),
    whole: { kind: partOf.kind, id: partOf.id },
    partKind,
    props: partOf.props ?? {},
  };
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
    props: work.props,
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
 *
 * `reattachedPart` names the ONE part whose composition edge this same write
 * frame retires only to attach it to a new whole immediately afterwards
 * (`reparent`, `node-operations.ts`). That part is not being detached at
 * all: the frame's final state has it attached, so the invariant this
 * refusal protects is preserved end-to-end even though its intermediate
 * state is not. Stated as the part itself rather than as a "skip the check"
 * flag, so the exemption is bound to the resource that earned it — a
 * frame's reparent of part A can never quietly license a detach of part B.
 */
export async function assertCompositionExistencePreserved(
  ctx: Readonly<{
    graphId: string;
    registry: KindRegistry;
    lock: GraphWriteLock;
    reattachedPart?: CompositionNodeRef;
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

  const reattached = ctx.reattachedPart;
  if (reattached?.kind === part.kind && reattached.id === part.id) {
    return;
  }

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
 * The composition edge that currently attaches this part, together with the
 * whole it attaches it to. `undefined` when `concreteKind` is not a
 * composition part at all, or the part currently has no live whole.
 *
 * THE reader behind both "which whole does this part hold"
 * ({@link findLiveCompositionWhole}) and "which edge row realizes that
 * attachment right now" (`reparent`'s retire target,
 * `node-operations.ts`) — one traversal, one orientation decision, one
 * population predicate, so the mover and the reporter can never disagree
 * about which edge is the incumbent.
 *
 * `excludeEdgeIds` (default none) skips a connected edge by id regardless of
 * its own liveness — merge's plan-time preview
 * (`unattachedRequiredPartOrphansAmong`, `src/graph-merge/merge.ts`) uses it
 * to ask "does this part have a live whole AFTER this merge's own planned
 * edge deletions land", against a backend that still shows those edges as
 * live (nothing has been written yet at plan time), without a second,
 * plan-aware spelling of this predicate.
 */
export async function findLiveCompositionAttachment(
  registry: KindRegistry,
  backend: GraphReadBackend,
  graphId: string,
  concreteKind: string,
  concreteId: string,
  excludeEdgeIds?: ReadonlySet<string>,
): Promise<
  Readonly<{ edge: EdgeRow; whole: CompositionWholeRef }> | undefined
> {
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
    const whole =
      partSide === "from" ?
        { kind: edge.to_kind, id: edge.to_id }
      : { kind: edge.from_kind, id: edge.from_id };
    return { edge, whole };
  }
  return undefined;
}

/**
 * Whether a stated `partOf.props` is already what the satisfied incumbent
 * edge holds — the decision itself, not a boolean a caller re-derives the
 * comparison from, so both consumers read the same verdict:
 * {@link assertSatisfiedPartOfPropsHonored} (which turns a disagreement into
 * the refusal) and the lock-free pre-check that decides whether an
 * already-satisfied get-or-create can stay read-only
 * ({@link incumbentSatisfiesRequestedAttachment}).
 */
type SatisfiedPartOfPropsVerdict =
  | Readonly<{ honored: true }>
  | Readonly<{
      honored: false;
      currentProps: Record<string, unknown>;
      requestedProps: Record<string, unknown>;
    }>;

/**
 * THE one place stated `partOf.props` are compared against an attachment that
 * is ALREADY satisfied (same whole, same realizing edge).
 *
 * `props` omitted: nothing stated, nothing to compare — honored. `props`
 * stated: run through {@link validateEdgeProps} against `pair.viaEdgeKind`'s
 * own schema — the same owner `validateAndPrepareEdgeCreate` calls for a
 * fresh attach, so an invalid value is refused here exactly as it would be on
 * create, never silently accepted because the caller happens not to write.
 * (That refusal is a property of the caller's own input, not of the row, which
 * is why the lock-free pre-check may reach it too.) A valid value that is
 * canonically (`canonicalEqual`, key order aside) identical to the edge's live
 * stored props is honored; a valid value that DIFFERS is not, and the
 * verdict carries both sides for the refusal to name.
 */
function judgeSatisfiedPartOfProps(
  registry: KindRegistry,
  attachment: CompositionAttachment,
  pair: CompositionPair,
  currentEdge: Pick<EdgeRow, "props">,
): SatisfiedPartOfPropsVerdict {
  if (attachment.props === undefined) return { honored: true };
  const edgeType = requireDefined(
    registry.getEdgeType(pair.viaEdgeKind),
    `getEdgeType(${pair.viaEdgeKind}) is undefined for a resolved composition pair's own realizing edge kind`,
  );
  const validatedProps = validateEdgeProps(edgeType.schema, attachment.props, {
    kind: pair.viaEdgeKind,
    operation: "create",
  });
  const storedProps = rowPropsToObject(currentEdge.props);
  return canonicalEqual(validatedProps, storedProps) ?
      { honored: true }
    : {
        honored: false,
        currentProps: storedProps,
        requestedProps: validatedProps,
      };
}

/**
 * The refusal {@link decideCompositionIncumbent}'s satisfied arm owes — every
 * surface's no-write return (`reparent`'s no-op and the get-or-create
 * postcondition's idempotent hit both resolve there). That arm performs no
 * edge write, so without this call `props` would be neither applied nor
 * refused nor even validated — an accepted option silently dropped, the same
 * shape `situation: "existing"` refuses one dimension over (a differing
 * whole, or a differing realizing edge).
 *
 * A disagreeing value refuses with `CompositionExistenceError`
 * (`situation: "props"`) naming both: this call resolves an attachment, it
 * does not rewrite the realizing edge's properties
 * (`store.edges.<via>.update(...)` does that).
 */
function assertSatisfiedPartOfPropsHonored(
  registry: KindRegistry,
  partKind: string,
  partId: string,
  attachment: CompositionAttachment,
  pair: CompositionPair,
  currentEdge: Pick<EdgeRow, "id" | "kind" | "props">,
): void {
  const verdict = judgeSatisfiedPartOfProps(
    registry,
    attachment,
    pair,
    currentEdge,
  );
  if (verdict.honored) return;
  throw new CompositionExistenceError({
    partKind,
    partId,
    situation: "props",
    edgeKind: currentEdge.kind,
    edgeId: currentEdge.id,
    currentProps: verdict.currentProps,
    requestedProps: verdict.requestedProps,
  });
}

/**
 * What a fenced attachment does with an incumbent whole it finds under the
 * per-graph write lock — the ONE dimension that separates "move this part"
 * from "make sure this part holds this whole":
 *
 * - `"replace"` — `nodes.<Kind>.reparent(...)`: retire the incumbent
 *   attachment and write the requested one. Moving a part is what the caller
 *   asked for.
 * - `"refuse"` — every get-or-create path: an incumbent that is NOT the
 *   requested attachment raises `CompositionExistenceError`
 *   (`situation: "existing"`). A lookup never moves a part as a side effect,
 *   so two racing callers that each ask for a different whole end with
 *   exactly one attachment and one refusal.
 *
 * Stated as a disposition the write plan carries rather than as two
 * code paths, because the verdict is only sound once the incumbent has been
 * re-read under the lock: a lock-free read can be stale by the time the
 * frame writes, and acting on its verdict is exactly how a refusing caller
 * used to perform a silent move.
 */
export type CompositionIncumbentDisposition = "replace" | "refuse";

/**
 * One resolved attachment a write frame owes: the caller's stated
 * `partOf` verbatim (needed to tell "no `props` stated" from `props: {}`),
 * the resolved {@link CompositionCreateWork} the attach is built from, and
 * what to do about an incumbent ({@link CompositionIncumbentDisposition}).
 *
 * Built BEFORE any row is read — `resolveCompositionAttachment`'s and
 * `resolveCompositionCreate`'s refusals are synchronous and read-free — so a
 * configuration defect of the call refuses without locking anything.
 */
export type CompositionAttachmentRequest = Readonly<{
  attachment: CompositionAttachment;
  work: CompositionCreateWork;
  onIncumbent: CompositionIncumbentDisposition;
}>;

/**
 * Pairs a resolved {@link CompositionCreateWork} with the attachment it came
 * from and the disposition the calling surface declares. The one constructor
 * of {@link CompositionAttachmentRequest}, so no call site can assemble a
 * request whose `work` and `attachment` describe different wholes.
 */
function compositionAttachmentRequest(
  work: CompositionCreateWork,
  attachment: CompositionAttachment,
  onIncumbent: CompositionIncumbentDisposition,
): CompositionAttachmentRequest {
  return { attachment, work, onIncumbent };
}

/**
 * THE resolution of one caller-stated `partOf` into the request a fenced
 * attachment frame runs: `resolveCompositionCreate`'s read-free refusals (an
 * undeclared pair, an unknown or ambiguous `via`, a required part with no
 * `partOf`) followed by {@link compositionAttachmentRequest}'s single
 * construction. `undefined` means this frame owes no attachment at all.
 *
 * Every surface that attaches a part against a row that ALREADY exists comes
 * through here — `nodes.<Kind>.reparent(...)` with `"replace"`, every
 * get-or-create leg with `"refuse"` — so no surface resolves a pair a caller
 * above it already resolved, and the `work`/`attachment` pairing stays the one
 * thing {@link compositionAttachmentRequest} builds.
 */
export function resolveCompositionAttachmentRequest(
  registry: KindRegistry,
  part: Readonly<{ kind: string; id: string }>,
  partOf: CompositionAttachment,
  onIncumbent: CompositionIncumbentDisposition,
): CompositionAttachmentRequest;
export function resolveCompositionAttachmentRequest(
  registry: KindRegistry,
  part: Readonly<{ kind: string; id: string }>,
  partOf: CompositionAttachment | undefined,
  onIncumbent: CompositionIncumbentDisposition,
): CompositionAttachmentRequest | undefined;
export function resolveCompositionAttachmentRequest(
  registry: KindRegistry,
  part: Readonly<{ kind: string; id: string }>,
  partOf: CompositionAttachment | undefined,
  onIncumbent: CompositionIncumbentDisposition,
): CompositionAttachmentRequest | undefined {
  const work = resolveCompositionCreate(registry, {
    kind: part.kind,
    id: part.id,
    ...(partOf === undefined ? {} : { partOf }),
  });
  if (work === undefined) return undefined;
  return compositionAttachmentRequest(
    work,
    requireDefined(
      partOf,
      "resolveCompositionCreate returned composition work for a call that stated no partOf",
    ),
    onIncumbent,
  );
}

/**
 * Whether `current` IS the requested attachment: the same whole, held
 * through the resolved pair's realizing edge. Compared against the RESOLVED
 * `pair.viaEdgeKind` rather than against `attachment.via`, so an omitted
 * `via` means "the one declared pair", never "any realizing edge will do".
 *
 * The whole/via half of {@link incumbentSatisfiesRequestedAttachment}, which
 * is what both the fenced verdict ({@link decideCompositionIncumbent}) and the
 * lock-free pre-check that lets an already-satisfied get-or-create stay
 * read-only (`applyExistingPartOfPostcondition`, `node-operations.ts`) read —
 * one spelling, so the cheap skip and the authoritative verdict can never
 * disagree about what "already holds" means.
 */
function incumbentHoldsRequestedAttachment(
  request: CompositionAttachmentRequest,
  current: Readonly<{
    edge: Pick<EdgeRow, "kind">;
    whole: CompositionWholeRef;
  }>,
): boolean {
  const { attachment, work } = request;
  return (
    current.whole.kind === attachment.kind &&
    current.whole.id === attachment.id &&
    current.edge.kind === work.pair.viaEdgeKind
  );
}

/**
 * Whether this incumbent leaves the request with NOTHING to write: it is the
 * requested attachment ({@link incumbentHoldsRequestedAttachment}) AND the
 * realizing edge already carries the stated `props`
 * ({@link judgeSatisfiedPartOfProps}) — the two conjuncts
 * {@link decideCompositionIncumbent}'s satisfied arm is built from, in one
 * predicate so the cheap skip and the authoritative verdict cannot disagree
 * about what "nothing to do" means.
 *
 * Read twice, against the same row: once lock-free, to let an already-resolved
 * get-or-create return without opening a write transaction at all
 * (`applyExistingPartOfPostcondition`, `node-operations.ts` — including the
 * idempotent ingest that restates the props every time, which would otherwise
 * take the per-graph write fence for a no-op), and once under the fence, where
 * the verdict is authoritative. Only the SKIP is ever taken from the lock-free
 * read: anything else escalates to the fence, which is the one allowed to
 * refuse or write.
 *
 * A `props` value that does not validate against the realizing edge's schema
 * refuses from either read — that refusal reads the caller's input, never the
 * row, so it cannot be stale.
 */
export function incumbentSatisfiesRequestedAttachment(
  registry: KindRegistry,
  request: CompositionAttachmentRequest,
  current: Readonly<{
    edge: Pick<EdgeRow, "kind" | "props">;
    whole: CompositionWholeRef;
  }>,
): boolean {
  return (
    incumbentHoldsRequestedAttachment(request, current) &&
    judgeSatisfiedPartOfProps(
      registry,
      request.attachment,
      request.work.pair,
      current.edge,
    ).honored
  );
}

/**
 * What one fenced attachment frame does, decided from the incumbent the
 * frame re-read UNDER THE LOCK:
 *
 * - `"satisfied"` — the part already holds exactly this attachment. No write
 *   at all, which is what makes a repeated get-or-create (and a `reparent`
 *   to the whole the part already holds) idempotent rather than a refusal.
 *   A stated `props` is still honored here
 *   ({@link assertSatisfiedPartOfPropsHonored}): this arm writes no edge, so
 *   a differing value is refused rather than silently dropped.
 * - `"attach"` — the part holds no live whole: write the attachment.
 * - `"replace"` — a DIFFERENT incumbent under `onIncumbent: "replace"`:
 *   retire it, then write the requested attachment.
 *
 * A different incumbent under `onIncumbent: "refuse"` throws
 * `CompositionExistenceError` (`situation: "existing"`) naming both sides —
 * the held whole (and realizing edge, when only the edge differs) and the
 * requested one.
 *
 * Pure and synchronous: the read that produced `current` is the caller's, so
 * this decision can be reached only from inside the fence that read it.
 */
function decideCompositionIncumbent(
  registry: KindRegistry,
  partId: string,
  request: CompositionAttachmentRequest,
  current:
    | Readonly<{
        edge: Pick<EdgeRow, "id" | "kind" | "props">;
        whole: CompositionWholeRef;
      }>
    | undefined,
): "satisfied" | "attach" | "replace" {
  if (current === undefined) return "attach";

  const { attachment, work, onIncumbent } = request;
  const partKind = work.partKind;
  if (incumbentHoldsRequestedAttachment(request, current)) {
    assertSatisfiedPartOfPropsHonored(
      registry,
      partKind,
      partId,
      attachment,
      work.pair,
      current.edge,
    );
    return "satisfied";
  }

  if (onIncumbent === "replace") return "replace";

  const wholeMatches =
    current.whole.kind === attachment.kind &&
    current.whole.id === attachment.id;
  throw new CompositionExistenceError({
    partKind,
    partId,
    situation: "existing",
    currentWhole: current.whole,
    ...(wholeMatches ? { currentVia: current.edge.kind } : {}),
    requestedWhole: { kind: attachment.kind, id: attachment.id },
    requestedVia: work.pair.viaEdgeKind,
  });
}

/**
 * One fenced attachment's DECISION: the disposition
 * {@link decideCompositionIncumbent} reached, plus the incumbent it was
 * reached from, so the write half never re-reads the row the verdict was
 * judged against.
 *
 * The decision itself travels, not a flag a caller re-derives it from: a
 * frame that holds one of these cannot spell a second, drifting version of
 * "what does this incumbent mean".
 */
export type FencedCompositionAttachment = Readonly<{
  request: CompositionAttachmentRequest;
  disposition: "satisfied" | "attach" | "replace";
  /** The incumbent the disposition was judged against; absent when none. */
  incumbent?: Readonly<{ edge: EdgeRow; whole: CompositionWholeRef }>;
}>;

/**
 * THE single owner of "does this edge endpoint row exist and count as live" —
 * shared by two questions asked at two different times against the two
 * different rows one composition attachment touches:
 *
 * - `assertLiveEdgeEndpoints` (`edge-operations.ts`) calls this for BOTH
 *   endpoints, at WRITE time, inside `attachCompositionCreateEdge`'s ordinary
 *   edge-create pipeline — the only place the PART endpoint is ever checked,
 *   since a resurrection leg's part row is still a tombstone until the
 *   property update earlier in the same frame restores it.
 * - {@link decideCompositionAttachmentUnderFence} calls this for the WHOLE
 *   endpoint only, at DECIDE time, before that same frame's first statement —
 *   see that function's docblock for why only the whole can be hoisted.
 *
 * One spelling of the liveness verdict keeps the two calls from ever judging
 * "is this row live" differently, the way a second copy of a decision drifts
 * per this codebase's Contract Discipline rule.
 */
export function assertEndpointRowLive(
  edgeKind: string,
  endpoint: "from" | "to",
  nodeKind: string,
  nodeId: string,
  row: NodeRow | undefined,
): void {
  if (row === undefined || row.deleted_at !== undefined) {
    throw new EndpointNotFoundError({ edgeKind, endpoint, nodeKind, nodeId });
  }
}

/**
 * THE fenced DECIDE half of an attachment: re-read the incumbent on the
 * frame's own transaction target — under the per-graph write lock the caller
 * already holds — and judge it ({@link decideCompositionIncumbent}).
 *
 * Separated from the write half so a frame that owes OTHER statements can
 * run every decision this one can reach before its first statement: the
 * get-or-create `ifExists: "update"` / resurrection leg decides here, then
 * updates properties, then applies the decision. A refusal this function
 * raises therefore precedes the property update, which is what keeps a
 * caller that catches it inside an enclosing `store.transaction(...)` — where
 * there is no nested frame to roll back — from committing an update whose
 * attachment never applied.
 *
 * That is why this function, not the write half, also owns the WHOLE
 * endpoint's liveness read: when the disposition is going to attach a new
 * edge (`"attach"` or `"replace"`), a dead or missing whole is refused HERE,
 * via {@link assertEndpointRowLive}, before returning — not left to
 * `attachCompositionCreateEdge`'s `assertLiveEdgeEndpoints` call, which on
 * the get-or-create leg runs only after the property update. The PART
 * endpoint is deliberately NOT read here: on the resurrection leg the part
 * row is still a tombstone until the update that runs after this decide
 * restores it, so a part-liveness read taken here would refuse every
 * resurrection. `assertLiveEdgeEndpoints` keeps owning that side, at write
 * time. A `"satisfied"` disposition writes nothing, so it owes no fresh
 * liveness read.
 *
 * `target` is the frame's own transaction target, which is the only reason
 * the verdict can be trusted: a verdict from a lock-free read is exactly what
 * would let a refusing caller perform a silent move. `lock: GraphWriteLock`
 * is compile-time evidence this read (like the incumbent re-read beside it)
 * cannot precede the per-graph write lock — the same device
 * `assertCompositionExistencePreserved` uses.
 */
export async function decideCompositionAttachmentUnderFence(
  registry: KindRegistry,
  target: GraphReadBackend,
  graphId: string,
  partId: string,
  request: CompositionAttachmentRequest,
  lock: GraphWriteLock,
): Promise<FencedCompositionAttachment> {
  void lock;
  const incumbent = await findLiveCompositionAttachment(
    registry,
    target,
    graphId,
    request.work.partKind,
    partId,
  );
  const disposition = decideCompositionIncumbent(
    registry,
    partId,
    request,
    incumbent,
  );
  if (disposition === "attach" || disposition === "replace") {
    const { pair } = request.work;
    const { attachment } = request;
    const wholeSide = pair.partSide === "from" ? "to" : "from";
    const wholeRow = await target.getNode(
      graphId,
      attachment.kind,
      attachment.id,
    );
    assertEndpointRowLive(
      pair.viaEdgeKind,
      wholeSide,
      attachment.kind,
      attachment.id,
      wholeRow,
    );
  }
  return {
    request,
    disposition,
    ...(incumbent === undefined ? {} : { incumbent }),
  };
}

/**
 * The live whole a composition part currently holds, if any — read to name
 * it in `CompositionExistenceError`'s `situation: "existing"` message, and
 * to decide whether a `getOrCreateByConstraint` postcondition is already
 * satisfied. The whole-only projection of
 * {@link findLiveCompositionAttachment}.
 */
export async function findLiveCompositionWhole(
  registry: KindRegistry,
  backend: GraphReadBackend,
  graphId: string,
  concreteKind: string,
  concreteId: string,
  excludeEdgeIds?: ReadonlySet<string>,
): Promise<CompositionWholeRef | undefined> {
  const attachment = await findLiveCompositionAttachment(
    registry,
    backend,
    graphId,
    concreteKind,
    concreteId,
    excludeEdgeIds,
  );
  return attachment?.whole;
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
