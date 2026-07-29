import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // 集成测试反复调用 git 子进程，串行更稳定、日志更可读
    fileParallelism: false,
  },
});
