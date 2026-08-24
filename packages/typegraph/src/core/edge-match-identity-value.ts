/** Whether one value can participate in a durable edge match identity. */
export function isPortableEdgeMatchIdentityValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
