import { CompilerInvariantError } from "../errors";
import type {
  EdgeConvergeCreateCommand,
  EdgeConvergeCreateCommandResult,
  EdgeCreateCommand,
  EdgeCreateCommandResult,
  GraphCommand,
  GraphCommandResult,
  NodeCreateCommand,
  NodeCreateCommandResult,
} from "./types";

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
    const { row } = result;
    const { params } = command.plan;
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
