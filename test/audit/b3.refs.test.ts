import { merge, expectSameValidation, isJsonSerializable, mergeReport } from "./helpers"

// B3 - $ref handling (see docs/TEST_PLAN.md)

describe("B3.1 internal references", () => {
  it("B3.1.1 resolves a simple internal $ref inside allOf", () => {
    const data = { definitions: { A: { type: "string" } }, allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] }
    const result = merge(data)
    expect(result).toEqual({ type: "string", minLength: 1, definitions: { A: { type: "string" } } })
    expectSameValidation(data, result, ["a", "", 1])
  })

  it("B3.1.2 decodes ~1 and ~0 escapes in pointers", () => {
    const data = { definitions: { "a/b": { "c~d": { type: "string" } } }, allOf: [{ $ref: "#/definitions/a~1b/c~0d" }, { minLength: 1 }] }
    const result = merge(data)
    expect(result).toMatchObject({ type: "string", minLength: 1 })
    expect(result.allOf).toBeUndefined()
  })

  it("B3.1.3 decodes percent-encoded pointer segments", () => {
    const result = merge({ definitions: { "a b": { type: "string" } }, allOf: [{ $ref: "#/definitions/a%20b" }, { minLength: 1 }] })
    expect(result).toMatchObject({ type: "string", minLength: 1 })
  })

  it("B3.1.4 follows a $ref to a $ref", () => {
    const data = { definitions: { A: { $ref: "#/definitions/B" }, B: { type: "string" } }, allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] }
    const result = merge(data)
    expect(result).toMatchObject({ type: "string", minLength: 1 })
    expect(result.$ref).toBeUndefined()
  })

  it("B3.1.5 merges sibling content of an intermediate $ref target", () => {
    const result = merge({ definitions: { A: { $ref: "#/definitions/B", description: "d" }, B: { type: "string" } }, allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] })
    expect(result).toMatchObject({ type: "string", minLength: 1, description: "d" })
  })

  it("B3.1.6 resolves a $ref whose target itself contains allOf", () => {
    const data = { definitions: { A: { allOf: [{ type: "string" }, { minLength: 1 }] } }, allOf: [{ $ref: "#/definitions/A" }, { maxLength: 5 }] }
    const result = merge(data)
    expect(result).toEqual({ type: "string", minLength: 1, maxLength: 5, definitions: { A: { type: "string", minLength: 1 } } })
    expectSameValidation(data, result, ["a", "", "abcdef"])
  })

  it("B3.1.7 resolves a pointer that walks through an allOf item of the source", () => {
    const result = merge({ definitions: { A: { allOf: [{ properties: { x: { type: "string" } } }] } }, allOf: [{ $ref: "#/definitions/A/allOf/0/properties/x" }, { maxLength: 5 }] })
    expect(result).toMatchObject({ type: "string", maxLength: 5 })
  })

  it("B3.1.8 reports a pointer that only exists in the merged output as unresolvable (documented limitation)", () => {
    const { result, refErrors } = mergeReport({ definitions: { A: { allOf: [{ properties: { x: { type: "string" } } }, { properties: { x: { minLength: 1 } } }] } }, allOf: [{ $ref: "#/definitions/A/properties/x" }, { maxLength: 5 }] })
    expect(refErrors.map((e) => e.ref)).toEqual(["#/definitions/A/properties/x"])
    expect(result.allOf).toBeDefined()
  })

  it("B3.1.9 resolves a $ref pointing into an array", () => {
    const result = merge({ items: [{ type: "string" }], allOf: [{ $ref: "#/items/0" }, { minLength: 1 }] })
    expect(result).toEqual({ type: "string", minLength: 1, items: [{ type: "string" }] })
  })

  it("B3.1.10 leaves a $ref outside allOf untouched", () => {
    const data = { definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A" } } }
    expect(merge(data)).toEqual(data)
  })

  it("B3.1.11 resolves against the source option when merging a fragment", () => {
    const source = { definitions: { A: { type: "string" } } }
    expect(merge({ allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] }, { source })).toEqual({ type: "string", minLength: 1 })
  })

  it("B3.1.12 resolves OpenAPI component refs against the source option with explicit rules", () => {
    const source = { openapi: "3.0.0", components: { schemas: { A: { type: "string" } } } }
    expect(merge({ allOf: [{ $ref: "#/components/schemas/A" }, { minLength: 1 }] }, { source })).toEqual({ type: "string", minLength: 1 })
  })
})

describe("B3.2 broken and external references", () => {
  it("B3.2.1 calls onRefResolveError for a broken $ref and keeps the allOf", () => {
    const { result, refErrors } = mergeReport({ allOf: [{ $ref: "#/nope" }, { type: "string" }] })
    expect(refErrors).toEqual([{ message: "Cannot resolve $ref", path: [], ref: "#/nope" }])
    expect(result).toEqual({ allOf: [{ $ref: "#/nope" }, { type: "string" }] })
  })

  it("B3.2.2 reports the path of a nested broken $ref", () => {
    const { result, refErrors } = mergeReport({ properties: { a: { allOf: [{ $ref: "#/nope" }, { type: "string" }, { minLength: 1 }] } } })
    expect(refErrors.map((e) => e.path)).toEqual([["properties", "a"]])
    expect(result.properties.a.allOf).toHaveLength(3)
  })

  it("B3.2.3 reports a broken $ref when the source option does not contain the target", () => {
    const { result, refErrors } = mergeReport({ allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] }, { source: { definitions: {} } })
    expect(refErrors.map((e) => e.ref)).toEqual(["#/definitions/A"])
    expect(result).toEqual({ allOf: [{ $ref: "#/definitions/A" }, { minLength: 1 }] })
  })

  // AM-15 (fixed): on a broken $ref the sibling keys of the node (here "definitions") are moved into a new allOf item, which changes the document structure and breaks every "#/definitions/..." pointer
  test("B3.2.4 keeps root siblings in place when a $ref inside allOf is broken", () => {
    const data = { definitions: { A: { type: "string" } }, allOf: [{ $ref: "#/nope" }, { type: "string" }] }
    const { result } = mergeReport(data)
    expect(result.definitions).toEqual({ A: { type: "string" } })
  })

  it("B3.2.5 still resolves the good $ref items next to a broken one", () => {
    const { result, refErrors } = mergeReport({ definitions: { A: { type: "string" } }, allOf: [{ $ref: "#/nope" }, { $ref: "#/definitions/A" }, { minLength: 1 }] })
    expect(refErrors.map((e) => e.ref)).toEqual(["#/nope"])
    expect(result.allOf).toEqual(expect.arrayContaining([{ $ref: "#/nope" }, { type: "string" }, { minLength: 1 }]))
  })

  it("B3.2.6 leaves an external $ref untouched and reports it", () => {
    const { result, refErrors } = mergeReport({ allOf: [{ $ref: "other.json#/A" }, { type: "string" }] })
    expect(refErrors.map((e) => e.ref)).toEqual(["other.json#/A"])
    expect(result).toEqual({ allOf: [{ $ref: "other.json#/A" }, { type: "string" }] })
  })

  it("B3.2.7 leaves an external $ref outside allOf untouched without reporting", () => {
    const { result, refErrors } = mergeReport({ properties: { a: { $ref: "other.json#/A" } } })
    expect(refErrors).toEqual([])
    expect(result).toEqual({ properties: { a: { $ref: "other.json#/A" } } })
  })

  it("B3.2.8 does not throw on a broken $ref without onRefResolveError", () => {
    expect(() => merge({ allOf: [{ $ref: "#/nope" }, { type: "string" }] })).not.toThrow()
  })
})

describe("B3.3 cyclic references", () => {
  it("B3.3.1 skips a $ref that points at the allOf node itself", () => {
    expect(merge({ properties: { a: { allOf: [{ $ref: "#/properties/a" }, { type: "string" }] } } })).toEqual({ properties: { a: { type: "string" } } })
  })

  // D-4b: the cycle re-entry is a $ref to the source location of the re-entered node (serializable output)
  it("B3.3.2 resolves $ref: '#' inside allOf, the re-entry is a $ref", () => {
    const data = { type: "object", properties: { a: { allOf: [{ $ref: "#" }, { description: "x" }] } } }
    const result = merge(data)
    expect(result.properties.a.type).toBe("object")
    expect(result.properties.a.description).toBe("x")
    expect(result.properties.a.properties.a).toEqual({ $ref: "#/properties/a" })
    expect(isJsonSerializable(result)).toBe(true)
    expectSameValidation(data, result, [{}, { a: 1 }, { a: {} }, { a: { a: { a: {} } } }, { a: { a: 1 } }])
  })

  it("B3.3.3 resolves a self-recursive definition used inside its own allOf", () => {
    const result = merge({ definitions: { Node: { type: "object", properties: { child: { allOf: [{ $ref: "#/definitions/Node" }, { description: "child" }] } } } } })
    const child = result.definitions.Node.properties.child
    expect(child).toMatchObject({ type: "object", description: "child" })
    expect(child.properties.child).toEqual({ $ref: "#/definitions/Node/properties/child" })
    expect(isJsonSerializable(result)).toBe(true)
  })

  it("B3.3.4 merges an indirect cycle A -> B -> A and keeps all constraints", () => {
    const result = merge({ definitions: {
      A: { allOf: [{ $ref: "#/definitions/B" }, { minLength: 1 }] },
      B: { allOf: [{ $ref: "#/definitions/A" }, { maxLength: 5 }] },
    } })
    expect(result.definitions.A).toEqual({ minLength: 1, maxLength: 5 })
    expect(result.definitions.B).toEqual({ minLength: 1, maxLength: 5 })
  })

  it("B3.3.5 merges a three-node cycle A -> B -> C -> A", () => {
    const result = merge({ definitions: {
      A: { allOf: [{ $ref: "#/definitions/B" }, { minLength: 1 }] },
      B: { allOf: [{ $ref: "#/definitions/C" }, { maxLength: 5 }] },
      C: { allOf: [{ $ref: "#/definitions/A" }, { type: "string" }] },
    } })
    for (const key of ["A", "B", "C"]) {
      expect(result.definitions[key]).toEqual({ type: "string", minLength: 1, maxLength: 5 })
    }
  })

  it("B3.3.6 keeps a non-allOf recursive $ref as a string", () => {
    const data = { definitions: { Node: { type: "object", properties: { child: { $ref: "#/definitions/Node" } } } } }
    expect(merge(data)).toEqual(data)
  })

  it("B3.3.7 uses a recursive definition from the outside", () => {
    const result = merge({ definitions: { Node: { type: "object", properties: { child: { $ref: "#/definitions/Node" } } } }, allOf: [{ $ref: "#/definitions/Node" }, { description: "root" }] })
    expect(result).toEqual({ type: "object", description: "root", properties: { child: { $ref: "#/definitions/Node" } }, definitions: { Node: { type: "object", properties: { child: { $ref: "#/definitions/Node" } } } } })
  })

  it("B3.3.8 handles cyclic JavaScript references without $ref", () => {
    const data: any = { type: "object", properties: { a: { allOf: [{ description: "a" }] } } }
    data.properties.a.allOf.push(data)
    const result = merge(data)
    expect(result.properties.a).toMatchObject({ type: "object", description: "a" })
    expect(result.properties.a.properties.a).toEqual({ $ref: "#/properties/a" })
    expect(isJsonSerializable(result)).toBe(true)
  })

  // AM-07 (fixed): cycle detection stringifies the allOf items (normalize.ts) as soon as one of them is a $ref, which throws on cyclic JavaScript input
  test("B3.3.9 handles cyclic JavaScript references mixed with $ref items", () => {
    const data: any = { properties: { a: { allOf: [{ $ref: "#/properties/b" }] }, b: { type: "string" } } }
    data.properties.a.allOf.push(data)
    expect(() => merge(data)).not.toThrow()
  })

  it("B3.3.10 resolves a cross cycle between two properties", () => {
    const result = merge({ type: "object", properties: {
      foo: { allOf: [{ description: "foo" }, { $ref: "#/properties/baz" }] },
      baz: { properties: { test: { $ref: "#/properties/foo" } } },
    } })
    expect(result.properties.foo).toMatchObject({ description: "foo", properties: { test: { $ref: "#/properties/foo" } } })
    expect(result.properties.baz).toEqual({ properties: { test: { $ref: "#/properties/foo" } } })
  })
})
