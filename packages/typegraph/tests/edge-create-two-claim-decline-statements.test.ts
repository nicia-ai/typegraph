/**
 * A two-claim `edge.create` plan is refused by the bundled command port
 * before it runs any SQL, observed below the port.
 *
 * The shared decline harness (`backends/integration/edge-create-declines.ts`)
 * pins the port's `unsupported` answer and the unchanged rows on every lane;
 * rows cannot show a lock taken or a read issued before the refusal. Here
 * the write-shape recorder captures every statement the DRIVER is asked to
 * run (better-sqlite3, libSQL, PGlite — the PostgreSQL port is the same code
 * on every PostgreSQL driver), and the declined dispatch's transaction must
 * run exactly the statements an empty transaction runs: its own control
 * statements and nothing else. A one-claim-free plan in the same position
 * runs its INSERT, so the recorder demonstrably sees the port's statements.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../src";
import {
  type ClaimEdgeCardinalityParams,
  type EdgeCreateCommand,
  type GraphBackend,
  type InsertEdgeParams,
} from "../src/backend/types";
import {
  buildEdgeCreatePathGraph,
  ITEM,
  nextEdgeCreatePathGraphId,
  seedEdgeCreatePathGraph,
} from "./backends/integration/edge-create-path-fixture";
import {
  openWriteShapeEngine,
  renderWriteShape,
  WRITE_SHAPE_DRIVERS,
  type WriteShapeEngine,
} from "./helpers/write-shape-recorder";

/**
 * A transaction's own framing: the statements that open, settle or nest it,
 * and the driver exchanges (a libSQL client transaction) that frame it.
 */
const TRANSACTION_CONTROL =
  /^(?:sql (?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|libsql )/u;

/**
 * Every line `run` leaves in the trace that is neither transaction control
 * nor its settled outcome: what the engine was asked to do inside it.
 */
async function statementsInside(
  engine: WriteShapeEngine,
  run: () => Promise<unknown>,
): Promise<readonly string[]> {
  const capture = await engine.recorder.capture(async () => {
    await run();
    return "settled";
  });
  return renderWriteShape(capture, [])
    .filter((line) => !line.startsWith("=> "))
    .filter((line) => !line.startsWith("    "))
    .filter((line) => !TRANSACTION_CONTROL.test(line));
}

function edgeCreate(
  graphId: string,
  id: string,
  directions: readonly ("source" | "target")[],
): EdgeCreateCommand {
  const params: InsertEdgeParams = {
    graphId,
    id,
    kind: "mxBoth",
    fromKind: "MxItem",
    fromId: ITEM.c.id,
    toKind: "MxItem",
    toId: ITEM.d.id,
    props: { label: "x" },
  };
  const claims = directions.map((direction): ClaimEdgeCardinalityParams => ({
    graphId,
    direction,
    cardinality: "one",
    edgeKind: params.kind,
    edgeId: params.id,
    fromKind: params.fromKind,
    fromId: params.fromId,
    toKind: params.toKind,
    toId: params.toId,
  }));
  return {
    kind: "edge.create",
    plan: {
      entity: "edge",
      params,
      ...(claims.length === 0 ? {} : { cardinalityClaims: claims }),
    },
  };
}

function dispatchInTransaction(
  root: GraphBackend,
  command: EdgeCreateCommand,
): Promise<unknown> {
  return root.transaction((transaction) =>
    transaction.commands.execute(command, {
      session: "transaction",
      coordination: "none",
    }),
  );
}

describe("a two-claim edge.create plan, below the port", () => {
  let engine: WriteShapeEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it.each(WRITE_SHAPE_DRIVERS)(
    "%s: the declined dispatch runs no statement inside its transaction",
    async (driver) => {
      const opened = await openWriteShapeEngine(driver);
      engine = opened;
      const graphId = nextEdgeCreatePathGraphId("edge_create_two_claim");
      const [store] = await createStoreWithSchema(
        buildEdgeCreatePathGraph(graphId),
        opened.root,
      );
      await seedEdgeCreatePathGraph(store);

      const empty = await statementsInside(opened, () =>
        opened.root.transaction(() => Promise.resolve()),
      );
      let result: unknown;
      const declined = await statementsInside(opened, async () => {
        result = await dispatchInTransaction(
          opened.root,
          edgeCreate(graphId, "new", ["source", "target"]),
        );
      });
      expect(result).toEqual({
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["cardinalityClaim"],
      });
      expect(declined).toEqual(empty);

      const control = await statementsInside(opened, () =>
        dispatchInTransaction(opened.root, edgeCreate(graphId, "control", [])),
      );
      expect(
        control.filter((line) => line.startsWith('sql INSERT INTO "')),
      ).toHaveLength(1);
    },
  );
});
