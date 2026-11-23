/**
 * What each driver's native transaction handle proves about identity.
 *
 * State TypeGraph keeps for a native transaction can only be keyed by that
 * transaction if the driver's handle distinguishes one BEGIN from the next.
 * These probes state, per driver, whether it does: through the adapter's
 * `transactionWithNative` and through the `tx.sql` a Store transaction
 * exposes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { PER_BEGIN_NATIVE_DRIVERS } from "../../helpers/native-transaction-handles";
import type { IntegrationTestContext } from "./test-context";

const ProbeItem = defineNode("ProbeItem", {
  schema: z.object({ label: z.string() }),
});

const probeGraph = defineGraph({
  id: "native_handle_probe",
  nodes: { ProbeItem: { type: ProbeItem } },
  edges: {},
});

export function registerNativeTransactionHandleProbeTests(
  context: IntegrationTestContext,
): void {
  describe("native transaction handle identity", () => {
    it("hands transactionWithNative a distinct native object per BEGIN only on per-BEGIN drivers", async () => {
      const backend = context.getBackend();
      const first = await backend.transactionWithNative((_target, native) =>
        Promise.resolve(native),
      );
      const second = await backend.transactionWithNative((_target, native) =>
        Promise.resolve(native),
      );
      expect({
        driver: context.driver,
        distinctPerBegin: first !== second,
      }).toEqual({
        driver: context.driver,
        distinctPerBegin: PER_BEGIN_NATIVE_DRIVERS.has(context.driver),
      });
    });

    it("exposes a distinct tx.sql per store.transaction attempt only on per-BEGIN drivers", async () => {
      const [store] = await createAdapterStoreWithSchema(
        probeGraph,
        context.getBackend(),
      );
      const first = await store.transaction((tx) =>
        Promise.resolve(
          tx.sqlAvailability === "available" ? tx.sql : undefined,
        ),
      );
      const second = await store.transaction((tx) =>
        Promise.resolve(
          tx.sqlAvailability === "available" ? tx.sql : undefined,
        ),
      );
      expect({
        driver: context.driver,
        exposed: first !== undefined && second !== undefined,
        distinctPerBegin: first !== second,
      }).toEqual({
        driver: context.driver,
        exposed: true,
        distinctPerBegin: PER_BEGIN_NATIVE_DRIVERS.has(context.driver),
      });
    });
  });
}
