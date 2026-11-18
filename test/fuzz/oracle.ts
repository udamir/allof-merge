/*
 * Equivalence oracle: @cfworker/json-schema is the primary oracle, ajv is a
 * logged second opinion only. ajv 8 is wrong for `contains` next to tuple `items` (`{ items: [{ type: "string" }],
 * contains: true }` accepts `[]`), so an ajv-only disagreement never fails a test.
 */
import { Validator } from "@cfworker/json-schema"
import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020.js"

import { jsonSchemaMergeRules, merge, type MergeOptions, type MergeRules } from "../../src/index.ts"
import { instancesFor } from "./instances.ts"
import { withRefSiblingsApplied } from "./ref-siblings.ts"

export { withRefSiblingsApplied }

export type Profile = "draft-07" | "2020-12"

export const PROFILES: readonly Profile[] = ["draft-07", "2020-12"]

const CF_DRAFT = { "draft-07": "7", "2020-12": "2020-12" } as const

export const profileRules = (profile: Profile): MergeRules => jsonSchemaMergeRules(profile)

export type CaseOptions = Pick<MergeOptions,
  | "mergeCombinarySibling" | "mergeRefSibling" | "refAnnotations"
  | "dedupeAnyOf" | "dedupeFragments" | "dedupeCombinaryGroups" | "dropFalseBranches" | "simplify">

export interface FuzzCase {
  profile: Profile
  schema: unknown
  options?: CaseOptions
}

// "oracle-error": cfworker itself fails on the original (e.g. a left-recursive $ref); such inputs are not test cases
export type FailureKind = "throws" | "not-serializable" | "invalid-output" | "mismatch" | "not-idempotent" | "oracle-error"

export interface Failure {
  kind: FailureKind
  message: string
  merged?: unknown
  instance?: unknown
  original?: boolean     // cfworker verdict of the original schema
  result?: boolean       // cfworker verdict of the merged (or re-merged) schema
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

export const cfValidator = (schema: unknown, profile: Profile) => {
  const validator = new Validator((profile === "draft-07" ? withRefSiblingsApplied(schema) : schema) as any, CF_DRAFT[profile], true)
  return (instance: unknown): boolean => validator.validate(instance).valid
}

// ajv second opinion ------------------------------------------------------------------------------------------------

const AJV_OPTIONS = { strict: false, allErrors: false, validateSchema: false, validateFormats: false, logger: false } as const
let ajv07: Ajv | undefined
let ajv2020: Ajv2020 | undefined
const ajvFor = (profile: Profile) => profile === "2020-12" ? (ajv2020 ??= new Ajv2020(AJV_OPTIONS)) : (ajv07 ??= new Ajv(AJV_OPTIONS))

export const ajvValidator = (schema: unknown, profile: Profile) => {
  // compiled without caching by schema identity: every case is a fresh object
  const validate = ajvFor(profile).compile(schema as any)
  ajvFor(profile).removeSchema(schema as any)
  return (instance: unknown): boolean => validate(instance) as boolean
}

// known ajv defects: a disagreement on a schema that uses them is expected and not logged as new
export const KNOWN_AJV_ISSUES: { id: string, test: (json: string) => boolean, description: string }[] = [
  {
    id: "ajv-contains-tuple-items",
    test: (json) => json.includes("\"contains\"") && /"items":\[/.test(json),
    description: "ajv 8 accepts [] for { items: [S], contains: C } (@cfworker/json-schema rejects it)",
  },
  {
    id: "ajv-contains-prefixItems",
    test: (json) => json.includes("\"contains\"") && json.includes("\"prefixItems\""),
    description: "ajv 8 (2020) accepts [] for { prefixItems: [S], contains: C } (same defect as the tuple `items` case)",
  },
  {
    id: "ajv-inherited-member-keys",
    test: (json) => /"(constructor|__proto__|toString)":/.test(json),
    description: "ajv 8 treats inherited Object.prototype members as present properties for `properties`/`dependencies`/`dependentRequired` keyed `constructor`/`__proto__`, so {} is checked against them",
  },
]

export interface AjvDisagreement {
  id: string
  profile: Profile
  schema: unknown
  merged: unknown
  instance: unknown
  cfworker: boolean
  ajvOriginal: boolean
  ajvMerged: boolean
  known?: string
}

/** ajv's verdicts on original vs merged; returns the first instance where ajv sees a difference that cfworker does not. */
export const ajvSecondOpinion = (id: string, c: FuzzCase, merged: unknown, instances: unknown[]): AjvDisagreement | undefined => {
  let vo: (x: unknown) => boolean
  let vm: (x: unknown) => boolean
  try {
    vo = ajvValidator(clone(c.schema), c.profile)
    vm = ajvValidator(clone(merged), c.profile)
  } catch { return undefined }
  const cf = cfValidator(clone(c.schema), c.profile)
  for (const instance of instances) {
    let a: boolean, b: boolean
    try { a = vo(instance); b = vm(instance) } catch { return undefined }
    if (a !== b) {
      const json = JSON.stringify(c.schema) + JSON.stringify(merged)
      const known = KNOWN_AJV_ISSUES.find((issue) => issue.test(json))?.id
      return { id, profile: c.profile, schema: c.schema, merged, instance, cfworker: cf(instance), ajvOriginal: a, ajvMerged: b, known }
    }
  }
  return undefined
}

// the property ------------------------------------------------------------------------------------------------------

export interface CheckOptions {
  rules?: MergeRules       // override of the profile's rule set (used by the injected-bug self-test)
  extraInstances?: unknown[]
  idempotence?: boolean    // also check merge(merge(x)) ≡ merge(x) (default true)
  onMerged?: (merged: unknown, instances: unknown[]) => void
}

class OracleError extends Error {}

const firstDifference = (a: (x: unknown) => boolean, b: (x: unknown) => boolean, instances: unknown[]) => {
  for (const instance of instances) {
    let original: boolean
    try { original = a(instance) } catch (error: any) { throw new OracleError(String(error?.message ?? error)) }
    const result = b(instance)
    if (original !== result) { return { instance, original, result } }
  }
  return undefined
}

const runMerge = (schema: unknown, c: FuzzCase, rules: MergeRules) => merge(clone(schema), { ...c.options, rules })

// the distinct `format` values anywhere in a value
const formatsOf = (value: unknown, found = new Set<unknown>(), seen = new Set<object>()): Set<unknown> => {
  if (typeof value !== "object" || value === null || seen.has(value)) { return found }
  seen.add(value)
  if (!Array.isArray(value) && typeof (value as any).format === "string") { found.add((value as any).format) }
  for (const child of Object.values(value)) { formatsOf(child, found, seen) }
  return found
}

const holdsFalse = (value: unknown): boolean => JSON.stringify(value).includes("false")

/**
 * User: two different formats in one conjunction make the schema `false`. `format` only
 * constrains strings, so for an asserting validator the decided output rejects non-string instances the original
 * accepts: a deliberate deviation, not a defect. A case whose input holds two different formats and whose output holds
 * a `false` is not checked.
 */
const decidedFormatDeviation = (schema: unknown, merged: unknown): boolean => formatsOf(schema).size > 1 && holdsFalse(merged)

/**
 * Checks one case: merge does not throw, the output is serializable and accepted by cfworker, the merged schema gives
 * every generated instance the same verdict as the original, and merging the output again changes nothing.
 * Returns undefined when the case holds.
 */
export const checkCase = (c: FuzzCase, options: CheckOptions = {}): Failure | undefined => {
  const rules = options.rules ?? profileRules(c.profile)
  let merged: unknown
  try { merged = runMerge(c.schema, c, rules) } catch (error: any) {
    return { kind: "throws", message: String(error?.message ?? error) }
  }
  let json: string | undefined
  try { json = JSON.stringify(merged) } catch (error: any) {
    return { kind: "not-serializable", message: String(error?.message ?? error) }
  }
  if (json === undefined) { return { kind: "invalid-output", message: "merge returned undefined", merged } }
  merged = JSON.parse(json)
  if (decidedFormatDeviation(c.schema, merged)) { return undefined }

  let original: (x: unknown) => boolean
  let result: (x: unknown) => boolean
  // an original cfworker cannot load is not a test case (the generators never produce one)
  original = cfValidator(clone(c.schema), c.profile)
  try { result = cfValidator(clone(merged), c.profile) } catch (error: any) {
    return { kind: "invalid-output", message: "cfworker rejects the merged schema: " + String(error?.message ?? error), merged }
  }

  const instances = instancesFor([c.schema, merged], { extra: options.extraInstances })
  options.onMerged?.(merged, instances)
  let diff: ReturnType<typeof firstDifference>
  try { diff = firstDifference(original, result, instances) } catch (error: any) {
    return error instanceof OracleError
      ? { kind: "oracle-error", message: "cfworker fails on the original: " + error.message, merged }
      : { kind: "invalid-output", message: "cfworker fails on the merged schema: " + String(error?.message ?? error), merged }
  }
  if (diff) { return { kind: "mismatch", message: "merged schema gives a different verdict", merged, ...diff } }

  if (options.idempotence !== false) {
    let againJson: string
    try { againJson = JSON.stringify(runMerge(merged, c, rules)) } catch (error: any) {
      return { kind: "not-idempotent", message: "merge(merge(x)) throws: " + String(error?.message ?? error), merged }
    }
    // the usual case: a merged schema is a fixpoint, nothing to validate
    if (againJson === json) { return undefined }
    const again = JSON.parse(againJson)
    const twice = cfValidator(again, c.profile)
    let diff2: ReturnType<typeof firstDifference>
    try { diff2 = firstDifference(result, twice, instances) } catch (error: any) {
      return { kind: "not-idempotent", message: "cfworker fails on merge(merge(x)): " + String(error?.message ?? error), merged: again }
    }
    if (diff2) { return { kind: "not-idempotent", message: "merge(merge(x)) is not equivalent to merge(x)", merged: again, ...diff2 } }
  }
  return undefined
}

/** True when cfworker can load the schema with the profile's dialect (corpus filter, generator guard). */
export const oracleAccepts = (schema: unknown, profile: Profile): boolean => {
  try { cfValidator(clone(schema), profile)(null); return true } catch { return false }
}
