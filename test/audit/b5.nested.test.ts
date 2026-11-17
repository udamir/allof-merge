import { merge, expectSameValidation, hasNoAllOf } from "./helpers"

// B5 - allOf nested inside other keywords (see docs/TEST_PLAN.md)

const inner = { allOf: [{ type: "string" }, { minLength: 1 }] }
const merged = { type: "string", minLength: 1 }

describe("B5.1 allOf inside schema keywords", () => {
  it.each([
    ["properties", { properties: { a: inner } }, (r: any) => r.properties.a],
    ["patternProperties", { patternProperties: { "^a": inner } }, (r: any) => r.patternProperties["^a"]],
    ["additionalProperties", { additionalProperties: inner }, (r: any) => r.additionalProperties],
    ["items (schema)", { items: inner }, (r: any) => r.items],
    ["items (tuple)", { items: [inner, inner] }, (r: any) => r.items[1]],
    ["additionalItems", { items: [{}], additionalItems: inner }, (r: any) => r.additionalItems],
    ["contains", { contains: inner }, (r: any) => r.contains],
    ["propertyNames", { propertyNames: { allOf: [{ pattern: "^a" }, { maxLength: 2 }] } }, (r: any) => r.propertyNames],
    ["definitions", { definitions: { A: inner } }, (r: any) => r.definitions.A],
    ["$defs", { $defs: { A: inner } }, (r: any) => r.$defs.A],
    ["dependencies (schema)", { dependencies: { a: { allOf: [{ required: ["b"] }, { required: ["c"] }] } } }, (r: any) => r.dependencies.a],
    ["oneOf branch", { oneOf: [inner, { type: "number" }] }, (r: any) => r.oneOf[0]],
    ["anyOf branch", { anyOf: [inner, { type: "number" }] }, (r: any) => r.anyOf[0]],
  ])("B5.1 merges allOf nested in %s", (_name, data, pick) => {
    const result = merge(data)
    const node = pick(result)
    expect(node.allOf).toBeUndefined()
    expect(hasNoAllOf(result)).toBe(true)
    if (_name === "propertyNames") {
      expect(node).toEqual({ pattern: "^a", maxLength: 2 })
    } else if (_name.startsWith("dependencies")) {
      expect([...node.required].sort()).toEqual(["b", "c"])
    } else {
      expect(node).toEqual(merged)
    }
  })

  // AM-18 (fixed): the "/not" rule has no child rules, so allOf under "not" is never merged
  test("B5.1.14 merges allOf nested in not", () => {
    const result = merge({ not: inner })
    expect(result).toEqual({ not: merged })
  })

  it("B5.1.15 merges allOf nested inside an allOf item (flattening)", () => {
    const data = { allOf: [{ allOf: [{ type: "string" }, { allOf: [{ minLength: 1 }] }] }, { maxLength: 5 }] }
    const result = merge(data)
    expect(result).toEqual({ type: "string", minLength: 1, maxLength: 5 })
    expectSameValidation(data, result, ["a", "", "abcdef"])
  })

  it("B5.1.16 merges allOf items that have both allOf and sibling content", () => {
    const data = { allOf: [{ allOf: [{ type: "string" }], minLength: 1 }, { maxLength: 5 }] }
    const result = merge(data)
    expect(result).toEqual({ type: "string", minLength: 1, maxLength: 5 })
  })

  it("B5.1.17 merges allOf that lives next to other keywords (sibling content of the allOf node)", () => {
    const data = { type: "object", required: ["a"], allOf: [{ properties: { a: { type: "string" } } }, { properties: { a: { minLength: 1 } } }] }
    const result = merge(data)
    expect(result).toEqual({ type: "object", required: ["a"], properties: { a: { type: "string", minLength: 1 } } })
    expectSameValidation(data, result, [{ a: "x" }, { a: "" }, {}])
  })

  it("B5.1.18 merges allOf produced by merging properties (two levels)", () => {
    const data = { allOf: [
      { properties: { a: { properties: { b: { type: "string" } } } } },
      { properties: { a: { properties: { b: { minLength: 1 } }, required: ["b"] } } },
    ] }
    const result = merge(data)
    expect(result).toEqual({ properties: { a: { properties: { b: { type: "string", minLength: 1 } }, required: ["b"] } } })
    expectSameValidation(data, result, [{ a: { b: "x" } }, { a: { b: "" } }, { a: {} }])
  })

  it("B5.1.19 merges allOf inside oneOf branches combined with an outer allOf", () => {
    const data = { allOf: [{ oneOf: [{ allOf: [{ type: "string" }, { minLength: 1 }] }, { type: "number" }] }, { description: "d" }] }
    const result = merge(data)
    expect(hasNoAllOf(result)).toBe(true)
    expect(result).toEqual({ oneOf: [{ type: "string", minLength: 1 }, { type: "number" }], description: "d" })
  })

  it("B5.1.20 merges allOf within a deep mixed structure", () => {
    const data = {
      type: "object",
      properties: {
        list: { type: "array", items: { oneOf: [{ properties: { x: inner } }, { additionalProperties: inner }] } },
        map: { type: "object", additionalProperties: { items: [inner], additionalItems: inner } },
      },
    }
    const result = merge(data)
    expect(hasNoAllOf(result)).toBe(true)
    expect(result.properties.list.items.oneOf[0].properties.x).toEqual(merged)
    expect(result.properties.list.items.oneOf[1].additionalProperties).toEqual(merged)
    expect(result.properties.map.additionalProperties.items[0]).toEqual(merged)
    expect(result.properties.map.additionalProperties.additionalItems).toEqual(merged)
    expectSameValidation(data, result, [{ list: [{ x: "a" }], map: { k: ["a", "b"] } }, { list: [{ x: "" }] }, { map: { k: ["a", ""] } }])
  })
})

describe("B5.2 allOf outside schema positions", () => {
  it("B5.2.1 does not merge allOf under an unknown key of a JSON Schema document", () => {
    const data = { foo: { allOf: [{ type: "string" }, { minLength: 1 }] } }
    expect(merge(data)).toEqual(data)
  })

  it("B5.2.2 does not merge allOf in an OpenAPI location that is not a schema", () => {
    const data = { openapi: "3.0.0", info: { title: "t", allOf: [{ a: 1 }, { b: 2 }] }, components: { schemas: { A: inner } } }
    const result = merge(data)
    expect(result.info).toEqual(data.info)
    expect(result.components.schemas.A).toEqual(merged)
  })
})
