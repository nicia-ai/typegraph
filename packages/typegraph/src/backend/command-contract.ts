import { CompilerInvariantError, ConfigurationError } from "../errors";
import type {
  EdgeConvergeCreateCommand,
  EdgeConvergeCreateCommandResult,
  EdgeCreateCommand,
  EdgeCreateCommandResult,
  GraphCommand,
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandIsolation,
  GraphCommandPort,
  GraphCommandResult,
  GraphCommandSession,
  GraphWriteFenceAcquisition,
  NodeCreateCommand,
  NodeCreateCommandResult,
} from "./types";

const graphCommandCoordinationBindings = new WeakMap<
  object,
  Readonly<{
    graphId: string;
    acquisition: GraphWriteFenceAcquisition;
    sessionIdentity: object;
  }>
>();
const graphCommandPortSessionIdentities = new WeakMap<object, object>();

export type {
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandIsolation,
  GraphCommandSession,
  GraphWriteFenceAcquisition,
} from "./types";

/**
 * Retains a transaction command session's identity across a transparent port
 * wrapper. Coordination attaches to the session identity, not the wrapper
 * object, so an observing/decorating backend cannot make a proven
 * advisory lock look like it belongs to another connection.
 */
export function carryGraphCommandPortSessionMetadata(
  base: GraphCommandPort,
  derived: GraphCommandPort,
): void {
  if (base.session !== derived.session) {
    throw new CompilerInvariantError(
      "A derived graph command port must retain its base command session.",
      { baseSession: base.session, derivedSession: derived.session },
    );
  }
  graphCommandPortSessionIdentities.set(
    derived,
    graphCommandPortSessionIdentity(base),
  );
}

function graphCommandPortSessionIdentity(port: GraphCommandPort): object {
  return graphCommandPortSessionIdentities.get(port) ?? port;
}

/**
 * Internal evidence mint used only after a graph's write fence has been
 * acquired on the command port's transaction. The binding prevents a real
 * acquisition from transaction A (or graph A) authorizing a command on B, and
 * carries what that acquisition observed and did so every later decision
 * reads the facts of the statement that earned them.
 */
export function mintGraphCommandCoordination(
  port: GraphCommandPort,
  graphId: string,
  acquisition: GraphWriteFenceAcquisition,
): GraphCommandCoordination {
  const coordination = Object.freeze({}) as GraphCommandCoordination;
  graphCommandCoordinationBindings.set(coordination, {
    graphId,
    acquisition,
    sessionIdentity: graphCommandPortSessionIdentity(port),
  });
  return coordination;
}

function isGraphCommandCoordination(
  value: unknown,
): value is GraphCommandCoordination {
  if (typeof value !== "object" || value === null) return false;
  return graphCommandCoordinationBindings.has(value);
}

/** Normalize a database isolation setting into command-contract vocabulary. */
export function normalizeGraphCommandIsolation(
  value: unknown,
): GraphCommandIsolation {
  if (typeof value !== "string") return "unknown";
  switch (value.replaceAll(" ", "_").toLowerCase()) {
    case "read_committed":
    case "read_uncommitted": {
      return "read_committed";
    }
    case "repeatable_read": {
      return "repeatable_read";
    }
    case "serializable": {
      return "serializable";
    }
    default: {
      return "unknown";
    }
  }
}

/** The column a fence acquisition reports its session isolation under. */
const FENCE_ISOLATION_COLUMN = "transaction_isolation";
/** The column a fence acquisition reports its advanced fence row under. */
const FENCE_ROW_GENERATION_COLUMN = "generation";

/**
 * THE one reader of a graph-write fence acquisition's result row, shared by
 * the portable acquisition and the fused schema + graph fence so neither can
 * read the session's isolation or the fence-row evidence differently. A
 * missing row or column is the absence of the fact, never a default: an
 * unreported isolation is `unknown`, and an unreported generation means the
 * statement advanced no fence row.
 */
export function readGraphWriteFenceAcquisition(
  row: Readonly<Record<string, unknown>> | undefined,
): GraphWriteFenceAcquisition {
  const generation = row?.[FENCE_ROW_GENERATION_COLUMN];
  return {
    isolation: normalizeGraphCommandIsolation(row?.[FENCE_ISOLATION_COLUMN]),
    fenceRow:
      generation === undefined || generation === null ? "none" : "advanced",
  };
}

const UNOBSERVED_FENCE_ACQUISITION: GraphWriteFenceAcquisition = {
  isolation: "unknown",
  fenceRow: "none",
};

function boundGraphCommandCoordination(
  port: GraphCommandPort,
  coordination: GraphCommandCoordination,
  graphId?: string,
) {
  const binding = graphCommandCoordinationBindings.get(coordination);
  return (
      binding?.sessionIdentity === graphCommandPortSessionIdentity(port) &&
        (graphId === undefined || binding.graphId === graphId)
    ) ?
      binding
    : undefined;
}

/** Effective isolation of coordination earned by this graph and transaction. */
export function graphCommandCoordinationIsolation(
  port: GraphCommandPort,
  graphId: string,
  coordination: GraphCommandCoordination,
): GraphCommandIsolation {
  return graphCommandCoordinationAcquisition(port, coordination, graphId)
    .isolation;
}

function graphCommandCoordinationAcquisition(
  port: GraphCommandPort,
  coordination: GraphCommandCoordination,
  graphId?: string,
): GraphWriteFenceAcquisition {
  return (
    boundGraphCommandCoordination(port, coordination, graphId)?.acquisition ??
    UNOBSERVED_FENCE_ACQUISITION
  );
}

/**
 * Whether a session that acquired the per-graph write fence this way reads
 * everything committed by the acquirers that held the fence before it.
 *
 * `read_committed` takes a fresh snapshot per statement, so every statement
 * after the acquisition sees what committed while it waited. A snapshot
 * isolation (`repeatable_read`, `serializable`) keeps the snapshot it took at
 * its first statement, however long it then waits — and a lock cannot change
 * that. PostgreSQL's serialization-failure detection does not help either: it
 * arbitrates serializable transactions against each other only, so a
 * serializable session and a read-committed writer can both commit. What does
 * hold at those levels is first-updater-wins on a row both sessions write:
 * an acquisition that advanced the graph's fence row succeeds only when no
 * other acquirer committed after this session's snapshot, and fails with a
 * serialization failure otherwise. So a snapshot isolation observes the
 * winner exactly when its acquisition advanced the fence row. Everything
 * else — including `unknown` — fails closed.
 *
 * THE one predicate every "must observe the fence winner" check consults:
 * match-key convergence ({@link assertGraphCommandConvergenceIsolation}) and
 * the lock-only reads of {@link assertFencedSnapshotIsFresh} both need "did
 * this session's snapshot start after the fence it waited for released", and
 * a second inline spelling of the isolation set is exactly the copy that
 * drifts.
 */
export function observesPostFenceCommits(
  acquisition: GraphWriteFenceAcquisition,
): boolean {
  switch (acquisition.isolation) {
    case "read_committed": {
      return true;
    }
    case "repeatable_read":
    case "serializable": {
      return acquisition.fenceRow === "advanced";
    }
    case "unknown": {
      return false;
    }
    default: {
      return acquisition.isolation satisfies never;
    }
  }
}

/** What a caller changes to pass {@link observesPostFenceCommits}. */
const FRESH_SNAPSHOT_SUGGESTION =
  "Use read_committed transaction isolation. Snapshot isolation levels " +
  "(repeatable_read, serializable) are supported only on a backend whose " +
  "graph-write fence advances the graph's fence row (`tableNames.fences`) " +
  "and reports the effective transaction isolation.";

/**
 * THE fresh-snapshot guard of a decision the per-graph write fence alone
 * protects — a read with no claim row behind it, such as the edge-acyclicity
 * probe or a whole delete's parts closure. Such a read is only as good as the
 * snapshot it runs on, so the session that took the fence must observe what
 * committed while it waited.
 *
 * `coordination` is `undefined` exactly when the store's write-fence plan is
 * `engine-serialized` or `caller-serialized` (one writer at a time, nothing
 * to observe). Every frame of a transaction that holds a keyed fence carries
 * the coordination its acquisition minted, the nested and sibling frames
 * included, so this cannot be skipped by where in the transaction it runs.
 *
 * @throws ConfigurationError carrying `refusal.code`
 */
export function assertFencedSnapshotIsFresh(
  port: GraphCommandPort,
  graphId: string,
  coordination: GraphCommandCoordination | undefined,
  refusal: Readonly<{ code: string; subject: string }>,
): void {
  if (coordination === undefined) return;
  const acquisition = graphCommandCoordinationAcquisition(
    port,
    coordination,
    graphId,
  );
  if (observesPostFenceCommits(acquisition)) return;
  throw new ConfigurationError(
    `${refusal.subject} requires a transaction isolation that observes ` +
      "writes committed while this session waited for the per-graph write fence.",
    {
      code: refusal.code,
      graphId,
      isolation: acquisition.isolation,
      fenceRow: acquisition.fenceRow,
    },
    { suggestion: FRESH_SNAPSHOT_SUGGESTION },
  );
}

/**
 * A match-key convergence must observe the winner after waiting for its graph
 * lock. A snapshot isolation can do that only when its acquisition advanced
 * the graph's fence row; adopted/custom transaction ports without an audited
 * isolation level fail closed for the same reason.
 */
export function assertGraphCommandConvergenceIsolation(
  port: GraphCommandPort,
  coordination: GraphCommandCoordination,
): void {
  const acquisition = graphCommandCoordinationAcquisition(port, coordination);
  if (observesPostFenceCommits(acquisition)) return;
  throw new ConfigurationError(
    "Match-key convergence requires a transaction isolation that observes " +
      "writes committed while this session waited for the per-graph write fence.",
    {
      code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
      isolation: acquisition.isolation,
      fenceRow: acquisition.fenceRow,
    },
    { suggestion: FRESH_SNAPSHOT_SUGGESTION },
  );
}

/** Assert that a coordination token belongs to this port and command graph. */
export function assertGraphCommandCoordination(
  port: GraphCommandPort,
  command: GraphCommand,
  coordination: GraphCommandCoordination,
): void {
  if (
    boundGraphCommandCoordination(
      port,
      coordination,
      command.plan.params.graphId,
    ) !== undefined
  ) {
    return;
  }
  throw new CompilerInvariantError(
    "Graph command coordination does not belong to this transaction port and graph.",
    { graphId: command.plan.params.graphId },
  );
}

/** Build the non-negotiable context for one command session. */
export function graphCommandExecutionContext(
  session: GraphCommandSession,
  coordination: "none" | GraphCommandCoordination = "none",
): GraphCommandExecutionContext {
  if (session === "root") {
    if (coordination !== "none") {
      throw new CompilerInvariantError(
        "A root command cannot inherit a transaction-scoped graph write lock.",
        { coordination, session },
      );
    }
    return { session, coordination: "none" };
  }
  return { session, coordination };
}

/**
 * Validate a context before it reaches a first-party executor. The helper
 * below always creates a valid value, while direct port callers use this same
 * assertion to keep session/coordination shape single-owned.
 */
export function assertGraphCommandExecutionContext(
  context: unknown,
): asserts context is GraphCommandExecutionContext {
  const facts =
    typeof context === "object" && context !== null ?
      (context as Readonly<Record<string, unknown>>)
    : undefined;
  if (
    facts === undefined ||
    (facts["coordination"] !== "none" &&
      !isGraphCommandCoordination(facts["coordination"])) ||
    !(
      (facts["session"] === "root" && facts["coordination"] === "none") ||
      facts["session"] === "transaction"
    )
  ) {
    throw new CompilerInvariantError(
      "A graph command received an invalid execution context.",
      { context: facts },
    );
  }
}

/** Refuse a backend result that does not describe the submitted command. */
export function assertCommandResultMatchesCommand(
  command: NodeCreateCommand,
  result: GraphCommandResult,
): asserts result is NodeCreateCommandResult;
export function assertCommandResultMatchesCommand(
  command: EdgeCreateCommand,
  result: GraphCommandResult,
): asserts result is EdgeCreateCommandResult;
export function assertCommandResultMatchesCommand(
  command: EdgeConvergeCreateCommand,
  result: GraphCommandResult,
): asserts result is EdgeConvergeCreateCommandResult;
export function assertCommandResultMatchesCommand(
  command: GraphCommand,
  result: GraphCommandResult,
): void;
export function assertCommandResultMatchesCommand(
  command: GraphCommand,
  result: GraphCommandResult,
): void {
  const planEntity = command.plan.entity;
  const graphId = command.plan.params.graphId;
  const commandId = command.plan.params.id;
  const resultEntity = result.entity;
  if (resultEntity !== planEntity) {
    throw new CompilerInvariantError(
      "A command result must describe the submitted command entity.",
      {
        planEntity,
        resultEntity,
        graphId,
        id: commandId,
      },
    );
  }
  if (result.outcome === "found") {
    if (command.kind !== "edge.converge-create") {
      throw new CompilerInvariantError(
        "Only an edge convergence command may return a found result.",
        { commandKind: command.kind, graphId, id: commandId },
      );
    }
    const row = result.row;
    const params = command.plan.params;
    const matchIdentityMatches =
      command.match.kind === "dynamic" ||
      (row.match_identity_name === command.match.identity.name &&
        row.match_identity_key === command.match.identity.key);
    if (
      row.graph_id === params.graphId &&
      row.kind === params.kind &&
      row.from_kind === params.fromKind &&
      row.from_id === params.fromId &&
      row.to_kind === params.toKind &&
      row.to_id === params.toId &&
      matchIdentityMatches
    ) {
      return;
    }
    throw new CompilerInvariantError(
      "A convergent edge result row must match the submitted edge identity.",
      {
        command: {
          graphId: params.graphId,
          kind: params.kind,
          fromKind: params.fromKind,
          fromId: params.fromId,
          toKind: params.toKind,
          toId: params.toId,
        },
        result: {
          graphId: row.graph_id,
          kind: row.kind,
          fromKind: row.from_kind,
          fromId: row.from_id,
          toKind: row.to_kind,
          toId: row.to_id,
        },
      },
    );
  }
  const plan = command.plan;
  if (result.outcome !== "created") return;
  const durableIdentityMatches =
    plan.entity === "node" ||
    plan.params.matchIdentity === undefined ||
    (result.entity === "edge" &&
      result.row.match_identity_name === plan.params.matchIdentity.name &&
      result.row.match_identity_key === plan.params.matchIdentity.key);
  if (
    result.row.graph_id === plan.params.graphId &&
    result.row.kind === plan.params.kind &&
    result.row.id === plan.params.id &&
    durableIdentityMatches
  ) {
    return;
  }
  throw new CompilerInvariantError(
    "A command result row must match the submitted command identity.",
    {
      command: {
        graphId: plan.params.graphId,
        kind: plan.params.kind,
        id: plan.params.id,
      },
      result: {
        graphId: result.row.graph_id,
        kind: result.row.kind,
        id: result.row.id,
      },
    },
  );
}

/**
 * Execute a command through the explicit authoritative seam.
 *
 * Store write paths must use this helper so session and coordination evidence
 * are explicit at every first-party call site.
 */
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: NodeCreateCommand,
  coordination?: "none" | GraphCommandCoordination,
): Promise<NodeCreateCommandResult>;
/** Execute an authoritative edge-create command and return its typed result. */
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: EdgeCreateCommand,
  coordination?: "none" | GraphCommandCoordination,
): Promise<EdgeCreateCommandResult>;
/** Execute an authoritative convergent edge-create command and return its typed result. */
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: EdgeConvergeCreateCommand,
  coordination?: "none" | GraphCommandCoordination,
): Promise<EdgeConvergeCreateCommandResult>;
/** Execute any graph command when its concrete kind is not statically known. */
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: GraphCommand,
  coordination?: "none" | GraphCommandCoordination,
): Promise<GraphCommandResult>;
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: GraphCommand,
  coordination: "none" | GraphCommandCoordination = "none",
): Promise<GraphCommandResult> {
  const context = graphCommandExecutionContext(port.session, coordination);
  assertGraphCommandExecutionContext(context);
  if (coordination !== "none") {
    assertGraphCommandCoordination(port, command, coordination);
    if (command.kind === "edge.converge-create") {
      // Store and public helper callers are checked here before a custom port
      // can execute the convergence command.
      assertGraphCommandConvergenceIsolation(port, coordination);
    }
  }
  return port.execute(command, context).then((result) => {
    assertCommandResultMatchesCommand(command, result);
    return result;
  });
}
