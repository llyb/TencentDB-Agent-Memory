import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["eval/*.test.ts"],
  testTimeout: 30000, hookTimeout: 30000, restoreMocks: true, unstubEnvs: true, unstubGlobals: true } });
