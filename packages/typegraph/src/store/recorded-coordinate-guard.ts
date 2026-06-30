import { ConfigurationError } from "../errors";

type RecordedCoordinateGuardOptions = Readonly<{
  code: string;
  message: string;
  context?: Readonly<Record<string, unknown>>;
  suggestion?: string;
}>;

type RecordedCoordinateOptions = Readonly<{ recordedAsOf?: unknown }>;

function hasOwnRecordedAsOf(
  options: unknown,
): options is RecordedCoordinateOptions {
  return (
    typeof options === "object" &&
    options !== null &&
    Object.hasOwn(options, "recordedAsOf")
  );
}

function ownRecordedAsOf(options: unknown): unknown {
  return hasOwnRecordedAsOf(options) ? options.recordedAsOf : undefined;
}

export function assertNoRecordedCoordinate(
  options: unknown,
  guard: RecordedCoordinateGuardOptions,
): void {
  const recordedAsOf = ownRecordedAsOf(options);
  if (recordedAsOf === undefined) return;

  throw new ConfigurationError(
    guard.message,
    {
      ...guard.context,
      code: guard.code,
      recordedAsOf,
    },
    guard.suggestion === undefined ?
      undefined
    : { suggestion: guard.suggestion },
  );
}
