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
    // one worker per physical core on SMT machines: a worker is a whole V8 process with its own GC and compiler
    // threads, and with the default (logical CPUs - 1) the CPU-bound files of the first wave ran 2.5-4x slower than
    // alone, which pushed the fuzz property past its timeout; the suite takes as long either way
    maxWorkers: "50%",
    setupFiles: ["test/setup/refIntegrity.ts"],
  },
})
