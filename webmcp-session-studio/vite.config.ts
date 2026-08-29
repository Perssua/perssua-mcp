import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/studio/",
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    pool: "vmForks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
