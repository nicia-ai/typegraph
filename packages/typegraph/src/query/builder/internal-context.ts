/**
 * Module-private builder context used by StoreView and recorded-time reads.
 *
 * These values are real query-builder mechanics, but not public builder API:
 * callers should pin coordinates through Store/StoreView and bind recorded
 * reads through Store options. A WeakMap keeps the public QueryBuilderConfig
 * free of internal-only fields while preserving clone-by-config behavior.
 */
import { type ReadCoordinate } from "../../core/temporal";
import { type RecordedReadBinding } from "../compiler/schema";
import { type QueryBuilderConfig } from "./types";

export type QueryBuilderInternalContext = Readonly<{
  recordedReadBinding?: RecordedReadBinding | undefined;
  sealedCoordinate?: ReadCoordinate | undefined;
}>;

const contexts = new WeakMap<QueryBuilderConfig, QueryBuilderInternalContext>();

export function registerQueryBuilderInternalContext(
  config: QueryBuilderConfig,
  context: QueryBuilderInternalContext,
): void {
  if (
    context.recordedReadBinding === undefined &&
    context.sealedCoordinate === undefined
  ) {
    return;
  }
  contexts.set(config, context);
}

export function getQueryBuilderInternalContext(
  config: QueryBuilderConfig,
): QueryBuilderInternalContext {
  return contexts.get(config) ?? {};
}
