import { ErrorMessage } from "../../src/errors"
import { clone, merge, compile, expectMergeEquivalent, expectRejects, expectSameValidation, mergeReport } from "./helpers"

// B2 - conflicting and impossible merges, onMergeError (see docs/TEST_PLAN.md)

// a schema that is impossible to satisfy must still be a valid schema (object or boolean) and reject every instance
const expectImpossibleSchema = (schema: unknown, instances: unknown[]) => {
  expect(schema === false || (typeof schema === "object" && schema !== null)).toBe(true)
  expectRejects(schema, instances)
}

describe("B2.1 onMergeError reporting", () => {
  it("B2.1.1 reports a type conflict with message, path and conflicting values", () => {
    const { mergeErrors } = mergeReport({ allOf: [{ type: "string" }, { type: "number" }] })
    expect(mergeErrors).toEqual([{ message: ErrorMessage.mergeError(), path: [], values: ["string", "number"] }])
  })

  it("B2.1.2 reports the path of a nested conflict", () => {
    const { mergeErrors } = mergeReport({ properties: { a: { items: { allOf: [{ type: "string" }, { type: "number" }] } } } })
    expect(mergeErrors.map((e) => e.path)).toEqual([["properties", "a", "items"]])
  })

  it("B2.1.3 reports disjoint enums", () => {
    const { mergeErrors } = mergeReport({ allOf: [{ enum: [1] }, { enum: [2] }] })
    expect(mergeErrors).toEqual([{ message: ErrorMessage.mergeError(), path: [], values: [[1], [2]] }])
  })

  it("B2.1.4 reports different const values", () => {
    const { mergeErrors } = mergeReport({ allOf: [{ const: 1 }, { const: 2 }] })
    expect(mergeErrors).toEqual([{ message: ErrorMessage.mergeError(), path: [], values: [1, 2] }])
  })

  it("B2.1.5 does not throw when no onMergeError hook is given", () => {
    expect(() => merge({ allOf: [{ type: "string" }, { type: "number" }] })).not.toThrow()
  })

  it("B2.1.6 does not report compatible merges", () => {
    const { mergeErrors } = mergeReport({ allOf: [{ type: "string", minLength: 1 }, { type: "string", maxLength: 2 }] })
    expect(mergeErrors).toEqual([])
  })
})

describe("B2.2 result of an impossible merge", () => {
  // AM-01 (fixed): the conflicting "type" is dropped from the result, which turns an impossible schema into an unconstrained one (validates more than the original)
  test("B2.2.1 string ∧ number yields a schema that rejects everything", () => {
    const { result } = mergeReport({ allOf: [{ type: "string", description: "x" }, { type: "number" }] })
    expectImpossibleSchema(result, ["s", 1, true, null, {}, []])
  })

  // AM-01 (fixed): when the conflict leaves no other keyword the whole node becomes undefined
  test("B2.2.2 the root result is still a schema when the whole node is impossible", () => {
    const { result } = mergeReport({ allOf: [{ type: "string" }, { type: "number" }] })
    expectImpossibleSchema(result, ["s", 1])
  })

  // AM-01 (fixed): the property is removed from "properties" so the merged schema accepts any value for it
  test("B2.2.3 an impossible property schema is kept as an impossible schema", () => {
    const data = { type: "object", properties: { a: { allOf: [{ type: "string" }, { type: "number" }] } } }
    const { result } = mergeReport(data)
    expect(result.properties).toHaveProperty("a")
    expectRejects(result, [{ a: "s" }, { a: 1 }])
    expect(compile(result)({})).toBe(true)
  })

  // AM-01 (fixed) / ISSUE-AM-09: "enum: []" is not a valid schema (enum must be non-empty) and ajv refuses to compile it
  test("B2.2.4 disjoint enums yield a schema that rejects everything", () => {
    const { result } = mergeReport({ allOf: [{ enum: [1] }, { enum: [2] }] })
    expectImpossibleSchema(result, [1, 2, 3])
  })

  // AM-01 (fixed): "const" is dropped and the result becomes undefined
  test("B2.2.5 different const values yield a schema that rejects everything", () => {
    const { result } = mergeReport({ allOf: [{ const: 1 }, { const: 2 }] })
    expectImpossibleSchema(result, [1, 2])
  })

  it("B2.2.6 const outside enum is kept as an (equivalent) impossible combination", () => {
    expectMergeEquivalent({ allOf: [{ const: 3 }, { enum: [1, 2] }] }, [1, 2, 3])
  })

  it("B2.2.7 minimum > maximum is kept as an (equivalent) impossible combination", () => {
    expectMergeEquivalent({ allOf: [{ minimum: 10 }, { maximum: 5 }] }, [0, 5, 7, 10, 11])
  })

  // AM-05 (fixed): boolean schema "false" inside allOf is silently dropped, the merged schema accepts "abc"
  test("B2.2.8 allOf with false yields a schema that rejects everything", () => {
    const { result } = mergeReport({ allOf: [{ type: "string" }, false] })
    expectImpossibleSchema(result, ["abc", 1])
  })

  // AM-05 (fixed): same for a property schema
  test("B2.2.9 allOf with false inside a property rejects every value of that property", () => {
    const data = { properties: { a: { allOf: [false, { type: "string" }] } } }
    const result = merge(data)
    expectRejects(result, [{ a: "x" }, { a: 1 }])
    expect(compile(result)({})).toBe(true)
  })
})

describe("B2.3 impossible branches inside oneOf / anyOf", () => {
  // DESIGN_PROPOSALS §5 row 2: an impossible branch is kept as `false` instead of being removed
  // changed by dropFalseBranches (default true, FEATURE_DESIGN decision Q3-1): the impossible branch is removed; the
  // former contract (kept as false) is the dropFalseBranches: false alternative
  it("B2.3.1 drops a single impossible oneOf branch (kept as false with dropFalseBranches: false) and does not call onMergeError", () => {
    const data = { oneOf: [{ allOf: [{ type: "string" }, { type: "number" }] }, { type: "number" }] }
    const { result, mergeErrors } = mergeReport(data)
    expect(result).toEqual({ oneOf: [{ type: "number" }] })
    expect(mergeErrors).toEqual([])
    const kept = mergeReport(data, { dropFalseBranches: false })
    expect(kept.result).toEqual({ oneOf: [false, { type: "number" }] })
    expect(kept.mergeErrors).toEqual([])
  })

  // DESIGN_PROPOSALS §5 row 1/2: the impossible property becomes `false`; the branch itself stays (it still accepts objects without `a`)
  it("B2.3.2 keeps an anyOf branch whose nested property is impossible, with the property as false", () => {
    const data = { anyOf: [{ properties: { a: { allOf: [{ type: "string" }, { type: "number" }] } } }, { type: "boolean" }] }
    const { result } = mergeReport(data)
    expect(result).toEqual({ anyOf: [{ properties: { a: false } }, { type: "boolean" }] })
    expectSameValidation(data, result, [{}, { a: "s" }, { a: 1 }, true])
  })

  // DESIGN_PROPOSALS §5 row 2: the conflicting branch stays as `false`
  it("B2.3.3 drops only the branch that conflicts with a combinary sibling (false with dropFalseBranches: false)", () => {
    const data = { oneOf: [{ type: "string" }, { type: "number" }], type: "string" }
    expect(merge(clone(data), { mergeCombinarySibling: true })).toEqual({ oneOf: [{ type: "string" }] })
    expect(merge(clone(data), { mergeCombinarySibling: true, dropFalseBranches: false })).toEqual({ oneOf: [{ type: "string" }, false] })
  })

  // AM-08 (fixed): when two branches are impossible the "nodeToDelete" map keeps only one index per parent, the other branch is written as null
  // DESIGN_PROPOSALS §5 row 2: impossible branches stay as `false`
  test("B2.3.4 drops several impossible branches [bad, bad, ok] (false each with dropFalseBranches: false)", () => {
    const data = { oneOf: [
      { allOf: [{ type: "string" }, { type: "number" }] },
      { allOf: [{ type: "string" }, { type: "number" }] },
      { type: "boolean" },
    ] }
    expect(mergeReport(clone(data)).result).toEqual({ oneOf: [{ type: "boolean" }] })
    expect(mergeReport(clone(data), { dropFalseBranches: false }).result).toEqual({ oneOf: [false, false, { type: "boolean" }] })
  })

  // AM-08 (fixed): same with the good branch in the middle
  test("B2.3.5 drops several impossible branches [bad, ok, bad] (false each with dropFalseBranches: false)", () => {
    const data = { oneOf: [
      { allOf: [{ type: "string" }, { type: "number" }] },
      { type: "boolean" },
      { allOf: [{ type: "string" }, { type: "number" }] },
    ] }
    expect(mergeReport(clone(data)).result).toEqual({ oneOf: [{ type: "boolean" }] })
    expect(mergeReport(clone(data), { dropFalseBranches: false }).result).toEqual({ oneOf: [false, { type: "boolean" }, false] })
  })

  // AM-08 (fixed): when every branch is impossible the result is { oneOf: [null] }, which is not a schema
  test("B2.3.6 all branches impossible yields a schema without null entries that rejects everything", () => {
    const { result } = mergeReport({ oneOf: [
      { allOf: [{ type: "string" }, { type: "number" }] },
      { allOf: [{ type: "boolean" }, { type: "number" }] },
    ] })
    if (result && Array.isArray(result.oneOf)) {
      expect(result.oneOf).not.toContain(null)
      expect(result.oneOf).not.toContain(undefined)
    }
    expectImpossibleSchema(result, ["s", 1, true])
  })

  it("B2.3.6b reports a combinary whose every branch is impossible", () => {
    const { mergeErrors } = mergeReport({ oneOf: [
      { allOf: [{ type: "string" }, { type: "number" }] },
      { allOf: [{ type: "boolean" }, { type: "number" }] },
    ] })
    expect(mergeErrors.map((e) => e.path)).toEqual([["oneOf"]])
  })

  // DESIGN_PROPOSALS §5 row 2: the impossible nested branch stays as `false`
  it("B2.3.7 drops a branch of a nested oneOf without touching the outer one", () => {
    const data = { oneOf: [{ oneOf: [{ allOf: [{ type: "string" }, { type: "number" }] }, { type: "boolean" }] }, { type: "null" }] }
    expect(mergeReport(clone(data)).result).toEqual({ oneOf: [{ oneOf: [{ type: "boolean" }] }, { type: "null" }] })
    expect(mergeReport(clone(data), { dropFalseBranches: false }).result).toEqual({ oneOf: [{ oneOf: [false, { type: "boolean" }] }, { type: "null" }] })
  })

  // AM-09 (fixed): a tuple position whose schemas conflict is written as null
  test("B2.3.8 a conflicting tuple position does not produce null in items", () => {
    const { result } = mergeReport({ allOf: [
      { items: [{ type: "string" }], additionalItems: { type: "boolean" } },
      { items: [{ minLength: 1 }, { type: "number" }] },
    ] })
    expect(result.items).toHaveLength(2)
    expect(result.items[1]).not.toBeNull()
    expectRejects(result, [["a", 1], ["a", true]])
  })
})
