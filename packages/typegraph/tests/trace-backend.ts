/**
 * Backend tracing and fault-injection overlays for contract tests.
 *
 * `createTracingBackend` records every backend method invocation — root
 * calls by method name, transaction-scoped calls with a `tx.` prefix, and
 * transaction boundaries as `transaction:begin` / `:commit` / `:rollback` —
 * so tests can assert WHERE work happens ("the found path opens no
 * transaction", "every sidecar write runs inside a transaction") instead of
 * only what the final state looks like.
 *
 * `createCommitFailingBackend` runs the callback normally and then throws at
 * the commit boundary, producing a real rollback — the shape of a
 * SQLITE_BUSY-at-commit or a Postgres serialization abort. Contract: hooks
 * must report such an operation through `onError`, never `onOperationEnd`.
 */
import type {
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../src/backend/types";

type MethodRecorder = (name: string) => void;

function wrapCallable(
  value: unknown,
  self: object,
  record: () => void,
): unknown {
  if (typeof value !== "function") return value;
  const callable = value as (...args: readonly unknown[]) => unknown;
  return (...args: readonly unknown[]): unknown => {
    record();
    return Reflect.apply(callable, self, args);
  };
}

function traceProxy<T extends object>(
  target: T,
  prefix: string,
  record: MethodRecorder,
): T {
  return new Proxy(target, {
    get(inner, property, receiver): unknown {
      const value: unknown = Reflect.get(inner, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }

      if (property === "transaction") {
        const transaction = value as GraphBackend["transaction"];
        const tracedTransaction: GraphBackend["transaction"] = async <R>(
          fn: (tx: TransactionBackend) => Promise<R>,
          options: TransactionOptions | undefined,
        ): Promise<R> => {
          record(`${prefix}transaction:begin`);
          try {
            const result = await transaction(
              (tx) => fn(traceProxy(tx, "tx.", record)),
              options,
            );
            record(`${prefix}transaction:commit`);
            return result;
          } catch (error: unknown) {
            record(`${prefix}transaction:rollback`);
            throw error;
          }
        };
        return tracedTransaction;
      }

      return wrapCallable(value, inner, () => {
        record(`${prefix}${property}`);
      });
    },
  });
}

export function createTracingBackend(target: GraphBackend): Readonly<{
  backend: GraphBackend;
  calls: string[];
  reset: () => void;
}> {
  const calls: string[] = [];
  const backend = traceProxy(target, "", (name) => {
    calls.push(name);
  });
  return {
    backend,
    calls,
    reset() {
      calls.length = 0;
    },
  };
}

export class InjectedCommitFailure extends Error {
  constructor() {
    super("injected commit failure");
    this.name = "InjectedCommitFailure";
  }
}

/**
 * Wraps a backend so that — once armed — every transaction runs its callback
 * normally and then fails at the commit boundary, rolling the work back.
 */
export function createCommitFailingBackend(target: GraphBackend): Readonly<{
  backend: GraphBackend;
  arm: () => void;
  disarm: () => void;
}> {
  let armed = false;
  const backend = new Proxy(target, {
    get(inner, property, receiver): unknown {
      const value: unknown = Reflect.get(inner, property, receiver);
      if (property !== "transaction" || typeof value !== "function") {
        return value;
      }
      const transaction = value as GraphBackend["transaction"];
      const failingTransaction: GraphBackend["transaction"] = <R>(
        fn: (tx: TransactionBackend) => Promise<R>,
        options: TransactionOptions | undefined,
      ): Promise<R> =>
        transaction(async (tx) => {
          const result = await fn(tx);
          if (armed) throw new InjectedCommitFailure();
          return result;
        }, options);
      return failingTransaction;
    },
  });
  return {
    backend,
    arm() {
      armed = true;
    },
    disarm() {
      armed = false;
    },
  };
}
