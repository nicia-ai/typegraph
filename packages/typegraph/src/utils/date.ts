/**
 * Date encoding utilities for consistent storage.
 *
 * Contract: All dates are stored as ISO 8601 strings in UTC.
 * - Always includes milliseconds
 * - Always UTC (Z suffix)
 * - Sorts correctly as strings
 */

import { ValidationError } from "../errors";

/**
 * ISO 8601 datetime pattern.
 * Matches formats like:
 * - 2024-01-15T10:30:00.000Z
 * - 2024-01-15T10:30:00Z
 * - 2024-01-15T10:30:00.123Z
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Checks if a string is a valid ISO 8601 datetime.
 *
 * @param value - String to validate
 * @returns True if valid ISO 8601 datetime
 */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  // Also check that Date parsing produces a valid date
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

/**
 * Validates that a string is a valid ISO 8601 datetime.
 * Throws ValidationError if invalid.
 *
 * @param value - String to validate
 * @param fieldName - Name of field for error message
 * @returns The validated string
 * @throws ValidationError if not a valid ISO datetime
 */
export function validateIsoDate(value: string, fieldName: string): string {
  if (!isValidIsoDate(value)) {
    throw new ValidationError(
      `Invalid ISO 8601 datetime for "${fieldName}": "${value}". ` +
        `Expected format: YYYY-MM-DDTHH:mm:ss.sssZ`,
      {
        issues: [
          {
            path: fieldName,
            message: `Invalid ISO 8601 datetime format. Expected: YYYY-MM-DDTHH:mm:ss.sssZ, got: "${value}"`,
          },
        ],
      },
      {
        suggestion: `Use a valid ISO 8601 UTC datetime like "2024-01-15T10:30:00.000Z"`,
      },
    );
  }
  return value;
}

/**
 * Validates an optional ISO date string.
 * Returns undefined if value is undefined, otherwise validates.
 */
export function validateOptionalIsoDate(
  value: string | undefined,
  fieldName: string,
): string | undefined {
  if (value === undefined) return undefined;
  return validateIsoDate(value, fieldName);
}

/**
 * Encodes a Date to an ISO 8601 string for storage.
 */
export function encodeDate(date: Date): string {
  return date.toISOString();
}

/**
 * Decodes an ISO 8601 string to a Date.
 * Validates the string format first.
 *
 * @throws ValidationError if not a valid ISO datetime
 */
export function decodeDate(isoString: string): Date {
  validateIsoDate(isoString, "date");
  return new Date(isoString);
}

/**
 * Returns the current timestamp as an ISO string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
