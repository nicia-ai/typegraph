/**
 * Adversarial correctness check for IS2's top-10 selection, independent of
 * cross-engine consensus. Every engine agreeing is not proof of correctness
 * — this lane has already shipped two bugs (the friend-workload bug, the
 * lexicographic-vs-numeric tie-break bug) that every engine shared
 * identically, which is exactly why row-count and even early digest parity
 * didn't catch them (see reports/snb-lane1-results.md's IS2 saga).
 *
 * The committed smoke fixture's dedicated tie-cluster person
 * (dataset/smoke-fixture-constants.ts) authors comments spanning
 * TIE_CLUSTER_LOW_BLOCK (3-digit ids) and TIE_CLUSTER_HIGH_BLOCK (4-digit
 * ids), all sharing one creationDate and replying to the same post — with
 * no other tie-breaking signal but ascending message id, that person's
 * exact correct IS2 answer (the 10 numerically smallest message ids
 * across both blocks, in ascending order) is known in advance. The two
 * different digit widths matter: a single contiguous range of same-length
 * ids would make unpadded lexicographic order and numeric order coincide
 * by construction, so this check would pass whether or not
 * dataset/ldbc-csv.ts's zero-padding fix is actually applied. This checks
 * each doctor-runnable engine's actual result against the true numeric
 * answer directly, not against the other engines.
 *
 * Usage: tsx src/real/verify-is2-tie-break.ts [--engines=a,b,c]
 */
import { parseSnbCliOptions } from "./cli";
import { messageId, personId } from "./dataset/ldbc-csv";
import { resolveDatasetRoot } from "./dataset/resolve";
import {
  TIE_CLUSTER_MESSAGE_IDS,
  TIE_CLUSTER_PERSON_ID,
} from "./dataset/smoke-fixture-constants";
import { createLadybugEngine } from "./engines/ladybug";
import { createNeo4jEngine } from "./engines/neo4j";
import { createPgGraphEngine } from "./engines/pggraph";
import { createTypegraphPostgresEngine } from "./engines/typegraph-postgres";
import { createTypegraphSqliteEngine } from "./engines/typegraph-sqlite";
import { type SnbEngineFactory } from "./engines/types";
import { runDoctor, type SnbEngineName } from "./harness/doctor";

const ENGINE_FACTORIES: Readonly<Record<SnbEngineName, SnbEngineFactory>> = {
  "typegraph-sqlite": createTypegraphSqliteEngine,
  "typegraph-postgres": createTypegraphPostgresEngine,
  neo4j: createNeo4jEngine,
  ladybugdb: createLadybugEngine,
  pggraph: createPgGraphEngine,
};

// The true answer, derived numerically from the full candidate set — not
// assumed from a contiguous range — so this stays correct regardless of
// how the two blocks are shaped.
const EXPECTED_TOP_10 = [...TIE_CLUSTER_MESSAGE_IDS]
  .sort((left, right) => left - right)
  .slice(0, 10)
  .map((id) => messageId(String(id)));

/** IS2's digest is `JSON.stringify` of its canonical rows (see canonicalDigest) — decoding it back out is the only way to inspect which messages an engine actually picked, without adding a raw-rows accessor to the engine API just for this check. */
function messageIdsFromDigest(digest: string): readonly string[] {
  const rows = JSON.parse(digest) as readonly { messageId: string }[];
  return rows.map((row) => row.messageId);
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseSnbCliOptions(argv);
  const datasetRoot = await resolveDatasetRoot("smoke", options.dataDir);
  const doctorResult = await runDoctor({ engines: options.engines });
  const engineNames = options.engines.filter(
    (name) => doctorResult.runnable[name],
  );

  if (engineNames.length === 0) {
    console.log(
      "No requested engines are runnable on this machine — nothing to " +
        "check (expected in CI without Docker/optional packages).",
    );
    return;
  }

  const personIdArg = personId(String(TIE_CLUSTER_PERSON_ID));
  const mismatches: string[] = [];

  for (const engineName of engineNames) {
    const factory = ENGINE_FACTORIES[engineName];
    const handle = await factory({
      datasetRoot,
      log: (message) => console.log(`[${engineName}] ${message}`),
    });
    try {
      await handle.load();
      const result = await handle.queries.IS2(personIdArg);
      const actualTop10 = messageIdsFromDigest(result.digest);
      const matches =
        actualTop10.length === EXPECTED_TOP_10.length &&
        actualTop10.every((id, index) => id === EXPECTED_TOP_10[index]);
      if (matches) {
        console.log(`  [PASS] ${engineName}: matched the known-correct top 10`);
      } else {
        mismatches.push(
          `${engineName}: expected [${EXPECTED_TOP_10.join(", ")}], got [${actualTop10.join(", ")}]`,
        );
        console.error(`  [FAIL] ${engineName}: top-10 mismatch`);
      }
    } finally {
      await handle.close();
    }
  }

  if (mismatches.length > 0) {
    console.error("\nIS2 tie-break oracle mismatches:");
    for (const mismatch of mismatches) {
      console.error(`  ${mismatch}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nAll ${engineNames.length} runnable engine(s) matched the known-correct IS2 answer for the tie-cluster person.`,
  );
}

await main(process.argv.slice(2));
