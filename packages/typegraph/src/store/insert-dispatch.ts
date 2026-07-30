import {
  type EdgeRow,
  type GraphBackend,
  type InsertEdgeParams,
  type InsertNodeParams,
  type NodeRow,
  type TransactionBackend,
} from "../backend/types";
import { requireDefined } from "../utils/presence";

export type InsertDispatch<Params, Row> = Readonly<{
  one: (params: Params) => Promise<Row>;
  oneNoReturn?: ((params: Params) => Promise<void>) | undefined;
  batch?: ((params: readonly Params[]) => Promise<void>) | undefined;
  batchReturning?:
    ((params: readonly Params[]) => Promise<readonly Row[]>) | undefined;
}>;

type InsertBackend = GraphBackend | TransactionBackend;

export function nodeInsertDispatch(
  backend: InsertBackend,
): InsertDispatch<InsertNodeParams, NodeRow> {
  return {
    one: (params) => backend.insertNode(params),
    oneNoReturn:
      backend.insertNodeNoReturn === undefined ?
        undefined
      : (params) => requireDefined(backend.insertNodeNoReturn)(params),
    batch:
      backend.insertNodesBatch === undefined ?
        undefined
      : (params) => requireDefined(backend.insertNodesBatch)(params),
    batchReturning:
      backend.insertNodesBatchReturning === undefined ?
        undefined
      : (params) => requireDefined(backend.insertNodesBatchReturning)(params),
  };
}

export function edgeInsertDispatch(
  backend: InsertBackend,
): InsertDispatch<InsertEdgeParams, EdgeRow> {
  return {
    one: (params) => backend.insertEdge(params),
    oneNoReturn:
      backend.insertEdgeNoReturn === undefined ?
        undefined
      : (params) => requireDefined(backend.insertEdgeNoReturn)(params),
    batch:
      backend.insertEdgesBatch === undefined ?
        undefined
      : (params) => requireDefined(backend.insertEdgesBatch)(params),
    batchReturning:
      backend.insertEdgesBatchReturning === undefined ?
        undefined
      : (params) => requireDefined(backend.insertEdgesBatchReturning)(params),
  };
}

export async function runInsertNoReturn<Params, Row>(
  dispatch: InsertDispatch<Params, Row>,
  params: Params,
): Promise<void> {
  if (dispatch.oneNoReturn !== undefined) {
    await dispatch.oneNoReturn(params);
    return;
  }
  await dispatch.one(params);
}

export async function runInsertBatch<Params, Row>(
  dispatch: InsertDispatch<Params, Row>,
  params: readonly Params[],
): Promise<void> {
  if (params.length === 0) return;
  if (dispatch.batch !== undefined) {
    await dispatch.batch(params);
    return;
  }
  for (const insertParams of params) {
    await runInsertNoReturn(dispatch, insertParams);
  }
}

export async function runInsertBatchReturning<Params, Row>(
  dispatch: InsertDispatch<Params, Row>,
  params: readonly Params[],
): Promise<readonly Row[]> {
  if (params.length === 0) return [];
  if (dispatch.batchReturning !== undefined) {
    return dispatch.batchReturning(params);
  }
  const rows: Row[] = [];
  for (const insertParams of params) {
    rows.push(await dispatch.one(insertParams));
  }
  return rows;
}
