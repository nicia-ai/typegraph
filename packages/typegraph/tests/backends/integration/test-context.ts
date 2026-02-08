import { type IntegrationStore } from "./fixtures";

export type IntegrationTestContext = Readonly<{
  getStore: () => IntegrationStore;
}>;
