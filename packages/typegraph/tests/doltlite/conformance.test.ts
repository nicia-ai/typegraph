import { createDoltliteBackend } from "../../src/backend/doltlite";
import { createAdapterTestSuite } from "../backends/adapter-test-suite";
import { createIntegrationTestSuite } from "../backends/integration-test-suite";

createAdapterTestSuite("DoltLite (experimental)", async () => {
  const { backend } = await createDoltliteBackend({ vector: false });
  return backend;
});

createIntegrationTestSuite("DoltLite (experimental)", async () => {
  const { backend } = await createDoltliteBackend({ vector: false });
  return {
    backend,
    cleanup: () => backend.close(),
    createSerializedBackend: async (overrides) => {
      const { backend: serializedBackend } = await createDoltliteBackend({
        vector: false,
        schemaProvisioning: overrides?.schemaProvisioning ?? "dml-only",
        ...(overrides?.capabilities === undefined ?
          {}
        : { capabilities: overrides.capabilities }),
      });
      return {
        backend: serializedBackend,
        close: () => serializedBackend.close(),
      };
    },
  };
});
