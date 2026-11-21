/**
 * A command-port decorator that declines edge command dimensions on demand.
 *
 * A command port may answer `unsupported` for any dimension of `edge.create`
 * (`cardinalityClaim`, `endpointPredicate`, `schemaFence`) or of
 * `edge.converge-create` (`convergence`, `endpointPredicate`), having run no
 * SQL, and the Store must then reach a correct outcome some other way. This
 * decorator replaces the command port of a backend — the root's and that of
 * every transaction the backend opens — with one that asks a
 * {@link DispatchPolicy} what to do with each edge command: decline it, pass
 * it to the real port, or plant rows on the dispatch's own session first and
 * then pass it. A declined dispatch never reaches the real port.
 *
 * The decorated backend is built with `deriveBackend` only, never a spread,
 * so it carries the source's resource audit and fence marks. Note that it is
 * therefore a DERIVED root: the bundled-root autocommit path, which only an
 * exact first-party root takes, is out of its reach, and every root write
 * through it runs in a store-opened transaction.
 *
 * Used by the shared decline harness (`backends/integration/
 * edge-create-declines.ts`) and by the edge-create path golden's declining
 * receivers (`edge-create-path-golden-scenarios.ts`).
 */
import { type GraphBackend } from "../../src";
import { deriveBackend } from "../../src/backend/derive-backend";
import {
  type EdgeConvergeCreateCommand,
  type EdgeCreateCommand,
  type GraphCommandPort,
  type GraphCommandResult,
  type TransactionBackend,
} from "../../src/backend/types";

export type EdgeDeclineDimension =
  "schemaFence" | "cardinalityClaim" | "endpointPredicate" | "convergence";

type EdgeCommand = EdgeCreateCommand | EdgeConvergeCreateCommand;

type EdgeCommandKind = EdgeCommand["kind"];

/**
 * What the decorator does with one edge command dispatch: pass it to the
 * real port, answer `unsupported` with `decline` instead, or run `plant` on
 * the dispatch's own session and then pass it.
 */
export type DispatchStep =
  | "pass"
  | Readonly<{
      decline: readonly [EdgeDeclineDimension, ...EdgeDeclineDimension[]];
    }>
  | Readonly<{
      plant: (backend: GraphBackend | TransactionBackend) => Promise<void>;
    }>;

/** Decides each edge command dispatch; `ordinal` counts dispatches of its kind. */
export type DispatchPolicy = (
  command: EdgeCommand,
  ordinal: number,
) => DispatchStep;

export function decline(
  ...dimensions: readonly [EdgeDeclineDimension, ...EdgeDeclineDimension[]]
): DispatchStep {
  return { decline: dimensions };
}

/** One line naming an edge command dispatch: session, kind and plan shape. */
function describeDispatch(
  command: EdgeCommand,
  session: GraphCommandPort["session"],
): string {
  const claims = command.plan.cardinalityClaims?.length ?? 0;
  const fence = command.plan.schemaFence === undefined ? "" : " +schemaFence";
  const match =
    command.kind === "edge.converge-create" ?
      ` match=${command.match.kind}`
    : "";
  return `${session} ${command.kind} claims=${claims}${fence}${match}`;
}

function isEdgeCommand(
  command: Parameters<GraphCommandPort["execute"]>[0],
): command is EdgeCommand {
  return command.kind !== "node.create";
}

export type DecliningBackend = Readonly<{
  backend: GraphBackend;
  /** One line per edge command dispatch, in dispatch order. */
  dispatches: readonly string[];
}>;

/**
 * `base` with every command port replaced by one that follows `policy`.
 * `onDispatch` receives each dispatch's line as it settles.
 */
export function decliningCommandBackend(
  base: GraphBackend,
  policy: DispatchPolicy,
  onDispatch?: (line: string) => void,
): DecliningBackend {
  const dispatches: string[] = [];
  const ordinals: Record<EdgeCommandKind, number> = {
    "edge.create": 0,
    "edge.converge-create": 0,
  };
  const settle = (line: string): void => {
    dispatches.push(line);
    onDispatch?.(line);
  };
  function decorate(
    port: GraphCommandPort,
    owner: GraphBackend | TransactionBackend,
  ): GraphCommandPort {
    return {
      session: port.session,
      execute: async (command, executionContext) => {
        if (!isEdgeCommand(command)) {
          return port.execute(command, executionContext);
        }
        const ordinal = ordinals[command.kind];
        ordinals[command.kind] = ordinal + 1;
        const step = policy(command, ordinal);
        const line = describeDispatch(command, port.session);
        if (step !== "pass" && "decline" in step) {
          settle(`port ${line} -> declined ${step.decline.join(",")}`);
          // The dimension tuple is the caller's to keep honest per command
          // kind: a decline names what this command could not apply.
          return {
            outcome: "unsupported",
            entity: "edge",
            dimensions: step.decline,
          } as unknown as GraphCommandResult;
        }
        const planted = step !== "pass";
        if (planted) await step.plant(owner);
        const result = await port.execute(command, executionContext);
        settle(
          `port ${line} -> ${planted ? "planted, then " : ""}${result.outcome}`,
        );
        return result;
      },
    };
  }
  const backend = deriveBackend(base, {
    commands: decorate(base.commands, base),
    transaction: <T>(
      fn: (transaction: TransactionBackend) => Promise<T>,
      options?: Parameters<GraphBackend["transaction"]>[1],
    ): Promise<T> =>
      base.transaction(
        (transaction) =>
          fn(
            deriveBackend(transaction, {
              commands: decorate(transaction.commands, transaction),
            }),
          ),
        options,
      ),
  });
  return { backend, dispatches };
}

/**
 * Steps per edge command kind, each consumed by the next dispatch of that
 * kind; a dispatch with no step left passes.
 */
export type DispatchScript = Readonly<
  Partial<Record<EdgeCommandKind, readonly DispatchStep[]>>
>;

export type ScriptedPolicy = Readonly<{
  policy: DispatchPolicy;
  /**
   * The steps no dispatch consumed, as `<kind> #<n>`: a script cannot
   * silently miss a command the Store never sent.
   */
  unconsumed: () => readonly string[];
}>;

export function scriptedPolicy(script: DispatchScript): ScriptedPolicy {
  const consumed: Record<EdgeCommandKind, number> = {
    "edge.create": 0,
    "edge.converge-create": 0,
  };
  return {
    policy: (command, ordinal) => {
      consumed[command.kind] = ordinal + 1;
      return script[command.kind]?.[ordinal] ?? "pass";
    },
    unconsumed: () =>
      (["edge.create", "edge.converge-create"] as const).flatMap((kind) =>
        (script[kind] ?? [])
          .slice(consumed[kind])
          .map((_step, index) => `${kind} #${consumed[kind] + index}`),
      ),
  };
}
