/**
 * Query Execution Module
 *
 * Provides utilities for executing queries, mapping results,
 * and handling pagination/streaming.
 */

// Result mapping
export {
  buildSelectableNode,
  buildSelectContext,
  mapResults,
  transformPathColumns,
} from "./result-mapper";

// Pagination and streaming
export {
  adjustOrderByForDirection,
  buildCursorFromContext,
  buildCursorPredicate,
  buildPaginatedResult,
  createStreamIterable,
  getStreamBatchSize,
  parsePaginateOptions,
  validateCursor,
} from "./pagination";

// Field tracking for smart select optimization
export {
  buildSelectiveFields,
  createTrackingContext,
  FieldAccessTracker,
} from "./field-tracker";
export {
  mapSelectiveResults,
  MissingSelectiveFieldError,
} from "./selective-result-mapper";

// Value decoding for selective projections
export { decodeSelectedValue, nullToUndefined } from "./value-decoder";
