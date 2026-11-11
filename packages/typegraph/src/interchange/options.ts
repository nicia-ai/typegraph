import { type z } from "zod";

import { ConfigurationError } from "../errors";

/** The public interchange entry points whose options are parsed here. */
export type InterchangeOperation =
  "importGraph" | "importGraphStream" | "exportGraph" | "exportGraphStream";

/**
 * Parses one interchange entry point's options, refusing a key the entry
 * point does not declare rather than dropping it: a misspelled
 * `validateReferences` would otherwise import without the guard the caller
 * asked to keep. The declared keys are the schema's own shape, so the
 * refusal can never disagree with what the parse applies.
 *
 * @throws ConfigurationError `INTERCHANGE_OPTION_UNKNOWN`, `details.option`
 *   naming the first undeclared key
 */
export function parseInterchangeOptions<Shape extends z.ZodRawShape, Output>(
  operation: InterchangeOperation,
  schema: z.ZodType<Output> & Readonly<{ shape: Shape }>,
  options: object,
): Output {
  const declared = Object.keys(schema.shape);
  const option = Object.keys(options).find((key) => !declared.includes(key));
  if (option !== undefined) {
    throw new ConfigurationError(
      `${operation}() was given unknown option "${option}".`,
      { code: "INTERCHANGE_OPTION_UNKNOWN", operation, option },
      { suggestion: `Accepted options: ${declared.join(", ")}.` },
    );
  }
  return schema.parse(options);
}
