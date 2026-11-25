/**
 * THE RATCHET for Store-layer registries keyed by an object.
 *
 * Store state kept for a transaction (the managed write session of a
 * `store.transaction` attempt, leased schema fences, held graph write locks,
 * savepoint checkpoints, recorded-capture scopes) is kept in side tables keyed
 * by the identity of a backend, target, context or native handle object. Each
 * such table decides its own scope implicitly: which bindings of one native
 * transaction share an entry follows from which object a caller happens to
 * pass, so two bindings of one transaction can disagree about savepoints,
 * fences and locks. Until that state is carried explicitly, this ratchet keeps
 * the set of such tables from growing.
 *
 * The invariant: every `WeakMap` / `WeakSet` / `Map` / `Set` constructed in the
 * Store layers whose key type is an object is listed in
 * {@link OBJECT_KEYED_COLLECTIONS} with what keys it, why, and how many
 * construction sites carry its label (multiset EQUALITY, both directions, so
 * a new one fails, a second one under an existing label fails, and a removed
 * one must be delisted), and the number of construction sites keyed by a
 * transaction binding, counted from the scan, may only go down.
 *
 * The key type is resolved with the type checker, so a key typed `object` and
 * an untyped `new Map()` whose type comes from its context are both seen; a
 * branded string key (`MergeKey`, `NodeId`) is a primitive and is not.
 */
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  createScanProgram,
  PACKAGE_ROOT,
  type ScanProgram,
} from "./helpers/operation-scope-scan";

const STORE_LAYERS = [
  "store",
  "graph-merge",
  "identity",
  "provenance",
  "interchange",
] as const;

/** What a collection's key identifies. */
type KeyedBy =
  /** A transaction binding (backend/target), or a frame on one. Debt or a binding-owned table. */
  | "transaction-binding"
  /** A root backend: state that outlives every transaction on it. */
  | "root-backend"
  /** A caller's native driver handle. */
  | "native-handle"
  /** A transaction callback's runtime port object (one per context). */
  | "callback-context"
  /** Local to one function call: built and dropped by that call. */
  | "call-local"
  /** Not a backend, target, context or native handle. */
  | "other";

type Allowance = Readonly<{
  keyedBy: KeyedBy;
  reason: string;
  /** Construction sites carrying this label; 1 when omitted. */
  sites?: number;
}>;

/**
 * Every object-keyed collection in the Store layers, by `file#label` (the
 * declaration it initializes, or the enclosing function).
 */
const OBJECT_KEYED_COLLECTIONS: Readonly<Record<string, Allowance>> = {
  // --- keyed by a transaction binding -----------------------------------
  "store/savepoint-state.ts#checkpoints": {
    keyedBy: "transaction-binding",
    reason:
      "Keyed by the binding's derivation root. Its owner is the native transaction, but keying it by the native transaction joins caller re-adoptions of one handle and changes known defect 'hazard 4a' (transaction-session-hazards.ts); that move is a deliberate behaviour change for its own change.",
  },
  "store/savepoint-state.ts#scopes": {
    keyedBy: "transaction-binding",
    reason: "As `checkpoints`: moves with it.",
  },
  "store/recorded-capture.ts#recordedTransactionBindings": {
    keyedBy: "transaction-binding",
    reason:
      "One recorded-capture scope per Store binding, registered on its overlay and raw target; two history Stores on one transaction each have their own scope, so the owner is the capture scope, not the transaction.",
  },
  "store/recorded-capture.ts#recordedRevisionBindings": {
    keyedBy: "transaction-binding",
    reason: "The capture scope's revision session; owned like its bindings.",
  },
  "store/recorded-capture/clock.ts#recordedGraphLockMemos": {
    keyedBy: "transaction-binding",
    reason:
      "A capture scope's graph-lock memo, set on that scope's overlay and rolled back with its savepoints; owned by the capture scope.",
  },
  "store/claims/composition-windows.ts#openCompositionWindowVerdicts": {
    keyedBy: "transaction-binding",
    reason:
      "One merge-apply write frame on one binding, visible to bindings derived from it for that frame's duration; owned by the operation.",
  },
  "store/operations/composition-create.ts#deferredExistenceFrames": {
    keyedBy: "transaction-binding",
    reason: "One merge-apply write frame, as `openCompositionWindowVerdicts`.",
  },
  "store/operations/write-transaction.ts#writeTransactionSessions": {
    keyedBy: "transaction-binding",
    reason:
      "The managed write session of one `store.transaction` attempt, keyed by its target: state about the attempt's Store binding (its graph, revision and history configuration), not about the native transaction alone. It stays keyed by the target because graph-merge reads it (`forceWriteTransactionRevision`, `hasPendingWriteTransactionRevision`) through the transaction runtime port's `backend`, a type the public API report spells; carrying the session there is a port change.",
  },
  "store/operations/write-transaction.ts#leasedSchemaFences": {
    keyedBy: "transaction-binding",
    reason:
      "Schema fences a reusable write session leased, keyed by the target that acquired them; a fence is about one graph on one set of physical tables. It stays keyed by target: the adopted history path seeds one lease on four objects of one binding (raw, capture overlay, witness wrapper, execution scope), and `lockSchemaVersionForStoreWrite` consults it from capture, identity and evolution code that holds no session yet.",
  },
  // --- keyed by a root backend ------------------------------------------
  "store/fixed-schema-working-copy.ts#FIXED_SCHEMA_BACKENDS": {
    keyedBy: "root-backend",
    reason: "Marks a fixed-schema working-copy root backend for its lifetime.",
  },
  "store/materialize-removals.ts#reclaimCache": {
    keyedBy: "root-backend",
    reason: "A per-root cache of reclaim plans; no transaction state.",
  },
  "store/recorded-capture/clock.ts#ENSURED_ORIGINS_RELATIONS": {
    keyedBy: "root-backend",
    reason: "Records that a root backend's DDL was ensured; process lifetime.",
  },
  // --- keyed by a native handle -----------------------------------------
  "store/evolution.ts#ACTIVE_ADOPTED_TRANSACTIONS": {
    keyedBy: "native-handle",
    reason:
      "Detects nested adopted scopes on the caller's handle before any adoption exists; on better-sqlite3 the handle is the long-lived database, not a per-BEGIN object.",
  },
  // --- keyed by a transaction callback's runtime ------------------------
  "store/runtime-port.ts#transactionStoreOwners": {
    keyedBy: "callback-context",
    reason: "Which Store owns one callback's context: per binding/view.",
  },
  "store/runtime-port.ts#evolvedTransactionOriginalOwners": {
    keyedBy: "callback-context",
    reason: "The evolved callback's original Store: per binding/view.",
  },
  "store/runtime-port.ts#storeRuntimeTokens": {
    keyedBy: "other",
    reason:
      "One identity token per Store runtime, so the owner maps compare tokens rather than hold a runtime whose members demand an operation.",
  },
  "store/runtime-port.ts#evolvedTransactionStores": {
    keyedBy: "callback-context",
    reason: "The evolved callback's temporary view: per binding/view.",
  },
  "store/runtime-port.ts#activeTransactionContexts": {
    keyedBy: "callback-context",
    reason: "Whether one callback is still running: per attempt's callback.",
  },
  "store/runtime-port.ts#scopedTransactionRuntimes": {
    keyedBy: "callback-context",
    reason: "A measure scope's runtime → its callback's runtime.",
  },
  // --- local to one call ----------------------------------------------
  "store/operations/write-transaction.ts#uniqueTargets": {
    keyedBy: "call-local",
    reason:
      "Deduplicates the targets one schema-fence lease covers; dropped when the call returns.",
  },
  "store/operations/write-transaction.ts#previousLeases": {
    keyedBy: "call-local",
    reason:
      "The leases one call displaced, restored in its `finally`; dropped when the call returns.",
  },
  // --- not keyed by a backend, target, context or native handle ---------
  "graph-merge/clustering.ts#offendingSet": {
    keyedBy: "other",
    reason: "Merge clusters.",
  },
  "graph-merge/ingestion-branch.ts#PRIVATE_BRANCHES": {
    keyedBy: "other",
    reason: "Ingestion branch handles.",
  },
  "graph-merge/merge.ts#baseSurvivingEdges": {
    keyedBy: "other",
    reason: "Match edges.",
  },
  "graph-merge/mutation-plan.ts#seen": {
    keyedBy: "other",
    reason: "Cycle guard over property values.",
  },
  "graph-merge/review-evidence.ts#reviewOptionEvidence": {
    keyedBy: "other",
    reason: "Cycle guard over option values.",
  },
  "graph-merge/review-evidence.ts#nextAncestors": {
    keyedBy: "other",
    reason: "Cycle guard over option values.",
  },
  "graph-merge/union-find.ts#parent": {
    keyedBy: "other",
    reason: "Generic union-find over merge keys.",
  },
  "identity/schema-transition.ts#IDENTITY_DDL_RACES": {
    keyedBy: "other",
    reason: "Error objects.",
  },
  "identity/separation.ts#provenSeparationReadiness": {
    keyedBy: "other",
    reason: "KindRegistry.",
  },
  "interchange/import.ts#failedMoves": {
    keyedBy: "other",
    reason: "Composition moves.",
  },
  "interchange/import.ts#gaps": {
    keyedBy: "other",
    reason: "Composition moves.",
  },
  "interchange/import.ts#failures": {
    keyedBy: "other",
    reason: "Composition moves (two functions).",
    sites: 2,
  },
  "interchange/ingestion-import-target.ts#INGESTION_IMPORT_TARGETS": {
    keyedBy: "other",
    reason: "Ingestion handles.",
  },
  "interchange/stream-source.ts#EXPORT_STREAM_BACKENDS": {
    keyedBy: "other",
    reason: "Keyed by an export stream; the root backend is its value.",
  },
  "provenance/scope.ts#evolvedScopes": {
    keyedBy: "other",
    reason: "Keyed by a Store (an evolved view).",
  },
  "store/acyclicity.ts#byRegistry": {
    keyedBy: "other",
    reason: "KindRegistry.",
  },
  "store/acyclicity.ts#acyclicEdgeRelationsCache": {
    keyedBy: "other",
    reason: "GraphDef.",
  },
  "store/acyclicity.ts#acyclicEdgeKindPlacementsCache": {
    keyedBy: "other",
    reason: "GraphDef.",
  },
  "store/embedding-sync.ts#embeddingFieldsCache": {
    keyedBy: "other",
    reason: "Zod schemas.",
  },
  "store/reserved-keys.ts#assertSchemaKeysAreFree": {
    keyedBy: "other",
    reason: "Cycle guard over Zod schemas.",
  },
  "store/savepoint-state.ts#registerSavepointState": {
    keyedBy: "other",
    reason: "Checkpoint functions.",
  },
  "store/store.ts#nonEmpty": {
    keyedBy: "other",
    reason: "Schema change entries (two sites).",
    sites: 2,
  },
  "store/store.ts#IDENTITY_FACADES": {
    keyedBy: "other",
    reason: "Keyed by a Store.",
  },
  "store/subgraph.ts#sharedSubgraphPlans": {
    keyedBy: "other",
    reason: "Batch items.",
  },
  "store/subgraph.ts#introspectorCache": {
    keyedBy: "other",
    reason: "GraphDef.",
  },
  "store/claims/composition-claims.ts#compositionHoldersCache": {
    keyedBy: "other",
    reason: "KindRegistry.",
  },
};

/**
 * Construction sites keyed by a transaction binding, as the scan finds them.
 * May only decrease: lower it when a registry moves onto state the
 * transaction carries explicitly.
 */
const TRANSACTION_BINDING_KEYED_BASELINE = 9;

/** `"transaction" in x` probes in the Store layers. May only decrease. */
const TRANSACTION_MEMBER_PROBE_BASELINE = 5;

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Void;

/** A primitive, a union of primitives, or a branded primitive. */
function isPrimitiveKey(type: ts.Type): boolean {
  if ((type.flags & PRIMITIVE_FLAGS) !== 0) return true;
  if (type.isUnion()) return type.types.every((part) => isPrimitiveKey(part));
  if (type.isIntersection()) {
    return type.types.some((part) => isPrimitiveKey(part));
  }
  return false;
}

const COLLECTION_CONSTRUCTORS = new Set(["WeakMap", "WeakSet", "Map", "Set"]);

/** The first type argument of a collection type, unwrapping context. */
function collectionKeyType(
  checker: ts.TypeChecker,
  node: ts.NewExpression,
): ts.Type | undefined {
  const own = checker.getTypeArguments(
    checker.getTypeAtLocation(node) as ts.TypeReference,
  )[0];
  if (own !== undefined && (own.flags & ts.TypeFlags.Any) === 0) return own;
  // An untyped `new Map()` takes its type from where it is returned or
  // assigned: unwrap `undefined` and a Promise, then read the collection.
  const contextual = checker.getContextualType(node);
  if (contextual === undefined) return own;
  const unwrapped = checker.getNonNullableType(contextual);
  const awaited = checker.getAwaitedType(unwrapped) ?? unwrapped;
  const parts = awaited.isUnion() ? awaited.types : [awaited];
  return (
    parts
      .map((part) => checker.getTypeArguments(part as ts.TypeReference)[0])
      .find((key) => key !== undefined) ?? own
  );
}

function declarationName(name: ts.Node): string | undefined {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) ?
      name.text
    : undefined;
}

/** The declaration a collection initializes, or its enclosing function. */
function collectionLabel(node: ts.Node): string {
  for (let current = node.parent; ; current = current.parent) {
    if (
      ts.isVariableDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertyAssignment(current)
    ) {
      const name = declarationName(current.name);
      if (name !== undefined) return name;
    }
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return declarationName(current.name) ?? "anonymous";
    }
    if (ts.isSourceFile(current)) return "module";
  }
}

type ScanResult = Readonly<{
  /** `file#label` → how many construction sites carry it. */
  collections: ReadonlyMap<string, number>;
  transactionProbes: number;
}>;

function scanStoreLayers(scan: ScanProgram): ScanResult {
  const roots = STORE_LAYERS.map(
    (layer) => path.join(PACKAGE_ROOT, "src", layer) + path.sep,
  );
  const collections = new Map<string, number>();
  let transactionProbes = 0;
  for (const file of scan.sourceFiles) {
    if (!roots.some((root) => file.startsWith(root))) continue;
    const source = scan.program.getSourceFile(file);
    if (source === undefined) continue;
    const relative = path
      .relative(path.join(PACKAGE_ROOT, "src"), file)
      .replaceAll(path.sep, "/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        COLLECTION_CONSTRUCTORS.has(node.expression.text)
      ) {
        const key = collectionKeyType(scan.checker, node);
        if (key === undefined || !isPrimitiveKey(key)) {
          const label = `${relative}#${collectionLabel(node)}`;
          collections.set(label, (collections.get(label) ?? 0) + 1);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isStringLiteralLike(node.left) &&
        node.left.text === "transaction"
      ) {
        transactionProbes += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { collections, transactionProbes };
}

describe("transaction registry ratchet", () => {
  // One type-checked program over `src`; coverage instrumentation slows it.
  const scanned = (() => {
    let result: ScanResult | undefined;
    return () => {
      result ??= scanStoreLayers(createScanProgram({}));
      return result;
    };
  })();

  it(
    "every object-keyed collection in the Store layers is listed, and every listing exists",
    { timeout: 180_000 },
    () => {
      const found = Object.fromEntries(
        [...scanned().collections].toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
      const listed = Object.fromEntries(
        Object.entries(OBJECT_KEYED_COLLECTIONS)
          .map(([label, allowance]) => [label, allowance.sites ?? 1] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
      );
      expect(found).toEqual(listed);
    },
  );

  it(
    "collections keyed by a transaction binding only decrease",
    { timeout: 180_000 },
    () => {
      // Counted from the construction sites the scan found, so a registry that
      // reuses a listed label, or one the listing has not caught up with, is
      // counted rather than assumed away.
      const count = [...scanned().collections]
        .filter(
          ([label]) =>
            OBJECT_KEYED_COLLECTIONS[label]?.keyedBy === "transaction-binding",
        )
        .reduce((total, [, sites]) => total + sites, 0);
      expect(
        count,
        "Lower TRANSACTION_BINDING_KEYED_BASELINE when a registry moves onto state the transaction carries explicitly; never raise it.",
      ).toBe(TRANSACTION_BINDING_KEYED_BASELINE);
    },
  );

  it('"transaction" in probes only decrease', { timeout: 180_000 }, () => {
    expect(
      scanned().transactionProbes,
      "Lower TRANSACTION_MEMBER_PROBE_BASELINE when a probe is replaced; never raise it.",
    ).toBe(TRANSACTION_MEMBER_PROBE_BASELINE);
  });
});
