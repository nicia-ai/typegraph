/**
 * The one idiom for a deterministic two-writer race on a server PostgreSQL
 * suite: hold-and-gate.
 *
 * The HOLDER runs its write inside a transaction and then parks on a gate,
 * keeping that transaction — and every lock its write took — open. The
 * CONTENDER starts its competing write on another pool. A probe connection
 * polls `pg_stat_activity` until the contender either settles on its own or is
 * observed waiting on a lock the holder's connection holds; only then does the
 * gate open and the holder commit.
 *
 * The interleaving is therefore forced, never hoped for: which writer wins is
 * fixed by construction, and whether the contender had to wait is itself an
 * observed fact a case can assert. A fence that is not taken shows up as a
 * contender that settles while the holder is still open — not as a race that
 * happens to pass. There is no sleep standing in for synchronization: the
 * poll interval only paces the probe, and the deadline turns a contender that
 * neither settles nor waits into a loud failure.
 *
 * Holder and contender are told apart by `application_name`, which each
 * suite sets per pool (see {@link poolApplicationName}).
 */
import { type Pool, type PoolConfig } from "pg";

import { requireDefined } from "../../../src/utils/presence";

/** How long the contender may take to either settle or park on a lock. */
const SETTLE_OR_BLOCK_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 10;

export type Outcome<T> = Readonly<
  { status: "ok"; value: T } | { status: "error"; error: unknown }
>;

/** Whether the contender settled on its own or parked on the holder's lock. */
export type ContenderState = "settled" | "blocked";

export type HeldRace<THolder, TContender> = Readonly<{
  contenderState: ContenderState;
  holder: Outcome<THolder>;
  contender: Outcome<TContender>;
}>;

/** A race reduced to what a case asserts in one `toEqual`. */
export type RaceSummary = Readonly<{
  contenderState: ContenderState;
  holder: string;
  contender: string;
}>;

type Gate = Readonly<{ promise: Promise<void>; open: () => void }>;

function createGate(): Gate {
  const handle: { open?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    handle.open = resolve;
  });
  return {
    promise,
    open: () => {
      requireDefined(handle.open)();
    },
  };
}

async function settle<T>(operation: Promise<T>): Promise<Outcome<T>> {
  try {
    return { status: "ok", value: await operation };
  } catch (error) {
    return { status: "error", error };
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pool options tagging every connection with `applicationName`, which is how
 * the probe tells the holder's and the contender's backends apart.
 */
export function poolApplicationName(
  applicationName: string,
): Pick<PoolConfig, "application_name"> {
  return { application_name: applicationName };
}

/**
 * Whether a backend of `contenderApplication` is waiting on a lock that a
 * backend of `holderApplication` holds. `pg_blocking_pids` names the actual
 * blocker, so a wait on anything else does not count as the race being
 * engaged.
 */
async function contenderIsBlockedByHolder(
  probe: Pool,
  contenderApplication: string,
  holderApplication: string,
): Promise<boolean> {
  const result = await probe.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_stat_activity AS waiter
       JOIN pg_stat_activity AS blocker
         ON blocker.pid = ANY (pg_blocking_pids(waiter.pid))
       WHERE waiter.datname = current_database()
         AND waiter.application_name = $1
         AND waiter.wait_event_type = 'Lock'
         AND blocker.application_name = $2
     ) AS blocked`,
    [contenderApplication, holderApplication],
  );
  return result.rows[0]?.blocked === true;
}

async function settledOrBlocked(
  probe: Pool,
  contenderApplication: string,
  holderApplication: string,
  contender: Promise<unknown>,
): Promise<ContenderState> {
  const state = { settled: false };
  void contender.then(() => {
    state.settled = true;
  });
  const deadline = Date.now() + SETTLE_OR_BLOCK_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (state.settled) return "settled";
    if (
      await contenderIsBlockedByHolder(
        probe,
        contenderApplication,
        holderApplication,
      )
    ) {
      return "blocked";
    }
    await pause(POLL_INTERVAL_MS);
  }
  throw new Error(
    `The contender (application_name ${contenderApplication}) neither settled nor waited on a lock held by ${holderApplication} within ${String(SETTLE_OR_BLOCK_DEADLINE_MS)}ms.`,
  );
}

/**
 * Runs `holder` until it calls `holdOpen()` — after its write, inside its
 * transaction — then starts `contender` and waits until the contender settles
 * or is observed blocked by the holder, and only then lets the holder's
 * transaction finish.
 *
 * Both writers are always awaited to completion before this returns or
 * throws, so no transaction outlives the case.
 */
export async function raceAgainstHeldTransaction<THolder, TContender>(
  options: Readonly<{
    probe: Pool;
    holderApplication: string;
    contenderApplication: string;
    holder: (holdOpen: () => Promise<void>) => Promise<THolder>;
    contender: () => Promise<TContender>;
  }>,
): Promise<HeldRace<THolder, TContender>> {
  const written = createGate();
  const release = createGate();
  const holder = settle(
    options.holder(() => {
      written.open();
      return release.promise;
    }),
  );
  await Promise.race([written.promise, holder]);
  const contender = settle(options.contender());
  const observation = await settle(
    settledOrBlocked(
      options.probe,
      options.contenderApplication,
      options.holderApplication,
      contender,
    ),
  );
  release.open();
  const holderOutcome = await holder;
  const contenderOutcome = await contender;
  if (observation.status === "error") throw observation.error;
  return {
    contenderState: observation.value,
    holder: holderOutcome,
    contender: contenderOutcome,
  };
}

function outcomeLabel(outcome: Outcome<unknown>): string {
  if (outcome.status === "ok") return "ok";
  return outcome.error instanceof Error ?
      outcome.error.name
    : String(outcome.error);
}

export function summarizeRace(race: HeldRace<unknown, unknown>): RaceSummary {
  return {
    contenderState: race.contenderState,
    holder: outcomeLabel(race.holder),
    contender: outcomeLabel(race.contender),
  };
}

/** The value of an outcome a case already asserted succeeded. */
export function requireValue<T>(outcome: Outcome<T>): T {
  if (outcome.status === "error") {
    throw new Error("Expected the write to succeed", { cause: outcome.error });
  }
  return outcome.value;
}

/** The error of an outcome a case already asserted failed. */
export function requireError(outcome: Outcome<unknown>): unknown {
  if (outcome.status === "ok") {
    throw new Error("Expected the write to fail, but it succeeded");
  }
  return outcome.error;
}
