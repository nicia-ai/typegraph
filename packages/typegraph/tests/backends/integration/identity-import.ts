import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { snapshotExportContention } from "../../../src/backend/transaction-resource";
import { type IdentityTransferAssertion } from "../../../src/identity/service";
import {
  exportGraph,
  exportGraphStream,
  importGraph,
  importGraphStream,
} from "../../../src/interchange";
import { storeBackend, storeRuntime } from "../../../src/store/runtime-port";
import { type Store } from "../../../src/store/store";
import {
  createTestBackend,
  expectAuditedBackend,
  matchingArray,
  matchingObject,
} from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

/**
 * Identity interchange parity.
 *
 * Identity import was covered only by SQLite-backed unit tests, yet its
 * correctness turns on values that cross the driver boundary: assertion
 * validity instants are compared as canonical ISO strings, while a driver may
 * hand back a `Date` (PostgreSQL) or a zoneless string depending on dialect. An
 * idempotent re-import, which decides "already imported" by comparing stored
 * `valid_from`/`valid_to` against the document, is the assertion that fails
 * first when canonicalization regresses on one backend.
 *
 * Source and target graphs are normally separate `graph_id`s on the same
 * per-test backend. The streaming snapshot case picks its target with
 * {@link createStreamingImportTarget}: same backend where the engine can write
 * while the export's snapshot transaction is open, an independent backend
 * where it cannot.
 */
const InterchangePerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const InterchangeAuthor = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

function identityInterchangeGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      Person: { type: InterchangePerson },
      Author: { type: InterchangeAuthor },
    },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });
}

const identityInterchangeSourceGraph = identityInterchangeGraph(
  "identity_interchange_source",
);
const identityInterchangeTargetGraph = identityInterchangeGraph(
  "identity_interchange_target",
);

const HOUR_MS = 60 * 60 * 1000;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Ref = Readonly<{ kind: string; id: string }>;

function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Orders endpoints by code point, as the interchange format requires. */
function orderPair(left: Ref, right: Ref): readonly [Ref, Ref] {
  const byKind =
    left.kind < right.kind ? -1
    : left.kind > right.kind ? 1
    : 0;
  const order =
    byKind === 0 ?
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0
    : byKind;
  return order <= 0 ? [left, right] : [right, left];
}

function transfer(
  id: string,
  first: Ref,
  second: Ref,
  validFrom: string,
  validTo?: string,
): IdentityTransferAssertion {
  const [a, b] = orderPair(first, second);
  return {
    id,
    relation: "same",
    a,
    b,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
  };
}

async function seedSource(context: IntegrationTestContext) {
  const store = await context.createStore(identityInterchangeSourceGraph);
  // `createStreamingImportTarget` below picks this suite's import target by
  // asking `snapshotExportContention`, which answers `undefined` both for a
  // genuinely independent backend and for one nobody audited — the same answer
  // for opposite situations. So the fixture states which one it is in: an
  // unaudited fixture would silently route every lane down the independent
  // branch and the suite would still be green.
  expectAuditedBackend(storeBackend(store));
  const alice = await store.nodes.Person.create(
    { name: "Alice" },
    { id: "alice" },
  );
  const author = await store.nodes.Author.create(
    { penName: "A." },
    { id: "author" },
  );
  const bob = await store.nodes.Person.create({ name: "Bob" }, { id: "bob" });
  return {
    store,
    alice,
    author,
    bob,
    // The identity read API takes graph-typed refs; the interchange format
    // speaks plain ones.
    aliceRef: { kind: "Person", id: alice.id } satisfies Ref,
    authorRef: { kind: "Author", id: author.id } satisfies Ref,
  };
}

/**
 * A store the suite's snapshot export can legally be streamed into.
 *
 * `importGraphStream` refuses a target that shares the source's SERIALIZED
 * database connection: the export's repeatable-read transaction holds that one
 * connection for its whole life, so the import could never take the writer
 * lock. That is true of SQLite and of PGlite (one in-process instance), and
 * `snapshotExportContention` — the same predicate the refusal itself consults —
 * is what says so.
 *
 * A pooled PostgreSQL backend is NOT serialized: the export transaction and
 * the import's writes take different connections from the pool. Those suites
 * therefore import into a second graph id on the SUITE'S OWN backend, so
 * PostgreSQL is exercised as the import TARGET. Unconditionally importing into
 * a fresh in-memory SQLite backend, as this used to, silently reduced every
 * backend's target coverage to SQLite.
 */
async function createStreamingImportTarget(
  context: IntegrationTestContext,
): Promise<Store<typeof identityInterchangeTargetGraph>> {
  const backend = context.getBackend();
  if (snapshotExportContention(backend, backend) === undefined) {
    return context.createStore(identityInterchangeTargetGraph);
  }
  const [target] = await createStoreWithSchema(
    identityInterchangeTargetGraph,
    createTestBackend(),
  );
  return target;
}

export function registerIdentityImportIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Operational Identity interchange", () => {
    it("round-trips state identity and re-imports it idempotently", async () => {
      const { store: source, alice, author, bob } = await seedSource(context);
      await source.identity.assertSame(alice, author);
      await source.identity.assertSame(alice, bob);

      const document = await exportGraph(source);
      expect(document.identity?.mode).toBe("state");
      expect(document.identity?.assertions).toHaveLength(2);

      const target = await context.createStore(identityInterchangeTargetGraph);
      const first = await importGraph(target, document, {
        onConflict: "skip",
      });
      expect(first.errors).toEqual([]);
      expect(first.identity).toEqual({ created: 2, skipped: 0 });
      expect(await target.identity.membersOf(alice)).toEqual(
        await source.identity.membersOf(alice),
      );

      // Re-import decides "already present" by comparing the stored validity
      // instants to the document as strings; a driver-shaped timestamp would
      // report a conflict or a spurious create here rather than a skip.
      const second = await importGraph(target, document, {
        onConflict: "skip",
      });
      expect(second.errors).toEqual([]);
      expect(second.identity).toEqual({ created: 0, skipped: 2 });
      await expect(
        storeRuntime(target).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("restores an archival export with byte-identical timestamps", async () => {
      const { store: source, alice, author, bob } = await seedSource(context);
      const retracted = await source.identity.assertSame(alice, author);
      await source.identity.retractAssertion(retracted.assertion.id);
      await source.identity.assertSame(alice, bob);

      const archive = await exportGraph(source, {
        identityMode: "archival",
        includeDeleted: true,
      });
      const assertions = archive.identity?.assertions ?? [];
      expect(assertions).toHaveLength(2);
      // One retracted (windowed) and one open row, every present instant in the
      // canonical millisecond-and-Z form regardless of what the driver returned.
      const instants = assertions.flatMap((assertion) => [
        assertion.validFrom,
        ...(assertion.validTo === undefined ? [] : [assertion.validTo]),
      ]);
      expect(instants).toHaveLength(3);
      for (const instant of instants) {
        expect(instant).toMatch(CANONICAL_TIMESTAMP_PATTERN);
      }

      const target = await context.createStore(identityInterchangeTargetGraph);
      const result = await importGraph(target, archive, {
        onConflict: "skip",
      });
      expect(result.errors).toEqual([]);
      expect(result.identity).toEqual({ created: 2, skipped: 0 });

      const restored = await exportGraph(target, {
        identityMode: "archival",
        includeDeleted: true,
      });
      expect(restored.identity).toEqual(archive.identity);
      expect(await target.identity.membersOf(alice)).toEqual(
        await source.identity.membersOf(alice),
      );
      await expect(
        storeRuntime(target).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("carries a cascade cause through an archival round-trip", async () => {
      // An archival export exists to preserve endings, and an ending is not
      // fully described by WHEN it happened: a merge treats a cascade and an
      // explicit retraction differently. Dropping the cause on export would
      // silently downgrade every cascade in the document to an explicit
      // retraction, so it travels with the row.
      const { store: source, alice, author, bob } = await seedSource(context);
      const cascaded = await source.identity.assertSame(alice, author);
      const explicit = await source.identity.assertSame(alice, bob);
      await source.identity.retractAssertion(explicit.assertion.id);
      await source.nodes.Author.delete(author.id);

      const archive = await exportGraph(source, {
        identityMode: "archival",
        includeDeleted: true,
      });
      const exported = archive.identity?.assertions ?? [];
      expect(
        exported.find((assertion) => assertion.id === cascaded.assertion.id)
          ?.endedBy,
      ).toEqual({ kind: "Author", id: "author" });
      expect(
        exported.find((assertion) => assertion.id === explicit.assertion.id)
          ?.endedBy,
      ).toBeUndefined();

      const target = await context.createStore(identityInterchangeTargetGraph);
      const result = await importGraph(target, archive, {
        onConflict: "skip",
      });
      expect(result.errors).toEqual([]);
      expect(result.identity).toEqual({ created: 2, skipped: 0 });

      const restored = await exportGraph(target, {
        identityMode: "archival",
        includeDeleted: true,
      });
      expect(restored.identity).toEqual(archive.identity);

      // A re-import still recognizes the row as already present, which it can
      // only do if the stored cause matches the document's.
      const again = await importGraph(target, archive, { onConflict: "skip" });
      expect(again.errors).toEqual([]);
      expect(again.identity).toEqual({ created: 0, skipped: 2 });
    });

    it("rejects an ending cause that no ending or endpoint supports", async () => {
      const {
        store: source,
        alice,
        aliceRef,
        authorRef,
      } = await seedSource(context);
      const bobRef: Ref = { kind: "Person", id: "bob" };

      // A cause without an ending describes nothing.
      await expect(
        storeRuntime(source).importIdentityAssertionsAtTarget(
          source.backend,
          [
            {
              ...transfer("open-cause", aliceRef, authorRef, isoAt(-HOUR_MS)),
              endedBy: aliceRef,
            },
          ],
          "archival",
        ),
      ).rejects.toMatchObject({
        name: "ValidationError",
        details: matchingObject({
          issues: matchingArray([
            expect.objectContaining({
              code: "IDENTITY_IMPORT_ENDED_BY_WITHOUT_END",
            }),
          ]),
        }),
      });

      // A cascade only ever ends assertions that TOUCH the deleted node, so a
      // cause naming a stranger describes an ending that cannot have happened.
      await expect(
        storeRuntime(source).importIdentityAssertionsAtTarget(
          source.backend,
          [
            {
              ...transfer(
                "stranger-cause",
                aliceRef,
                authorRef,
                isoAt(-HOUR_MS),
                isoAt(-HOUR_MS / 2),
              ),
              endedBy: bobRef,
            },
          ],
          "archival",
        ),
      ).rejects.toMatchObject({
        name: "ValidationError",
        details: matchingObject({
          issues: matchingArray([
            expect.objectContaining({
              code: "IDENTITY_IMPORT_ENDED_BY_NOT_ENDPOINT",
            }),
          ]),
        }),
      });

      expect(await source.identity.membersOf(alice)).toEqual([aliceRef]);
      await expect(
        storeRuntime(source).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("rejects an archival assertion that ends in the future", async () => {
      const {
        store: source,
        alice,
        aliceRef,
        authorRef,
      } = await seedSource(context);

      await expect(
        storeRuntime(source).importIdentityAssertionsAtTarget(
          source.backend,
          [
            transfer(
              "ends-later",
              aliceRef,
              authorRef,
              isoAt(-HOUR_MS),
              isoAt(HOUR_MS),
            ),
          ],
          "archival",
        ),
      ).rejects.toMatchObject({
        name: "ValidationError",
        details: matchingObject({
          issues: matchingArray([
            expect.objectContaining({
              code: "IDENTITY_IMPORT_FUTURE_VALID_TO",
            }),
          ]),
        }),
      });

      expect(await source.identity.membersOf(alice)).toEqual([aliceRef]);
      await expect(
        storeRuntime(source).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("rejects an open assertion dated in the future", async () => {
      const { store: source, aliceRef, authorRef } = await seedSource(context);

      await expect(
        storeRuntime(source).importIdentityAssertionsAtTarget(
          source.backend,
          [transfer("starts-later", aliceRef, authorRef, isoAt(HOUR_MS))],
          "archival",
        ),
      ).rejects.toMatchObject({
        name: "ValidationError",
        details: matchingObject({
          issues: matchingArray([
            expect.objectContaining({
              code: "IDENTITY_IMPORT_FUTURE_VALID_FROM",
            }),
          ]),
        }),
      });
    });

    it("rejects a negative validity window and accepts a zero-width one", async () => {
      const { store: source, aliceRef, authorRef } = await seedSource(context);
      const instant = isoAt(-HOUR_MS);

      await expect(
        storeRuntime(source).importIdentityAssertionsAtTarget(
          source.backend,
          [
            transfer(
              "negative",
              aliceRef,
              authorRef,
              isoAt(-HOUR_MS),
              isoAt(-2 * HOUR_MS),
            ),
          ],
          "archival",
        ),
      ).rejects.toMatchObject({
        name: "ValidationError",
        details: matchingObject({
          issues: matchingArray([
            expect.objectContaining({ code: "IDENTITY_IMPORT_INVALID_WINDOW" }),
          ]),
        }),
      });

      // A same-instant retraction emits exactly this window, so it must import.
      const summary = await storeRuntime(
        source,
      ).importIdentityAssertionsAtTarget(
        source.backend,
        [transfer("zero-width", aliceRef, authorRef, instant, instant)],
        "archival",
      );
      expect(summary).toEqual({ created: 1, skipped: 0 });
      await expect(
        storeRuntime(source).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("round-trips identity through the interchange stream", async () => {
      const { store: source, alice, author, bob } = await seedSource(context);
      await source.identity.assertSame(alice, author);
      await source.identity.assertSame(alice, bob);

      const target = await createStreamingImportTarget(context);
      const result = await importGraphStream(
        target,
        exportGraphStream(source, { includeTemporal: true, batchSize: 1 }),
        { onConflict: "error" },
      );

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.identity).toEqual({ created: 2, skipped: 0 });
      expect(await target.identity.membersOf(alice)).toEqual(
        await source.identity.membersOf(alice),
      );
      await expect(
        storeRuntime(target).validateIdentity(),
      ).resolves.toBeUndefined();
    });
  });
}
