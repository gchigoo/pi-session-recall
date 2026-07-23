import { defineConfig } from "vitest/config";

/**
 * 默认单测配置：unit 与共享 fixture。
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
