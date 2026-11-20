/**
 * The one idiom for standing up a server-PostgreSQL suite's connections.
 *
 * Every suite in this directory is gated on `POSTGRES_URL`
 * (`describe.runIf(process.env["POSTGRES_URL"])`), so the environment variable
 * has already answered "should this lane run?". Once it is set, a failure to
 * connect or migrate is a FAILURE of that lane — not a reason to skip it.
 *
 * These suites previously caught every setup error, logged it, and left
 * `isPostgresAvailable` false so each test skipped itself. The result was a
 * lane that exits 0 with every concurrency test skipped: a read-only server, a
 * missing extension, a migration that no longer applies, all reported as
 * success. That is silent coverage loss in exactly the suites whose whole
 * purpose is to catch a race no other lane can see.
 *
 * The single owner of the recovery, rather than five copies of a `try/catch`,
 * because five copies is how the previous shape came to differ in its logging
 * and its cleanup and would eventually come to differ in its verdict.
 */
import { type Pool } from "pg";

/**
 * Runs `setUp`, and on failure closes `pools` before rethrowing.
 *
 * The pools are closed explicitly rather than left to `afterAll`: a suite
 * publishes its module-level pool handles only once setup has fully succeeded,
 * so a pool that failed mid-setup is reachable from nowhere else and would keep
 * the worker's event loop alive after the failure.
 *
 * The original error is attached as `cause` — it is the diagnosis; the wrapper
 * only says which suite and why a skip was not an option.
 */
export async function runServerSuiteSetup(
  suiteName: string,
  pools: readonly Pool[],
  setUp: () => Promise<void>,
): Promise<void> {
  try {
    await setUp();
  } catch (error) {
    for (const pool of pools) {
      try {
        await pool.end();
      } catch {
        // A pool that will not close cannot make the setup failure below any
        // worse, and reporting it instead would bury the cause.
      }
    }
    throw new Error(
      `${suiteName}: PostgreSQL suite setup failed. POSTGRES_URL is set, so this lane must fail rather than skip — a green skip here reports a server the suite never reached as a pass.`,
      { cause: error },
    );
  }
}
