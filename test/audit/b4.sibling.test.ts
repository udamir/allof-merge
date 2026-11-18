import { describe, it, expect } from "vite-plus/test"
import { merge, expectSameValidation, mergeReport } from "./helpers.ts"

// B4 - sibling merging options: mergeRefSibling, mergeCombinarySibling

describe("B4.1 mergeRefSibling", () => {
  const data = { definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A", minLength: 1 } } }

  it("B4.1.1 merges $ref with its sibling content when enabled", () => {
    const result = merge(data, { mergeRefSibling: true })
    expect(result.properties.a).toEqual({ type: "string", minLength: 1 })
  })

  it("B4.1.2 leaves $ref with sibling content untouched by default", () => {
    expect(merge(data)).toEqual(data)
  })

  it("B4.1.3 leaves a bare $ref untouched even when enabled", () => {
    const bare = { definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A" } } }
    expect(merge(bare, { mergeRefSibling: true })).toEqual(bare)
  })

  // D-9 (VR-35): a broken $ref with siblings is left as it is and reported
  it("B4.1.4 leaves a broken $ref with siblings unchanged and reports it", () => {
    const { result, refErrors } = mergeReport({ properties: { a: { $ref: "#/nope", minLength: 1 } } }, { mergeRefSibling: true })
    expect(refErrors.map((e) => [e.ref, e.path])).toEqual([["#/nope", ["properties", "a"]]])
    expect(result.properties.a).toEqual({ $ref: "#/nope", minLength: 1 })
  })

  it("B4.1.5 merges $ref siblings of allOf items regardless of the option", () => {
    const doc = { definitions: { A: { type: "string" } }, allOf: [{ $ref: "#/definitions/A", minLength: 1 }, { maxLength: 5 }] }
    expect(merge(doc)).toMatchObject({ type: "string", minLength: 1, maxLength: 5 })
    expect(merge(doc, { mergeRefSibling: true })).toMatchObject({ type: "string", minLength: 1, maxLength: 5 })
  })

  it("B4.1.6 merges $ref siblings with a target that has its own allOf", () => {
    const doc = { definitions: { A: { allOf: [{ type: "string" }, { minLength: 1 }] } }, properties: { a: { $ref: "#/definitions/A", maxLength: 5 } } }
    const result = merge(doc, { mergeRefSibling: true })
    expect(result.properties.a).toEqual({ type: "string", minLength: 1, maxLength: 5 })
  })

  it("B4.1.7 works for refs inside OpenAPI components", () => {
    const doc = { openapi: "3.0.0", components: { schemas: { A: { type: "object" }, B: { $ref: "#/components/schemas/A", description: "B" } } } }
    const result = merge(doc, { mergeRefSibling: true })
    expect(result.components.schemas.B).toEqual({ type: "object", description: "B" })
  })
})

describe("B4.2 mergeCombinarySibling", () => {
  it("B4.2.1 pushes sibling keywords into every oneOf branch", () => {
    const data = { oneOf: [{ type: "string" }, { type: "number" }], minLength: 1 }
    const result = merge(data, { mergeCombinarySibling: true })
    expect(result).toEqual({ oneOf: [{ minLength: 1, type: "string" }, { minLength: 1, type: "number" }] })
    expectSameValidation(data, result, ["a", "", 1])
  })

  it("B4.2.2 pushes sibling keywords into every anyOf branch", () => {
    const result = merge({ anyOf: [{ type: "string" }, { type: "number" }], description: "d" }, { mergeCombinarySibling: true })
    expect(result).toEqual({ anyOf: [{ description: "d", type: "string" }, { description: "d", type: "number" }] })
  })

  it("B4.2.3 keeps definitions, $defs, $id and $schema outside the branches", () => {
    const result = merge({ anyOf: [{ type: "string" }], definitions: { X: { type: "number" } }, $defs: { Y: {} }, $id: "id", $schema: "s", description: "d" }, { mergeCombinarySibling: true })
    expect(result).toEqual({ anyOf: [{ description: "d", type: "string" }], definitions: { X: { type: "number" } }, $defs: { Y: {} }, $id: "id", $schema: "s" })
  })

  it("B4.2.4 keeps the OpenAPI discriminator outside the branches", () => {
    const result = merge({ openapi: "3.0.0", components: { schemas: { A: { oneOf: [{ type: "object" }, { type: "object" }], discriminator: { propertyName: "t" }, description: "d" } } } }, { mergeCombinarySibling: true })
    expect(result.components.schemas.A).toEqual({ oneOf: [{ description: "d", type: "object" }, { description: "d", type: "object" }], discriminator: { propertyName: "t" } })
  })

  it("B4.2.5 applies to the result of an allOf merge", () => {
    const data = { allOf: [{ oneOf: [{ type: "string" }, { type: "number" }] }, { minLength: 1 }] }
    const result = merge(data, { mergeCombinarySibling: true })
    expect(result).toEqual({ oneOf: [{ minLength: 1, type: "string" }, { minLength: 1, type: "number" }] })
    expectSameValidation(data, result, ["a", "", 1])
  })

  // a branch that conflicts with the sibling stays as `false`
  it("B4.2.6 drops branches that conflict with the sibling (false with dropFalseBranches: false)", () => {
    const data = { oneOf: [{ type: "string" }, { type: "number" }], type: "string" }
    const result = merge(data, { mergeCombinarySibling: true })
    expect(result).toEqual({ oneOf: [{ type: "string" }] })
    expectSameValidation(data, result, ["a", 1])
    const kept = merge(data, { mergeCombinarySibling: true, dropFalseBranches: false })
    expect(kept).toEqual({ oneOf: [{ type: "string" }, false] })
    expectSameValidation(data, kept, ["a", 1])
  })

  it("B4.2.7 leaves combinary siblings untouched by default", () => {
    const data = { oneOf: [{ type: "string" }, { type: "number" }], minLength: 1 }
    expect(merge(data)).toEqual(data)
  })

  it("B4.2.8 works for nested schemas", () => {
    const result = merge({ properties: { a: { oneOf: [{ type: "string" }, { type: "number" }], description: "d" } } }, { mergeCombinarySibling: true })
    expect(result.properties.a).toEqual({ oneOf: [{ description: "d", type: "string" }, { description: "d", type: "number" }] })
  })

  it("B4.2.9 leaves a combinary without siblings untouched", () => {
    const data = { oneOf: [{ type: "string" }, { type: "number" }] }
    expect(merge(data, { mergeCombinarySibling: true })).toEqual(data)
  })

  it("B4.2.10 combines two combinaries from different allOf items as a cartesian product", () => {
    const data = { allOf: [{ oneOf: [{ minLength: 1 }, { maxLength: 1 }] }, { anyOf: [{ pattern: "^a" }] }] }
    const result = merge(data)
    expect(result.oneOf).toHaveLength(2)
    expect(result.anyOf).toHaveLength(1)
    expectSameValidation(data, result, ["a", "ab", "b", ""])
  })

  it("B4.2.11 both options together work on a GraphApi-like document", () => {
    const doc = {
      graphapi: "0.1.2",
      components: { objects: { A: { type: "object", properties: { x: { type: "string" } } }, B: { $ref: "#/components/objects/A", description: "B" } } },
    }
    const result = merge(doc, { mergeRefSibling: true, mergeCombinarySibling: true })
    expect(result.components.objects.B).toEqual({ type: "object", description: "B", properties: { x: { type: "string" } } })
  })
})
