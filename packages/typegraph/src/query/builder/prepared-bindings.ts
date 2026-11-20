import { ConfigurationError } from "../../errors";
import type { QueryAst } from "../ast";
import type { DatabaseExpression } from "../expressions";
import { collectParameterMetadata } from "./prepared-query";

/** Parameter expressions reused by a query and its typed preparation boundary. */
export type PreparedParameterDeclaration = Readonly<
  Record<string, DatabaseExpression>
>;

export type PreparedBindings<Parameters extends PreparedParameterDeclaration> =
  {
    readonly [Name in keyof Parameters]: Parameters[Name] extends (
      DatabaseExpression<infer Value>
    ) ?
      Value
    : never;
  };

/** Refuses declarations that would promise different bindings from the SQL relation. */
export function validatePreparedBindingsDeclaration(
  parameters: PreparedParameterDeclaration,
  queries: readonly QueryAst[],
  expressions: readonly DatabaseExpression[] = [],
): void {
  const metadata = collectParameterMetadata(queries, expressions);
  const names = Object.keys(parameters);
  if (
    Object.getOwnPropertySymbols(parameters).length > 0 ||
    names.length !== metadata.names.size ||
    names.some((name) => !metadata.names.has(name))
  )
    throw new ConfigurationError(
      "Prepared parameter declarations must name every query parameter exactly once.",
    );

  for (const [name, expression] of Object.entries(parameters)) {
    if (expression.node.kind !== "parameter" || expression.node.name !== name)
      throw new ConfigurationError(
        `Prepared declaration "${name}" must contain the parameter expression with that name.`,
      );
    const expectedType = metadata.expressionParameterTypes.get(name);
    if (
      expectedType === undefined ||
      expectedType !== expression.valueType ||
      expression.nullable
    )
      throw new ConfigurationError(
        `Prepared declaration "${name}" must match its typed query parameter.`,
      );
    if (metadata.listParameters.has(name))
      throw new ConfigurationError(
        `Prepared declaration "${name}" cannot describe a legacy list parameter.`,
      );
  }
}
