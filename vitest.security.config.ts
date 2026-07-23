import { defineConfig } from "vitest/config";

/**
 * 安全回归测试配置。
 */
export default defineConfig({
  test: {
    include: ["tests/security/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
