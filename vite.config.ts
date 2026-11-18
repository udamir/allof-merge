import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    platform: "neutral",
    target: "es2022",
    dts: true,
  },
  lint: {
    ignorePatterns: ["dist/**", "temp/**", "benchmark/**"],
    rules: {
      // `then` is a JSON Schema keyword, not a thenable
      "unicorn/no-thenable": "off",
      // holey arrays of a known length are intended (copies keep holes)
      "unicorn/no-new-array": "off",
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup/refIntegrity.ts"],
  },
})
