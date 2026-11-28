/**
 * A refusal raised in JavaScript AFTER a write statement already ran leaves
 * that statement's rows behind when the caller catches the refusal and lets
 * its transaction commit.
 *
 * Each case below triggers one refusal inside `store.transaction()`, catches
 * it so the callback returns normally, and then reads the committed state from
 * outside the transaction. The correct state is the one with the refused call
 * fully undone: nothing it wrote survives. Where main still commits a partial
 * write, the case pins the exact state it commits today as a known defect
 * (`expectObservation`), so the fix that closes it has to flip the marker.
 *
 * The refusals are all decided by the library, not by the database, so no
 * statement fails and a PostgreSQL transaction is not aborted by them: the
 * commit goes through on every lane, and what it commits is the observation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  searchable,
  TypeGraphError,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import {
  type AdapterBackend,
  type BackendCapabilities,
  type TransactionBackend,
} from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import { uniquenessClaimAxis } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

/** Every lane: the hazards below are store-side orderings, not engine facts. */
const EVERY_DRIVER = {} as const;

/** What a call threw, reduced to its class and its specific code. */
function refusalOf(thrown: unknown): string {
  if (!(thrown instanceof Error)) return `resolved:${String(thrown)}`;
  if (thrown instanceof TypeGraphError) {
    const detailCode = thrown.details["code"];
    return typeof detailCode === "string" ?
        `${thrown.name}:${detailCode}`
      : `${thrown.name}:${thrown.code}`;
  }
  return `${thrown.name}:${thrown.message}`;
}

/** What a call threw, or `"resolved"` when it did not throw. */
async function settle(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/** The ids of `entities`, sorted, as plain strings. */
function sortedIds(
  entities: readonly Readonly<{ id: string }>[],
): readonly string[] {
  return entities.map((entity) => entity.id).toSorted();
}

// ============================================================
// Row 1: edge batch with a durable match identity
// ============================================================

const SbrPerson = defineNode("SbrPerson", {
  schema: z.object({ name: z.string() }),
});

const sbrKnows = defineEdge("sbrKnows", {
  schema: z.object({ label: z.string() }),
});

const durableBatchGraph = defineGraph({
  id: "statement_before_refusal_durable_batch",
  nodes: { SbrPerson: { type: SbrPerson } },
  edges: {
    sbrKnows: {
      type: sbrKnows,
      from: [SbrPerson],
      to: [SbrPerson],
      matchIdentity: { name: "sbr-knows-label", fields: ["label"] },
    },
  },
});

// ============================================================
// Row 2: bulkGetOrCreateByEndpoints, return mode, clearValidTo
// ============================================================

const sbrLink = defineEdge("sbrLink", { schema: z.object({}) });

const endpointGraph = defineGraph({
  id: "statement_before_refusal_endpoints",
  nodes: { SbrPerson: { type: SbrPerson } },
  edges: {
    sbrLink: { type: sbrLink, from: [SbrPerson], to: [SbrPerson] },
  },
});

// ============================================================
// Rows 3 and 6: own-kind uniqueness claimed after the node row
// ============================================================

const SBR_EMAIL_UNIQUE = {
  name: "sbr_member_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

const SbrMember = defineNode("SbrMember", {
  schema: z.object({ email: z.string() }),
});

const uniqueGraph = defineGraph({
  id: "statement_before_refusal_unique",
  nodes: { SbrMember: { type: SbrMember, unique: [SBR_EMAIL_UNIQUE] } },
  edges: {},
});

const uniqueRegistry = buildKindRegistry(uniqueGraph);

const SBR_EMAIL = "taken@statement-before-refusal.example";

/** The node id holding the email claim of `email`, read off the sidecar. */
async function emailClaimOwner(
  backend: GraphBackend,
  email: string,
): Promise<string | undefined> {
  const row = await backend.checkUnique({
    graphId: uniqueGraph.id,
    nodeKind: uniquenessClaimAxis(
      "SbrMember",
      SBR_EMAIL_UNIQUE.scope,
      uniqueRegistry,
    ),
    constraintName: SBR_EMAIL_UNIQUE.name,
    key: computeUniqueKey(
      { email },
      SBR_EMAIL_UNIQUE.fields,
      SBR_EMAIL_UNIQUE.collation,
    ),
    includeDeleted: false,
  });
  return row?.node_id;
}

/**
 * `backend`, whose transaction targets declare atomic node-insert claims and
 * carry a command port that answers `unsupported` to every `node.create` — a
 * custom port that cannot fuse the plan the store hands it. Every other
 * command reaches the real port.
 */
function backendRefusingNodeCreateCommands(
  backend: GraphBackend,
): GraphBackend {
  function refusing(target: TransactionBackend): TransactionBackend {
    const port = target.commands;
    return deriveBackend(target, {
      capabilities: { ...target.capabilities, atomicNodeInsertClaims: true },
      commands: {
        session: port.session,
        execute: (command, executionContext) =>
          command.kind === "node.create" ?
            Promise.resolve({
              outcome: "unsupported" as const,
              entity: "node" as const,
              dimensions: ["claims"] as const,
            })
          : port.execute(command, executionContext),
      },
    });
  }
  // Over a projection: the store's own backend object is frozen.
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction((target) => run(refusing(target)), options),
  });
}

const COMPETITOR_ID = "competitor";

/**
 * `backend`, whose transaction targets take the portable probe-then-insert
 * create path (no atomic node-insert claims) and, the first time a uniqueness
 * probe returns, write a competing node holding the probed email and its
 * claim — another writer landing between the probe and the insert. The probe
 * answers what it read before the competitor landed.
 */
function backendRacingTheProbe(backend: GraphBackend): GraphBackend {
  function racing(target: TransactionBackend): TransactionBackend {
    let raced = false;
    async function competitorLands(): Promise<void> {
      if (raced) return;
      raced = true;
      await target.insertNode({
        graphId: uniqueGraph.id,
        kind: "SbrMember",
        id: COMPETITOR_ID,
        props: { email: SBR_EMAIL },
      });
      await target.insertUnique({
        graphId: uniqueGraph.id,
        nodeKind: uniquenessClaimAxis(
          "SbrMember",
          SBR_EMAIL_UNIQUE.scope,
          uniqueRegistry,
        ),
        constraintName: SBR_EMAIL_UNIQUE.name,
        key: computeUniqueKey(
          { email: SBR_EMAIL },
          SBR_EMAIL_UNIQUE.fields,
          SBR_EMAIL_UNIQUE.collation,
        ),
        nodeId: COMPETITOR_ID,
        concreteKind: "SbrMember",
      });
    }
    const checkUniqueBatch = target.checkUniqueBatch;
    return deriveBackend(target, {
      capabilities: { ...target.capabilities, atomicNodeInsertClaims: false },
      checkUnique: async (params) => {
        const read = await target.checkUnique(params);
        await competitorLands();
        return read;
      },
      ...(checkUniqueBatch === undefined ?
        {}
      : {
          checkUniqueBatch: async (
            params: Parameters<typeof checkUniqueBatch>[0],
          ) => {
            const read = await checkUniqueBatch(params);
            await competitorLands();
            return read;
          },
        }),
    });
  }
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction((target) => run(racing(target)), options),
  });
}

const SBR_OLD_EMAIL = "old@statement-before-refusal.example";

/**
 * `backend`, whose transaction targets lack `hardDeleteUniquesByNodeIds` — a
 * custom transaction handle that implements less than the backend it came
 * from, which the root's uniqueness verdict does not see.
 */
function backendWithoutBatchedClaimDelete(backend: GraphBackend): GraphBackend {
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            projectBackendWithout(target, [
              "hardDeleteUniquesByNodeIds",
            ]) as TransactionBackend,
          ),
        options,
      ),
  });
}

// ============================================================
// Row 8: a set update's new key claimed between probe and reservation
// ============================================================

/** Unique on the pair, so one patch moves each member onto its own key. */
const SBR_RACED_UNIQUE = {
  name: "sbr_raced_member_email_region",
  fields: ["email", "region"],
  scope: "kind",
  collation: "binary",
} as const;

const SbrRacedMember = defineNode("SbrRacedMember", {
  schema: z.object({
    email: z.string(),
    region: z.string(),
    bio: searchable({ language: "english" }),
  }),
});

const racedUniqueGraph = defineGraph({
  id: "statement_before_refusal_raced_unique",
  nodes: {
    SbrRacedMember: { type: SbrRacedMember, unique: [SBR_RACED_UNIQUE] },
  },
  edges: {},
});

const racedUniqueRegistry = buildKindRegistry(racedUniqueGraph);

/** The claim row `(email, region)` keys under the raced constraint. */
function racedClaimTarget(email: string, region: string) {
  return {
    graphId: racedUniqueGraph.id,
    nodeKind: uniquenessClaimAxis(
      "SbrRacedMember",
      SBR_RACED_UNIQUE.scope,
      racedUniqueRegistry,
    ),
    constraintName: SBR_RACED_UNIQUE.name,
    key: computeUniqueKey(
      { email, region },
      SBR_RACED_UNIQUE.fields,
      SBR_RACED_UNIQUE.collation,
    ),
  } as const;
}

/** The node id holding the live claim of `(email, region)`. */
async function racedClaimOwner(
  backend: Pick<GraphBackend, "checkUnique">,
  email: string,
  region: string,
): Promise<string | undefined> {
  const row = await backend.checkUnique({
    ...racedClaimTarget(email, region),
    includeDeleted: false,
  });
  return row?.node_id;
}

const RACED_OLD_EMAIL = "old@raced.example";
const RACED_NEW_EMAIL = "new@raced.example";
const RACED_COMPETITOR_ID = "raced-competitor";

/**
 * `target`, which — the first time a batched uniqueness probe returns — writes
 * a competing node holding `(RACED_NEW_EMAIL, region)` and its claim: another
 * writer reserving one of the set's new keys after the set update's probe
 * found it free. The probe answers what it read before the competitor landed.
 */
function racingTheSetProbe(
  target: TransactionBackend,
  region: string,
): TransactionBackend {
  let raced = false;
  const checkUniqueBatch = requireDefined(target.checkUniqueBatch);
  return deriveBackend(target, {
    checkUniqueBatch: async (params) => {
      const read = await checkUniqueBatch(params);
      if (!raced) {
        raced = true;
        await target.insertNode({
          graphId: racedUniqueGraph.id,
          kind: "SbrRacedMember",
          id: RACED_COMPETITOR_ID,
          props: { email: RACED_NEW_EMAIL, region, bio: "competitor" },
        });
        await target.insertUnique({
          ...racedClaimTarget(RACED_NEW_EMAIL, region),
          nodeId: RACED_COMPETITOR_ID,
          concreteKind: "SbrRacedMember",
        });
      }
      return read;
    },
  });
}

/** `backend`, whose transaction targets are {@link racingTheSetProbe}'s. */
function backendRacingTheSetProbe(
  backend: GraphBackend,
  region: string,
): GraphBackend {
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction(
        (target) => run(racingTheSetProbe(target, region)),
        options,
      ),
  });
}

/**
 * The adapter backend `backend`, whose transaction targets — on both the
 * plain and the native-handle entry — are {@link racingTheSetProbe}'s: what a
 * history store is built over.
 */
function adapterRacingTheSetProbe<TNative>(
  backend: AdapterBackend<TNative>,
  region: string,
): AdapterBackend<TNative> {
  return deriveBackend(backend, {
    transaction: (run, options) =>
      backend.transaction(
        (target) => run(racingTheSetProbe(target, region)),
        options,
      ),
    transactionWithNative: (run, options) =>
      backend.transactionWithNative(
        (target, native) => run(racingTheSetProbe(target, region), native),
        options,
      ),
  });
}

// ============================================================
// A trigger that suppresses one row of the keyed write
// ============================================================

const SbrSuppressed = defineNode("SbrSuppressed", {
  schema: z.object({ status: z.string() }),
});

const suppressedGraph = defineGraph({
  id: "statement_before_refusal_suppressed",
  nodes: { SbrSuppressed: { type: SbrSuppressed } },
  edges: {},
});

/** The row the trigger below suppresses. */
const SUPPRESSED_ID = "suppressed";

/**
 * Installs a `BEFORE UPDATE` trigger that silently skips any UPDATE of the
 * node {@link SUPPRESSED_ID} in {@link suppressedGraph} — `RAISE(IGNORE)` on
 * SQLite, `RETURN NULL` on PostgreSQL — and lets every other row through.
 * Returns the teardown.
 */
async function installRowSuppressingTrigger(
  backend: Pick<GraphBackend, "dialect" | "executeDdl" | "tableNames">,
): Promise<() => Promise<void>> {
  const executeDdl = requireDefined(backend.executeDdl);
  const nodesTable = `"${requireDefined(backend.tableNames).nodes}"`;
  const graphLiteral = `'${suppressedGraph.id}'`;
  const idLiteral = `'${SUPPRESSED_ID}'`;
  if (backend.dialect === "postgres") {
    await executeDdl(
      `CREATE FUNCTION tg_suppress_fn() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.id = ${idLiteral} THEN
           RETURN NULL;
         END IF;
         RETURN NEW;
       END $$`,
    );
    await executeDdl(
      `CREATE TRIGGER tg_suppress BEFORE UPDATE ON ${nodesTable}
       FOR EACH ROW WHEN (OLD.graph_id = ${graphLiteral})
       EXECUTE FUNCTION tg_suppress_fn()`,
    );
    return async () => {
      await executeDdl(`DROP TRIGGER tg_suppress ON ${nodesTable}`);
      await executeDdl(`DROP FUNCTION tg_suppress_fn()`);
    };
  }
  await executeDdl(
    `CREATE TRIGGER tg_suppress BEFORE UPDATE ON ${nodesTable}
     WHEN OLD.graph_id = ${graphLiteral} AND OLD.id = ${idLiteral}
     BEGIN
       SELECT RAISE(IGNORE);
     END`,
  );
  return async () => {
    await executeDdl(`DROP TRIGGER tg_suppress`);
  };
}

// ============================================================
// Row 4: windowed bulk identity assertions
// ============================================================

const SbrIdentityPerson = defineNode("SbrIdentityPerson", {
  schema: z.object({ name: z.string() }),
});

const identityGraph = defineGraph({
  id: "statement_before_refusal_identity",
  nodes: { SbrIdentityPerson: { type: SbrIdentityPerson } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

// ============================================================
// Row 5: searchable() fields on a backend whose fulltext is off
// ============================================================

const SbrDocument = defineNode("SbrDocument", {
  schema: z.object({ title: searchable(), status: z.string() }),
});

const fulltextOffGraph = defineGraph({
  id: "statement_before_refusal_fulltext_off",
  nodes: { SbrDocument: { type: SbrDocument } },
  edges: {},
});

/** `capabilities` with no fulltext declaration: what `fulltext: false` reports. */
function withoutFulltext(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  const { fulltext: _declared, ...remaining } = capabilities;
  return remaining;
}

/**
 * `backend` reporting no fulltext capability, on the root and on every
 * transaction target — the store-visible shape of a backend built with
 * `fulltext: false`.
 */
function backendWithFulltextOff(backend: GraphBackend): GraphBackend {
  return deriveBackend(projectGraphBackend(backend), {
    capabilities: withoutFulltext(backend.capabilities),
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              capabilities: withoutFulltext(target.capabilities),
            }),
          ),
        options,
      ),
  });
}

export function registerStatementBeforeRefusalIntegrationTests(
  context: IntegrationTestContext,
): void {
  const lane = { driver: context.driver };

  describe("a refusal raised after a write statement leaves nothing behind", () => {
    for (const method of ["bulkCreate", "bulkInsert"] as const) {
      it(`${method} with a durable match identity commits no row of a batch one member of which conflicts`, async () => {
        const store = await context.createStore(durableBatchGraph);
        const from = await store.nodes.SbrPerson.create(
          { name: "From" },
          { id: "from" },
        );
        const to = await store.nodes.SbrPerson.create(
          { name: "To" },
          { id: "to" },
        );
        await store.edges.sbrKnows.create(
          from,
          to,
          { label: "same" },
          { id: "incumbent" },
        );

        const outcome = await store.transactionWithReceipt(async (tx) =>
          settle(
            tx.edges.sbrKnows[method]([
              { id: "fresh", from, to, props: { label: "fresh" } },
              { id: "duplicate", from, to, props: { label: "same" } },
            ]),
          ),
        );

        const stored = await store.edges.sbrKnows.find();
        expectObservation({
          lane,
          observed: {
            refusal: refusalOf(outcome.result),
            receiptEdges: outcome.receipt.writes.total,
            edges: sortedIds(stored),
          },
          correct: {
            refusal:
              "EdgeMatchIdentityConflictError:EDGE_MATCH_IDENTITY_CONFLICT",
            receiptEdges: 0,
            edges: ["incumbent"],
          },
          defects: [
            {
              label: "audit:set-update-refusal-1",
              on: EVERY_DRIVER,
              today: {
                refusal:
                  "EdgeMatchIdentityConflictError:EDGE_MATCH_IDENTITY_CONFLICT",
                receiptEdges: 0,
                edges: ["fresh", "incumbent"],
              },
            },
          ],
        });
      });
    }

    it("bulkGetOrCreateByEndpoints refusing clearValidTo under ifExists: return commits none of its creates", async () => {
      const store = await context.createStore(endpointGraph);
      const alpha = await store.nodes.SbrPerson.create(
        { name: "Alpha" },
        { id: "alpha" },
      );
      const beta = await store.nodes.SbrPerson.create(
        { name: "Beta" },
        { id: "beta" },
      );
      const gamma = await store.nodes.SbrPerson.create(
        { name: "Gamma" },
        { id: "gamma" },
      );
      await store.edges.sbrLink.create(alpha, beta, {}, { id: "live" });

      const outcome = await store.transactionWithReceipt(async (tx) =>
        settle(
          tx.edges.sbrLink.bulkGetOrCreateByEndpoints(
            [
              { from: alpha, to: gamma, props: {} },
              { from: alpha, to: beta, props: {}, clearValidTo: true },
            ],
            { ifExists: "return" },
          ),
        ),
      );

      const stored = await store.edges.sbrLink.find();
      expectObservation({
        lane,
        observed: {
          refusal: refusalOf(outcome.result),
          receiptTotal: outcome.receipt.writes.total,
          endpoints: stored
            .map((edge) => `${edge.fromId}->${edge.toId}`)
            .toSorted(),
        },
        correct: {
          refusal: "ConfigurationError:CLEAR_VALID_TO_REQUIRES_UPDATE",
          receiptTotal: 0,
          endpoints: ["alpha->beta"],
        },
        defects: [
          {
            label: "audit:set-update-refusal-2",
            on: EVERY_DRIVER,
            today: {
              refusal: "ConfigurationError:CLEAR_VALID_TO_REQUIRES_UPDATE",
              receiptTotal: 0,
              endpoints: ["alpha->beta", "alpha->gamma"],
            },
          },
        ],
      });
    });

    it("a create whose custom command port answers unsupported commits no row when its uniqueness claim refuses", async () => {
      const store = await context.createStore(uniqueGraph);
      await store.nodes.SbrMember.create(
        { email: SBR_EMAIL },
        { id: "incumbent" },
      );
      const portableStore = createStore(
        uniqueGraph,
        backendRefusingNodeCreateCommands(store.backend),
      );

      const thrown = await portableStore.transaction(async (tx) =>
        settle(
          tx.nodes.SbrMember.create({ email: SBR_EMAIL }, { id: "refused" }),
        ),
      );

      const stored = await store.nodes.SbrMember.find();
      expectObservation({
        lane,
        observed: {
          refusal: refusalOf(thrown),
          members: sortedIds(stored),
          claimOwner: await emailClaimOwner(store.backend, SBR_EMAIL),
        },
        correct: {
          refusal: "UniquenessError:UNIQUENESS_VIOLATION",
          members: ["incumbent"],
          claimOwner: "incumbent",
        },
        defects: [
          {
            label: "audit:set-update-refusal-3",
            on: EVERY_DRIVER,
            today: {
              refusal: "UniquenessError:UNIQUENESS_VIOLATION",
              members: ["incumbent", "refused"],
              claimOwner: "incumbent",
            },
          },
        ],
      });
    });

    describe.for(["bulkAssertSame", "bulkAssertDifferent"] as const)(
      "%s with validity windows",
      (verb) => {
        it("commits no earlier pair's assertion when a later pair refuses", async () => {
          const store = await context.createStore(identityGraph);
          const endpointStart = "2019-01-01T00:00:00.000Z";
          const people = await store.nodes.SbrIdentityPerson.bulkCreate(
            ["first", "second", "third"].map((id) => ({
              id,
              props: { name: id },
              validFrom: endpointStart,
            })),
          );
          const first = requireDefined(people[0]);
          const second = requireDefined(people[1]);
          const third = requireDefined(people[2]);

          const thrown = await store.transaction(async (tx) =>
            settle(
              tx.identity[verb]([
                {
                  a: first,
                  b: second,
                  validFrom: "2020-01-01T00:00:00.000Z",
                },
                {
                  a: third,
                  b: { kind: "SbrIdentityPerson", id: "absent" },
                  validFrom: "2020-01-01T00:00:00.000Z",
                },
              ]),
            ),
          );

          expect(thrown).toBeInstanceOf(Error);
          const assertions = await store.identity.assertionsOf(first);
          expectObservation({
            lane,
            observed: {
              refused: thrown instanceof TypeGraphError,
              assertionsOfFirst: assertions.map(
                (assertion) =>
                  `${assertion.relation}:${assertion.a.id}~${assertion.b.id}`,
              ),
            },
            correct: { refused: true, assertionsOfFirst: [] },
            defects: [
              {
                label: "audit:set-update-refusal-4",
                on: EVERY_DRIVER,
                today: {
                  refused: true,
                  assertionsOfFirst: [
                    `${verb === "bulkAssertSame" ? "same" : "different"}:first~second`,
                  ],
                },
              },
            ],
          });
        });
      },
    );

    it("a create on a fulltext-off backend refusing its searchable() field commits no row", async () => {
      const store = await context.createStore(fulltextOffGraph);
      const fulltextOffStore = createStore(
        fulltextOffGraph,
        backendWithFulltextOff(store.backend),
      );

      const thrown = await fulltextOffStore.transaction(async (tx) =>
        settle(
          tx.nodes.SbrDocument.create(
            { title: "giraffe", status: "draft" },
            { id: "refused" },
          ),
        ),
      );

      const stored = await store.nodes.SbrDocument.find();
      expectObservation({
        lane,
        observed: {
          refusal: refusalOf(thrown),
          documents: sortedIds(stored),
        },
        correct: {
          refusal:
            "UnsupportedBackendCapabilityError:UNSUPPORTED_BACKEND_CAPABILITY",
          documents: [],
        },
        defects: [
          {
            label: "audit:set-update-refusal-5",
            on: EVERY_DRIVER,
            today: {
              refusal:
                "UnsupportedBackendCapabilityError:UNSUPPORTED_BACKEND_CAPABILITY",
              documents: ["refused"],
            },
          },
        ],
      });
    });

    it("an update on a fulltext-off backend refusing its searchable() field commits no change", async () => {
      const store = await context.createStore(fulltextOffGraph);
      const seeded = await store.nodes.SbrDocument.create(
        { title: "giraffe", status: "draft" },
        { id: "seeded" },
      );
      const fulltextOffStore = createStore(
        fulltextOffGraph,
        backendWithFulltextOff(store.backend),
      );

      const thrown = await fulltextOffStore.transaction(async (tx) =>
        settle(
          tx.nodes.SbrDocument.update(seeded.id, {
            title: "zebra",
            status: "published",
          }),
        ),
      );

      const stored = requireDefined(
        await store.nodes.SbrDocument.getById(seeded.id),
      );
      expectObservation({
        lane,
        observed: {
          refusal: refusalOf(thrown),
          title: stored.title,
          status: stored.status,
          version: stored.meta.version,
        },
        correct: {
          refusal:
            "UnsupportedBackendCapabilityError:UNSUPPORTED_BACKEND_CAPABILITY",
          title: "giraffe",
          status: "draft",
          version: seeded.meta.version,
        },
        defects: [
          {
            label: "audit:set-update-refusal-5",
            on: EVERY_DRIVER,
            today: {
              refusal:
                "UnsupportedBackendCapabilityError:UNSUPPORTED_BACKEND_CAPABILITY",
              title: "zebra",
              status: "published",
              version: seeded.meta.version + 1,
            },
          },
        ],
      });
    });

    it("a create whose uniqueness key another writer takes between probe and insert commits no row", async () => {
      const store = await context.createStore(uniqueGraph);
      const racedStore = createStore(
        uniqueGraph,
        backendRacingTheProbe(store.backend),
      );

      const thrown = await racedStore.transaction(async (tx) =>
        settle(
          tx.nodes.SbrMember.create({ email: SBR_EMAIL }, { id: "refused" }),
        ),
      );

      const stored = await store.nodes.SbrMember.find();
      expectObservation({
        lane,
        observed: {
          refusal: refusalOf(thrown),
          members: sortedIds(stored),
          claimOwner: await emailClaimOwner(store.backend, SBR_EMAIL),
        },
        correct: {
          refusal: "UniquenessError:UNIQUENESS_VIOLATION",
          members: [COMPETITOR_ID],
          claimOwner: COMPETITOR_ID,
        },
        defects: [
          {
            label: "audit:set-update-refusal-6",
            on: EVERY_DRIVER,
            today: {
              refusal: "UniquenessError:UNIQUENESS_VIOLATION",
              members: [COMPETITOR_ID, "refused"],
              claimOwner: COMPETITOR_ID,
            },
          },
        ],
      });
    });
    // Row 8. The probe finds both new keys free; a competing writer then
    // reserves one of them. The set update reserves its new keys before it
    // writes a row, so the conflict is raised by that reservation, with no row
    // written, and the reservation it did take for the other member is given
    // back.
    describe.for(["updateWhere", "compareAndSet"] as const)(
      "%s: a new key another writer reserves after the set update's probe",
      (verb) => {
        it("commits no row, claim, sidecar or receipt entry", async (ctx) => {
          const store = await context.createStore(racedUniqueGraph);
          if (store.backend.capabilities.fulltext?.supported !== true) {
            ctx.skip();
          }
          const east = await store.nodes.SbrRacedMember.create(
            { email: RACED_OLD_EMAIL, region: "east", bio: "giraffe" },
            { id: "east" },
          );
          const west = await store.nodes.SbrRacedMember.create(
            { email: RACED_OLD_EMAIL, region: "west", bio: "giraffe" },
            { id: "west" },
          );
          const racedStore = createStore(
            racedUniqueGraph,
            backendRacingTheSetProbe(store.backend, "west"),
          );

          const outcome = await racedStore.transactionWithReceipt(async (tx) =>
            settle(
              verb === "updateWhere" ?
                tx.nodes.SbrRacedMember.updateWhere({
                  patch: { email: RACED_NEW_EMAIL, bio: "zebra" },
                  where: (candidate) => candidate.email.eq(RACED_OLD_EMAIL),
                })
              : tx.nodes.SbrRacedMember.compareAndSet(west.id, {
                  expected: { email: RACED_OLD_EMAIL },
                  patch: { email: RACED_NEW_EMAIL, bio: "zebra" },
                }),
            ),
          );

          async function hits(query: string): Promise<readonly string[]> {
            const results = await store.search.fulltext("SbrRacedMember", {
              query,
              limit: 10,
            });
            return results.map((hit) => hit.node.id).toSorted();
          }
          const storedEast = requireDefined(
            await store.nodes.SbrRacedMember.getById(east.id),
          );
          const storedWest = requireDefined(
            await store.nodes.SbrRacedMember.getById(west.id),
          );
          expect({
            refusal: refusalOf(outcome.result),
            receiptTotal: outcome.receipt.writes.total,
            rows: [
              [storedEast.email, storedEast.bio, storedEast.meta.version],
              [storedWest.email, storedWest.bio, storedWest.meta.version],
            ],
            claims: {
              eastOld: await racedClaimOwner(
                store.backend,
                RACED_OLD_EMAIL,
                "east",
              ),
              westOld: await racedClaimOwner(
                store.backend,
                RACED_OLD_EMAIL,
                "west",
              ),
              eastNew: await racedClaimOwner(
                store.backend,
                RACED_NEW_EMAIL,
                "east",
              ),
              westNew: await racedClaimOwner(
                store.backend,
                RACED_NEW_EMAIL,
                "west",
              ),
            },
            oldTermHits: await hits("giraffe"),
            newTermHits: await hits("zebra"),
          }).toEqual({
            refusal: "UniquenessError:UNIQUENESS_VIOLATION",
            receiptTotal: 0,
            rows: [
              [RACED_OLD_EMAIL, "giraffe", east.meta.version],
              [RACED_OLD_EMAIL, "giraffe", west.meta.version],
            ],
            claims: {
              eastOld: east.id,
              westOld: west.id,
              eastNew: undefined,
              westNew: RACED_COMPETITOR_ID,
            },
            oldTermHits: [east.id, west.id],
            newTermHits: [],
          });
        });

        it("leaves the recorded history of a history store unchanged", async () => {
          const store = await context.createHistoryStore(racedUniqueGraph);
          const west = await store.nodes.SbrRacedMember.create(
            { email: RACED_OLD_EMAIL, region: "west", bio: "giraffe" },
            { id: "west" },
          );
          const [racedStore] = await createAdapterStoreWithSchema(
            racedUniqueGraph,
            adapterRacingTheSetProbe(context.getBackend(), "west"),
            { history: true },
          );
          const beforeRefusal = requireDefined(await store.recordedNow());

          const thrown = await racedStore.transaction(async (tx) =>
            settle(
              verb === "updateWhere" ?
                tx.nodes.SbrRacedMember.updateWhere({
                  patch: { email: RACED_NEW_EMAIL },
                  where: (candidate) => candidate.id.eq(west.id),
                })
              : tx.nodes.SbrRacedMember.compareAndSet(west.id, {
                  expected: { email: RACED_OLD_EMAIL },
                  patch: { email: RACED_NEW_EMAIL },
                }),
            ),
          );

          const afterCommit = requireDefined(await store.recordedNow());
          const recorded = requireDefined(
            await store
              .asOfRecorded(afterCommit)
              .nodes.SbrRacedMember.getById(west.id),
          );
          // The competitor's raw insert records nothing either: it bypasses
          // the capture overlay, so the recorded clock may advance only if the
          // refused update recorded something.
          expect({
            refusal: refusalOf(thrown),
            recordedAdvanced: afterCommit !== beforeRefusal,
            recorded: [recorded.email, recorded.meta.version],
            westOld: await racedClaimOwner(
              store.backend,
              RACED_OLD_EMAIL,
              "west",
            ),
          }).toEqual({
            refusal: "UniquenessError:UNIQUENESS_VIOLATION",
            recordedAdvanced: false,
            recorded: [RACED_OLD_EMAIL, west.meta.version],
            westOld: west.id,
          });
        });
      },
    );

    // Row 9. The transaction handle implements less than the root its
    // uniqueness verdict was resolved from. Every claim member the set update
    // calls is bound off that handle before the dry-run, so the refusal comes
    // with nothing written.
    it("a set update on a transaction without the batched claim delete refuses before it writes", async () => {
      const store = await context.createStore(uniqueGraph);
      const renamed = await store.nodes.SbrMember.create(
        { email: SBR_OLD_EMAIL },
        { id: "renamed" },
      );
      const narrowedStore = createStore(
        uniqueGraph,
        backendWithoutBatchedClaimDelete(store.backend),
      );

      const outcome = await narrowedStore.transactionWithReceipt(async (tx) =>
        settle(
          tx.nodes.SbrMember.updateWhere({
            patch: { email: SBR_EMAIL },
            where: (candidate) => candidate.id.eq(renamed.id),
          }),
        ),
      );

      const stored = requireDefined(
        await store.nodes.SbrMember.getById(renamed.id),
      );
      expect({
        refusal: refusalOf(outcome.result),
        receiptTotal: outcome.receipt.writes.total,
        email: stored.email,
        version: stored.meta.version,
        oldClaimOwner: await emailClaimOwner(store.backend, SBR_OLD_EMAIL),
        newClaimOwner: await emailClaimOwner(store.backend, SBR_EMAIL),
      }).toEqual({
        refusal: "ConfigurationError:SET_UPDATE_UNIQUENESS_UNSUPPORTED",
        receiptTotal: 0,
        email: SBR_OLD_EMAIL,
        version: renamed.meta.version,
        oldClaimOwner: renamed.id,
        newClaimOwner: undefined,
      });
    });
    // A trigger that suppresses a row the keyed write counted cuts the write
    // short after the other rows of the set changed: the count runs before
    // the UPDATE, and nothing in the statement can undo rows it already
    // wrote. The Store refuses the short result, but a caller that catches
    // the refusal and commits keeps the rows that changed, with their
    // sidecars not rebuilt. Owned by a separate design (the engine-ended
    // short-write class); pinned here at what it commits today.
    it("a set update whose keyed write a trigger cuts short commits no change", async () => {
      const store = await context.createStore(suppressedGraph);
      await store.nodes.SbrSuppressed.create(
        { status: "draft" },
        { id: SUPPRESSED_ID },
      );
      await store.nodes.SbrSuppressed.create(
        { status: "draft" },
        { id: "written" },
      );
      const dropTrigger = await installRowSuppressingTrigger(store.backend);
      try {
        const thrown = await store.transaction(async (tx) =>
          settle(
            tx.nodes.SbrSuppressed.updateWhere({
              patch: { status: "published" },
              where: (candidate) => candidate.status.eq("draft"),
            }),
          ),
        );
        const stored = await store.nodes.SbrSuppressed.find();
        expectObservation({
          lane,
          observed: {
            refused: thrown !== "resolved",
            rows: stored
              .map((row) => [row.id, row.status, row.meta.version])
              .toSorted(),
          },
          correct: {
            refused: true,
            rows: [
              [SUPPRESSED_ID, "draft", 1],
              ["written", "draft", 1],
            ],
          },
          defects: [
            {
              label: "set-update short write after rows changed",
              on: EVERY_DRIVER,
              today: {
                refused: true,
                rows: [
                  [SUPPRESSED_ID, "draft", 1],
                  ["written", "published", 2],
                ],
              },
            },
          ],
        });
      } finally {
        await dropTrigger();
      }
    });
  });
}
