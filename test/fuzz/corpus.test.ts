/*
 * corpus replay: every committed case (test/fuzz/corpus/*.json, provenance in corpus.ts) must be merged
 * equivalently under the cfworker oracle, without throwing, serializable and idempotent. Intentional output-form
 * differences (format conflicts and other fragments kept as allOf, contradictions written as `false`) are
 * equivalent by construction.
 */
import { describe, it, expect } from "vite-plus/test"
import { checkCase } from "./oracle.ts"
import { loadCorpus } from "./corpus.ts"
import { formatFailure } from "./property.ts"

describe("fuzz corpus replay (cfworker oracle)", () => {
  for (const { file, cases } of loadCorpus()) {
    it(`${file}: ${cases.length} cases are merged equivalently`, () => {
      expect(cases.length).toBeGreaterThan(0)
      const failures: string[] = []
      for (const c of cases) {
        const failure = checkCase(c)
        if (failure) { failures.push(formatFailure(c, failure, [`case: ${file} ${c.id} (${c.source})`])) }
      }
      if (failures.length) { throw new Error(`${failures.length} corpus case(s) failed:\n\n${failures.slice(0, 5).join("\n\n")}`) }
    })
  }
})
