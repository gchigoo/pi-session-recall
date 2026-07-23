import { defineConfig } from "vitest/config";

/**
 * 集成测试配置。
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
  },
});
