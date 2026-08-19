/**
 * Pure unit coverage for `collectPredecessorChain` (T7(c) replacement,
 * precedent: `iterative-graph-operation.test.ts`'s
 * `shouldRefreshWorkingTableStatistics` rows). No database: the seam is
 * exercised directly against a fake `readPredecessor` so the bound and
 * termination axes are testable independently of a real backend.
 *
 * `collectPredecessorChain` is UNREACHABLE past its bound through the
 * public API (`runWorkingTableRounds` raises `GraphAlgorithmConvergenceError`
 * before extraction unless the plan converged, and a converged plan has at
 * most `maxIterations - 1` hops), which is exactly why these rows exist:
 * the cross-backend fixtures in `weighted-shortest-path-extraction.ts`
 * cannot reach the over-bound and absent-row cases at all.
 */
import { describe, expect, it } from "vitest";

import type { PathNode } from "../src/store/algorithms/types";
import {
  collectPredecessorChain,
  type PredecessorChainRow,
} from "../src/store/algorithms/weighted-shortest-path";

/**
 * `predecessorId: undefined` stands in for a SQL NULL predecessor.
 * `PredecessorChainRow`'s columns are typed `unknown` specifically because
 * drivers deliver NULL in varying shapes (AGENTS.md bans `null` from
 * TypeGraph's own types), and `nodeIdentityFromRow`'s string-pair predicate
 * treats every non-string value — `undefined` included — identically.
 */
function chainRow(
  nodeId: string,
  predecessorId: string | undefined,
): PredecessorChainRow {
  return {
    node_id: nodeId,
    node_kind: "Person",
    distance: 0,
    hops: 0,
    predecessor_id: predecessorId,
    predecessor_kind: predecessorId === undefined ? undefined : "Person",
  };
}

describe("collectPredecessorChain", () => {
  it("stops at a NULL predecessor without issuing a read", async () => {
    const first = chainRow("source", undefined);
    let readCount = 0;
    const readPredecessor = (
      _predecessor: PathNode,
    ): Promise<PredecessorChainRow | undefined> => {
      readCount++;
      return Promise.resolve(undefined);
    };

    const chain = await collectPredecessorChain(first, readPredecessor, 10);

    expect(chain).toEqual([first]);
    expect(readCount).toBe(0);
  });

  it("truncates silently at the recursive CTE's hop bound", async () => {
    const first = chainRow("target", "predecessor-0");
    const maxIterations = 3;
    let issuedReads = 0;
    const readPredecessor = (
      predecessor: PathNode,
    ): Promise<PredecessorChainRow | undefined> => {
      issuedReads++;
      // Always returns another row with a non-null predecessor: the chain
      // never terminates on its own, so only the bound can stop the loop.
      return Promise.resolve(
        chainRow(predecessor.id, `${predecessor.id}-next`),
      );
    };

    const chain = await collectPredecessorChain(
      first,
      readPredecessor,
      maxIterations,
    );

    // maxIterations + 2: `first` plus one row per loop iteration
    // (`position` runs 0..=maxIterations inclusive, i.e. maxIterations + 1
    // iterations).
    expect(chain.length).toBe(maxIterations + 2);
    expect(issuedReads).toBe(maxIterations + 1);
  });

  it("stops when the predecessor row is absent", async () => {
    const first = chainRow("target", "middle");
    // The middle hop resolves to a real row (whose own predecessor is
    // "source"); the second hop's read then comes back empty, as a working
    // table's primary-key point read does when the row is gone.
    const middleRow = chainRow("middle", "source");
    const readPredecessor = (
      predecessor: PathNode,
    ): Promise<PredecessorChainRow | undefined> =>
      Promise.resolve(predecessor.id === "middle" ? middleRow : undefined);

    const chain = await collectPredecessorChain(first, readPredecessor, 10);

    expect(chain).toEqual([first, middleRow]);
  });
});
