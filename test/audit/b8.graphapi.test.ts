import { graphapiMergeRules } from "../../src"
import { merge, hasNoAllOf } from "./helpers"

// B8 - GraphApi rules (see docs/TEST_PLAN.md)

const doc = (components: any, extra: any = {}) => ({ graphapi: "0.1.2", ...extra, components })

describe("B8.1 rule selection and locations", () => {
  it("B8.1.1 auto-detects GraphApi documents and merges component types", () => {
    const result = merge(doc({ objects: { A: { allOf: [{ type: "object", properties: { x: { type: "string" } } }, { properties: { y: { type: "number" } } }] } } }))
    expect(result.components.objects.A).toEqual({ type: "object", properties: { x: { type: "string" }, y: { type: "number" } } })
  })

  it("B8.1.2 graphapiMergeRules is exported and usable as explicit rules", () => {
    const result = merge({ components: { objects: { A: { allOf: [{ type: "object" }, { description: "d" }] } } } }, { rules: graphapiMergeRules })
    expect(result.components.objects.A).toEqual({ type: "object", description: "d" })
  })

  it("B8.1.3 merges allOf inside queries, mutations and subscriptions and their args", () => {
    const op = { args: { properties: { id: { allOf: [{ type: "string" }, { nullable: false }] } } }, allOf: [{ type: "object" }, { description: "d" }] }
    const result = merge(doc({}, { queries: { q: op }, mutations: { m: op }, subscriptions: { s: op } }))
    for (const key of ["queries", "mutations", "subscriptions"]) {
      const node = result[key][Object.keys(result[key])[0]]
      expect(node).toMatchObject({ type: "object", description: "d" })
      expect(node.args.properties.id).toEqual({ type: "string", nullable: false })
    }
    expect(hasNoAllOf(result)).toBe(true)
  })

  it("B8.1.4 merges allOf inside directive args", () => {
    const result = merge(doc({ directives: { d: { args: { properties: { a: { allOf: [{ type: "string" }, { description: "x" }] } } } } } }))
    expect(result.components.directives.d.args.properties.a).toEqual({ type: "string", description: "x" })
  })

  it("B8.1.5 resolves $ref to other components", () => {
    const result = merge(doc({ objects: { A: { type: "object", properties: { x: { type: "string" } } }, B: { allOf: [{ $ref: "#/components/objects/A" }, { description: "B" }] } } }))
    expect(result.components.objects.B).toEqual({ type: "object", description: "B", properties: { x: { type: "string" } } })
  })
})

describe("B8.2 GraphApi keyword semantics", () => {
  const comp = (schema: any) => merge(doc({ scalars: { S: schema } })).components.scalars.S

  it("B8.2.1 nullable is OR-ed", () => {
    expect(comp({ allOf: [{ type: "string", nullable: false }, { nullable: true }] })).toEqual({ type: "string", nullable: true })
    expect(comp({ allOf: [{ type: "string", nullable: false }, { nullable: false }] })).toEqual({ type: "string", nullable: false })
  })

  it("B8.2.2 specifiedByURL: last wins", () => {
    expect(comp({ allOf: [{ specifiedByURL: "a" }, { specifiedByURL: "b" }] })).toEqual({ specifiedByURL: "b" })
  })

  it("B8.2.3 enum values objects are merged with nested descriptions and deprecations", () => {
    const result = comp({ allOf: [
      { values: { RED: { description: "r" } } },
      { values: { GREEN: { description: "g", deprecated: { reason: "old" } } } },
    ] })
    expect(result).toEqual({ values: { RED: { description: "r" }, GREEN: { description: "g", deprecated: { reason: "old" } } } })
  })

  it("B8.2.4 interfaces and directives maps are merged", () => {
    const result = comp({ allOf: [
      { interfaces: { Node: {} }, directives: { d1: { meta: { a: 1 } } } },
      { interfaces: { Entity: {} }, directives: { d2: { meta: { b: 2 } } } },
    ] })
    expect(result).toEqual({ interfaces: { Node: {}, Entity: {} }, directives: { d1: { meta: { a: 1 } }, d2: { meta: { b: 2 } } } })
  })

  it("B8.2.5 uses the JSON Schema resolvers for standard keywords", () => {
    expect(comp({ allOf: [{ type: ["string", "null"] }, { type: "string" }, { minLength: 1 }, { minLength: 3 }] })).toEqual({ type: "string", minLength: 3 })
  })
})
