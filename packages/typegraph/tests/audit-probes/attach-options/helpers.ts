import { TypeGraphError } from "../../../src";

export async function outcomeOf(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

export function isTypedRefusal(outcome: unknown): boolean {
  return outcome instanceof TypeGraphError;
}
