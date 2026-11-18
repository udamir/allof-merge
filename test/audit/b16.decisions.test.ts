import { describe, it, expect } from "vite-plus/test"
import fs from "fs"
import path from "path"

import {
  createGraphapiMergeRules,
  createMerger,
  graphapiMergeRules,
  jsonSchemaMergeRules,
  openApiJsonSchemaMergeRules,
  openApiMergeRules,

  type MergeResolver,
  type MergeRules,
} from "../../src/index.ts"
import * as resolvers from "../../src/resolvers/index.ts"
import { createResolutionIndex } from "../../src/resolve.ts"
import { collectRefs, danglingRefs, expectRefsResolve } from "../helpers/refIntegrity.ts"
import { clone, compile, expectSameValidation, merge, mergeReport } from "./helpers.ts"

const resources = path.resolve(import.meta.dirname, "../resources")
const loadResource = (name: string) => JSON.parse(fs.readFileSync(path.join(resources, name), "utf8"))

const oasDoc = (version: string, schemas: Record<string, unknown>) => ({ openapi: version, info: { title: "t", version: "1" }, paths: {}, components: { schemas } })
const graphDoc = (schemas: Record<string, unknown>) => ({ graphapi: "0.1.2", components: { schemas } })

describe("B16.1 format lattice only under the OpenAPI rule sets (D-14)", () => {
  const conflict = (format: [string, string]) => ({ allOf: [{ type: "integer", format: format[0] }, { format: format[1] }] })

  // Q1 (2026-11-18): two different formats are a contradiction (false), outside the OpenAPI lattice
  it.each(["draft-04", "draft-06", "draft-07", "2020-12"] as const)("B16.1.1 JSON Schema %s: int32 vs int64 and float vs double are contradictions", (draft) => {
    const rules = jsonSchemaMergeRules(draft)
    for (const pair of [["int32", "int64"], ["float", "double"]] as [string, string][]) {
      const { result, mergeErrors } = mergeReport(conflict(pair), { rules })
      expect(result).toBe(false)
      expect(mergeErrors).toHaveLength(1)
      expect(mergeErrors[0].values).toEqual(pair)
    }
  })

  it("B16.1.2 GraphApi rule set: int32 vs int64 is a contradiction", () => {
    const { result, mergeErrors } = mergeReport(graphDoc({ A: conflict(["int32", "int64"]) }))
    expect(result.components.schemas.A).toBe(false)
    expect(mergeErrors).toHaveLength(1)
  })

  it.each(["3.0.3", "3.1.0"])("B16.1.3 OpenAPI %s documents narrow int32 ⊂ int64 / float ⊂ double, also in nested schemas", (version) => {
    const doc = oasDoc(version, {
      A: conflict(["int64", "int32"]),
      B: { type: "object", properties: { n: { allOf: [{ type: "number", format: "double" }, { format: "float" }] } } },
      C: { allOf: [{ type: "string", format: "date" }, { format: "date-time" }] },
    })
    const { result, mergeErrors } = mergeReport(doc)
    expect(result.components.schemas.A).toEqual({ type: "integer", format: "int32" })
    expect(result.components.schemas.B.properties.n).toEqual({ type: "number", format: "float" })
    // other differing formats are a contradiction under OpenAPI too (Q1)
    expect(result.components.schemas.C).toBe(false)
    expect(mergeErrors).toHaveLength(1)
  })

  it("B16.1.4 openApiJsonSchemaMergeRules (3.0 and 3.1) narrow; the JSON Schema draft they build on does not", () => {
    expect(merge(conflict(["int32", "int64"]), { rules: openApiJsonSchemaMergeRules("3.0.x") })).toEqual({ type: "integer", format: "int32" })
    expect(merge(conflict(["int32", "int64"]), { rules: openApiJsonSchemaMergeRules("3.1.x") })).toEqual({ type: "integer", format: "int32" })
    expect(merge(conflict(["int32", "int64"]), { rules: jsonSchemaMergeRules("2020-12") })).toBe(false)
  })

  it("B16.1.5 the lattice is opt-in for JSON Schema rules through resolvers.mergeOpenApiFormat (group and per-key mode)", () => {
    const grouped = jsonSchemaMergeRules("draft-07", { "/format": { $: resolvers.mergeOpenApiFormat, group: "string" } })
    expect(merge(conflict(["int32", "int64"]), { rules: grouped })).toEqual({ type: "integer", format: "int32" })
    // without the group tag the string group is handed back to the per-key table: same result
    const perKey = jsonSchemaMergeRules("draft-07", { "/format": { $: resolvers.mergeOpenApiFormat } })
    expect(merge({ allOf: [{ format: "int32", minLength: 1 }, { format: "int64", maxLength: 3 }] }, { rules: perKey })).toEqual({ format: "int32", minLength: 1, maxLength: 3 })
    // and the strict resolver is a contradiction in per-key mode too (Q1)
    const strict = jsonSchemaMergeRules("draft-07", { "/format": { $: resolvers.mergeFormat } })
    expect(merge(conflict(["int32", "int64"]), { rules: strict })).toBe(false)
  })
})

describe("B16.2 cycle re-entry through a merged-away allOf (D-17, changed by D-22)", () => {
  const nodeDoc = () => ({
    definitions: {
      Node: { allOf: [{ properties: { child: { $ref: "#/definitions/Node/allOf/0" }, v: { type: "string" } } }, { required: ["v"] }] },
    },
  })

  it("B16.2.1 whole-document merge: Node is merged, the cycle re-entry points to the output location of the copy (D-22)", () => {
    const doc = nodeDoc()
    const { result, mergeErrors, refErrors } = mergeReport(clone(doc))
    // before D-17: Node was merged and child.properties.child pointed to "#/definitions/Node/allOf/0/properties/child";
    // D-17 kept Node unmerged; D-22: child is a copy of allOf/0 (Node's merged value is stricter: required v) and the
    // re-entry inside the copy points to the copy itself
    expect(result).toEqual({
      definitions: {
        Node: {
          properties: { child: { properties: { child: { $ref: "#/definitions/Node/properties/child" }, v: { type: "string" } } }, v: { type: "string" } },
          required: ["v"],
        },
      },
    })
    expect(danglingRefs(doc, result)).toEqual([])
    expect(mergeErrors).toEqual([])
    expect(refErrors).toEqual([])
  })

  it("B16.2.2 the kept document validates like the original (ajv oracle)", () => {
    const doc = { ...nodeDoc(), properties: { root: { $ref: "#/definitions/Node" } } }
    const result = merge(clone(doc))
    expectRefsResolve(doc, result)
    const instances = [{}, { root: {} }, { root: { v: "a" } }, { root: { v: 1 } }, { root: { v: "a", child: {} } }, { root: { v: "a", child: { child: { v: 1 } } } }, { root: { v: "a", child: { v: 2 } } }]
    expectSameValidation(doc, result, instances)
  })

  it("B16.2.3 only the allOf on the pointer path is kept; other allOf nodes are merged", () => {
    const doc = {
      definitions: {
        ...nodeDoc().definitions,
        Other: { allOf: [{ type: "object" }, { properties: { n: { $ref: "#/definitions/Node" } } }] },
        Plain: { allOf: [{ type: "string" }, { minLength: 1 }] },
      },
    }
    const result = merge(clone(doc))
    expectRefsResolve(doc, result)
    expect(result.definitions.Node.allOf).toBeUndefined()
    expect(result.definitions.Node.properties.child.properties.child).toEqual({ $ref: "#/definitions/Node/properties/child" })
    expect(result.definitions.Plain).toEqual({ type: "string", minLength: 1 })
    expect(result.definitions.Other.allOf).toBeUndefined()
    expect(result.definitions.Other.type).toBe("object")
  })

  it("B16.2.4 memo re-entry (D-4) whose source pointer runs through an allOf member", () => {
    const doc = {
      definitions: {
        A: {
          allOf: [
            { properties: { next: { allOf: [{ $ref: "#/definitions/A/allOf/0" }, { required: ["x"] }] } } },
            { type: "object" },
          ],
        },
        Ref: { allOf: [{ $ref: "#/definitions/A" }, { required: ["y"] }] },
      },
      properties: { a: { $ref: "#/definitions/A" }, r: { $ref: "#/definitions/Ref" } },
    }
    const { result } = mergeReport(clone(doc))
    expectRefsResolve(doc, result)
    // the re-entry of `next ∧ {required: [x]}` (source location #/definitions/A/allOf/0/properties/next) points to the
    // output location of the conjunction, #/definitions/A/properties/next (D-22): A is merged
    expect(result.definitions.A.allOf).toBeUndefined()
    expect(result.definitions.A.properties.next.properties.next).toEqual({ $ref: "#/definitions/A/properties/next" })
    expect(result.definitions.Ref.allOf).toBeUndefined()
    for (const ref of collectRefs(result)) {
      expect(createResolutionIndex(result).resolve(ref).ok).toBe(true)
    }
    expectSameValidation(doc, result, [{}, { a: 1 }, { a: { next: {} } }, { a: { next: { x: 1 } } }, { r: {} }, { r: { y: 1 } }, { r: { y: 1, next: { x: 1, next: {} } } }])
  })

  it("B16.2.5 fragment mode: every emitted pointer resolves against source (source is not rewritten)", () => {
    const doc = nodeDoc()
    const result = merge(doc.definitions.Node, { source: doc })
    const index = createResolutionIndex(doc)
    const refs = [...collectRefs(result)]
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) { expect(index.resolve(ref).ok).toBe(true) }
  })

  it("B16.2.6 a plain bare $ref into a merged allOf (no cycle) is still inlined (D-16) and the node merged", () => {
    const doc = {
      definitions: { A: { allOf: [{ properties: { a: { type: "string" } } }, { required: ["a"] }] } },
      properties: { p: { $ref: "#/definitions/A/allOf/0" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { a: { type: "string" } }, required: ["a"] })
    expect(result.properties.p).toEqual({ properties: { a: { type: "string" } } })
    expectRefsResolve(doc, result)
  })

  it("B16.2.7 a merger reused after a D-17 call merges the next document normally", () => {
    const merger = createMerger()
    const first: any = merger.merge(nodeDoc())
    expect(first.definitions.Node.allOf).toBeUndefined()
    const second: any = merger.merge({ definitions: { Node: { allOf: [{ properties: { v: { type: "string" } } }, { required: ["v"] }] } } })
    expect(second.definitions.Node).toEqual({ properties: { v: { type: "string" } }, required: ["v"] })
  })

  it("B16.2.8 cycle through an allOf inside OpenAPI components", () => {
    const doc = oasDoc("3.0.3", {
      Node: { allOf: [{ type: "object", properties: { child: { $ref: "#/components/schemas/Node/allOf/0" } } }, { required: ["child"] }] },
      User: { allOf: [{ $ref: "#/components/schemas/Node" }, { properties: { name: { type: "string" } } }] },
    })
    const result = merge(clone(doc))
    expectRefsResolve(doc, result)
    expect(result.components.schemas.Node).toEqual({
      type: "object",
      properties: { child: { type: "object", properties: { child: { $ref: "#/components/schemas/Node/properties/child" } } } },
      required: ["child"],
    })
    expect(result.components.schemas.User.properties.child).toEqual(result.components.schemas.Node.properties.child)
  })

  it.each(["openapi30x.json", "openapi31x.json"])("B16.2.9 every $ref of the whole-document merge of %s resolves in the output", (name) => {
    const doc = loadResource(name)
    const result = merge(clone(doc))
    expectRefsResolve(doc, result)
    // the same with mergeRefSibling and mergeCombinarySibling
    expectRefsResolve(doc, merge(clone(doc), { mergeRefSibling: true, mergeCombinarySibling: true }))
  })

  it("B16.2.10 the helper reports a dangling ref (self-check)", () => {
    expect(danglingRefs({ a: { b: {} }, c: { $ref: "#/a/b" } }, { a: {}, c: { $ref: "#/a/b" } })).toEqual(["#/a/b"])
    // refs broken in the input or external refs are not checked
    expect(danglingRefs({ c: { $ref: "#/x" }, d: { $ref: "other.json#/a" } }, { c: { $ref: "#/x" }, d: { $ref: "other.json#/a" } })).toEqual([])
  })
})

describe("B16.3 tuple keywords per draft (D-18)", () => {
  const mixed = () => ({ allOf: [{ prefixItems: [{ type: "string" }] }, { items: [{ minLength: 1 }, { type: "number" }] }] })

  it.each(["draft-04", "draft-06", "draft-07"] as const)("B16.3.1 %s: array items is the tuple, prefixItems an unknown keyword", (draft) => {
    const { result, mergeErrors } = mergeReport(mixed(), { rules: jsonSchemaMergeRules(draft) })
    expect(result).toEqual({ prefixItems: [{ type: "string" }], items: [{ minLength: 1 }, { type: "number" }] })
    expect(mergeErrors).toEqual([])
  })

  it("B16.3.2 2020-12: prefixItems is the tuple, an array items is kept as an allOf fragment and reported", () => {
    const { result, mergeErrors } = mergeReport(mixed(), { rules: jsonSchemaMergeRules("2020-12") })
    expect(result).toEqual({ prefixItems: [{ type: "string" }], allOf: [{ items: [{ minLength: 1 }, { type: "number" }] }] })
    expect(mergeErrors).toHaveLength(1)
    expect(mergeErrors[0].values).toEqual([[{ minLength: 1 }, { type: "number" }]])
  })

  it("B16.3.3 draft-07: two tuples merge positionally, prefixItems stays last-wins (ajv draft-07 oracle)", () => {
    const schema = { allOf: [{ items: [{ type: "string" }], additionalItems: { type: "number" }, prefixItems: [{ const: 1 }] }, { items: [{ minLength: 1 }, { minimum: 2 }], prefixItems: [{ const: 2 }] }] }
    const result = merge(clone(schema), { rules: jsonSchemaMergeRules("draft-07") })
    expect(result).toEqual({ items: [{ type: "string", minLength: 1 }, { type: "number", minimum: 2 }], additionalItems: { type: "number" }, prefixItems: [{ const: 2 }] })
    expectSameValidation(schema, result, [[], ["a"], [""], ["a", 1], ["a", 3], ["a", 3, 4], ["a", 3, "x"], [1]], "07")
  })

  it("B16.3.4 2020-12: prefixItems + items tails merge positionally (ajv 2020 oracle)", () => {
    const schema = { allOf: [{ prefixItems: [{ type: "string" }], items: { type: "number" } }, { prefixItems: [{ minLength: 1 }, { minimum: 2 }] }, { items: { maximum: 10 } }] }
    const result = merge(clone(schema), { rules: jsonSchemaMergeRules("2020-12") })
    expect(result).toEqual({ prefixItems: [{ type: "string", minLength: 1, maximum: 10 }, { type: "number", minimum: 2, maximum: 10 }], items: { type: "number", maximum: 10 } })
    expectSameValidation(schema, result, [[], ["a"], [""], ["a", 1], ["a", 3], ["a", 3, 4], ["a", 3, 11], ["a", 3, "x"], [1]], "2020")
  })

  it("B16.3.5 2020-12: several legacy tuples are fragments (with their additionalItems); other array fragments add up", () => {
    const schema = {
      allOf: [
        { items: [{ type: "string" }], additionalItems: false, contains: { type: "string" } },
        { items: [{ minLength: 1 }] },
        { items: { maxLength: 5 }, contains: { type: "number" } },
      ],
    }
    const { result, mergeErrors } = mergeReport(clone(schema), { rules: jsonSchemaMergeRules("2020-12") })
    expect(result.items).toEqual({ maxLength: 5 })
    expect(result.allOf).toEqual([
      { items: [{ type: "string" }], additionalItems: false },
      { items: [{ minLength: 1 }] },
      { contains: { type: "string" } },
      { contains: { type: "number" } },
    ])
    expect(mergeErrors).toHaveLength(1)
  })

  it("B16.3.6 2020-12: a single array items (nothing to combine) is copied as is; a stray additionalItems is last-wins", () => {
    const single = mergeReport({ allOf: [{ items: [{ type: "string" }] }, { minItems: 1 }] }, { rules: jsonSchemaMergeRules("2020-12") })
    expect(single.result).toEqual({ items: [{ type: "string" }], minItems: 1 })
    expect(single.mergeErrors).toEqual([])
    const stray = mergeReport({ allOf: [{ prefixItems: [{}], additionalItems: false }, { prefixItems: [{ type: "string" }], additionalItems: { type: "number" } }] }, { rules: jsonSchemaMergeRules("2020-12") })
    expect(stray.result).toEqual({ prefixItems: [{ type: "string" }], additionalItems: { type: "number" } })
    expect(stray.mergeErrors).toEqual([])
  })

  it("B16.3.7 OpenAPI 3.0 follows draft-04 and OpenAPI 3.1 follows 2020-12", () => {
    const oas30 = mergeReport(oasDoc("3.0.3", { A: mixed() }))
    expect(oas30.result.components.schemas.A).toEqual({ prefixItems: [{ type: "string" }], items: [{ minLength: 1 }, { type: "number" }] })
    expect(oas30.mergeErrors).toEqual([])
    const oas31 = mergeReport(oasDoc("3.1.0", { A: mixed() }))
    expect(oas31.result.components.schemas.A).toEqual({ prefixItems: [{ type: "string" }], allOf: [{ items: [{ minLength: 1 }, { type: "number" }] }] })
    expect(oas31.mergeErrors).toHaveLength(1)
  })

  it("B16.3.8 per-key fallbacks (custom /items rule) follow the same per-draft reading", () => {
    const custom = { "/items": { $: resolvers.itemsMergeResolver } }
    const draft07 = merge(mixed(), { rules: jsonSchemaMergeRules("draft-07", custom) })
    expect(draft07).toEqual({ prefixItems: [{ type: "string" }], items: [{ minLength: 1 }, { type: "number" }] })
    const schema = { allOf: [{ prefixItems: [{ type: "string" }], items: { type: "number" } }, { items: [{ minLength: 1 }] }, { items: { minimum: 1 } }] }
    const { result, mergeErrors } = mergeReport(schema, { rules: jsonSchemaMergeRules("2020-12", custom) })
    // a custom `/items` rule without child rules leaves the tail conjunction as `allOf` (as for every custom rule, B14.12)
    expect(result).toEqual({ prefixItems: [{ type: "string", minimum: 1 }], items: { allOf: [{ type: "number" }, { minimum: 1 }] }, allOf: [{ items: [{ minLength: 1 }] }] })
    expect(mergeErrors).toHaveLength(1)
  })

  it("B16.3.9 the default rules (draft-06) no longer read prefixItems as a tuple (contract change)", () => {
    const schema = { allOf: [{ prefixItems: [{ type: "number" }] }, { items: [{}, { type: "string" }] }] }
    const result = merge(clone(schema))
    expect(result).toEqual({ prefixItems: [{ type: "number" }], items: [{}, { type: "string" }] })
    // under a draft-07 validator prefixItems is unknown: [1, 2] is rejected by both
    expectSameValidation(schema, result, [[1, 2], [1, "a"], ["a", "b"], []], "07")
  })
})

describe("B16.4 vendor and unknown keywords (D-19)", () => {
  // reports differing values and keeps the last one
  const reportingLast: MergeResolver = (args, ctx) => {
    if (args.some((value) => value !== args[0])) { ctx.mergeError(args) }
    return args[args.length - 1]
  }
  const tag = (name: string): MergeResolver => (args) => `${name}:${args.join("+")}`

  it("B16.4.1 the default for unknown and vendor keys stays a silent last-wins", () => {
    const { result, mergeErrors } = mergeReport({ allOf: [{ "x-go-type": "a", foo: 1, properties: { p: { allOf: [{ "x-go-type": "c" }, { "x-go-type": "d" }] } } }, { "x-go-type": "b", foo: 2 }] })
    expect(result).toEqual({ "x-go-type": "b", foo: 2, properties: { p: { "x-go-type": "d" } } })
    expect(mergeErrors).toEqual([])
  })

  it("B16.4.2 an exact vendor rule applies at the root and at every nested schema location", () => {
    const rules = jsonSchemaMergeRules("draft-06", { "/x-go-type": { $: reportingLast } })
    const conflict = { allOf: [{ "x-go-type": "int" }, { "x-go-type": "string" }] }
    const schema = {
      allOf: [{ "x-go-type": "A" }, { "x-go-type": "B" }],
      properties: { p: clone(conflict) },
      items: clone(conflict),
      additionalProperties: clone(conflict),
      not: clone(conflict),
      definitions: { D: clone(conflict) },
    }
    const { result, mergeErrors } = mergeReport(schema, { rules })
    expect(result["x-go-type"]).toBe("B")
    for (const node of [result.properties.p, result.items, result.additionalProperties, result.not, result.definitions.D]) {
      expect(node).toEqual({ "x-go-type": "string" })
    }
    expect(mergeErrors.map((error) => error.values)).toEqual([["A", "B"], ...Array(5).fill(["int", "string"])])
  })

  it("B16.4.3 a strict vendor rule (resolvers.equal) turns a conflict into a contradiction", () => {
    const rules = jsonSchemaMergeRules("draft-07", { "/x-go-type": { $: resolvers.equal } })
    const { result, mergeErrors } = mergeReport({ properties: { p: { allOf: [{ "x-go-type": "int" }, { "x-go-type": "string" }] }, q: { allOf: [{ "x-go-type": "int" }, { "x-go-type": "int" }] } } }, { rules })
    expect(result).toEqual({ properties: { p: false, q: { "x-go-type": "int" } } })
    expect(mergeErrors).toHaveLength(1)
  })

  it("B16.4.4 a \"/x-*\" prefix rule applies to every x- key at the root and in nested schemas", () => {
    const rules = jsonSchemaMergeRules("draft-07", { "/x-*": { $: reportingLast } })
    const conflict = { allOf: [{ "x-a": 1, "x-b": "u" }, { "x-a": 2, "x-b": "u", other: 1 }, { other: 2 }] }
    const schema = { ...clone(conflict), properties: { p: clone(conflict) }, items: clone(conflict), patternProperties: { "^z": clone(conflict) } }
    const { result, mergeErrors } = mergeReport(schema, { rules })
    for (const node of [result, result.properties.p, result.items, result.patternProperties["^z"]]) {
      expect(node).toMatchObject({ "x-a": 2, "x-b": "u", other: 2 })
    }
    // only x-a conflicts (x-b is equal, `other` is not an x- key and stays silent last-wins)
    expect(mergeErrors.map((error) => error.values)).toEqual(Array(4).fill([1, 2]))
  })

  it("B16.4.5 precedence: exact key > longest prefix > /* (json-crawl), built-in keywords are exact keys", () => {
    const rules = jsonSchemaMergeRules("draft-07", {
      "/x-exact": { $: tag("exact") },
      "/x-*": { $: tag("x") }, "/x-long-*": { $: tag("long") }, "/ti*": { $: tag("ti") },
    })
    const result = merge({ allOf: [{ "x-exact": 1, "x-long-a": 1, "x-short": 1, "x-ex": 1, title: "a", tick: 1 }, { "x-exact": 2, "x-long-a": 2, "x-short": 2, "x-ex": 2, title: "b", tick: 2 }] }, { rules })
    expect(result).toEqual({ "x-exact": "exact:1+2", "x-long-a": "long:1+2", "x-short": "x:1+2", "x-ex": "x:1+2", title: "b", tick: "ti:1+2" })
    // a "/*" rule is the lowest of the three: it applies to unknown keys only
    const star = jsonSchemaMergeRules("draft-07", { "/*": { $: tag("star") }, "/x-*": { $: tag("x") } })
    expect(merge({ allOf: [{ "x-a": 1, foo: 1, minLength: 1 }, { "x-a": 2, foo: 2, minLength: 3 }] }, { rules: star })).toEqual({ "x-a": "x:1+2", foo: "star:1+2", minLength: 3 })
  })

  it("B16.4.6 the unknown-key default is overridden with a custom \"/?\" rule (root and nested); vendor rules still win", () => {
    const rules = jsonSchemaMergeRules("draft-07", { "/?": { $: reportingLast }, "/x-*": { $: resolvers.first } })
    const conflict = { allOf: [{ foo: 1, "x-a": 1, title: "a" }, { foo: 2, "x-a": 2, title: "b" }] }
    const { result, mergeErrors } = mergeReport({ ...clone(conflict), properties: { p: clone(conflict) } }, { rules })
    expect(result).toEqual({ foo: 2, "x-a": 1, title: "b", properties: { p: { foo: 2, "x-a": 1, title: "b" } } })
    // only the unknown key `foo` is reported (title has its built-in rule)
    expect(mergeErrors.map((error) => error.values)).toEqual([[1, 2], [1, 2]])
  })

  it("B16.4.7 rule sets without a \"/?\" rule fall back to last-wins instead of throwing (0.6.8 carry-over)", () => {
    const rules: MergeRules = { ...jsonSchemaMergeRules("draft-07") }
    delete (rules as any)["/?"]
    expect(merge({ allOf: [{ foo: 1, properties: { p: { allOf: [{ bar: 1 }, { bar: 2 }] } } }, { foo: 2 }] }, { rules })).toEqual({ foo: 2, properties: { p: { bar: 2 } } })
    // a minimal hand-written rule tree
    let tree: MergeRules
    tree = {
      $: resolvers.jsonSchemaMergeResolver,
      "/allOf": { "/*": () => tree, $: resolvers.mergeArray },
      "/properties": { "/*": () => tree, $: resolvers.propertiesMergeResolver, group: "objectShape" },
    }
    expect(merge({ allOf: [{ type: "string", properties: { a: { minLength: 1 } } }, { type: "number", properties: { a: { minLength: 2 } } }] }, { rules: tree }))
      .toEqual({ type: "number", properties: { a: { minLength: 2 } } })
  })

  it.each(["3.0.x", "3.1.x"] as const)("B16.4.8 openApiMergeRules(%s, customRules) applies vendor rules at every schema location", (version) => {
    const custom = { "/x-go-type": { $: reportingLast }, "/x-ext-*": { $: tag("ext") } }
    const rules = openApiMergeRules(version, custom)
    expect(openApiMergeRules(version, custom)).toBe(rules)
    expect(openApiMergeRules(version)).not.toBe(rules)
    const conflict = { allOf: [{ "x-go-type": "int", "x-ext-a": 1 }, { "x-go-type": "string", "x-ext-a": 2 }] }
    const doc = {
      openapi: version === "3.0.x" ? "3.0.3" : "3.1.0",
      paths: { "/a": { get: { parameters: [{ name: "q", in: "query", schema: clone(conflict) }], responses: { 200: { content: { "application/json": { schema: { properties: { p: clone(conflict) } } } } } } } } },
      components: { schemas: { A: clone(conflict) } },
    }
    const { result, mergeErrors } = mergeReport(doc, { rules })
    const expected = { "x-go-type": "string", "x-ext-a": "ext:1+2" }
    expect(result.components.schemas.A).toEqual(expected)
    expect(result.paths["/a"].get.parameters[0].schema).toEqual(expected)
    expect(result.paths["/a"].get.responses[200].content["application/json"].schema.properties.p).toEqual(expected)
    expect(mergeErrors).toHaveLength(3)
    // the schema rules take the same custom rules; the OpenAPI semantics (lattice, discriminator) are kept
    const schemaRules = openApiJsonSchemaMergeRules(version, custom)
    expect(merge({ allOf: [{ format: "int32", "x-go-type": "a" }, { format: "int64", "x-go-type": "a" }] }, { rules: schemaRules })).toEqual({ format: "int32", "x-go-type": "a" })
  })

  it("B16.4.9 createGraphapiMergeRules(customRules) applies vendor rules in GraphApi schemas", () => {
    expect(createGraphapiMergeRules()).toBe(graphapiMergeRules)
    const custom = { "/x-*": { $: reportingLast } }
    const rules = createGraphapiMergeRules(custom)
    expect(createGraphapiMergeRules(custom)).toBe(rules)
    const doc = graphDoc({ A: { allOf: [{ type: "object", "x-go-type": "A" }, { "x-go-type": "B", properties: { p: { allOf: [{ "x-k": 1 }, { "x-k": 2 }] } } }] } })
    const { result, mergeErrors } = mergeReport(doc, { rules })
    expect(result.components.schemas.A).toEqual({ type: "object", "x-go-type": "B", properties: { p: { "x-k": 2 } } })
    expect(mergeErrors.map((error) => error.values)).toEqual([["A", "B"], [1, 2]])
    // GraphApi semantics are kept (nullable OR)
    expect(merge(graphDoc({ N: { allOf: [{ type: "string", nullable: false }, { nullable: true }] } }), { rules }).components.schemas.N).toEqual({ type: "string", nullable: true })
  })

  it("B16.4.10 caller-owned custom rule objects are referenced, not frozen", () => {
    const vendor = { $: reportingLast }
    const custom = { "/x-go-type": vendor }
    openApiMergeRules("3.0.x", custom)
    createGraphapiMergeRules(custom)
    jsonSchemaMergeRules("draft-07", custom)
    expect(Object.isFrozen(vendor)).toBe(false)
    expect(Object.isFrozen(custom)).toBe(false)
  })

  it("B16.4.11 vendor rules do not change validation (ajv oracle, x- keys are annotations)", () => {
    const schema = { allOf: [{ type: "object", "x-a": 1, properties: { n: { type: "number", "x-b": "u" } } }, { required: ["n"], "x-a": 2 }] }
    const rules = jsonSchemaMergeRules("draft-07", { "/x-*": { $: reportingLast } })
    const result = merge(clone(schema), { rules })
    expectSameValidation(schema, result, [{}, { n: 1 }, { n: "a" }, null, 1])
    expect(compile(result)({ n: 1 })).toBe(true)
  })
})
