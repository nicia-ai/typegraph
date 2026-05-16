/**
 * #140 do-sqlite test harness worker.
 *
 * A minimal Durable Object whose only job is to expose a real
 * `ctx.storage` (SQLite-backed) to the test suite via
 * `runInDurableObject`. All assertions run inside the DO context where
 * `state.storage` is a genuine `DurableObjectStorage` with the async
 * `transaction(async () => ...)` runner.
 */
import { DurableObject } from "cloudflare:workers";

export class SpikeDO extends DurableObject {
  async ping(): Promise<string> {
    return "ok";
  }
}

export default {
  fetch(): Response {
    return new Response("typegraph do-sqlite test worker");
  },
};
