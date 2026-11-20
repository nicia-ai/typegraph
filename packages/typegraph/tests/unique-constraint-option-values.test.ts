/**
 * `defineGraph` writes the defaults into a unique constraint that leaves
 * `scope` or `collation` out, and refuses one that states either outside its
 * domain.
 *
 * The store reads any scope but `"kind"` as subclass-wide, so an omitted
 * scope has always been enforced across the subclass component. Writing that
 * default into the registration is what makes the serializer and the
 * stored-schema parser agree with it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  subClassOf,
  UniquenessError,
} from "../src";
import {
  COLLATION_VALUES,
  UNIQUENESS_SCOPE_VALUES,
} from "../src/core/unique-constraint-options";
import { createTestBackend } from "./test-utils";

const Account = defineNode("Account", {
  schema: z.object({ email: z.string() }),
});
const Admin = defineNode("Admin", {
  schema: z.object({ email: z.string() }),
});

type StatedDeclaration = Readonly<{
  name: "account_email";
  fields: readonly ["email"];
  scope: "kind";
  collation: "binary";
}>;

/**
 * An untyped caller's declaration, on `Account` and on its subclass `Admin`:
 * the types require both members.
 */
function graphDeclaring(members: Readonly<Record<string, unknown>>) {
  const unique = [
    { name: "account_email", fields: ["email"], ...members },
  ] as unknown as readonly StatedDeclaration[];
  return defineGraph({
    id: "unique_constraint_option_values",
    nodes: {
      Account: { type: Account, unique },
      Admin: { type: Admin, unique },
    },
    edges: {},
    ontology: [subClassOf(Admin, Account)],
  });
}

function refusalOf(members: Readonly<Record<string, unknown>>): unknown {
  try {
    graphDeclaring(members);
    return "accepted";
  } catch (error) {
    return error;
  }
}

const INVALID_STATEMENTS = [
  { option: "scope", value: "kindWithSubclasses" },
  { option: "scope", value: "Kind" },
  { option: "scope", value: true },
  // eslint-disable-next-line unicorn/no-null -- an untyped caller can state null
  { option: "scope", value: null },
  { option: "collation", value: "CaseInsensitive" },
  { option: "collation", value: "caseSensitive" },
  { option: "collation", value: 1 },
] as const;

describe("unique constraint option values", () => {
  it.each(INVALID_STATEMENTS)(
    "refuses $option: $value at defineGraph",
    ({ option, value }) => {
      const refusal = refusalOf({ [option]: value });

      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details).toEqual({
        code: "UNIQUE_CONSTRAINT_OPTION_INVALID",
        kind: "Account",
        constraintName: "account_email",
        option,
        value,
      });
    },
  );
  // MUTATION CHECK: dropping the `assertUniqueConstraintOptions` loop from
  // `withUniqueConstraintDefaultsWritten` accepts every statement here, and
  // each case fails.

  it.each([
    { members: {}, scope: "kindWithSubClasses", collation: "binary" },
    {
      members: { collation: "caseInsensitive" },
      scope: "kindWithSubClasses",
      collation: "caseInsensitive",
    },
    { members: { scope: "kind" }, scope: "kind", collation: "binary" },
  ] as const)(
    "writes the defaults into a declaration stating $members",
    ({ members, scope, collation }) => {
      const graph = graphDeclaring(members);

      expect(graph.nodes.Account.unique).toEqual([
        { name: "account_email", fields: ["email"], scope, collation },
      ]);
    },
  );

  it("enforces an omitted scope across the subclass component", async () => {
    const [store] = await createStoreWithSchema(
      graphDeclaring({}),
      createTestBackend(),
    );

    await store.nodes.Account.create({ email: "a@example.com" });
    await expect(
      store.nodes.Admin.create({ email: "a@example.com" }),
    ).rejects.toBeInstanceOf(UniquenessError);
  });
  // MUTATION CHECK: reading an omitted node scope as `"kind"` in
  // `NODE_UNIQUE_CONSTRAINT_DEFAULTS` accepts the `Admin` row, and this case
  // fails.

  it("keeps a graph whose declarations state both members as given", () => {
    for (const scope of UNIQUENESS_SCOPE_VALUES) {
      for (const collation of COLLATION_VALUES) {
        const registration = {
          type: Account,
          unique: [
            { name: "account_email", fields: ["email"], scope, collation },
          ],
        } as const;

        const graph = defineGraph({
          id: "unique_constraint_option_values_stated",
          nodes: { Account: registration },
          edges: {},
        });

        expect(graph.nodes.Account).toBe(registration);
      }
    }
  });
});
