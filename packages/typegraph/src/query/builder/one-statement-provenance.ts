import { ConfigurationError } from "../../errors";

export type OneStatementReadProvenance = Readonly<{
  graphId: string;
  executionTarget: object | undefined;
}>;

/** Owns graph/target compatibility for every set-operation construction path. */
export function assertCompatibleSetOperationProvenance(
  expected: OneStatementReadProvenance,
  candidate: OneStatementReadProvenance,
): void {
  if (candidate.graphId !== expected.graphId) {
    throw new ConfigurationError(
      "Set operations cannot combine queries from different graphs.",
      {
        expectedGraphId: expected.graphId,
        receivedGraphId: candidate.graphId,
      },
    );
  }
  if (
    expected.executionTarget !== undefined &&
    candidate.executionTarget !== undefined &&
    expected.executionTarget !== candidate.executionTarget
  ) {
    throw new ConfigurationError(
      "Set operations cannot combine queries from different execution targets.",
      { graphId: expected.graphId },
    );
  }
}
