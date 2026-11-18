/*
 * fast-check arbitraries for random allOf pairs/triples, one keyword table per profile.
 * Values are kept small and drawn from short lists so that bounds, patterns and names of different allOf members meet.
 */
import fc from "fast-check"

import type { CaseOptions, FuzzCase, Profile } from "./oracle.ts"
import { PATTERN_SAMPLES } from "./instances.ts"

const TYPES = ["string", "number", "integer", "object", "array", "null", "boolean"] as const
const NUMBERS = [-1, 0, 1, 2, 3, 0.5, 1.5]
const MULTIPLES = [2, 3, 0.5, 1.5]
const FORMATS = ["date", "email", "ipv4", "int32"]
const PATTERNS = Object.keys(PATTERN_SAMPLES)
const NAMES = ["a", "b", "ab", "x1", "__proto__", "constructor"]
const MEMBERS: unknown[] = [1, 2, 1.5, "a", "b", "ab", null, true, [1], { a: 1 }, [], {}]

// an object with own enumerable keys (also `__proto__`) built from entries; later duplicates are dropped
const objectOf = <V>(entries: [string, V][]): Record<string, V> => {
  const result: Record<string, V> = {}
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, key)) { continue }
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return result
}

const dict = <V>(keys: fc.Arbitrary<string>, value: fc.Arbitrary<V>, maxKeys = 2) =>
  fc.array(fc.tuple(keys, value), { minLength: 1, maxLength: maxKeys }).map(objectOf)

const num = fc.constantFrom(...NUMBERS)
const count = fc.nat(3)
const name = fc.constantFrom(...NAMES)
const names = fc.uniqueArray(name, { minLength: 1, maxLength: 3 })

// keyword fragments without subschemas
const scalarFragments = (profile: Profile): fc.Arbitrary<Record<string, unknown>>[] => {
  const common: fc.Arbitrary<Record<string, unknown>>[] = [
    fc.record({ type: fc.constantFrom(...TYPES) }),
    fc.record({ type: fc.uniqueArray(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 3 }) }),
    fc.record({ minimum: num }), fc.record({ maximum: num }),
    fc.record({ exclusiveMinimum: num }), fc.record({ exclusiveMaximum: num }),
    fc.record({ multipleOf: fc.constantFrom(...MULTIPLES) }),
    fc.record({ minLength: count }), fc.record({ maxLength: count }),
    fc.record({ pattern: fc.constantFrom(...PATTERNS) }),
    fc.record({ format: fc.constantFrom(...FORMATS) }),
    fc.record({ enum: fc.uniqueArray(fc.constantFrom(...MEMBERS), { minLength: 1, maxLength: 3, selector: (v) => JSON.stringify(v) }) }),
    fc.record({ const: fc.constantFrom(...MEMBERS) }),
    fc.record({ required: names }),
    fc.record({ minProperties: count }), fc.record({ maxProperties: count }),
    fc.record({ minItems: count }), fc.record({ maxItems: count }),
    fc.record({ uniqueItems: fc.boolean() }),
    fc.record({ title: fc.constantFrom("A", "B"), description: fc.constantFrom("d") }, { requiredKeys: ["title"] }),
    fc.record({ "x-a": fc.constantFrom(1, "v") }),
  ]
  const byProfile = profile === "2020-12"
    ? [
      fc.record({ dependentRequired: dict(name, names) }),
      fc.record({ minContains: count }), fc.record({ maxContains: count }),
    ]
    : [fc.record({ dependencies: dict(name, names) })]
  return [...common, ...byProfile]
}

const assign = (fragments: Record<string, unknown>[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const fragment of fragments) {
    for (const key of Object.keys(fragment)) {
      Object.defineProperty(result, key, { value: fragment[key], enumerable: true, writable: true, configurable: true })
    }
  }
  return result
}

export interface SchemaArbitraries {
  schema: fc.Arbitrary<unknown>
  root: fc.Arbitrary<unknown>
}

// `$ref`s, bare or with siblings; the siblings apply next to the reference in every draft (the oracle reads
// draft-07 `$ref` siblings the same way, see withRefSiblingsApplied)
const refLeaves = (profile: Profile) => {
  const container = profile === "2020-12" ? "$defs" : "definitions"
  return fc.constantFrom({ $ref: `#/${container}/A` }, { $ref: `#/${container}/B` })
}

const buildTree = (profile: Profile, withRefs: boolean): fc.Arbitrary<unknown> => {
  const leaf = fc.oneof(...scalarFragments(profile))
  const tree = fc.letrec((tie) => {
    const schema = tie("schema")
    const structural: fc.Arbitrary<Record<string, unknown>>[] = [
      fc.record({ properties: dict(name, schema) }),
      fc.record({ patternProperties: dict(fc.constantFrom(...PATTERNS), schema, 1) }),
      fc.record({ additionalProperties: fc.oneof(fc.constant(false), schema) }),
      fc.record({ propertyNames: fc.oneof(fc.record({ maxLength: count }), fc.record({ pattern: fc.constantFrom(...PATTERNS) }), fc.record({ enum: names })) }),
      fc.record({ contains: schema }),
      fc.record({ not: schema }),
      fc.record({ oneOf: fc.array(schema, { minLength: 1, maxLength: 3 }) }),
      fc.record({ anyOf: fc.array(schema, { minLength: 1, maxLength: 3 }) }),
      fc.record({ if: schema, then: schema, else: schema }, { requiredKeys: ["if"] }),
      fc.record({ allOf: fc.array(schema, { minLength: 1, maxLength: 3 }) }),
      ...profile === "2020-12"
        ? [
          fc.record({ items: schema }),
          fc.record({ prefixItems: fc.array(schema, { minLength: 1, maxLength: 2 }), items: fc.oneof(fc.constant(false), schema) }, { requiredKeys: ["prefixItems"] }),
          fc.record({ dependentSchemas: dict(name, schema, 1) }),
        ]
        : [
          fc.record({ items: schema }),
          fc.record({ items: fc.array(schema, { minLength: 1, maxLength: 2 }), additionalItems: fc.oneof(fc.constant(false), schema) }, { requiredKeys: ["items"] }),
          fc.record({ additionalItems: schema }),
          fc.record({ dependencies: dict(name, schema, 1) }),
        ],
    ]
    const refs = withRefs
      ? [
        { arbitrary: refLeaves(profile) as fc.Arbitrary<unknown>, weight: 2 },
        { arbitrary: fc.tuple(refLeaves(profile), fc.array(leaf, { minLength: 1, maxLength: 2 })).map(([r, l]) => assign([...l, r])) as fc.Arbitrary<unknown>, weight: 1 },
      ]
      : []
    return {
      schema: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        { arbitrary: fc.array(leaf, { minLength: 1, maxLength: 3 }).map(assign), weight: 6 },
        { arbitrary: fc.constantFrom<unknown>(true, false, {}), weight: 1 },
        { arbitrary: fc.tuple(fc.oneof(...structural), fc.array(leaf, { maxLength: 2 })).map(([s, l]) => assign([...l, s])), weight: 4 },
        ...refs,
      ),
    }
  })
  return tree.schema
}

/** Recursive schema arbitrary of a profile; `root` is an `allOf` of 2–4 schemas (pairs and triples mostly). */
export const schemaArbitraries = (profile: Profile): SchemaArbitraries => {
  const leaf = fc.oneof(...scalarFragments(profile))
  const plain = buildTree(profile, false)
  const withRefs = buildTree(profile, true)
  const container = profile === "2020-12" ? "$defs" : "definitions"
  const sibling = fc.option(fc.array(leaf, { minLength: 1, maxLength: 2 }).map(assign), { freq: 4 })
  const rootOf = (allOf: unknown[], sib: Record<string, unknown> | null, defs?: Record<string, unknown>) =>
    assign([...sib ? [sib] : [], ...defs ? [{ [container]: defs }] : [], { allOf }])
  const rootPlain = fc.tuple(fc.array(plain, { minLength: 2, maxLength: 4 }), sibling).map(([allOf, sib]) => rootOf(allOf, sib))
  // definitions are generated without refs: no ref cycles (a cycle that consumes no instance never terminates in a validator)
  const rootRefs = fc.tuple(fc.array(withRefs, { minLength: 2, maxLength: 4 }), sibling, plain, plain)
    .map(([allOf, sib, a, b]) => rootOf(allOf, sib, { A: a, B: b }))
  const root = fc.oneof({ arbitrary: rootPlain, weight: 3 }, { arbitrary: rootRefs, weight: 1 })
  return { schema: plain, root }
}

export const caseArbitrary = (profile: Profile): fc.Arbitrary<FuzzCase> => {
  const { root } = schemaArbitraries(profile)
  // the safe simplifications are on by default (mostly on here too), `simplify` is opt-in (half of the cases: every
  // rule, or a random selection)
  const safe = fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 })
  const simplify = fc.oneof(
    fc.constant(false),
    fc.constant(true),
    fc.record({ enumByType: fc.boolean(), contradictions: fc.boolean(), redundantBounds: fc.boolean(), containsToMinItems: fc.boolean() }),
  )
  const options: fc.Arbitrary<CaseOptions> = fc.record({
    mergeCombinarySibling: fc.boolean(),
    mergeRefSibling: fc.boolean(),
    refAnnotations: fc.constantFrom<CaseOptions["refAnnotations"]>("merge", "omit", ["title", "x-*"]),
    dedupeAnyOf: safe,
    dedupeFragments: safe,
    dedupeCombinaryGroups: safe,
    dropFalseBranches: safe,
    simplify,
  })
  return fc.tuple(root, options).map(([schema, opts]) => ({ profile, schema, options: opts }))
}
