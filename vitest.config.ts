import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 与 tsconfig paths 对齐（@/* → src/*）
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    fileParallelism: false,
    include: ["__tests__/**/*.test.ts"],
  },
});
