import type { Result } from "../utils/result";

export { err, ok, type Result, unwrap } from "../utils/result";

export function isOk<T, E>(
  result: Result<T, E>,
): result is Readonly<{ success: true; data: T }> {
  return result.success;
}

export function isErr<T, E>(
  result: Result<T, E>,
): result is Readonly<{ success: false; error: E }> {
  return !result.success;
}
