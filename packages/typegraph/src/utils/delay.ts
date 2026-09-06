/**
 * Resolves after `milliseconds`. Zero or negative resolves immediately,
 * without scheduling a timer.
 */
export function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
