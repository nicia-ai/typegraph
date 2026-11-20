import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/errors";
import { withAdoptedTransactionScope } from "../src/store/evolution";

describe("adopted callback scope", () => {
  it("preserves nested ordinary callback composition", async () => {
    const session = {};
    const result = await withAdoptedTransactionScope(session, async () =>
      withAdoptedTransactionScope(session, async () => {
        await Promise.resolve();
        return "nested ordinary";
      }),
    );
    expect(result).toBe("nested ordinary");
  });

  it("refuses evolution inside an ordinary callback", async () => {
    const session = {};
    await expect(
      withAdoptedTransactionScope(session, async () =>
        withAdoptedTransactionScope(
          session,
          async () => {
            await Promise.resolve();
            return "unreached";
          },
          true,
        ),
      ),
    ).rejects.toThrow(ConfigurationError);
  });

  it("refuses an ordinary callback inside evolution and releases scope on failure", async () => {
    const session = {};
    await expect(
      withAdoptedTransactionScope(
        session,
        async () => {
          await withAdoptedTransactionScope(session, async () => {
            await Promise.resolve();
            return "unreached";
          });
        },
        true,
      ),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      withAdoptedTransactionScope(session, async () => {
        await Promise.resolve();
        return "released";
      }),
    ).resolves.toBe("released");
  });
});
