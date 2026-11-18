import { describe, it, expect } from "vite-plus/test"
import fs from "fs"
import path from "path"
import YAML from "js-yaml"

import {
  createMerger,
  jsonSchemaMergeRules,
  merge as mergeSource,
  mergeWithIssues,
  openApiJsonSchemaMergeRules,
  openApiMergeRules,
  schemaMergeRulesFor,
  selectMergeRules,

  type MergeIssue,
  type MergeOptions,
} from "../../src/index.ts"
import { engine } from "../../src/engine.ts"
import { loadCorpus } from "../fuzz/corpus.ts"
import { profileRules } from "../fuzz/oracle.ts"
import { clone, collectObjects, merge } from "./helpers.ts"

// fast path, F-10 (single-item allOf simplified like a merged node), rule auto-selection

const s = { type: "string" }
const n = { type: "number" }

const resources = path.resolve(import.meta.dirname, "../resources")

// output and issues with the fast path off (the engine's regular path for every node)
const slow = <T>(run: () => T): T => {
  engine.fastPath = false
  try {
    return run()
  } finally {
    engine.fastPath = undefined
  }
}

// structuredClone keeps holes and cycles (JSON does not)
const both = (value: unknown, options: MergeOptions = {}) => {
  const fast = mergeWithIssues(structuredClone(value), options)
  const regular = slow(() => mergeWithIssues(structuredClone(value), options))
  return { fast, regular }
}

const sameAsRegular = (value: unknown, options: MergeOptions = {}) => {
  const { fast, regular } = both(value, options)
  expect(fast.result).toEqual(regular.result)
  const view = (issues: MergeIssue[]) => issues.map((issue) => [issue.code, issue.path, issue.sourcePointer])
  expect(view(fast.issues)).toEqual(view(regular.issues))
  return fast.result as any
}

describe("B22.1 fast path equivalence (P1)", () => {
  it.each(["openapi30x.json", "openapi31x.json"])("B22.1.1 %s: same output and issues with and without the fast path", (file) => {
    const doc = JSON.parse(fs.readFileSync(path.join(resources, file), "utf8"))
    sameAsRegular(doc)
    sameAsRegular(doc, { mergeRefSibling: true, mergeCombinarySibling: true })
  })

  it.each(["streetlights-kafka-2.6.yml", "streetlights-kafka-3.0.yml"])("B22.1.2 AsyncAPI %s", (file) => {
    const doc = YAML.load(fs.readFileSync(path.join(resources, "asyncapi", file), "utf8"))
    sameAsRegular(doc)
  })

  it("B22.1.3 the fuzz corpus: same output with and without the fast path", () => {
    let count = 0
    for (const { cases } of loadCorpus()) {
      for (const c of cases) {
        const options = { ...c.options, rules: profileRules(c.profile) } as MergeOptions
        const fast = JSON.stringify(mergeSource(clone(c.schema), options))
        const regular = slow(() => JSON.stringify(mergeSource(clone(c.schema), options)))
        expect([c.id, fast]).toEqual([c.id, regular])
        count++
      }
    }
    expect(count).toBeGreaterThan(500)
  })

  it("B22.1.4 one output instance per input instance (D-11, B9.2.17)", () => {
    const shared = { type: "object", properties: { x: { type: "string" } } }
    const data = { definitions: { A: shared }, properties: { a: { allOf: [{ $ref: "#/definitions/A" }, { description: "a" }] }, b: { allOf: [{ $ref: "#/definitions/A" }, { description: "b" }] }, c: shared } }
    const result = merge(data)
    expect(result.properties.a.properties.x).toBe(result.definitions.A.properties.x)
    expect(result.properties.c).toBe(result.definitions.A)
    expect(result.definitions.A).not.toBe(shared)
    // the output shares no object with the input
    const input = collectObjects(data)
    for (const object of collectObjects(result)) { expect(input.has(object)).toBe(false) }
  })

  it("B22.1.5 holes, array lengths and own __proto__ keys are copied like the regular path", () => {
    const sparse: unknown[] = [1]
    sparse[3] = { a: 1 }
    const data = JSON.parse('{"properties":{"__proto__":{"type":"string"}},"enum":null}')
    data.examples = sparse
    const result = sameAsRegular(data)
    expect(result.examples.length).toBe(4)
    expect(1 in result.examples).toBe(false)
    expect(Object.getPrototypeOf(result.properties)).toBe(Object.prototype)
    expect(Object.keys(result.properties)).toEqual(["__proto__"])
  })
})

describe("B22.2 nodes that are never skipped (P2)", () => {
  const cases: [string, unknown, MergeOptions][] = [
    ["1 own allOf (also malformed)", { properties: { a: { allOf: { type: "string" } } } }, {}],
    ["2 $ref with siblings (mergeRefSibling)", { definitions: { A: s }, properties: { a: { $ref: "#/definitions/A", minLength: 1 } } }, { mergeRefSibling: true }],
    ["3 oneOf with siblings (mergeCombinarySibling)", { properties: { a: { type: "object", oneOf: [{ required: ["x"] }, { required: ["y"] }] } } }, { mergeCombinarySibling: true }],
    ["3 anyOf next to oneOf (mergeCombinarySibling)", { anyOf: [{ minimum: 1 }, { minimum: 2 }], oneOf: [{ maximum: 5 }, { maximum: 6 }] }, { mergeCombinarySibling: true }],
    ["4 a literal false branch", { properties: { a: { oneOf: [false, n] } } }, {}],
    ["4 a { not: {} } branch (not-empty)", { properties: { a: { anyOf: [{ not: {} }, n] } } }, { unsatisfiable: "not-empty" }],
    ["5 duplicate anyOf branches", { properties: { a: { anyOf: [s, s, n] } } }, {}],
    ["6 a $ref through a merged allOf", { definitions: { Pet: { allOf: [{ properties: { id: s } }, { required: ["id"] }] } }, properties: { id: { $ref: "#/definitions/Pet/allOf/0/properties/id" } } }, {}],
    ["7 an identity cycle", (() => { const a: any = { properties: {} }; a.properties.self = a; return { definitions: { A: a } } })(), {}],
    ["8 deeper than maxDepth", (() => { let deep: any = s; for (let i = 0; i < 8; i++) { deep = { properties: { p: deep } } } return deep })(), { maxDepth: 4 }],
  ]

  it.each(cases)("B22.2.1 rule %s", (_label, input, options) => {
    sameAsRegular(input, options)
  })

  it("B22.2.2 the expected outputs", () => {
    expect(merge({ properties: { a: { oneOf: [false, n] } } })).toEqual({ properties: { a: { oneOf: [n] } } })
    expect(merge({ properties: { a: { anyOf: [s, s, n] } } })).toEqual({ properties: { a: { anyOf: [s, n] } } })
    expect(merge({ definitions: { A: s }, properties: { a: { $ref: "#/definitions/A", minLength: 1 } } }, { mergeRefSibling: true }).properties.a).toEqual({ type: "string", minLength: 1 })
    const pet = merge({ definitions: { Pet: { allOf: [{ properties: { id: s } }, { required: ["id"] }] } }, properties: { id: { $ref: "#/definitions/Pet/allOf/0/properties/id" } } })
    expect(pet.properties.id).toEqual({ $ref: "#/definitions/Pet/properties/id" })
  })
})

describe("B22.3 needsMerge (P3)", () => {
  const merger = createMerger()
  it.each([
    [{ type: "object", properties: { a: s } }, false],
    [{ anyOf: [s, n] }, false],
    [{ oneOf: [s, n], description: "d" }, false],
    [{ properties: { a: { allOf: [s] } } }, true],
    [{ anyOf: [s, s] }, true],
    [{ oneOf: [false, s] }, true],
    [{ $ref: "#/x", minLength: 1 }, false],
    ["string", false],
  ] as [unknown, boolean][])("B22.3.1 %j -> %s", (value, expected) => {
    expect(merger.needsMerge(value)).toBe(expected)
  })

  it("B22.3.2 the merger's options decide", () => {
    expect(createMerger({ mergeRefSibling: true }).needsMerge({ $ref: "#/x", minLength: 1 })).toBe(true)
    expect(createMerger({ mergeCombinarySibling: true }).needsMerge({ oneOf: [s, n], type: "string" })).toBe(true)
    expect(createMerger({ dedupeAnyOf: false }).needsMerge({ anyOf: [s, s] })).toBe(false)
    expect(createMerger({ dropFalseBranches: false }).needsMerge({ oneOf: [false, s] })).toBe(false)
    expect(createMerger({ maxDepth: 1 }).needsMerge({ properties: { a: { properties: { b: s } } } })).toBe(true)
  })

  it("B22.3.3 a value that needs no merge is returned as an equal copy", () => {
    const value = { type: "object", properties: { a: { anyOf: [s, n] } } }
    expect(merger.needsMerge(value)).toBe(false)
    const result = merger.merge(value)
    expect(result).toEqual(value)
    expect(result).not.toBe(value)
  })
})

describe("B22.4 F-10: a single-item allOf gets the merged-node simplifications", () => {
  it.each([
    [{ allOf: [{ anyOf: [s, s, n] }] }, { anyOf: [s, n] }],
    [{ allOf: [{ anyOf: [s, s, n] }, {}] }, { anyOf: [s, n] }],
    [{ allOf: [{ oneOf: [false, n] }, {}] }, { oneOf: [n] }],
    [{ allOf: [{ oneOf: [{ allOf: [s, n] }, n] }] }, { oneOf: [n] }],
  ])("B22.4.1 %j", (input, expected) => {
    const once = merge(clone(input))
    expect(once).toEqual(expected)
    expect(merge(clone(once))).toEqual(once)
  })
})

describe("B22.5 rule auto-selection (S1)", () => {
  const tuple = (schema: string | undefined) => ({ ...schema ? { $schema: schema } : {}, allOf: [{ items: [s] }, { items: [{ minLength: 1 }, n] }] })

  it.each([
    ["http://json-schema.org/draft-04/schema#", "draft-04"],
    ["http://json-schema.org/draft-06/schema#", "draft-06"],
    ["http://json-schema.org/draft-07/schema#", "draft-07"],
    ["https://json-schema.org/draft/2019-09/schema", "2020-12"],
    ["https://json-schema.org/draft/2020-12/schema", "2020-12"],
    ["https://example.com/my-dialect", "draft-06"],
  ] as const)("B22.5.1 $schema %s -> %s rules", (uri, draft) => {
    expect(selectMergeRules({ $schema: uri })).toBe(jsonSchemaMergeRules(draft))
  })

  it("B22.5.2 a 2020-12 document keeps an array items as a fragment, a draft-07 one merges the tuple", () => {
    // both items are legacy tuples under 2020-12: each is kept as a fragment
    expect(merge(tuple("https://json-schema.org/draft/2020-12/schema")).allOf).toEqual([{ items: [s] }, { items: [{ minLength: 1 }, n] }])
    expect(merge(tuple("http://json-schema.org/draft-07/schema#")).items).toEqual([{ type: "string", minLength: 1 }, n])
  })

  it("B22.5.3 OpenAPI versions are matched exactly; a 3.1 jsonSchemaDialect selects the schema draft", () => {
    expect(selectMergeRules({ openapi: "3.0.3" })).toBe(openApiMergeRules("3.0.x"))
    expect(selectMergeRules({ openapi: "3.0" })).toBe(openApiMergeRules("3.0.x"))
    expect(selectMergeRules({ openapi: "3.1.0" })).toBe(openApiMergeRules("3.1.x"))
    expect(selectMergeRules({ openapi: "3.2.0" })).toBe(openApiMergeRules("3.1.x"))
    expect(selectMergeRules({ openapi: "13.0" })).toBe(jsonSchemaMergeRules("draft-06"))
    expect(selectMergeRules({ openapi: "30" })).toBe(jsonSchemaMergeRules("draft-06"))
    const draft07 = selectMergeRules({ openapi: "3.1.0", jsonSchemaDialect: "http://json-schema.org/draft-07/schema#" })
    expect(draft07).toBe(openApiMergeRules("3.1.x", undefined, "draft-07"))
    expect(draft07).not.toBe(openApiMergeRules("3.1.x"))
    const doc = { openapi: "3.1.0", jsonSchemaDialect: "http://json-schema.org/draft-07/schema#", paths: {}, components: { schemas: { T: { allOf: [{ items: [s] }, { items: [{ minLength: 1 }] }] } } } }
    expect(merge(doc).components.schemas.T).toEqual({ items: [{ type: "string", minLength: 1 }] })
  })

  it("B22.5.4 schemaMergeRulesFor", () => {
    expect(schemaMergeRulesFor("draft-07")).toBe(jsonSchemaMergeRules("draft-07"))
    expect(schemaMergeRulesFor("2019-09")).toBe(jsonSchemaMergeRules("2020-12"))
    expect(schemaMergeRulesFor("http://json-schema.org/draft-04/schema#")).toBe(jsonSchemaMergeRules("draft-04"))
    expect(schemaMergeRulesFor("openapi-3.0")).toBe(openApiJsonSchemaMergeRules("3.0.x"))
    expect(schemaMergeRulesFor("openapi-3.1")).toBe(openApiJsonSchemaMergeRules("3.1.x"))
    expect(schemaMergeRulesFor("asyncapi-schema")).toBeDefined()
    expect(schemaMergeRulesFor("application/vnd.apache.avro;version=1.9.0")).toBeUndefined()
    expect(schemaMergeRulesFor("application/schema+json;version=draft-07")).toBe(jsonSchemaMergeRules("draft-07"))
  })
})

describe("B22.6 fragment-mode result cache (F-11)", () => {
  it("B22.6.1 a repeated call returns the same output and replays its issues", () => {
    const doc = { definitions: { A: { allOf: [s, { minLength: 1 }] }, B: { properties: { a: { $ref: "#/definitions/A" }, x: { allOf: [s, n] } } } } }
    const merger = createMerger({ source: doc })
    const first: MergeIssue[] = []
    const second: MergeIssue[] = []
    const a = merger.merge(doc.definitions.B, { onIssue: (issue) => first.push(issue) })
    const b = merger.merge(doc.definitions.B, { onIssue: (issue) => second.push(issue) })
    expect(b).toBe(a)
    expect(second).toEqual(first)
    expect(first.map((issue) => issue.code)).toEqual(["unsatisfiable"])
  })
})
