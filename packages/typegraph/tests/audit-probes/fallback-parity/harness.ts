import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import {
  type GraphBackend,
  type GraphCommand,
  type GraphCommandResult,
  type TransactionBackend,
} from "../../../src/backend/types";

type ClaimMembers = Readonly<{
  claimEdgeCardinality?: unknown;
  claimEdgeCardinalityGuarded?: unknown;
  claimEdgeCardinalityBatch?: unknown;
  purgeEdgeClaims?: unknown;
  hardDeleteUniquesByConcreteKind?: unknown;
}>;

function stripClaimMembers<T extends object>(target: T): T {
  return projectBackendWithout(target as T & ClaimMembers, [
    "claimEdgeCardinality",
    "claimEdgeCardinalityGuarded",
    "claimEdgeCardinalityBatch",
    "purgeEdgeClaims",
    "hardDeleteUniquesByConcreteKind",
  ]) as T;
}

/** A transactional backend that declares no claim relations at all. */
export function withoutClaimSupport(backend: GraphBackend): GraphBackend {
  return deriveBackend(stripClaimMembers(backend), {
    capabilities: { ...backend.capabilities, constraintClaims: false },
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(stripClaimMembers(target), {
              capabilities: {
                ...target.capabilities,
                constraintClaims: false,
              },
            }),
          ),
        options,
      ),
  });
}

function unsupportedFor(command: GraphCommand): GraphCommandResult {
  switch (command.kind) {
    case "node.create": {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions: ["claims"],
      };
    }
    case "edge.create": {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["cardinalityClaim", "endpointPredicate"],
      };
    }
    case "edge.converge-create": {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["convergence", "endpointPredicate"],
      };
    }
  }
}

/** A custom command port that answers `unsupported` to every command. */
export function withUnsupportedCommands(
  backend: GraphBackend,
  respond: (command: GraphCommand) => GraphCommandResult = unsupportedFor,
): GraphBackend {
  const decorate = (target: TransactionBackend): TransactionBackend =>
    deriveBackend(target, {
      commands: {
        session: target.commands.session,
        execute: (command) => Promise.resolve(respond(command)),
      },
    });
  return deriveBackend(backend, {
    transaction: (run, options) =>
      backend.transaction((target) => run(decorate(target)), options),
  });
}

/** Drops named members from the root backend and from every transaction target. */
export function withoutMembers(
  backend: GraphBackend,
  omitted: readonly string[],
): GraphBackend {
  const strip = <T extends object>(target: T): T =>
    projectBackendWithout(target, omitted as never[]) as T;
  return deriveBackend(strip(backend), {
    transaction: (run, options) =>
      backend.transaction((target) => run(strip(target)), options),
  });
}
