import { jsonSchemaMergeRules } from "../../src"
import { merge, clone, expectAccepts, expectMergeEquivalent, expectRejects, expectSameValidation, mergeReport } from "./helpers"

// B1 - keyword-by-keyword merge semantics (see docs/TEST_PLAN.md)

describe("B1.1 type", () => {
  it("B1.1.1 keeps a single type when all items agree", () => {
    expect(merge({ allOf: [{ type: "string" }, { type: "string" }] })).toEqual({ type: "string" })
  })

  it("B1.1.2 intersects arrays of types", () => {
    const data = { allOf: [{ type: ["string", "number", "null"] }, { type: ["number", "null"] }] }
    const result = merge(data)
    expect(result).toEqual({ type: ["number", "null"] })
    expectSameValidation(data, result, ["a", 1, null, true, {}])
  })

  it("B1.1.3 collapses an array intersected with a scalar type", () => {
    const data = { allOf: [{ type: ["string", "number"] }, { type: "string" }] }
    const result = merge(data)
    expect(result).toEqual({ type: "string" })
    expectSameValidation(data, result, ["a", 1, null])
  })

  it("B1.1.4 keeps a single-element type array as a scalar", () => {
    expect(merge({ allOf: [{ type: ["string"] }, { type: ["string", "number"] }] })).toEqual({ type: "string" })
  })

  // AM-02 (fixed): integer is a subtype of number, mergeTypes compares type names as opaque strings and reports a conflict
  test("B1.1.5 integer ∧ number is integer", () => {
    const data = { allOf: [{ type: "integer" }, { type: "number" }] }
    const { result, mergeErrors } = mergeReport(data)
    expect(mergeErrors).toEqual([])
    expect(result).toEqual({ type: "integer" })
    expectSameValidation(data, result, [1, 1.5, "1"])
  })

  // AM-02 (fixed): same subtype problem for arrays of types
  test("B1.1.6 [integer, boolean] ∧ [number, string] is integer", () => {
    const data = { allOf: [{ type: ["integer", "boolean"] }, { type: ["number", "string"] }] }
    const result = merge(data)
    expect(result).toEqual({ type: "integer" })
    expectSameValidation(data, result, [1, 1.5, "1", true])
  })
})

describe("B1.2 enum and const", () => {
  it("B1.2.1 intersects enums (order of members is not significant)", () => {
    const data = { allOf: [{ enum: [1, 10, 2, "a"] }, { enum: [2, 10, 1] }] }
    const result = merge(data)
    expect([...result.enum].sort()).toEqual([1, 10, 2])
    expectSameValidation(data, result, [1, 2, 10, "a", 3])
  })

  it("B1.2.2 intersects enums with object members of identical shape", () => {
    const data = { allOf: [{ enum: [{ a: 1 }, { b: 2 }] }, { enum: [{ a: 1 }] }] }
    expect(merge(data)).toEqual({ enum: [{ a: 1 }] })
  })

  // AM-13 (fixed): enum members are compared via JSON.stringify, so equal objects with different key order are treated as different
  test("B1.2.3 enum object members are compared structurally, not by key order", () => {
    const data = { allOf: [{ enum: [{ a: 1, b: 2 }] }, { enum: [{ b: 2, a: 1 }] }] }
    const { result, mergeErrors } = mergeReport(data)
    expect(mergeErrors).toEqual([])
    expect(result.enum).toHaveLength(1)
    expectSameValidation(data, result, [{ a: 1, b: 2 }, { a: 1 }])
  })

  it("B1.2.4 keeps a single enum untouched", () => {
    expect(merge({ allOf: [{ enum: [3, 1, 2] }, { type: "number" }] })).toEqual({ enum: [3, 1, 2], type: "number" })
  })

  it("B1.2.5 keeps equal const values", () => {
    expect(merge({ allOf: [{ const: 1 }, { const: 1 }] })).toEqual({ const: 1 })
    expect(merge({ allOf: [{ const: { a: [1] } }, { const: { a: [1] } }] })).toEqual({ const: { a: [1] } })
  })

  // AM-13 (fixed): const values are compared via JSON.stringify
  test("B1.2.6 const objects are compared structurally, not by key order", () => {
    const data = { allOf: [{ const: { a: 1, b: 2 } }, { const: { b: 2, a: 1 } }] }
    const { result, mergeErrors } = mergeReport(data)
    expect(mergeErrors).toEqual([])
    expectSameValidation(data, result, [{ a: 1, b: 2 }, { a: 1 }])
  })

  it("B1.2.7 const and enum are both kept and stay equivalent", () => {
    expectMergeEquivalent({ allOf: [{ const: 1 }, { enum: [1, 2] }] }, [1, 2, 3])
  })
})

describe("B1.3 numeric bounds", () => {
  it("B1.3.1 takes the tightest minimum and maximum", () => {
    const data = { allOf: [{ minimum: 1, maximum: 10 }, { minimum: 5, maximum: 7 }] }
    const result = merge(data)
    expect(result).toEqual({ minimum: 5, maximum: 7 })
    expectSameValidation(data, result, [0, 1, 5, 6, 7, 8, 10])
  })

  it("B1.3.2 takes the tightest numeric exclusive bounds (draft-06+)", () => {
    const data = { allOf: [{ exclusiveMinimum: 1, exclusiveMaximum: 10 }, { exclusiveMinimum: 5, exclusiveMaximum: 7 }] }
    const result = merge(data)
    expect(result).toEqual({ exclusiveMinimum: 5, exclusiveMaximum: 7 })
    expectSameValidation(data, result, [1, 5, 5.5, 7, 10])
  })

  it("B1.3.3 keeps minimum and exclusiveMinimum side by side (draft-06+)", () => {
    const data = { allOf: [{ minimum: 5 }, { exclusiveMinimum: 5 }] }
    const result = merge(data)
    expect(result).toEqual({ minimum: 5, exclusiveMinimum: 5 })
    expectSameValidation(data, result, [4, 5, 6])
  })

  it("B1.3.4 draft-04 boolean exclusiveMinimum stays true when the exclusive bound wins", () => {
    const rules = jsonSchemaMergeRules("draft-04")
    expect(merge({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { minimum: 5, exclusiveMinimum: false }] }, { rules }))
      .toEqual({ minimum: 5, exclusiveMinimum: true })
    expect(merge({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { minimum: 1 }] }, { rules }))
      .toEqual({ minimum: 5, exclusiveMinimum: true })
  })

  // AM-10 (fixed): boolean exclusiveMinimum is OR-ed regardless of which minimum wins; x=5 is valid for both inputs but the merged schema rejects it
  test("B1.3.5 draft-04 boolean exclusiveMinimum is dropped when a larger inclusive minimum wins", () => {
    const rules = jsonSchemaMergeRules("draft-04")
    const result = merge({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] }, { rules })
    expect(result.minimum).toBe(5)
    expect(result.exclusiveMinimum).not.toBe(true)
  })

  // AM-10 (fixed): same for exclusiveMaximum; x=5 is valid for both inputs
  test("B1.3.6 draft-04 boolean exclusiveMaximum is dropped when a smaller inclusive maximum wins", () => {
    const rules = jsonSchemaMergeRules("draft-04")
    const result = merge({ allOf: [{ maximum: 10, exclusiveMaximum: true }, { maximum: 5 }] }, { rules })
    expect(result.maximum).toBe(5)
    expect(result.exclusiveMaximum).not.toBe(true)
  })
})

describe("B1.4 multipleOf", () => {
  it("B1.4.1 uses the least common multiple for integers", () => {
    const data = { allOf: [{ multipleOf: 4 }, { multipleOf: 6 }] }
    const result = merge(data)
    expect(result).toEqual({ multipleOf: 12 })
    expectSameValidation(data, result, [12, 24, 4, 6, 8, 18])
  })

  it("B1.4.2 uses the least common multiple for more than two items", () => {
    expect(merge({ allOf: [{ multipleOf: 7 }, { multipleOf: 11 }, { multipleOf: 13 }] })).toEqual({ multipleOf: 1001 })
  })

  it("B1.4.3 handles decimal multipleOf values", () => {
    expect(merge({ allOf: [{ multipleOf: 0.5 }, { multipleOf: 0.2 }] })).toEqual({ multipleOf: 1 })
    expect(merge({ allOf: [{ multipleOf: 0.1 }, { multipleOf: 0.3 }] })).toEqual({ multipleOf: 0.3 })
    expect(merge({ allOf: [{ multipleOf: 2.5 }, { multipleOf: 1.5 }] })).toEqual({ multipleOf: 7.5 })
  })
})

describe("B1.5 strings", () => {
  it("B1.5.1 takes the tightest minLength and maxLength", () => {
    const data = { allOf: [{ minLength: 1, maxLength: 10 }, { minLength: 3, maxLength: 5 }] }
    const result = merge(data)
    expect(result).toEqual({ minLength: 3, maxLength: 5 })
    expectSameValidation(data, result, ["", "ab", "abc", "abcde", "abcdef"])
  })

  it("B1.5.2 keeps a single pattern verbatim", () => {
    expect(merge({ allOf: [{ pattern: "^a" }, { type: "string" }] })).toEqual({ pattern: "^a", type: "string" })
  })

  it("B1.5.3 combines two patterns anchored at the start", () => {
    const data = { allOf: [{ pattern: "^a" }, { pattern: "^[a-z]+$" }] }
    const result = merge(data)
    expect(typeof result.pattern).toBe("string")
    expectSameValidation(data, result, ["abc", "a1", "bcd", ""])
  })

  // AM-03 (fixed): patterns are combined as "(?=p1)(?=p2)" which evaluates both lookaheads at the same position, so "^a" and "b$" can never both hold for "ab"
  test("B1.5.4 combines a prefix pattern and a suffix pattern", () => {
    const data = { allOf: [{ pattern: "^a" }, { pattern: "b$" }] }
    const result = merge(data)
    expectSameValidation(data, result, ["ab", "axb", "a", "b", "ba"])
  })

  // AM-03 (fixed): two unanchored patterns ("contains a" and "contains b") must accept "ab" and "ba"
  test("B1.5.5 combines two unanchored patterns", () => {
    const data = { allOf: [{ pattern: "a" }, { pattern: "b" }] }
    const result = merge(data)
    expectSameValidation(data, result, ["ab", "ba", "xaxbx", "a", "b", ""])
  })

  it("B1.5.6 combining three patterns still yields a single string pattern", () => {
    const result = merge({ allOf: [{ pattern: "^a" }, { pattern: "^.b" }, { pattern: "^..c" }] })
    expect(typeof result.pattern).toBe("string")
    expectAccepts(result, ["abc", "abcd"])
    expectRejects(result, ["abd", "bbc"])
  })
})

describe("B1.6 required", () => {
  it("B1.6.1 unions required lists without duplicates", () => {
    const data = { allOf: [{ required: ["b", "a"] }, { required: ["c", "a"] }] }
    const result = merge(data)
    expect([...result.required].sort()).toEqual(["a", "b", "c"])
    expectSameValidation(data, result, [{ a: 1, b: 1, c: 1 }, { a: 1, b: 1 }, {}])
  })

  it("B1.6.2 keeps a single required list verbatim", () => {
    expect(merge({ allOf: [{ required: ["b", "a"] }, { type: "object" }] })).toEqual({ required: ["b", "a"], type: "object" })
  })
})

describe("B1.7 properties × additionalProperties × patternProperties", () => {
  it("B1.7.1 merges the same property from several items", () => {
    const data = { allOf: [{ properties: { a: { type: "string" } } }, { properties: { a: { minLength: 1 }, b: { type: "number" } } }] }
    const result = merge(data)
    expect(result).toEqual({ properties: { a: { type: "string", minLength: 1 }, b: { type: "number" } } })
    expectSameValidation(data, result, [{ a: "x" }, { a: "" }, { a: 1 }, { b: "x" }, { b: 1 }])
  })

  it("B1.7.2 removes a property forbidden by additionalProperties: false in another item", () => {
    const data = { allOf: [{ properties: { a: { type: "string" } } }, { additionalProperties: false, properties: { b: {} } }] }
    const result = merge(data)
    expect(result).toEqual({ properties: { b: {} }, additionalProperties: false })
    expectSameValidation(data, result, [{ a: "x" }, { b: 1 }, {}, { c: 1 }])
  })

  it("B1.7.3 applies an additionalProperties schema of another item to a non-common property", () => {
    const data = { allOf: [{ properties: { a: { type: "string" } } }, { additionalProperties: { minLength: 3 } }] }
    const result = merge(data)
    expect(result).toEqual({ properties: { a: { type: "string", minLength: 3 } }, additionalProperties: { minLength: 3 } })
    expectSameValidation(data, result, [{ a: "abc" }, { a: "ab" }, { a: 1 }, { z: "ab" }, { z: "abc" }])
  })

  it("B1.7.4 keeps a property that matches a patternProperties pattern of another item", () => {
    const data = { allOf: [{ properties: { foo: { type: "string" } } }, { patternProperties: { "^f": { minLength: 2 } } }] }
    const result = merge(data)
    expect(result.properties).toEqual({ foo: { type: "string" } })
    expectSameValidation(data, result, [{ foo: "ab" }, { foo: "a" }, { foo: 1 }, { far: "a" }])
  })

  // AM-04 (fixed): a property that matches none of the other item's patterns is deleted even though additionalProperties is absent (defaults to true), so the merged schema accepts { foo: 1 }
  test("B1.7.5 keeps a property that matches no pattern when additionalProperties is absent", () => {
    const data = { allOf: [{ properties: { foo: { type: "string" } } }, { patternProperties: { "^x": { minLength: 2 } } }] }
    const result = merge(data)
    expectSameValidation(data, result, [{ foo: "a" }, { foo: 1 }, { xy: "ab" }, { xy: "a" }])
  })

  // AM-04 (fixed): the property is deleted as soon as any single pattern does not match, even if another pattern matches
  test("B1.7.6 keeps a property when at least one of several patterns matches", () => {
    const data = { allOf: [{ properties: { foo: { type: "string" } } }, { patternProperties: { "^f": { minLength: 2 }, "^x": {} } }] }
    const result = merge(data)
    expectSameValidation(data, result, [{ foo: "ab" }, { foo: "a" }, { foo: 1 }, { foo: 12 }])
  })

  // AM-04 (fixed): property "b" (allowed by item 2) is deleted because it does not match the pattern of item 1, so the merged schema rejects { b: 1 }
  test("B1.7.7 keeps a property listed in one item when another item has only non-matching patternProperties", () => {
    const data = { allOf: [{ patternProperties: { "^a": { type: "string" } } }, { additionalProperties: false, properties: { b: {} } }] }
    const result = merge(data)
    expectSameValidation(data, result, [{ b: 1 }, { a1: "x" }, { a1: 1 }, {}])
  })

  it("B1.7.8 drops patternProperties forbidden by additionalProperties: false of another item", () => {
    const data = { allOf: [{ patternProperties: { "^a": { type: "string" } } }, { additionalProperties: false, properties: { a1: {} } }] }
    const result = merge(data)
    expect(result.patternProperties).toBeUndefined()
    expect(result.additionalProperties).toBe(false)
  })

  it("B1.7.9 merges the same patternProperties pattern and keeps distinct ones", () => {
    const data = { allOf: [{ patternProperties: { "^a": { type: "string" } } }, { patternProperties: { "^a": { minLength: 1 }, "^b": {} } }] }
    const result = merge(data)
    expect(result).toEqual({ patternProperties: { "^a": { type: "string", minLength: 1 }, "^b": {} } })
    expectSameValidation(data, result, [{ a: "x" }, { a: "" }, { a: 1 }, { b: 1 }])
  })

  it("B1.7.10 merges two additionalProperties schemas", () => {
    const data = { allOf: [{ additionalProperties: { type: "string" } }, { additionalProperties: { minLength: 1 } }] }
    const result = merge(data)
    expect(result).toEqual({ additionalProperties: { type: "string", minLength: 1 } })
    expectSameValidation(data, result, [{ x: "a" }, { x: "" }, { x: 1 }])
  })

  it("B1.7.11 additionalProperties true is absorbed by a schema", () => {
    expect(merge({ allOf: [{ additionalProperties: true }, { additionalProperties: { minLength: 1 } }] })).toEqual({ additionalProperties: { minLength: 1 } })
    expect(merge({ allOf: [{ additionalProperties: true }, { additionalProperties: true }] })).toEqual({ additionalProperties: true })
  })

  it("B1.7.12 additionalProperties false wins over true and over a schema", () => {
    expect(merge({ allOf: [{ additionalProperties: true }, { additionalProperties: false }] })).toEqual({ additionalProperties: false })
    expect(merge({ allOf: [{ additionalProperties: false }, { additionalProperties: { minLength: 1 } }] })).toEqual({ additionalProperties: false })
  })

  it("B1.7.13 boolean property schemas: false wins, true is absorbed", () => {
    expect(merge({ allOf: [{ properties: { a: false } }, { properties: { a: { type: "string" } } }] })).toEqual({ properties: { a: false } })
    expect(merge({ allOf: [{ properties: { a: true } }, { properties: { a: { type: "string" } } }] })).toEqual({ properties: { a: { type: "string" } } })
  })

  it("B1.7.14 takes the tightest minProperties and maxProperties", () => {
    expect(merge({ allOf: [{ minProperties: 1, maxProperties: 10 }, { minProperties: 2, maxProperties: 5 }] })).toEqual({ minProperties: 2, maxProperties: 5 })
  })
})

describe("B1.8 items, additionalItems and array keywords", () => {
  it("B1.8.1 merges two items schemas", () => {
    const data = { allOf: [{ items: { type: "string" } }, { items: { minLength: 1 } }] }
    const result = merge(data)
    expect(result).toEqual({ items: { type: "string", minLength: 1 } })
    expectSameValidation(data, result, [["a"], [""], [1], []])
  })

  // AM-19 (fixed): the items schema also applies to the positions after the tuple, so it becomes the merged additionalItems
  it("B1.8.2 applies an items schema to every element of a tuple and to the tail", () => {
    const data = { allOf: [{ items: [{ type: "string" }, { type: "number" }] }, { items: { minLength: 1 } }] }
    const result = merge(data)
    expect(result).toEqual({ items: [{ type: "string", minLength: 1 }, { type: "number", minLength: 1 }], additionalItems: { minLength: 1 } })
    expectSameValidation(data, result, [["a", 1], ["", 1], [1, 1], ["a"], ["a", 1, "b"], ["a", 1, ""]])
  })

  it("B1.8.3 merges two tuples position by position", () => {
    const data = { allOf: [{ items: [{ type: "string" }] }, { items: [{ minLength: 1 }, { type: "number" }] }] }
    const result = merge(data)
    expect(result).toEqual({ items: [{ type: "string", minLength: 1 }, { type: "number" }] })
    expectSameValidation(data, result, [["a", 1], ["", 1], ["a", "b"], ["a", 1, true]])
  })

  it("B1.8.4 additionalItems: false limits the merged tuple length", () => {
    const data = { allOf: [{ items: [{ type: "string" }], additionalItems: false }, { items: [{ minLength: 1 }, { type: "number" }] }] }
    const result = merge(data)
    expect(result).toEqual({ items: [{ type: "string", minLength: 1 }], additionalItems: false })
    expectSameValidation(data, result, [["a"], ["a", 1], [""]])
  })

  it("B1.8.5 merges additionalItems schemas of two tuples", () => {
    const data = { allOf: [{ items: [{ type: "string" }], additionalItems: { type: "string" } }, { items: [{ type: "string" }], additionalItems: { minLength: 1 } }] }
    const result = merge(data)
    expect(result.additionalItems).toEqual({ type: "string", minLength: 1 })
    expectSameValidation(data, result, [["a", "b"], ["a", ""], ["a", 1], ["a"]])
  })

  // AM-19 (fixed): a single additionalItems is passed through untouched (resolvers run only for 2+ values), so the items schema of the other item is not applied to the tail elements and ["a", ""] is accepted
  test("B1.8.6 merges an items schema into a single additionalItems", () => {
    const data = { allOf: [{ items: [{ type: "string" }], additionalItems: { type: "string" } }, { items: { minLength: 1 } }] }
    const result = merge(data)
    expect(result.additionalItems).toEqual({ type: "string", minLength: 1 })
    expectSameValidation(data, result, [["a", "b"], ["a", ""], ["", "b"]])
  })

  it("B1.8.6b merges an items schema into additionalItems when two items carry additionalItems", () => {
    const data = { allOf: [{ items: [{}], additionalItems: { type: "string" } }, { items: { minLength: 1 } }, { items: [{}], additionalItems: { maxLength: 5 } }] }
    const result = merge(clone(data))
    expect(result.additionalItems).toEqual({ type: "string", minLength: 1, maxLength: 5 })
    expectSameValidation(data, result, [["a", "b"], ["a", ""], ["", "b"], ["a", "abcdef"]])
  })

  it("B1.8.7 uniqueItems true wins", () => {
    expect(merge({ allOf: [{ uniqueItems: false }, { uniqueItems: true }] })).toEqual({ uniqueItems: true })
    expect(merge({ allOf: [{ uniqueItems: false }, { uniqueItems: false }] })).toEqual({ uniqueItems: false })
  })

  it("B1.8.8 takes the tightest minItems and maxItems", () => {
    expect(merge({ allOf: [{ minItems: 1, maxItems: 10 }, { minItems: 2, maxItems: 5 }] })).toEqual({ minItems: 2, maxItems: 5 })
  })

  // AM-12 (fixed): "contains" is merged as a schema intersection, but [contains A] ∧ [contains B] is not [contains A∧B]; ["a", 1] is valid for the original and rejected by the merged schema
  test("B1.8.9 contains keeps both constraints instead of intersecting the schemas", () => {
    const data = { allOf: [{ contains: { type: "string" } }, { contains: { type: "number" } }] }
    const { result, mergeErrors } = mergeReport(data)
    expect(mergeErrors).toEqual([])
    expectSameValidation(data, result, [["a", 1], ["a"], [1], []])
  })
})

describe("B1.9 dependencies, propertyNames, not", () => {
  it("B1.9.1 unions array dependencies", () => {
    const data = { allOf: [{ dependencies: { a: ["b"] } }, { dependencies: { a: ["c"], d: ["e"] } }] }
    const result = merge(data)
    expect([...result.dependencies.a].sort()).toEqual(["b", "c"])
    expect(result.dependencies.d).toEqual(["e"])
    expectSameValidation(data, result, [{ a: 1, b: 1, c: 1 }, { a: 1, b: 1 }, { d: 1 }, { d: 1, e: 1 }])
  })

  it("B1.9.2 merges array and schema dependencies into a schema", () => {
    const data = { allOf: [{ dependencies: { a: ["b"] } }, { dependencies: { a: { required: ["c"] } } }] }
    const result = merge(data)
    expect([...result.dependencies.a.required].sort()).toEqual(["b", "c"])
    expectSameValidation(data, result, [{ a: 1, b: 1, c: 1 }, { a: 1, b: 1 }, { a: 1, c: 1 }, { b: 1 }])
  })

  it("B1.9.3 merges propertyNames schemas", () => {
    const data = { allOf: [{ propertyNames: { pattern: "^a" } }, { propertyNames: { maxLength: 3 } }] }
    const result = merge(data)
    expect(result).toEqual({ propertyNames: { pattern: "^a", maxLength: 3 } })
    expectSameValidation(data, result, [{ ab: 1 }, { abcd: 1 }, { b: 1 }])
  })

  it("B1.9.4 merges not schemas into not anyOf", () => {
    const data = { allOf: [{ not: { type: "string" } }, { not: { type: "number" } }] }
    const result = merge(data)
    expect(result).toEqual({ not: { anyOf: [{ type: "string" }, { type: "number" }] } })
    expectSameValidation(data, result, ["a", 1, true, null])
  })
})

describe("B1.10 annotations and OpenAPI-specific keywords", () => {
  it("B1.10.1 nullable: true ∧ false is false", () => {
    expect(merge({ allOf: [{ nullable: true }, { nullable: false }] })).toEqual({ nullable: false })
  })

  // AM-11 (fixed): there is no rule for nullable so the generic "last wins" rule applies; null is accepted by the merged schema although the first item forbids it
  test("B1.10.2 nullable: false ∧ true is false", () => {
    expect(merge({ allOf: [{ nullable: false }, { nullable: true }] })).toEqual({ nullable: false })
  })

  it("B1.10.3 readOnly, writeOnly and deprecated are OR-ed", () => {
    expect(merge({ allOf: [{ readOnly: true }, { readOnly: false }] })).toEqual({ readOnly: true })
    expect(merge({ allOf: [{ writeOnly: false }, { writeOnly: true }] })).toEqual({ writeOnly: true })
    expect(merge({ allOf: [{ deprecated: false }, { deprecated: true }] })).toEqual({ deprecated: true })
    expect(merge({ allOf: [{ readOnly: false }, { readOnly: false }] })).toEqual({ readOnly: false })
  })

  it("B1.10.4 title, description, default and externalDocs: last wins; different formats are a contradiction", () => {
    const result = merge({ allOf: [
      { title: "A", description: "a", format: "f", default: 1, externalDocs: { url: "a" } },
      { title: "B", description: "b", format: "f", default: 2, externalDocs: { url: "b" } },
    ] })
    expect(result).toEqual({ title: "B", description: "b", format: "f", default: 2, externalDocs: { url: "b" } })
    // Q1 (2026-11-18, replaces D-2): two different formats make the schema false (and are reported)
    expect(merge({ allOf: [{ title: "A", format: "f1" }, { title: "B", format: "f2" }] })).toBe(false)
  })

  it("B1.10.5 examples arrays are concatenated and example objects are deep merged", () => {
    expect(merge({ allOf: [{ examples: [1, 2] }, { examples: [3] }] })).toEqual({ examples: [1, 2, 3] })
    expect(merge({ allOf: [{ example: { a: 1 } }, { example: { b: 2 } }] })).toEqual({ example: { a: 1, b: 2 } })
    expect(merge({ allOf: [{ example: "a" }, { example: "b" }] })).toEqual({ example: "b" })
  })

  it("B1.10.6 unknown keywords and x-* extensions: last wins", () => {
    expect(merge({ allOf: [{ foo: 1, "x-a": { k: 1 } }, { foo: 2, "x-a": { j: 2 } }] })).toEqual({ foo: 2, "x-a": { j: 2 } })
  })

  it("B1.10.7 definitions and $defs are merged as objects and their members are merged too", () => {
    const result = merge({ allOf: [
      { definitions: { A: { type: "string" } }, $defs: { C: { allOf: [{ type: "string" }, { minLength: 1 }] } } },
      { definitions: { B: { type: "number" } }, $defs: { D: {} } },
    ] })
    expect(result).toEqual({ definitions: { A: { type: "string" }, B: { type: "number" } }, $defs: { C: { type: "string", minLength: 1 }, D: {} } })
  })

  it("B1.10.8 xml objects are deep merged", () => {
    expect(merge({ allOf: [{ xml: { name: "a", attribute: true } }, { xml: { name: "b" } }] })).toEqual({ xml: { name: "b", attribute: true } })
  })

  it("B1.10.9 $id and $schema: last wins when both present, single value kept", () => {
    expect(merge({ allOf: [{ $id: "a", $schema: "s" }, { $id: "b" }] })).toEqual({ $id: "b", $schema: "s" })
  })

  it("B1.10.10 OpenAPI discriminator objects are deep merged", () => {
    const result = merge({ openapi: "3.0.0", components: { schemas: { A: { allOf: [
      { discriminator: { propertyName: "t" } },
      { discriminator: { mapping: { a: "#/components/schemas/B" } } },
    ] } } } })
    expect(result.components.schemas.A).toEqual({ discriminator: { propertyName: "t", mapping: { a: "#/components/schemas/B" } } })
  })

  it("B1.10.11 keeps unrelated keywords from both items", () => {
    const data = { allOf: [{ type: "object", required: ["a"] }, { properties: { a: { type: "string" } }, maxProperties: 2 }] }
    const result = merge(data)
    expect(result).toEqual({ type: "object", required: ["a"], properties: { a: { type: "string" } }, maxProperties: 2 })
    expectSameValidation(data, result, [{ a: "x" }, { a: 1 }, {}, { a: "x", b: 1, c: 1 }])
    expect(clone(data)).toEqual(data)
  })
})
