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
  NodeCreateCommand,
  NodeCreateCommandResult,
} from "./types";

const graphCommandCoordinationBindings = new WeakMap<
  object,
  Readonly<{
    graphId: string;
    isolation: GraphCommandIsolation;
    sessionIdentity: object;
  }>
>();
const graphCommandPortSessionIdentities = new WeakMap<object, object>();

export type {
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandIsolation,
  GraphCommandSession,
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
 * Internal evidence mint used only after a graph's advisory lock has been
 * acquired on the command port's transaction. The binding prevents a real
 * lock from transaction A (or graph A) authorizing a command on B.
 */
export function mintGraphCommandCoordination(
  port: GraphCommandPort,
  graphId: string,
  isolation: GraphCommandIsolation,
): GraphCommandCoordination {
  const coordination = Object.freeze({}) as GraphCommandCoordination;
  graphCommandCoordinationBindings.set(coordination, {
    graphId,
    isolation,
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
  return (
    boundGraphCommandCoordination(port, coordination, graphId)?.isolation ??
    "unknown"
  );
}

/**
 * A match-key convergence must observe the winner after waiting for its graph
 * lock. Repeatable-read snapshots cannot do that; serializable can instead
 * force a database serialization retry. Adopted/custom transaction ports
 * without an audited isolation level fail closed for the same reason.
 */
export function assertGraphCommandConvergenceIsolation(
  port: GraphCommandPort,
  coordination: GraphCommandCoordination,
): void {
  const isolation =
    boundGraphCommandCoordination(port, coordination)?.isolation ?? "unknown";
  if (isolation === "read_committed" || isolation === "serializable") return;
  throw new ConfigurationError(
    "Match-key convergence requires read-committed or serializable transaction isolation.",
    {
      code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
      isolation,
    },
    {
      suggestion:
        "Use read_committed, retry a serializable transaction as a whole, or configure a custom PostgreSQL graph-write fence to report the effective transaction isolation.",
    },
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
