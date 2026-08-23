import { CompilerInvariantError } from "../errors";
import type {
  GraphCommand,
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandPort,
  GraphCommandResult,
  GraphCommandSession,
} from "./types";

const graphCommandCoordinations = new WeakSet<object>();

export type {
  GraphCommandAuthority,
  GraphCommandCoordination,
  GraphCommandExecutionContext,
  GraphCommandExecutionFacts,
  GraphCommandResultCache,
  GraphCommandSession,
} from "./types";

/** Internal evidence mint used only by the graph-write lock owner. */
export function mintGraphCommandCoordination(): GraphCommandCoordination {
  const coordination = Object.freeze({}) as GraphCommandCoordination;
  graphCommandCoordinations.add(coordination);
  return coordination;
}

function isGraphCommandCoordination(
  value: unknown,
): value is GraphCommandCoordination {
  if (typeof value !== "object" || value === null) return false;
  return graphCommandCoordinations.has(value);
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
    return {
      session,
      atomicity: "single-statement",
      authority: "authoritative",
      resultCache: "bypass",
      coordination,
    };
  }
  return {
    session,
    atomicity: "transaction",
    authority: "authoritative",
    resultCache: "bypass",
    coordination,
  };
}

/**
 * Validate a context before it reaches a first-party executor. The helper
 * below always creates a valid value, while direct port callers use this same
 * assertion to keep the authority contract single-owned.
 */
export function assertGraphCommandExecutionContext(
  context: unknown,
): asserts context is GraphCommandExecutionContext {
  const facts =
    typeof context === "object" ?
      (context as Readonly<Record<string, unknown>>)
    : undefined;
  if (
    facts?.["authority"] !== "authoritative" ||
    facts["resultCache"] !== "bypass" ||
    (facts["coordination"] !== "none" &&
      !isGraphCommandCoordination(facts["coordination"])) ||
    !(
      (facts["session"] === "root" &&
        facts["atomicity"] === "single-statement" &&
        facts["coordination"] === "none") ||
      (facts["session"] === "transaction" &&
        facts["atomicity"] === "transaction")
    )
  ) {
    throw new CompilerInvariantError(
      "An authoritative graph command received an invalid execution context.",
      { context: facts },
    );
  }
}

/**
 * Execute a command through the explicit authoritative seam.
 *
 * Store write paths must use this helper; it is the ratchet that makes the
 * authority and cache policy visible at every first-party call site.
 */
export function executeAuthoritativeGraphCommand(
  port: GraphCommandPort,
  command: GraphCommand,
  coordination: "none" | GraphCommandCoordination = "none",
): Promise<GraphCommandResult> {
  const context = graphCommandExecutionContext(port.session, coordination);
  assertGraphCommandExecutionContext(context);
  return port.execute(command, context);
}
