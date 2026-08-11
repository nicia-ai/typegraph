import type { GraphBackend, TransactionBackend } from "../backend/types";
import type { KindEntity } from "../core/types";
import { ConfigurationError, ValidationError } from "../errors";

export type ValidityEndMutationInput = Readonly<{
  validTo?: string;
  clearValidTo?: true;
}>;

/** One owner for the mutually-exclusive validity-end write contract. */
export function assertValidityEndMutation(
  input: ValidityEndMutationInput,
  context: Readonly<{ entityType: KindEntity; kind: string; id?: string }>,
): void {
  if (input.validTo === undefined || input.clearValidTo !== true) return;
  throw new ValidationError(
    '"validTo" and "clearValidTo" are mutually exclusive',
    {
      ...context,
      operation: "update",
      issues: [
        {
          path: "clearValidTo",
          message: 'Pass either "validTo" or "clearValidTo", not both',
        },
      ],
    },
  );
}

/** The end a row will hold after applying this mutation. */
export function validityEndAfterMutation(
  input: ValidityEndMutationInput,
  current: string | undefined,
): string | undefined {
  if (input.clearValidTo === true) return undefined;
  return input.validTo ?? current;
}

/**
 * Custom backends explicitly opt in to clearing. The store refuses before
 * invoking a backend that has not promised to apply the new state.
 */
export function assertClearValidToSupported(
  backend: GraphBackend | TransactionBackend,
  entityType: KindEntity,
): void {
  if (backend.capabilities.clearValidTo === true) return;
  throw new ConfigurationError(
    `This backend does not support clearing ${entityType} validTo`,
    {
      code: "CLEAR_VALID_TO_UNSUPPORTED",
      entityType,
    },
  );
}
