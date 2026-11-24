import { describe, expectTypeOf, it } from "vitest";

import type {
  GraphBackend,
  SchemaCommitPreflightBackend,
  SchemaWriteTransactionBackend,
  TransactionBackend,
  TransactionReadBackend,
} from "../src/backend/types";
import type { BatchableQuery } from "../src/query/builder/types";
import {
  enterOperation,
  enterTargetOperation,
  type EntryScope,
  legacyTransactionOperation,
  openTransactionSession,
  type Operation,
  type OperationBackend,
  type OperationEntry,
  type OperationScoped,
  type StatementBackend,
  type StoreCommitSchemaVersionWithPreflight,
  storeCommitSchemaVersionWithPreflight,
  type StoreSchemaWriteTransaction,
  storeSchemaWriteTransaction,
  type StoreSetActiveVersionWithPreflight,
  storeSetActiveVersionWithPreflight,
  type StoreTransactionBackend,
  type TransactionSession,
} from "../src/store/operation-scope";
import type { executeEdgeCreate } from "../src/store/operations/edge-operations";

type EdgeCreateBackend = Parameters<typeof executeEdgeCreate>[2];

/**
 * An engine transaction that adds no member but narrows one: a specialisation
 * all the same, since its handle promises what an ordinary one does not.
 */
type NarrowedTransactionBackend = TransactionBackend &
  Readonly<{
    executeStatement: NonNullable<TransactionBackend["executeStatement"]>;
  }>;

/**
 * Never called: an ordinary Store transaction cannot open a session, and an
 * ordinary session cannot enter an operation, of any engine type beyond the
 * ordinary one. `tsc` reports a `@ts-expect-error` that has no error.
 */
function fabricateSpecialisations(
  transaction: StoreTransactionBackend,
  session: TransactionSession,
) {
  return [
    // @ts-expect-error -- the pooled backend's `transaction` is not this transaction's
    openTransactionSession<GraphBackend>(transaction),
    // @ts-expect-error -- a narrowed member is a specialisation too
    openTransactionSession<NarrowedTransactionBackend>(transaction),
    // @ts-expect-error -- only its boundary mint grants the schema-write transaction
    openTransactionSession<SchemaWriteTransactionBackend>(transaction),
    // @ts-expect-error -- an ordinary session enters ordinary operations only
    enterOperation<GraphBackend>(session),
  ] as const;
}

/** Never called: resolves the session overload of the mint. */
function enteredFromSession(session: TransactionSession) {
  return enterOperation(session);
}

/** Never called: the operation of a session opened over `transaction`. */
function enteredFromOpenedSession<Engine extends TransactionBackend>(
  transaction: StoreTransactionBackend<Engine>,
) {
  return enterOperation(openTransactionSession(transaction));
}

/** Never called: the operation of a session opened over a raw transaction. */
function enteredFromEngineTransaction(transaction: TransactionBackend) {
  return enterOperation(openTransactionSession(transaction));
}

describe("operation-scoped statement targets", () => {
  it("refuses a raw transaction backend on the edge-create path", () => {
    expectTypeOf<TransactionBackend>().not.toExtend<EdgeCreateBackend>();
    expectTypeOf<GraphBackend>().toExtend<EdgeCreateBackend>();
  });

  // A write inside a transaction carries its session, so a bare handle —
  // even an operation-scoped one — is not an entry: only an operation
  // entered from a session is.
  it("refuses a bare handle where a write enters", () => {
    expectTypeOf<OperationBackend>().not.toExtend<EdgeCreateBackend>();
    expectTypeOf<StatementBackend>().not.toExtend<EdgeCreateBackend>();
    expectTypeOf<Operation>().toExtend<EdgeCreateBackend>();
    expectTypeOf<EdgeCreateBackend>().toEqualTypeOf<OperationEntry>();
  });

  it("enters an operation from a session, and passes the root through", () => {
    expectTypeOf(enterOperation).returns.toEqualTypeOf<OperationEntry>();
    expectTypeOf(enterOperation).parameter(0).toEqualTypeOf<EntryScope>();
    expectTypeOf(enteredFromSession).returns.toEqualTypeOf<Operation>();
    expectTypeOf<TransactionBackend>().not.toExtend<EntryScope>();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<EntryScope>();
  });
});

describe("the Store-facing transaction", () => {
  it("carries identity and SQL compilation, and no statement member", () => {
    expectTypeOf<
      Exclude<keyof StoreTransactionBackend, symbol>
    >().toEqualTypeOf<
      | "dialect"
      | "capabilities"
      | "tableNames"
      | "fulltextStrategy"
      | "vectorStrategy"
      | "fenceSql"
      | "compileSql"
    >();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<
      Pick<TransactionBackend, "execute">
    >();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<EdgeCreateBackend>();
  });

  it("is what every engine transaction narrows to without a conversion", () => {
    expectTypeOf<TransactionBackend>().toExtend<StoreTransactionBackend>();
    expectTypeOf<SchemaWriteTransactionBackend>().toExtend<StoreTransactionBackend>();
    expectTypeOf<SchemaCommitPreflightBackend>().toExtend<StoreTransactionBackend>();
    expectTypeOf<
      StoreTransactionBackend<SchemaWriteTransactionBackend>
    >().toExtend<StoreTransactionBackend>();
  });
});

describe("a specialised Store transaction", () => {
  // The review's edit: an ordinary transaction callback annotated as the
  // schema-write (or preflight) transaction. Neither the engine transaction
  // nor its schema-write subtype is assignable to a specialised form, so the
  // annotation is a type error wherever the engine hands a callback a value.
  it("is claimed by no engine transaction, so an annotation cannot grant it", () => {
    expectTypeOf<TransactionBackend>().not.toExtend<
      StoreTransactionBackend<SchemaWriteTransactionBackend>
    >();
    expectTypeOf<TransactionBackend>().not.toExtend<
      StoreTransactionBackend<SchemaCommitPreflightBackend>
    >();
    expectTypeOf<SchemaWriteTransactionBackend>().not.toExtend<
      StoreTransactionBackend<SchemaWriteTransactionBackend>
    >();
    expectTypeOf<SchemaCommitPreflightBackend>().not.toExtend<
      StoreTransactionBackend<SchemaCommitPreflightBackend>
    >();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<
      StoreTransactionBackend<SchemaCommitPreflightBackend>
    >();
  });

  // The second review's edit: `openTransactionSession<GraphBackend>(tx)` over
  // an ordinary transaction, whose operation's handle then promised the pooled
  // backend's `transaction` member. Every engine type beyond the ordinary
  // transaction, one that only narrows a member included, needs the record.
  it("is never named onto an ordinary transaction, the pooled backend included", () => {
    expectTypeOf<StoreTransactionBackend>().not.toExtend<
      StoreTransactionBackend<GraphBackend>
    >();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<
      StoreTransactionBackend<NarrowedTransactionBackend>
    >();
    expectTypeOf<OperationBackend>().not.toExtend<
      OperationScoped<GraphBackend>
    >();
    expectTypeOf<OperationBackend>().not.toExtend<
      OperationScoped<NarrowedTransactionBackend>
    >();
    expectTypeOf<TransactionSession>().not.toExtend<
      TransactionSession<GraphBackend>
    >();
    expectTypeOf<Operation>().not.toExtend<Operation<GraphBackend>>();
    expectTypeOf(fabricateSpecialisations).toBeFunction();
  });

  it("is claimed by no ordinary handle either", () => {
    // Member for member, the preflight target IS an ordinary transaction:
    // without the engine record a plain handle would satisfy it.
    expectTypeOf<TransactionBackend>().toExtend<SchemaCommitPreflightBackend>();
    expectTypeOf<OperationBackend>().not.toExtend<
      OperationScoped<SchemaCommitPreflightBackend>
    >();
    expectTypeOf<OperationBackend>().not.toExtend<
      OperationScoped<SchemaWriteTransactionBackend>
    >();
    expectTypeOf<OperationScoped<SchemaWriteTransactionBackend>>().toExtend<
      OperationScoped<SchemaCommitPreflightBackend>
    >();
    expectTypeOf<OperationScoped<SchemaCommitPreflightBackend>>().toExtend<
      StoreTransactionBackend<SchemaCommitPreflightBackend>
    >();
  });

  it("is handed only to the callback of the engine member that opens it", () => {
    expectTypeOf(storeSchemaWriteTransaction)
      .parameter(0)
      .toEqualTypeOf<GraphBackend["schemaWriteTransaction"]>();
    expectTypeOf(storeSchemaWriteTransaction).returns.toEqualTypeOf<
      StoreSchemaWriteTransaction | undefined
    >();
    expectTypeOf<
      Parameters<Parameters<StoreSchemaWriteTransaction>[1]>[0]
    >().toEqualTypeOf<StoreTransactionBackend<SchemaWriteTransactionBackend>>();
    expectTypeOf(storeCommitSchemaVersionWithPreflight).returns.toEqualTypeOf<
      StoreCommitSchemaVersionWithPreflight | undefined
    >();
    expectTypeOf<
      Parameters<Parameters<StoreCommitSchemaVersionWithPreflight>[1]>[0]
    >().toEqualTypeOf<StoreTransactionBackend<SchemaCommitPreflightBackend>>();
    expectTypeOf(storeSetActiveVersionWithPreflight).returns.toEqualTypeOf<
      StoreSetActiveVersionWithPreflight | undefined
    >();
    expectTypeOf<
      Parameters<Parameters<StoreSetActiveVersionWithPreflight>[1]>[0]
    >().toEqualTypeOf<StoreTransactionBackend<SchemaCommitPreflightBackend>>();
  });

  // The schema-write and preflight callbacks open their session over the
  // specialised transaction they are handed, and their statements (DDL among
  // them) go through that session's operation. The specialisation therefore
  // survives the session, and an ordinary transaction never gains it.
  it("keeps a specialised transaction's privilege through its session and operation", () => {
    expectTypeOf(
      openTransactionSession<SchemaCommitPreflightBackend>,
    ).returns.toEqualTypeOf<TransactionSession<SchemaCommitPreflightBackend>>();
    expectTypeOf(
      enteredFromOpenedSession<SchemaCommitPreflightBackend>,
    ).returns.toEqualTypeOf<Operation<SchemaCommitPreflightBackend>>();
    expectTypeOf<
      ReturnType<
        typeof enteredFromOpenedSession<SchemaWriteTransactionBackend>
      >["backend"]
    >().toEqualTypeOf<OperationScoped<SchemaWriteTransactionBackend>>();
    // A specialised session and its operation are still a session and an
    // operation: they enter wherever the plain ones do.
    expectTypeOf<
      TransactionSession<SchemaCommitPreflightBackend>
    >().toExtend<EntryScope>();
    expectTypeOf<
      Operation<SchemaCommitPreflightBackend>
    >().toExtend<OperationEntry>();
  });

  it("opens a plain session over any other transaction", () => {
    expectTypeOf(
      enteredFromEngineTransaction,
    ).returns.toEqualTypeOf<Operation>();
    expectTypeOf(
      enteredFromOpenedSession<TransactionBackend>,
    ).returns.toEqualTypeOf<Operation>();
    expectTypeOf<Operation["backend"]>().not.toExtend<
      OperationScoped<SchemaCommitPreflightBackend>
    >();
    expectTypeOf<Operation["backend"]>().not.toExtend<
      OperationScoped<SchemaWriteTransactionBackend>
    >();
    expectTypeOf<TransactionSession>().not.toExtend<
      TransactionSession<SchemaCommitPreflightBackend>
    >();
  });

  it("keeps the engine member's own parameters and result", () => {
    type EngineCommit = NonNullable<
      GraphBackend["commitSchemaVersionWithPreflight"]
    >;
    type EngineActivate = NonNullable<
      GraphBackend["setActiveVersionWithPreflight"]
    >;
    type EngineOpen = NonNullable<GraphBackend["schemaWriteTransaction"]>;
    expectTypeOf<
      Parameters<StoreCommitSchemaVersionWithPreflight>[0]
    >().toEqualTypeOf<Parameters<EngineCommit>[0]>();
    expectTypeOf<
      ReturnType<StoreCommitSchemaVersionWithPreflight>
    >().toEqualTypeOf<ReturnType<EngineCommit>>();
    expectTypeOf<
      Parameters<StoreSetActiveVersionWithPreflight>[0]
    >().toEqualTypeOf<Parameters<EngineActivate>[0]>();
    expectTypeOf<
      ReturnType<StoreSetActiveVersionWithPreflight>
    >().toEqualTypeOf<ReturnType<EngineActivate>>();
    expectTypeOf<Parameters<StoreSchemaWriteTransaction>[0]>().toEqualTypeOf<
      Parameters<EngineOpen>[0]
    >();
    expectTypeOf<Parameters<StoreSchemaWriteTransaction>[2]>().toEqualTypeOf<
      Parameters<EngineOpen>[2]
    >();
    expectTypeOf<
      Parameters<StoreSchemaWriteTransaction>["length"]
    >().toEqualTypeOf<Parameters<EngineOpen>["length"]>();
  });

  it("becomes a handle to its engine type only through the shim", () => {
    expectTypeOf(
      legacyTransactionOperation<StoreTransactionBackend>,
    ).returns.toEqualTypeOf<OperationBackend>();
    expectTypeOf(
      legacyTransactionOperation<
        StoreTransactionBackend<SchemaWriteTransactionBackend>
      >,
    ).returns.toEqualTypeOf<OperationScoped<SchemaWriteTransactionBackend>>();
    expectTypeOf(
      legacyTransactionOperation<GraphBackend | StoreTransactionBackend>,
    ).returns.toEqualTypeOf<StatementBackend>();
    expectTypeOf(
      legacyTransactionOperation<GraphBackend>,
    ).returns.toEqualTypeOf<GraphBackend>();
  });

  // `executeOn` takes an outside target: the root, or an engine transaction
  // (this Store's, another Store's, or one the caller opened), which
  // `enterTargetOperation` enters as a binding of its own. A transaction
  // context's `tx.backend` is a read projection with no statement
  // execution, so it is not a target at all.
  it("takes a root or an engine transaction as an executeOn target, never tx.backend", () => {
    type ExecuteOnTarget = Parameters<BatchableQuery["executeOn"]>[0];
    expectTypeOf<GraphBackend>().toExtend<ExecuteOnTarget>();
    expectTypeOf<TransactionBackend>().toExtend<ExecuteOnTarget>();
    expectTypeOf<TransactionReadBackend>().not.toExtend<ExecuteOnTarget>();
    expectTypeOf(enterTargetOperation).returns.toEqualTypeOf<OperationEntry>();
    expectTypeOf<ExecuteOnTarget>().toExtend<
      Parameters<typeof enterTargetOperation>[0]
    >();
  });
});
