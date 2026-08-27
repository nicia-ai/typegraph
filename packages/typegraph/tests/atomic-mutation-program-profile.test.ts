import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { resolveBundledRootAtomicMutationPrograms } from "../src/backend/capabilities/atomic-mutation-program";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";

describe("atomic mutation program execution profile", () => {
  it("registers every semantic program once on the exact bundled root", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-mutation-profile-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const profile = resolveBundledRootAtomicMutationPrograms(backend);
      expect(typeof profile?.createNodes).toBe("function");
      expect(typeof profile?.createEdges).toBe("function");
      expect(typeof profile?.deleteNodes).toBe("function");
      expect(typeof profile?.deleteEdges).toBe("function");
      expect(
        resolveBundledRootAtomicMutationPrograms(deriveBackend(backend, {})),
      ).toBeUndefined();
      await backend.transaction((transactionBackend) => {
        expect(
          resolveBundledRootAtomicMutationPrograms(transactionBackend),
        ).toBeUndefined();
        return Promise.resolve();
      });
    } finally {
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
