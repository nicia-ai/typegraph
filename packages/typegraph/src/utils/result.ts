/**
 * Result type for error handling without exceptions.
 * Use at service boundaries and for operations that can fail.
 */
export type Result<T, E = Error> =
  Readonly<{ success: true; data: T }> | Readonly<{ success: false; error: E }>;

/**
 * Creates a successful result.
 */
export function ok<T = undefined>(data?: T): Result<T, never> {
  return { success: true, data: data as T };
}

/**
 * Creates a failed result.
 */
export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Unwraps a result, throwing if it's an error.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.success) {
    return result.data;
  }
  throw result.error;
}

/**
 * Unwraps a result or returns a default value.
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  if (result.success) {
    return result.data;
  }
  return defaultValue;
}

/**
 * Type guard to check if result is successful.
 *
 * Narrows to the `Readonly<{...}>` success arm so that an early-return on the
 * negative branch (`if (isErr(x)) return; x.data`) leaves the success arm
 * reachable — the union members are themselves `Readonly`, so a mutable
 * predicate target would subtract nothing and break narrowing for callers.
 */
export function isOk<T, E>(
  result: Result<T, E>,
): result is Readonly<{ success: true; data: T }> {
  return result.success;
}

/**
 * Type guard to check if result is an error. See {@link isOk} for why the
 * predicate narrows to the `Readonly<{...}>` arm.
 */
export function isErr<T, E>(
  result: Result<T, E>,
): result is Readonly<{ success: false; error: E }> {
  return !result.success;
}

/**
 * Transforms the success value of a result.
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (data: T) => U,
): Result<U, E> {
  if (result.success) return ok(fn(result.data));
  return result;
}

/**
 * Transforms the error value of a result.
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  if (result.success) return result;
  return err(fn(result.error));
}

/**
 * Chains an operation that returns a Result on the success value.
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (data: T) => Result<U, E>,
): Result<U, E> {
  if (result.success) return fn(result.data);
  return result;
}

/**
 * Recovers from an error by producing an alternative Result.
 */
export function orElse<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => Result<T, F>,
): Result<T, F> {
  if (result.success) return result;
  return fn(result.error);
}
