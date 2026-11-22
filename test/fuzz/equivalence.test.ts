/*
 * Property-based equivalence test: random allOf pairs/triples per profile
 * (draft-07 and 2020-12 rule sets, with and without mergeCombinarySibling), instances targeted at each schema, and
 * merged ≡ original allOf checked with @cfworker/json-schema. ajv is a logged second opinion. Fixed seeds keep CI
 * deterministic; FUZZ_SEED / FUZZ_RUNS / FUZZ_PATH run other or more cases locally, e.g.
 *   FUZZ_SEED=123 FUZZ_RUNS=20000 pnpm test:fuzz
 */
import { describe, it, expect } from "vite-plus/test"
import fc from "fast-check"

import { jsonSchemaMergeRules } from "../../src/index.ts"
import { maxValue } from "../../src/resolvers/index.ts"
import { caseArbitrary } from "./arbitraries.ts"
import { KNOWN_AJV_ISSUES, PROFILES, ajvValidator, cfValidator, checkCase } from "./oracle.ts"
import { formatAjvDisagreements, fuzzSettings, fuzzTimeout, runProperty } from "./property.ts"

const countAllOf = (value: unknown): number => {
  if (!value || typeof value !== "object") { return 0 }
  const own = !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "allOf") && Array.isArray((value as any).allOf) ? 1 : 0
  return own + Object.values(value).reduce((sum: number, child) => sum + countAllOf(child), 0)
}

describe("fuzz: merged ≡ allOf (cfworker oracle)", () => {
  for (const profile of PROFILES) {
    it(`${profile}: random allOf pairs/triples are merged equivalently`, () => {
      const outcome = runProperty(profile)
      if (outcome.ajvDisagreements.length) {
        const unknown = outcome.ajvDisagreements.filter((d) => !d.known)
        console.log(`[fuzz ${profile}] ajv second opinion disagrees on ${outcome.ajvDisagreements.length} sampled case(s), ${unknown.length} not allowlisted (not a failure: cfworker is the oracle)\n${formatAjvDisagreements(unknown.slice(0, 5))}`)
      }
      if (outcome.failed) { throw new Error(outcome.report) }
      // discarded cases (cfworker cannot load the original) must stay rare, or the property silently loses coverage
      expect(outcome.oracleErrors).toBeLessThan(outcome.numRuns * 0.02)
    }, fuzzTimeout(fuzzSettings(profile).numRuns))
  }
})

describe("fuzz: oracle and harness self-tests", () => {
  it("the ajv `contains` + tuple `items` defect is allowlisted and cfworker is right", () => {
    const schema = { items: [{ type: "string" }], contains: true }
    expect(cfValidator(schema, "draft-07")([])).toBe(false)
    expect(ajvValidator(schema, "draft-07")([])).toBe(true)
    expect(KNOWN_AJV_ISSUES.some((issue) => issue.test(JSON.stringify(schema)))).toBe(true)
  })

  it("an injected bug (maxLength merged with max) is found and minimized to a small case", () => {
    const rules = jsonSchemaMergeRules("draft-07", { "/maxLength": { $: maxValue } })
    const outcome = runProperty("draft-07", { seed: 42, numRuns: 1000, path: undefined, rules })
    expect(outcome.failed).toBe(true)
    expect(outcome.failure?.kind).toBe("mismatch")
    const schema = outcome.minimized?.schema as any
    expect(Array.isArray(schema.allOf) ? schema.allOf.length : 0).toBeLessThanOrEqual(3)
    expect(JSON.stringify(schema)).toContain("maxLength")
    expect(JSON.stringify(schema).length).toBeLessThan(120)
    expect(outcome.report).toMatch(/seed: 42, path: /)
  }, fuzzTimeout(1000))

  it("the same seed generates the same cases", () => {
    for (const profile of PROFILES) {
      const a = fc.sample(caseArbitrary(profile), { seed: 99, numRuns: 30 })
      const b = fc.sample(caseArbitrary(profile), { seed: 99, numRuns: 30 })
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
    }
  })

  it("generated cases are mostly merged away (no allOf left) and the oracle is not vacuous", () => {
    const cases = fc.sample(caseArbitrary("draft-07"), { seed: 5, numRuns: 200 })
    let leftAllOf = 0
    let rejectsSomething = 0
    for (const c of cases) {
      let merged: unknown
      const failure = checkCase(c, { onMerged: (m) => { merged = m } })
      if (failure?.kind === "oracle-error") { continue }
      expect(failure).toBeUndefined()
      if (countAllOf(merged) > 0) { leftAllOf++ }
      if (merged === false || (typeof merged === "object" && merged !== null && Object.keys(merged).length > 0)) { rejectsSomething++ }
    }
    // fragments (contains, format conflicts, inexact multipleOf, patternProperties interactions, ...) are kept as allOf
    expect(leftAllOf).toBeLessThan(cases.length / 2)
    expect(rejectsSomething).toBeGreaterThan(cases.length * 0.8)
  })
})
