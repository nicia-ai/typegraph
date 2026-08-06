import { type GraphBackend } from "../backend/types";
import { type GraphInterchangeChunk } from "./types";

const EXPORT_STREAM_BACKENDS = new WeakMap<
  AsyncIterable<GraphInterchangeChunk>,
  GraphBackend
>();

export function markExportStreamBackend(
  stream: AsyncIterable<GraphInterchangeChunk>,
  backend: GraphBackend,
): AsyncIterable<GraphInterchangeChunk> {
  EXPORT_STREAM_BACKENDS.set(stream, backend);
  return stream;
}

export function exportStreamBackend(
  stream: AsyncIterable<GraphInterchangeChunk>,
): GraphBackend | undefined {
  return EXPORT_STREAM_BACKENDS.get(stream);
}
