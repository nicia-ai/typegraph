import { IdentityValidityWindowError } from "../errors";
import { compareCodePoints } from "../utils/compare";
import { validateOptionalCanonicalIsoDate } from "../utils/date";
import { type IdentityValidityWindow } from "./types";

export type ResolvedIdentityValidityWindow = Readonly<{
  validFrom: string;
  validTo?: string;
  effective: "current" | "historical" | "empty";
}>;

/** Whether a caller stated either bound, as opposed to passing an empty object. */
export function hasExplicitIdentityValidityWindow(
  window: IdentityValidityWindow | undefined,
): boolean {
  return window?.validFrom !== undefined || window?.validTo !== undefined;
}

/**
 * Validates, defaults, and classifies one identity assertion window against the
 * operation's single captured clock. Every writer and replay path shares this
 * owner so acceptance and current-state materialization cannot drift.
 */
export function resolveIdentityValidityWindow(
  window: IdentityValidityWindow | undefined,
  operationInstant: string,
): ResolvedIdentityValidityWindow {
  const validFrom =
    validateOptionalCanonicalIsoDate(window?.validFrom, "validFrom") ??
    operationInstant;
  const validTo = validateOptionalCanonicalIsoDate(window?.validTo, "validTo");
  if (compareCodePoints(validFrom, operationInstant) > 0) {
    throw new IdentityValidityWindowError({
      reason: "future-valid-from",
      validFrom,
      ...(validTo === undefined ? {} : { validTo }),
      operationInstant,
    });
  }
  if (
    validTo !== undefined &&
    compareCodePoints(validTo, operationInstant) > 0
  ) {
    throw new IdentityValidityWindowError({
      reason: "future-valid-to",
      validFrom,
      validTo,
      operationInstant,
    });
  }
  if (validTo !== undefined && compareCodePoints(validTo, validFrom) < 0) {
    throw new IdentityValidityWindowError({
      reason: "inverted",
      validFrom,
      validTo,
      operationInstant,
    });
  }
  const effective =
    validTo === validFrom ? "empty"
    : validTo === undefined ? "current"
    : "historical";
  return {
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    effective,
  };
}
