/** Decodes a driver's bigint or digit-string revision column to a number; any other value passes through for the caller to validate. */
export function decodeRevisionColumn(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return value;
}
