/*
 * Runs the equivalence property with fast-check and turns a failure into a readable report: profile, seed, path,
 * options, the minimized original, the merged output, the differing instance with the cfworker verdicts, ajv's
 * verdicts and a replay command. Environment: FUZZ_SEED (seed), FUZZ_RUNS (runs per profile), FUZZ_PATH (replay
 * path printed by a failure), FUZZ_AJV ("all" runs the ajv second opinion on every case instead of every 16th).
 */
import fc from "fast-check"

import type { MergeRules } from "../../src/index.ts"
import { caseArbitrary } from "./arbitraries.ts"
import { minimize } from "./minimize.ts"
import { type AjvDisagreement, type Failure, type FuzzCase, type Profile, ajvSecondOpinion, checkCase, clone, ajvValidator } from "./oracle.ts"

export const DEFAULT_SEEDS: Record<Profile, number> = { "draft-07": 7, "2020-12": 2020 }
export const DEFAULT_RUNS = 1000

const envNumber = (name: string): number | undefined => {
  const value = process.env[name]
  if (value === undefined || value === "") { return undefined }
  const n = Number(value)
  if (!Number.isFinite(n)) { throw new Error(`${name} must be a number, got ${value}`) }
  return n
}

export const fuzzSettings = (profile: Profile) => ({
  seed: envNumber("FUZZ_SEED") ?? DEFAULT_SEEDS[profile],
  numRuns: envNumber("FUZZ_RUNS") ?? DEFAULT_RUNS,
  path: process.env.FUZZ_PATH || undefined,
  ajvEvery: process.env.FUZZ_AJV === "all" ? 1 : 16,
})

export interface PropertyOutcome {
  failed: boolean
  report?: string
  minimized?: FuzzCase
  failure?: Failure
  numRuns: number
  oracleErrors: number     // generated cases discarded because cfworker cannot evaluate the original
  ajvDisagreements: AjvDisagreement[]
}

const show = (value: unknown) => { try { return JSON.stringify(value) } catch { return String(value) } }

const ajvVerdicts = (c: FuzzCase, merged: unknown, instance: unknown): string => {
  try {
    const a = ajvValidator(clone(c.schema), c.profile)(instance)
    const b = ajvValidator(clone(merged), c.profile)(instance)
    return `original ${a}, merged ${b}`
  } catch (error: any) { return "n/a (" + String(error?.message ?? error).slice(0, 80) + ")" }
}

export const formatFailure = (c: FuzzCase, failure: Failure, extra: string[] = []): string => [
  ...extra,
  `profile: ${c.profile}`,
  `options: ${show(c.options ?? {})}`,
  `failure: ${failure.kind} — ${failure.message}`,
  `original: ${show(c.schema)}`,
  `merged:   ${show(failure.merged)}`,
  ...("instance" in failure ? [
    `instance: ${show(failure.instance)} (keys: ${show(failure.instance && typeof failure.instance === "object" ? Object.keys(failure.instance) : [])})`,
    `cfworker: original ${failure.original}, merged ${failure.result}`,
    `ajv:      ${ajvVerdicts(c, failure.merged, failure.instance)}`,
  ] : []),
].join("\n")

/** Shrinks a failing case further with the greedy minimizer (same failure kind must persist). */
export const minimizeCase = (c: FuzzCase, failure: Failure, rules?: MergeRules): { minimized: FuzzCase, failure: Failure } => {
  const extraInstances = "instance" in failure ? [failure.instance] : []
  let last = failure
  const schema = minimize(c.schema, (candidate) => {
    const f = checkCase({ ...c, schema: candidate }, { rules, extraInstances })
    if (f && f.kind === failure.kind) { last = f; return true }
    return false
  })
  const minimized = { ...c, schema }
  return { minimized, failure: checkCase(minimized, { rules, extraInstances }) ?? last }
}

export const runProperty = (profile: Profile, overrides: { seed?: number, numRuns?: number, path?: string, rules?: MergeRules } = {}): PropertyOutcome => {
  const settings = { ...fuzzSettings(profile), ...overrides }
  const ajvDisagreements: AjvDisagreement[] = []
  let index = 0
  let oracleErrors = 0
  const property = fc.property(caseArbitrary(profile), (c) => {
    const n = index++
    const sample = n % settings.ajvEvery === 0
    let seen: { merged: unknown, instances: unknown[] } | undefined
    const failure = checkCase(c, { rules: overrides.rules, onMerged: sample ? (merged, instances) => { seen = { merged, instances } } : undefined })
    // cfworker cannot evaluate the original (e.g. a `$ref` inside a `__proto__`-keyed subschema map): not a test case
    if (failure?.kind === "oracle-error") { oracleErrors++; fc.pre(false) }
    if (!failure && sample && seen && !overrides.rules) {
      const d = ajvSecondOpinion(`${profile}#${n}`, c, seen.merged, seen.instances)
      if (d) { ajvDisagreements.push(d) }
    }
    return !failure
  })
  const details = fc.check(property, { seed: settings.seed, numRuns: settings.numRuns, path: settings.path, endOnFailure: false })
  if (!details.failed || !details.counterexample) {
    if (details.failed) { throw new Error(fc.defaultReportMessage(details) ?? "fast-check failed without a counterexample") }
    return { failed: false, numRuns: details.numRuns, oracleErrors, ajvDisagreements }
  }
  const counterexample = details.counterexample[0]
  const shrunkFailure = checkCase(counterexample, { rules: overrides.rules }) as Failure
  const { minimized, failure } = minimizeCase(counterexample, shrunkFailure, overrides.rules)
  const report = formatFailure(minimized, failure, [
    `equivalence property failed after ${details.numRuns} runs (${details.numShrinks} shrinks)`,
    `seed: ${details.seed}, path: ${details.counterexamplePath}`,
    `replay: FUZZ_SEED=${details.seed} FUZZ_PATH=${details.counterexamplePath} pnpm vp test run test/fuzz/equivalence -t "${profile}"`,
    `fast-check counterexample: ${show(counterexample.schema)}`,
  ])
  return { failed: true, report, minimized, failure, numRuns: details.numRuns, oracleErrors, ajvDisagreements }
}

export const formatAjvDisagreements = (list: AjvDisagreement[]): string => list.map((d) =>
  `${d.id}${d.known ? ` [known: ${d.known}]` : ""} instance ${show(d.instance)}: cfworker ${d.cfworker} (both), ajv original ${d.ajvOriginal} / merged ${d.ajvMerged}\n  original ${show(d.schema)}\n  merged   ${show(d.merged)}`,
).join("\n")
