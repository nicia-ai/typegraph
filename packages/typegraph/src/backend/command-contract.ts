import { CompilerInvariantError, ConfigurationError } from "../errors";
import type {
  GraphCommand,
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandPort,
  GraphCommandResult,
  GraphCommandSession,
} from "./types";

const graphCommandCoordinationBindings = new WeakMap<
  object,
  Readonly<{ graphId: string; sessionIdentity: object }>
>();
const graphCommandPortIsolations = new WeakMap<
  object,
  "read_committed" | "repeatable_read" | "serializable" | "unknown"
>();
const graphCommandPortSessionIdentities = new WeakMap<object, object>();

export type {
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandSession,
} from "./types";

/**
 * Retains a transaction command session's identity across a transparent port
 * wrapper. Coordination and isolation attach to the session identity, not the
 * wrapper object, so an observing/decorating backend cannot make a proven
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
): GraphCommandCoordination {
  const coordination = Object.freeze({}) as GraphCommandCoordination;
  graphCommandCoordinationBindings.set(coordination, {
    graphId,
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

/** Bind the effective isolation level to a transaction-scoped first-party port. */
export function bindGraphCommandPortIsolation(
  port: GraphCommandPort,
  isolation: "read_committed" | "repeatable_read" | "serializable" | "unknown",
): void {
  graphCommandPortIsolations.set(
    graphCommandPortSessionIdentity(port),
    isolation,
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
): void {
  if (port.session === "root") return;
  const isolation =
    graphCommandPortIsolations.get(graphCommandPortSessionIdentity(port)) ??
    "unknown";
  if (isolation === "read_committed" || isolation === "serializable") return;
  throw new ConfigurationError(
    "Match-key convergence requires read-committed or serializable transaction isolation.",
    {
      code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
      isolation,
    },
    {
      suggestion:
        "Use read_committed, retry a serializable transaction as a whole, or avoid getOrCreateByEndpoints in an adopted transaction whose isolation TypeGraph cannot inspect.",
    },
  );
}

/** Assert that a coordination token belongs to this port and command graph. */
export function assertGraphCommandCoordination(
  port: GraphCommandPort,
  command: GraphCommand,
  coordination: GraphCommandCoordination,
): void {
  const binding = graphCommandCoordinationBindings.get(coordination);
  if (
    binding?.sessionIdentity === graphCommandPortSessionIdentity(port) &&
    binding.graphId === command.plan.params.graphId
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

/**
 * Execute a command through the explicit authoritative seam.
 *
 * Store write paths must use this helper so session and coordination evidence
 * are explicit at every first-party call site.
 */
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: GraphCommand,
  coordination: "none" | GraphCommandCoordination = "none",
): Promise<GraphCommandResult> {
  const context = graphCommandExecutionContext(port.session, coordination);
  assertGraphCommandExecutionContext(context);
  if (coordination !== "none") {
    assertGraphCommandCoordination(port, command, coordination);
  }
  return port.execute(command, context);
}
