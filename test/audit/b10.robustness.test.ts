import { describe, it, test, expect } from "vite-plus/test"
import { merge, compile, expectRejects, hasNoAllOf, mergeReport } from "./helpers.ts"

// B10 - robustness: odd inputs, boolean schemas, empty allOf, large inputs

describe("B10.1 non-object and degenerate inputs", () => {
  it.each([
    ["number", 5],
    ["string", "abc"],
    ["boolean true", true],
    ["boolean false", false],
    ["null", null],
  ])("B10.1 returns primitive input unchanged (%s)", (_name, value) => {
    expect(merge(value)).toBe(value)
  })

  it("B10.1.6 returns undefined for undefined input", () => {
    expect(merge(undefined)).toBeUndefined()
  })

  it("B10.1.7 does not merge schemas inside a root array (root is not a schema)", () => {
    const data = [{ allOf: [{ type: "string" }, { minLength: 1 }] }]
    expect(merge(data)).toEqual(data)
  })

  it("B10.1.8 empty object stays empty", () => {
    expect(merge({})).toEqual({})
  })
})

describe("B10.2 degenerate allOf", () => {
  it("B10.2.1 removes an empty allOf", () => {
    expect(merge({ allOf: [], type: "string" })).toEqual({ type: "string" })
    expect(merge({ allOf: [] })).toEqual({})
  })

  it("B10.2.2 unwraps a single-item allOf", () => {
    expect(merge({ allOf: [{ type: "string" }] })).toEqual({ type: "string" })
  })

  it("B10.2.3 ignores non-object allOf items", () => {
    expect(merge({ allOf: [{ type: "string" }, 5 as any, null as any, "str" as any] })).toEqual({ type: "string" })
  })

  it("B10.2.4 drops an allOf that is not an array", () => {
    expect(merge({ allOf: { type: "string" } as any, minLength: 1 })).toEqual({ minLength: 1 })
  })

  it("B10.2.5 allOf of only true schemas is the empty schema", () => {
    expect(merge({ allOf: [true, true] })).toEqual({})
    expect(merge({ allOf: [{ type: "string" }, true] })).toEqual({ type: "string" })
  })

  // 0.x bug, fixed: jsonSchemaMergeResolver returns undefined when the merged object has no keys, so allOf of empty schemas yields undefined instead of {}
  test("B10.2.6 allOf of empty schemas is the empty schema", () => {
    expect(merge({ allOf: [{}, {}] })).toEqual({})
  })

  // 0.x bug, fixed: the undefined result removes the property from "properties"
  test("B10.2.7 a property with allOf of empty schemas is kept", () => {
    expect(merge({ properties: { a: { allOf: [{}, {}] } } })).toEqual({ properties: { a: {} } })
  })

  // 0.x bug, fixed: tuple positions that merge to the empty schema become null
  test("B10.2.8 tuple positions that merge to the empty schema are kept as {}", () => {
    const result = merge({ allOf: [{ items: [{}], additionalItems: { type: "string" } }, { items: [{}], additionalItems: { minLength: 1 } }] })
    expect(result.items).toEqual([{}])
  })

  // 0.x bug, fixed: false inside allOf is dropped
  test("B10.2.9 allOf containing false rejects everything", () => {
    const result = merge({ allOf: [false] })
    expectRejects(result, [1, "a", {}])
  })

  it("B10.2.10 duplicated allOf items merge to the single item", () => {
    const item = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
    expect(merge({ allOf: [item, { ...item }] })).toEqual(item)
  })

  it("B10.2.11 the same JS object used twice in one allOf merges to itself", () => {
    const item = { type: "object", required: ["a"] }
    expect(merge({ allOf: [item, item] })).toEqual(item)
  })
})

describe("B10.3 large inputs terminate and produce correct output", () => {
  it("B10.3.1 wide schema: 5000 properties each with allOf", () => {
    const properties: any = {}
    for (let i = 0; i < 5000; i++) {
      properties["p" + i] = { allOf: [{ type: "string", description: "d" + i }, { minLength: 1, maxLength: 10 }] }
    }
    const result = merge({ type: "object", properties })
    expect(Object.keys(result.properties)).toHaveLength(5000)
    expect(result.properties.p4999).toEqual({ type: "string", description: "d4999", minLength: 1, maxLength: 10 })
    expect(hasNoAllOf(result)).toBe(true)
  })

  it("B10.3.2 deep schema: 1000 nested properties levels, allOf on every level", () => {
    let schema: any = { allOf: [{ type: "string" }, { minLength: 1 }] }
    for (let i = 0; i < 1000; i++) {
      schema = { type: "object", properties: { a: schema }, allOf: [{ required: ["a"] }, { description: "lvl" + i }] }
    }
    const result = merge(schema)
    let depth = 0
    let node = result
    while (node.properties) {
      expect(node).toMatchObject({ type: "object", required: ["a"] })
      node = node.properties.a
      depth++
    }
    expect(depth).toBe(1000)
    expect(node).toEqual({ type: "string", minLength: 1 })
  })

  it("B10.3.3 deep allOf nesting: 1000 levels of allOf inside allOf are flattened", () => {
    let schema: any = { type: "string" }
    for (let i = 0; i < 1000; i++) {
      schema = { allOf: [schema, { ["x" + i]: i }] }
    }
    const result = merge(schema)
    expect(result.type).toBe("string")
    expect(Object.keys(result)).toHaveLength(1001)
    expect(hasNoAllOf(result)).toBe(true)
  })

  it("B10.3.4 long allOf chain: 200 items", () => {
    const items: any[] = []
    for (let i = 0; i < 200; i++) {
      items.push({ type: "object", properties: { ["p" + i]: { type: "string" } }, required: ["p" + i] })
    }
    const result = merge({ allOf: items })
    expect(Object.keys(result.properties)).toHaveLength(200)
    expect(result.required).toHaveLength(200)
    expect(result.type).toBe("object")
  })

  it("B10.3.5 many usages of one shared $ref: 1000 usages", () => {
    const properties: any = {}
    for (let i = 0; i < 1000; i++) {
      properties["p" + i] = { allOf: [{ $ref: "#/definitions/Shared" }, { description: "d" + i }] }
    }
    const result = merge({ definitions: { Shared: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }, type: "object", properties })
    expect(result.properties.p0).toEqual({ type: "object", properties: { x: { type: "string" } }, required: ["x"], description: "d0" })
    expect(result.properties.p999.description).toBe("d999")
    expect(hasNoAllOf(result)).toBe(true)
  })

  it("B10.3.6 cyclic graph: ring of 100 definitions referencing each other through allOf", () => {
    const definitions: any = {}
    const n = 100
    for (let i = 0; i < n; i++) {
      definitions["N" + i] = { type: "object", properties: { next: { allOf: [{ $ref: "#/definitions/N" + ((i + 1) % n) }, { description: "to " + ((i + 1) % n) }] } } }
    }
    const result = merge({ definitions })
    expect(result.definitions.N0.properties.next).toMatchObject({ type: "object", description: "to 1" })
    expect(hasNoAllOf(result)).toBe(true)
  })

  it("B10.3.7 cyclic JavaScript graph without $ref", () => {
    const nodes: any[] = []
    const n = 50
    for (let i = 0; i < n; i++) {
      nodes.push({ type: "object", properties: {} })
    }
    for (let i = 0; i < n; i++) {
      nodes[i].properties.next = { allOf: [nodes[(i + 1) % n], { description: "d" + i }] }
    }
    const result = merge({ definitions: Object.fromEntries(nodes.map((v, i) => ["N" + i, v])) })
    expect(result.definitions.N0.properties.next).toMatchObject({ type: "object", description: "d0" })
  })

  it("B10.3.8 merge called on every node of a tree gives the same result as a single merge", () => {
    const build = (d: number): any => d === 0
      ? { allOf: [{ type: "string" }, { minLength: 1 }] }
      : { type: "object", properties: Object.fromEntries(Array.from({ length: 3 }, (_, i) => ["p" + i, build(d - 1)])) }
    const root = build(4)
    const whole = merge(root)
    const visit = (node: any, merged: any) => {
      if (!node || typeof node !== "object") { return }
      expect(merge(node, { source: root })).toEqual(merged)
      for (const key of Object.keys(node.properties ?? {})) {
        visit(node.properties[key], merged.properties[key])
      }
    }
    visit(root, whole)
  })

  it("B10.3.9 a validator accepts the output of a large merge", () => {
    const properties: any = {}
    for (let i = 0; i < 200; i++) {
      properties["p" + i] = { allOf: [{ type: "string" }, { minLength: 1 }] }
    }
    const result = merge({ type: "object", properties, required: ["p0"] })
    const validate = compile(result)
    expect(validate({ p0: "a", p1: "b" })).toBe(true)
    expect(validate({ p0: "" })).toBe(false)
  })

  it("B10.3.10 broken refs in a large document are all reported", () => {
    const properties: any = {}
    for (let i = 0; i < 100; i++) {
      properties["p" + i] = { allOf: [{ $ref: "#/definitions/Missing" + i }, { description: "d" }] }
    }
    const { refErrors } = mergeReport({ type: "object", properties })
    expect(refErrors).toHaveLength(100)
  })
})
