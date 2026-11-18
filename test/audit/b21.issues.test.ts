import { describe, it, expect } from "vite-plus/test"
import {
  MERGE_ISSUES,
  createMerger,
  jsonSchemaMergeRules,
  mergeWithIssues,

  type MergeIssue,
  type MergeIssueCode,
  type MergeOptions,
} from "../../src/index.ts"
import { ErrorMessage } from "../../src/errors.ts"
import { clone, merge, mergeReport } from "./helpers.ts"

// Issue model

const s = { type: "string" }
const n = { type: "number" }

const issuesOf = (value: unknown, options: MergeOptions = {}) => mergeWithIssues(clone(value), options)

const only = (issues: MergeIssue[], code: MergeIssueCode): MergeIssue => {
  const found = issues.filter((issue) => issue.code === code)
  expect(found.map((issue) => issue.code)).toEqual([code])
  return found[0]
}

const draft2020 = jsonSchemaMergeRules("2020-12")

interface CodeCase {
  code: MergeIssueCode
  input: unknown
  options?: MergeOptions
  output?: unknown
  path?: (string | number)[]
  keyword?: string
  reason?: string
  ref?: string
}

const CASES: CodeCase[] = [
  { code: "malformed-value", input: { allOf: [{ minLength: -1 }, s] }, output: s, path: [], keyword: "minLength" },
  { code: "malformed-allof", input: { allOf: { type: "string" }, minLength: 1 }, output: { minLength: 1 }, keyword: "allOf" },
  { code: "malformed-allof-item", input: { allOf: [3, s] }, output: s, keyword: "allOf" },
  { code: "broken-ref", input: { allOf: [{ $ref: "#/definitions/X" }, s] }, ref: "#/definitions/X" },
  { code: "broken-ref", input: { allOf: [{ $ref: "#nope" }, s] }, ref: "#nope" },
  { code: "ref-cycle", input: { definitions: { A: { $ref: "#/definitions/B" }, B: { $ref: "#/definitions/A" } }, allOf: [{ $ref: "#/definitions/A" }, s] }, ref: "#/definitions/A" },
  { code: "pattern-invalid", input: { allOf: [{ pattern: "(" }, { pattern: "b" }] }, keyword: "pattern" },
  { code: "external-ref", input: { allOf: [{ $ref: "ext.json#/X" }, s] }, ref: "ext.json#/X" },
  { code: "unsatisfiable", input: { allOf: [s, n] }, output: false, path: [], reason: "type" },
  { code: "unsatisfiable", input: { allOf: [{ enum: [1, 2] }, { enum: [3] }] }, output: false, reason: "enum" },
  { code: "unsatisfiable", input: { allOf: [{ const: 1 }, { const: 2 }] }, output: false, reason: "const" },
  { code: "unsatisfiable", input: { allOf: [{ type: "string", format: "date-time" }, { format: "date" }] }, output: false, reason: "format" },
  { code: "unsatisfiable", input: { allOf: [false, s] }, output: false, reason: "false-item" },
  { code: "unsatisfiable", input: { allOf: [{ type: "string", minLength: 5 }, { maxLength: 2 }] }, options: { simplify: true }, output: false, reason: "simplify" },
  { code: "unsatisfiable-combinator", input: { anyOf: [{ allOf: [s, n] }] }, output: false, path: ["anyOf"], keyword: "anyOf" },
  { code: "branch-removed", input: { oneOf: [{ allOf: [s, n] }, n] }, output: { oneOf: [n] }, path: ["oneOf", 0], keyword: "oneOf" },
  { code: "branch-removed", input: { oneOf: [false, n] }, output: { oneOf: [n] }, path: ["oneOf", 0], keyword: "oneOf" },
  { code: "pattern-kept", input: { allOf: [{ pattern: "(a)\\1" }, { pattern: "b" }] }, output: { allOf: [{ pattern: "(a)\\1" }, { pattern: "b" }] }, keyword: "pattern" },
  { code: "contains-kept", input: { allOf: [{ contains: s }, { contains: n }] }, output: { allOf: [{ contains: s }, { contains: n }] }, keyword: "contains" },
  { code: "conditional-kept", input: { allOf: [{ if: s, then: { minLength: 1 } }, { if: n, then: { minimum: 1 } }] }, options: { rules: jsonSchemaMergeRules("draft-07") }, keyword: "if" },
  { code: "unevaluated-kept", input: { allOf: [{ properties: { a: s }, unevaluatedProperties: false }, { minProperties: 1 }] }, options: { rules: draft2020 } },
  { code: "object-shape-kept", input: { allOf: [{ patternProperties: { "^a": s } }, { additionalProperties: false, patternProperties: { "^b": n } }] }, reason: "pattern-interaction" },
  { code: "object-shape-kept", input: { allOf: [{ properties: { aaa: s }, additionalProperties: false }, { patternProperties: { "^a": n } }] }, options: { matchPatterns: false }, reason: "match-limit" },
  { code: "object-shape-kept", input: { allOf: [{ properties: { aaa: s }, additionalProperties: false }, { patternProperties: { "^(a+)+$": n } }] }, reason: "nested-quantifier" },
  { code: "object-shape-kept", input: { allOf: [{ properties: { aaa: s }, additionalProperties: false }, { patternProperties: { "(": n } }] }, reason: "invalid-pattern" },
  { code: "multipleof-kept", input: { allOf: [{ multipleOf: 0.1 }, { multipleOf: 1e-320 }] }, keyword: "multipleOf" },
  { code: "tuple-kept", input: { allOf: [{ prefixItems: [s] }, { items: [{ minLength: 1 }, n] }] }, options: { rules: draft2020 }, output: { prefixItems: [s], allOf: [{ items: [{ minLength: 1 }, n] }] }, keyword: "items" },
  { code: "branch-budget", input: { allOf: Array.from({ length: 11 }, (_, i) => ({ oneOf: [{ minimum: i }, { maximum: i }] })) }, keyword: "oneOf" },
  { code: "nullable-overridden", input: { openapi: "3.0.3", paths: {}, components: { schemas: { Base: s, Name: { allOf: [{ $ref: "#/components/schemas/Base" }], nullable: true } } } }, path: ["components", "schemas", "Name"], keyword: "nullable" },
  {
    code: "merge-conflict",
    input: { allOf: [{ "x-a": 1 }, { "x-a": 2 }] },
    options: { rules: jsonSchemaMergeRules("draft-07", { "/x-a": { $: (values, ctx) => { ctx.mergeError(values); return values[values.length - 1] } } }) },
    output: { "x-a": 2 },
  },
]

describe("B21.1 one issue per code (I1)", () => {
  it.each(CASES.map((c, i) => [`${c.code}${c.reason ? ` (${c.reason})` : ""} #${i}`, c] as const))("B21.1.1 %s", (_label, c) => {
    const { result, issues } = issuesOf(c.input, c.options)
    const issue = only(issues, c.code)
    expect(issue.severity).toBe(MERGE_ISSUES[c.code].severity)
    expect(issue.category).toBe(MERGE_ISSUES[c.code].category)
    expect(typeof issue.message).toBe("string")
    if ("output" in c) { expect(result).toEqual(c.output) }
    if (c.path) { expect(issue.path).toEqual(c.path) }
    if (c.keyword) { expect(issue.keyword).toBe(c.keyword) }
    if (c.reason) { expect(issue.reason).toBe(c.reason) }
    if (c.ref) { expect(issue.ref).toBe(c.ref) }
    // issues are frozen, so a consumer cannot change what a later replay reports
    expect(Object.isFrozen(issue)).toBe(true)
  })

  it("B21.1.2 cyclic-value: a cyclic value outside the source", () => {
    const outside: any = { type: "object", properties: {} }
    outside.properties.self = outside
    const { issues } = mergeWithIssues(outside, { source: { definitions: {} } })
    expect(only(issues, "cyclic-value").path).toEqual(["properties", "self"])
  })

  it("B21.1.3 external-ref next to $ref siblings (mergeRefSibling) is reported without the legacy callback (D-9)", () => {
    const input = { $ref: "ext.json#/X", minLength: 1 }
    expect(only(issuesOf(input, { mergeRefSibling: true }).issues, "external-ref").ref).toBe("ext.json#/X")
    expect(mergeReport(clone(input), { mergeRefSibling: true }).refErrors).toEqual([])
  })

  it("B21.1.4 object-shape-kept: more than MAX_PATTERN_TESTS name x pattern tests (test-budget)", () => {
    const properties = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, s]))
    const patternProperties = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`^q${i}$`, n]))
    const { issues } = issuesOf({ allOf: [{ properties, additionalProperties: false }, { patternProperties }] })
    expect(only(issues, "object-shape-kept").reason).toBe("test-budget")
  })

  it("B21.1.5 schema-format-kept: AsyncAPI 3 $ref to an Avro schema inside allOf", () => {
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Avro: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record", name: "R", fields: [] } },
          P: { allOf: [{ $ref: "#/components/schemas/Avro" }, { type: "object" }] },
        },
      },
    }
    const { issues } = issuesOf(doc)
    const issue = only(issues, "schema-format-kept")
    expect(issue.path).toEqual(["components", "schemas", "P"])
    expect(issue.ref).toBe("#/components/schemas/Avro")
  })

  it("B21.1.6 limits: ref-expansion-limit, expansion-budget, max-depth (once per target / call)", () => {
    const doc = { definitions: { A: { properties: { x: s } } }, properties: { a: { allOf: [{ $ref: "#/definitions/A" }, { minProperties: 1 }] }, b: { allOf: [{ $ref: "#/definitions/A" }, { maxProperties: 3 }] }, c: { allOf: [{ $ref: "#/definitions/A" }, { maxProperties: 4 }] } } }
    expect(only(issuesOf(doc, { maxRefExpansion: 1 }).issues, "ref-expansion-limit").ref).toBe("#/definitions/A")
    expect(only(issuesOf(doc, { expansionBudget: 1 }).issues, "expansion-budget").code).toBe("expansion-budget")
    let deep: any = { allOf: [s, { minLength: 1 }] }
    for (let i = 0; i < 6; i++) { deep = { properties: { p: deep } } }
    expect(only(issuesOf(deep, { maxDepth: 3 }).issues, "max-depth").code).toBe("max-depth")
  })

  it("B21.1.7 link-copied: a $ref into a member the merge makes stricter is replaced by a copy (D-22)", () => {
    const doc = {
      definitions: { A: { allOf: [{ properties: { id: { type: "string" } } }, { properties: { id: { minLength: 1 } } }] } },
      properties: { x: { $ref: "#/definitions/A/allOf/0/properties/id" } },
    }
    const { result, issues } = issuesOf(doc) as { result: any, issues: MergeIssue[] }
    expect(result.properties.x).toEqual({ type: "string" })
    const issue = only(issues, "link-copied")
    expect(issue.path).toEqual(["properties", "x"])
    expect(issue.ref).toBe("#/definitions/A/allOf/0/properties/id")
  })

  it("B21.1.8 kept-for-link: the D-17 fallback keeps a node unmerged and reports its limit once", () => {
    const limited = {
      definitions: { A: { allOf: [{ properties: { x: { type: "string" } } }, { properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/definitions/A/allOf/0/properties/x" }, q: { $ref: "#/definitions/A/allOf/0/properties/x" } },
    }
    const { issues } = issuesOf(limited, { maxRefExpansion: 1 })
    expect(only(issues, "kept-for-link").path).toEqual(["definitions", "A"])
    expect(issues.filter((issue) => issue.code === "ref-expansion-limit")).toHaveLength(1)
    // the legacy callback no longer reports the limit twice (once per re-merge round)
    const { mergeErrors } = mergeReport(clone(limited), { maxRefExpansion: 1 })
    expect(mergeErrors.filter((error) => error.message.includes("maxRefExpansion"))).toHaveLength(1)
  })

  it("B21.1.9 branch-kept-for-link: an impossible branch before a branch that holds a pointer target keeps its index", () => {
    const doc = {
      definitions: {
        N: { oneOf: [{ allOf: [s, n] }, { type: "object", properties: { next: { $ref: "#/definitions/N/oneOf/1" } } }] },
      },
    }
    const { issues } = issuesOf(doc)
    const codes = issues.map((issue) => issue.code)
    // either the impossible branch is removed (and links follow its new index) or it is kept for the link
    expect(codes.filter((code) => code === "branch-removed" || code === "branch-kept-for-link")).toHaveLength(1)
  })
})

describe("B21.2 legacy callbacks (I2, I3)", () => {
  it("B21.2.1 legacy codes keep their messages, paths and values", () => {
    const { mergeErrors, refErrors } = mergeReport({ properties: { a: { allOf: [s, n] }, b: { allOf: [{ $ref: "#/definitions/X" }, s] }, c: { allOf: [{ minLength: -1 }, s] } } })
    expect(mergeErrors).toEqual([
      { message: ErrorMessage.mergeError(), path: ["properties", "a"], values: ["string", "number"] },
      { message: ErrorMessage.malformedValue("minLength"), path: ["properties", "c"], values: [-1] },
    ])
    expect(refErrors).toEqual([{ message: ErrorMessage.refResolveError(), path: ["properties", "b"], ref: "#/definitions/X" }])
  })

  it("B21.2.2 per-key malformed values report the specific message (fix) and a lone malformed value is dropped (Q9)", () => {
    const pair = mergeReport({ allOf: [{ required: true }, { required: ["a"] }] })
    expect(pair.result).toEqual({ required: ["a"] })
    expect(pair.mergeErrors.map((error) => error.message)).toEqual([ErrorMessage.malformedValue("required")])
    const lone = mergeReport({ allOf: [{ required: true }, { type: "object" }] })
    expect(lone.result).toEqual({ type: "object" })
    expect(lone.mergeErrors.map((error) => error.message)).toEqual([ErrorMessage.malformedValue("required")])
    expect(merge({ allOf: [{ uniqueItems: "hi" }, { type: "array" }] })).toEqual({ type: "array" })
  })

  it("B21.2.3 new codes never reach the legacy callbacks", () => {
    const inputs = [
      { oneOf: [{ allOf: [s, n] }, n] },
      { allOf: [{ pattern: "(a)\\1" }, { pattern: "b" }] },
      { allOf: [{ contains: s }, { contains: n }] },
      { allOf: [false, s] },
    ]
    for (const input of inputs) {
      const { mergeErrors, refErrors } = mergeReport(clone(input))
      expect([...mergeErrors, ...refErrors]).toEqual([])
      expect(issuesOf(input).issues.length).toBeGreaterThan(0)
    }
  })

  it("B21.2.4 every code is in MERGE_ISSUES with severity error or warning", () => {
    for (const info of Object.values(MERGE_ISSUES)) {
      expect(["error", "warning"]).toContain(info.severity)
    }
    expect(MERGE_ISSUES.unsatisfiable.severity).toBe("error")
    expect(MERGE_ISSUES["branch-removed"].severity).toBe("warning")
  })
})

describe("B21.3 delivery (I4-I7)", () => {
  it("B21.3.1 issueLevel error filters warnings", () => {
    const input = { properties: { a: { allOf: [s, n] }, b: { oneOf: [false, n] } } }
    expect(issuesOf(input).issues.map((issue) => issue.code).sort()).toEqual(["branch-removed", "unsatisfiable"])
    expect(issuesOf(input, { issueLevel: "error" }).issues.map((issue) => issue.code)).toEqual(["unsatisfiable"])
  })

  it("B21.3.2 replay: a merger reports the same issues on every call; a per-call onIssue overrides the merger's", () => {
    const doc = {
      definitions: { F: { type: "string", format: "date-time", allOf: [{ format: "date" }] } },
      a: { allOf: [{ $ref: "#/definitions/F" }] },
    }
    const own: MergeIssue[] = []
    const merger = createMerger({ source: doc, onIssue: (issue) => own.push(issue) })
    const calls: MergeIssue[][] = []
    for (const node of [doc.definitions.F, doc.definitions.F, doc.a]) {
      const got: MergeIssue[] = []
      merger.merge(node, { onIssue: (issue) => got.push(issue) })
      calls.push(got)
    }
    expect(own).toEqual([])
    expect(calls.map((got) => got.map((issue) => [issue.code, issue.sourcePointer]))).toEqual([
      [["unsatisfiable", "#/definitions/F"]],
      [["unsatisfiable", "#/definitions/F"]],
      [["unsatisfiable", "#/a"]],
    ])
    merger.merge(doc.definitions.F)
    expect(own.map((issue) => issue.code)).toEqual(["unsatisfiable"])
  })

  it("B21.3.3 de-duplication: one issue per node and code; a shared conflict is reported per merged node", () => {
    const X = { allOf: [s, n] }
    const { issues } = mergeWithIssues({ properties: { a: X, b: X } })
    // the same input node at two places: one issue at its first location
    expect(issues.map((issue) => issue.path)).toEqual([["properties", "a"]])
    const doc = { definitions: { X: { allOf: [s, n] } }, properties: { a: { allOf: [{ $ref: "#/definitions/X" }] }, b: { allOf: [{ $ref: "#/definitions/X" }] } } }
    expect(issuesOf(doc).issues.map((issue) => issue.sourcePointer)).toEqual(["#/definitions/X", "#/properties/a", "#/properties/b"])
  })

  it("B21.3.4 mergeWithIssues equals merge + the collected onIssue", () => {
    const input = { properties: { a: { allOf: [s, n] }, b: { allOf: [{ contains: s }, { contains: n }] } } }
    const collected: MergeIssue[] = []
    const plain = merge(clone(input), { onIssue: (issue) => collected.push(issue) })
    const forwarded: MergeIssue[] = []
    const { result, issues } = mergeWithIssues(clone(input), { onIssue: (issue) => forwarded.push(issue) })
    expect(result).toEqual(plain)
    expect(issues).toEqual(collected)
    expect(forwarded).toEqual(collected)
  })

  it("B21.3.5 whole-document issues carry the source pointer of the node", () => {
    const doc = { definitions: { A: { allOf: [s, n] } } }
    const issue = only(issuesOf(doc).issues, "unsatisfiable")
    expect(issue.path).toEqual(["definitions", "A"])
    expect(issue.sourcePointer).toBe("#/definitions/A")
  })
})

describe("B21.4 formats (Q1, I8)", () => {
  const conj = (a: string, b: string, type = "string") => ({ allOf: [{ type, format: a }, { format: b }] })

  it.each([["date-time", "date"], ["x-sku", "x-ean"], ["email", "idn-email"], ["uri", "uri-reference"]])("B21.4.1 %s and %s are a contradiction", (a, b) => {
    const { result, issues } = issuesOf(conj(a, b))
    expect(result).toBe(false)
    expect(only(issues, "unsatisfiable").reason).toBe("format")
  })

  it("B21.4.2 the OpenAPI numeric lattice narrows without an issue; JSON Schema rules make it a contradiction", () => {
    const json = issuesOf(conj("int32", "int64", "integer"))
    expect(json.result).toBe(false)
    expect(only(json.issues, "unsatisfiable").reason).toBe("format")
    const doc = { openapi: "3.0.3", paths: {}, components: { schemas: { A: conj("int64", "int32", "integer"), B: conj("double", "float", "number") } } }
    const { result, issues } = issuesOf(doc) as { result: any, issues: MergeIssue[] }
    expect(result.components.schemas).toEqual({ A: { type: "integer", format: "int32" }, B: { type: "number", format: "float" } })
    expect(issues).toEqual([])
  })

  it("B21.4.3 equal formats merge without an issue", () => {
    const { result, issues } = issuesOf(conj("uuid", "uuid"))
    expect(result).toEqual({ type: "string", format: "uuid" })
    expect(issues).toEqual([])
  })
})

describe("B21.5 rule-defined outcomes are not issues (Q2, Q8)", () => {
  it.each([
    ["last-wins annotations", { allOf: [{ title: "A", description: "a" }, { title: "B", description: "b" }] }],
    ["vendor keys", { allOf: [{ "x-owner": "a" }, { "x-owner": "b" }] }],
    ["duplicate anyOf branches", { anyOf: [s, s, n] }],
    ["duplicate fragments", { allOf: [{ contains: n }, { contains: n }] }],
    ["identical combinator groups", { allOf: [{ oneOf: [s, n] }, { oneOf: [s, n] }] }],
    ["identity keywords of inlined targets", { definitions: { A: { $id: "a", type: "string" } }, allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] }],
    ["self reference", { definitions: { A: { allOf: [{ $ref: "#/definitions/A" }, s] } } }],
    ["a link rewritten to its merged location", { definitions: { Pet: { allOf: [{ properties: { id: s } }, { required: ["id"] }] } }, properties: { id: { $ref: "#/definitions/Pet/allOf/0/properties/id" } } }],
  ])("B21.5.1 %s", (_label, input) => {
    expect(issuesOf(input).issues).toEqual([])
  })
})
