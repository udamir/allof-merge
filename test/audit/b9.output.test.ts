import { describe, it, test, expect } from "vite-plus/test"
import { merge, clone, deepFreeze, expectIdempotent, isJsonSerializable, sharesReferences } from "./helpers.ts"

// B9 - output properties: immutability, aliasing, idempotence, serializability

const cases: Record<string, any> = {
  basic: { allOf: [{ type: "string" }, { minLength: 1 }] },
  properties: { allOf: [{ properties: { a: { type: "string" } } }, { properties: { a: { minLength: 1 } }, additionalProperties: { maxLength: 3 } }] },
  patternProperties: { allOf: [{ patternProperties: { "^a": { type: "string" } } }, { patternProperties: { "^a": { minLength: 1 } }, additionalProperties: false }] },
  itemsTuple: { allOf: [{ items: [{ type: "string" }], additionalItems: false }, { items: [{ minLength: 1 }, { type: "number" }] }] },
  ref: { definitions: { A: { type: "string" } }, allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] },
  refSibling: { definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A", minLength: 1 } } },
  oneOfPrune: { oneOf: [{ allOf: [{ type: "string" }, { type: "number" }] }, { type: "number" }] },
  combinarySibling: { oneOf: [{ type: "string" }, { type: "number" }], minLength: 1 },
  combinaryProduct: { allOf: [{ oneOf: [{ a: 1 }, { a: 2 }] }, { anyOf: [{ b: 1 }] }] },
  dependencies: { allOf: [{ dependencies: { a: ["b"] } }, { dependencies: { a: { required: ["c"] } } }] },
  not: { allOf: [{ not: { type: "string" } }, { not: { type: "number" } }] },
  enumRequired: { allOf: [{ enum: [3, 1], required: ["z", "a"] }, { enum: [1, 3], required: ["a"] }] },
  pattern: { allOf: [{ pattern: "^a" }, { pattern: "^b" }] },
  nestedAllOf: { allOf: [{ allOf: [{ type: "object" }, { properties: { a: { allOf: [{ type: "string" }, { maxLength: 2 }] } } }] }, { required: ["a"] }] },
  openapi: { openapi: "3.0.0", components: { schemas: { A: { type: "object" }, B: { allOf: [{ $ref: "#/components/schemas/A" }, { description: "B" }] } } } },
}
const options = { mergeRefSibling: true, mergeCombinarySibling: true }

describe("B9.1 input is not mutated", () => {
  it.each(Object.keys(cases))("B9.1 does not mutate the input (%s)", (name) => {
    const data = clone(cases[name])
    merge(deepFreeze(clone(data)), options)
    const data2 = clone(cases[name])
    merge(data2, options)
    expect(data2).toEqual(cases[name])
  })

  // AM-14 (fixed): additionalItemsMergeResolver assigns item.allOf = itemsSchema on the input additionalItems objects
  test("B9.1.17 does not mutate the input when several additionalItems meet an items schema", () => {
    const data = { allOf: [{ items: [{}], additionalItems: { type: "string" } }, { items: { minLength: 1 } }, { items: [{}], additionalItems: { maxLength: 5 } }] }
    const copy = clone(data)
    merge(deepFreeze(clone(data)))
    merge(copy)
    expect(copy).toEqual(data)
  })
})

describe("B9.2 output does not alias the input", () => {
  it.each(Object.keys(cases))("B9.2 shares no object references with the input (%s)", (name) => {
    const data = clone(cases[name])
    const result = merge(data, options)
    expect(sharesReferences(data, result)).toBe(false)
  })

  it("B9.2.17 resolved $ref targets are copied, not aliased; the copied subtree is shared by every usage (json-crawl clone semantics)", () => {
    const shared = { type: "object", properties: { x: { type: "string" } } }
    const data = { definitions: { A: shared }, properties: { a: { allOf: [{ $ref: "#/definitions/A" }, { description: "a" }] }, b: { allOf: [{ $ref: "#/definitions/A" }, { description: "b" }] } } }
    const result = merge(data)
    expect(result.definitions.A).not.toBe(shared)
    expect(result.properties.a.properties).not.toBe(shared.properties)
    // one input object maps to exactly one output object, so the merged usages share the copied sub-schemas of the target ("properties" itself is rebuilt by the merge, its members are not)
    expect(result.properties.a.properties.x).toBe(result.properties.b.properties.x)
    expect(result.properties.a.properties.x).toBe(result.definitions.A.properties.x)
    expect(result.properties.a).not.toBe(result.properties.b)
    result.properties.a.properties.x.type = "number"
    expect(shared.properties.x.type).toBe("string")
  })

  it("B9.2.18 the same input object referenced twice yields the same output object (structure preserved)", () => {
    const common = { allOf: [{ type: "string" }, { minLength: 1 }] }
    const result = merge({ properties: { a: common, b: common } })
    expect(result.properties.a).toEqual({ type: "string", minLength: 1 })
    expect(result.properties.a).toBe(result.properties.b)
  })

  it("B9.2.19 returns a new root object even when there is nothing to merge", () => {
    const data = { type: "string" }
    const result = merge(data)
    expect(result).toEqual(data)
    expect(result).not.toBe(data)
  })
})

describe("B9.3 idempotence", () => {
  it.each(Object.keys(cases))("B9.3 merge(merge(x)) equals merge(x) (%s)", (name) => {
    expectIdempotent(cases[name], options)
  })

  it("B9.3.17 merging an already merged document is a no-op", () => {
    const once = merge(cases.nestedAllOf)
    expect(merge(once)).toEqual(once)
  })
})

describe("B9.4 serializability", () => {
  it.each(Object.keys(cases))("B9.4 output is JSON-serializable (%s)", (name) => {
    expect(isJsonSerializable(merge(clone(cases[name]), options))).toBe(true)
  })

  it("B9.4.17 output contains no undefined values for successful merges", () => {
    const result = merge(cases.nestedAllOf)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  // D-4b: cycle re-entries are written as $ref, the output is always serializable
  it("B9.4.18 cyclic $ref inside allOf produces a JSON-serializable output", () => {
    const result = merge({ definitions: { Node: { type: "object", properties: { child: { allOf: [{ $ref: "#/definitions/Node" }, { description: "c" }] } } } } })
    expect(isJsonSerializable(result)).toBe(true)
  })

  it("B9.4.19 recursive $ref outside allOf stays a string and the output stays serializable", () => {
    const result = merge({ definitions: { Node: { type: "object", properties: { child: { $ref: "#/definitions/Node" } } } }, allOf: [{ $ref: "#/definitions/Node" }, { description: "root" }] })
    expect(isJsonSerializable(result)).toBe(true)
  })
})
