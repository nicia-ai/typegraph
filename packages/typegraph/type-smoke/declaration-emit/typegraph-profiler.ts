/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/profiler` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";

export const profiler = new QueryProfiler();
export const report = () => profiler.getReport();
export const attach = (...args: Parameters<QueryProfiler["attachToStore"]>) =>
  profiler.attachToStore(...args);
