import {
  arrayShapeGroup,
  conditionalGroup,
  createMerger,
  createResolutionIndex,
  dependenciesGroup,
  enumConstGroup,
  jsonSchemaMergeResolver,
  jsonSchemaMergeRules,
  keywordGroups,
  numericBoundsGroup,
  objectShapeGroup,
  resolvePointer,
  stringGroup,
  typeGroup,
} from "../../src"
import { ErrorMessage } from "../../src/errors"
import { getOwn, hasOwn, safeAssign, safeClone, safeSet } from "../../src/safe"
import type { GroupContext } from "../../src/types"
import { clone, compile, deepFreeze, expectSameValidation, isJsonSerializable, merge, mergeReport } from "./helpers"

// every `$ref` string of a value (cycle safe)
const refsOf = (value: unknown, found: string[] = [], seen = new Set<unknown>()): string[] => {
  if (!value || typeof value !== "object" || seen.has(value)) { return found }
  seen.add(value)
  for (const key of Object.keys(value)) {
    const child = (value as any)[key]
    if (key === "$ref" && typeof child === "string") { found.push(child) } else { refsOf(child, found, seen) }
  }
  return found
}

const expectRefsResolve = (value: unknown, source: unknown) => {
  const index = createResolutionIndex(source)
  for (const ref of refsOf(value)) {
    expect({ ref, ok: index.resolve(ref).ok }).toEqual({ ref, ok: true })
  }
}

const timed = <T>(fn: () => T): { value: T, ms: number } => {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

describe("B13.1 own-property safe helpers (src/safe.ts)", () => {
  it("B13.1.1 safeSet writes __proto__ as an own data property and never changes the prototype", () => {
    const target: any = {}
    safeSet(target, "__proto__", { polluted: true })
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(hasOwn(target, "__proto__")).toBe(true)
    expect(target.polluted).toBeUndefined()
    expect(getOwn(target, "__proto__")).toEqual({ polluted: true })
    expect(Object.keys(target)).toEqual(["__proto__"])
  })

  it("B13.1.2 hasOwn / getOwn ignore inherited members", () => {
    expect(hasOwn({}, "constructor")).toBe(false)
    expect(getOwn({}, "toString")).toBeUndefined()
    expect(hasOwn(null, "x")).toBe(false)
  })

  it("B13.1.3 safeClone / safeAssign copy __proto__ members as own properties", () => {
    const source = JSON.parse('{"__proto__":{"x":1},"a":2}')
    const copy: any = safeClone(source)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Object.keys(copy)).toEqual(["__proto__", "a"])
    const target: any = safeAssign({}, source)
    expect(target.x).toBeUndefined()
    expect(getOwn(target, "__proto__")).toEqual({ x: 1 })
  })
})

describe("B13.2 prototype safety of the engine (VR-20 .. VR-23)", () => {
  it("B13.2.1 VR-20 a memoized conjunction under the key __proto__ does not set a prototype", () => {
    const out = merge(JSON.parse('{"definitions":{"A":{"isAdmin":true},"B":{"x-y":1}},"properties":{"x":{"allOf":[{"$ref":"#/definitions/A"},{"$ref":"#/definitions/B"}]},"__proto__":{"allOf":[{"$ref":"#/definitions/A"},{"$ref":"#/definitions/B"}]}}}'))
    expect(Object.getPrototypeOf(out.properties)).toBe(Object.prototype)
    expect(out.properties.isAdmin).toBeUndefined()
    expect(Object.keys(out.properties)).toEqual(["x", "__proto__"])
    expect(getOwn(out.properties, "__proto__")).toEqual({ isAdmin: true, "x-y": 1 })
    expect(({} as any).isAdmin).toBeUndefined()
  })

  it("B13.2.2 VR-21 a top-level __proto__ keyword and __proto__ members survive as own properties", () => {
    const out = merge(JSON.parse('{"allOf":[{"type":"object"},{"minProperties":1}],"__proto__":{"x":1}}'))
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(getOwn(out, "__proto__")).toEqual({ x: 1 })
    const props = merge(JSON.parse('{"allOf":[{"properties":{"__proto__":{"minLength":1}},"additionalProperties":false},{"properties":{"__proto__":{"type":"string"}}}]}'))
    expect(getOwn(props.properties, "__proto__")).toEqual({ minLength: 1, type: "string" })
    expect(Object.getPrototypeOf(props.properties)).toBe(Object.prototype)
  })

  it("B13.2.3 VR-21 a merged definitions container keeps constructor / prototype / __proto__ members", () => {
    const data = JSON.parse('{"allOf":[{"definitions":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}},{"definitions":{"prototype":{"type":"boolean"}}}]}')
    const out = merge(data)
    expect(Object.keys(out.definitions).sort()).toEqual(["__proto__", "constructor", "prototype"])
    expect(getOwn(out.definitions, "__proto__")).toEqual({ type: "string" })
  })

  it("B13.2.4 VR-22 refs to inherited members are broken refs, reported and kept", () => {
    const { result, refErrors } = mergeReport({ definitions: {}, allOf: [{ $ref: "#/definitions/constructor" }, { $ref: "#/__proto__" }, { minLength: 1 }] })
    expect(refErrors.map((e) => e.ref)).toEqual(["#/definitions/constructor", "#/__proto__"])
    expect(result.allOf).toEqual([{ $ref: "#/definitions/constructor" }, { $ref: "#/__proto__" }, { minLength: 1 }])
  })

  it("B13.2.5 VR-23 resolvePointer and the resolution index never return Object.prototype", () => {
    expect(resolvePointer({ a: 1 }, "/__proto__")).toBeUndefined()
    expect(resolvePointer({ a: {} }, "/a/constructor")).toBeUndefined()
    expect(createResolutionIndex({}).resolve("#/__proto__")).toEqual({ ok: false, reason: "not-found" })
    expect(createResolutionIndex({ a: {} }).resolvePointer("/a/hasOwnProperty")).toBeUndefined()
    const own = JSON.parse('{"__proto__":{"type":"string"}}')
    expect(createResolutionIndex(own).resolve("#/__proto__")).toEqual({ ok: true, target: { type: "string" } })
  })
})

describe("B13.3 references (VR-36, VR-40, D-9)", () => {
  it("B13.3.1 VR-36 an unknown plain-name fragment is a broken ref, never the root", () => {
    const { result, refErrors } = mergeReport({ type: "object", allOf: [{ $ref: "#foo" }, { minLength: 1 }] })
    expect(refErrors.map((e) => e.ref)).toEqual(["#foo"])
    expect(result).toEqual({ type: "object", allOf: [{ $ref: "#foo" }, { minLength: 1 }] })
  })

  it("B13.3.2 VR-36 a plain-name fragment resolves a $anchor (2019+) and a draft-06/07 $id: '#name'", () => {
    const anchor = mergeReport({ $defs: { s: { $anchor: "foo", type: "string" } }, properties: { a: { allOf: [{ $ref: "#foo" }, { minLength: 1 }] } } })
    expect(anchor.refErrors).toEqual([])
    expect(anchor.result.properties.a).toMatchObject({ type: "string", minLength: 1 })
    const id = mergeReport({ definitions: { s: { $id: "#foo", type: "string" } }, properties: { a: { allOf: [{ $ref: "#foo" }, { minLength: 1 }] } } })
    expect(id.refErrors).toEqual([])
    expect(id.result.properties.a).toMatchObject({ type: "string", minLength: 1 })
    expect(createResolutionIndex({ $defs: { s: { $dynamicAnchor: "node", type: "object" } } }).resolve("#node")).toMatchObject({ ok: true })
  })

  it("B13.3.3 VR-36 `#/` is the member \"\" of the root", () => {
    const { result, refErrors } = mergeReport({ "": { type: "string" }, type: "object", properties: { a: { allOf: [{ $ref: "#/" }, { minLength: 1 }] } } })
    expect(refErrors).toEqual([])
    expect(result.properties.a).toEqual({ type: "string", minLength: 1 })
    expect(mergeReport({ type: "object", properties: { a: { allOf: [{ $ref: "#/" }, { minLength: 1 }] } } }).refErrors.map((e) => e.ref)).toEqual(["#/"])
  })

  it("B13.3.4 VR-40 a ref -> ref cycle inside allOf is reported instead of vanishing", () => {
    const { result, refErrors } = mergeReport({ definitions: { a: { $ref: "#/definitions/a" } }, properties: { x: { allOf: [{ $ref: "#/definitions/a" }, { minLength: 1 }] } } })
    expect(refErrors).toEqual([{ message: ErrorMessage.refResolveError(), path: ["properties", "x"], ref: "#/definitions/a" }])
    expect(result.properties.x).toEqual({ allOf: [{ $ref: "#/definitions/a" }, { minLength: 1 }] })
    const twoStep = mergeReport({ definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } }, allOf: [{ $ref: "#/definitions/a" }, { minLength: 1 }] })
    expect(twoStep.refErrors).toHaveLength(1)
  })

  it("B13.3.5 VR-40 a ref -> ref chain without a cycle still resolves", () => {
    const { result, refErrors } = mergeReport({ definitions: { a: { $ref: "#/definitions/b" }, b: { type: "string" } }, allOf: [{ $ref: "#/definitions/a" }, { minLength: 1 }] })
    expect(refErrors).toEqual([])
    expect(result).toMatchObject({ type: "string", minLength: 1 })
  })

  it("B13.3.6 D-9 (VR-35) mergeRefSibling leaves an external $ref with siblings unchanged without reporting", () => {
    const { result, refErrors } = mergeReport({ properties: { a: { $ref: "ext.json#/a", description: "d" } } }, { mergeRefSibling: true })
    expect(result.properties.a).toEqual({ $ref: "ext.json#/a", description: "d" })
    expect(refErrors).toEqual([])
  })

  it("B13.3.7 D-9 mergeRefSibling leaves a broken local $ref with siblings unchanged and reports it", () => {
    const { result, refErrors } = mergeReport({ properties: { a: { $ref: "#/nope", description: "d" } } }, { mergeRefSibling: true })
    expect(result.properties.a).toEqual({ $ref: "#/nope", description: "d" })
    expect(refErrors.map((e) => [e.ref, e.path])).toEqual([["#/nope", ["properties", "a"]]])
  })
})

describe("B13.4 cycle re-entries are $refs into the source (D-4, D-4b, VR-30, VR-31)", () => {
  const fooBaz = () => ({ components: { schemas: {
    Foo: { allOf: [{ properties: { test: { type: "string" } } }, { $ref: "#/components/schemas/Baz" }] },
    Baz: { properties: { test: { $ref: "#/components/schemas/Foo" } } },
  } } })

  it("B13.4.1 VR-30 fragment merge of a recursive conjunction emits only refs that are valid against source", () => {
    const doc = fooBaz()
    const { result, mergeErrors, refErrors } = mergeReport(doc.components.schemas.Foo, { source: doc })
    expect(mergeErrors).toEqual([])
    expect(refErrors).toEqual([])
    expect(isJsonSerializable(result)).toBe(true)
    expectRefsResolve(result, doc)
    expect(result).toEqual({ properties: { test: { type: "string", properties: { test: { allOf: [{ type: "string" }, { $ref: "#/components/schemas/Foo" }] } } } } })
    const instances = [{}, { test: "a" }, { test: 1 }, { test: { test: "a" } }]
    const original = { $ref: "#/components/schemas/Foo", components: doc.components }
    expectSameValidation(original, { ...result, components: doc.components }, instances, "2020")
  })

  it("B13.4.2 #208 part b: mergeRefSibling + source keeps refs into source, no cyclic object (reporter's comment 3)", () => {
    const $ref = "#/reusable/person"
    const person = {
      type: "object",
      properties: {
        name: { type: "string" },
        friends: { type: "array", items: { $ref, type: "object" } },
        friend: { $ref, type: "object" },
      },
      required: ["name", "age", "friends"],
    }
    const source = { reusable: { person }, openapi: "3.1.2" }
    const schema = { $ref, type: "object" }
    const { result, mergeErrors, refErrors } = mergeReport(deepFreeze(schema), { source: deepFreeze(source), mergeRefSibling: true })
    expect(mergeErrors).toEqual([])
    expect(refErrors).toEqual([])
    expect(isJsonSerializable(result)).toBe(true)
    expect(refsOf(result)).not.toContain("#")
    expectRefsResolve(result, source)
    expect(result).toMatchObject({ type: "object", required: ["name", "age", "friends"], properties: { name: { type: "string" }, friends: { type: "array" } } })
    const valid = { name: "a", age: 1, friends: [{ name: "b", age: 2, friends: [] }], friend: { name: "c", age: 3, friends: [] } }
    const instances = [valid, { name: "a", age: 1, friends: [{ age: 2, friends: [] }] }, { name: "a", age: 1, friends: [], friend: { name: "c" } }, { name: "a", friends: [] }, 1]
    expectSameValidation({ ...schema, reusable: source.reusable }, { ...result, reusable: source.reusable }, instances, "2020")
  })

  it("B13.4.3 D-4b whole-document cycles through $ref: '#' are serializable and equivalent", () => {
    const data = { type: "object", properties: { foo: { allOf: [{ description: "1" }, { $ref: "#" }] }, baz: { allOf: [{ description: "2" }, { $ref: "#" }] } } }
    const result = merge(clone(data))
    expect(isJsonSerializable(result)).toBe(true)
    expectRefsResolve(result, result)
    expectSameValidation(data, result, [{}, { foo: {} }, { foo: 1 }, { foo: { baz: { foo: 1 } } }, { foo: { baz: { foo: {} } } }])
  })

  it("B13.4.4 D-4b cyclic JavaScript input (no $ref) gives a serializable output", () => {
    const nodes: any[] = []
    for (let i = 0; i < 5; i++) { nodes.push({ type: "object", properties: {} }) }
    for (let i = 0; i < 5; i++) { nodes[i].properties.next = { allOf: [nodes[(i + 1) % 5], { description: "d" + i }] } }
    const doc = { definitions: Object.fromEntries(nodes.map((v, i) => ["N" + i, v])) }
    const result = merge(doc)
    expect(isJsonSerializable(result)).toBe(true)
    expectRefsResolve(result, doc)
  })

  it("B13.4.5 D-4b a cyclic schema outside the source is replaced by {} and reported", () => {
    const outside: any = { type: "object", properties: {} }
    outside.properties.self = outside
    const { result, mergeErrors } = mergeReport(outside, { source: { definitions: {} } })
    expect(isJsonSerializable(result)).toBe(true)
    expect(result.properties.self).toEqual({})
    expect(mergeErrors.map((e) => e.message)).toEqual([ErrorMessage.cyclicValue()])
  })

  it("B13.4.6 a merged conjunction re-entered in another document is not shared when it holds a cycle $ref", () => {
    const merger = createMerger()
    const shared: any = { type: "object", properties: {} }
    shared.properties.self = { allOf: [shared, { description: "x" }] }
    const docA = { definitions: { A: shared }, allOf: [{ $ref: "#/definitions/A" }, { title: "A" }] }
    const docB = { other: { A: shared }, allOf: [{ $ref: "#/other/A" }, { title: "A" }] }
    const a: any = merger.merge(docA)
    const b: any = merger.merge(docB)
    // whole-document merges: a re-entry whose source pointer runs through the merged root points to the output
    // location of the re-entered node (D-22), so every ref resolves in its own output
    expectRefsResolve(a, a)
    expectRefsResolve(b, b)
    expect(b.properties.self.properties.self).toEqual({ $ref: "#/properties/self" })
    expect(isJsonSerializable(a) && isJsonSerializable(b)).toBe(true)
  })
})

describe("B13.5 D-10 (VR-32) a contradiction keeps container siblings", () => {
  it("B13.5.1 keeps $defs next to allOf: [false]", () => {
    const data = { definitions: { A: { $defs: { B: { type: "integer" } }, allOf: [{ type: "string" }, { type: "number" }] } }, properties: { x: { $ref: "#/definitions/A/$defs/B" } } }
    const { result, mergeErrors } = mergeReport(data)
    expect(result.definitions.A).toEqual({ allOf: [false], $defs: { B: { type: "integer" } } })
    expect(mergeErrors).toHaveLength(1)
    expectRefsResolve(result, result)
  })

  it("B13.5.2 keeps definitions, $id and $schema; not-empty mode writes { not: {} }", () => {
    const data = { $id: "x", $schema: "http://json-schema.org/draft-07/schema#", definitions: { A: { type: "integer" } }, description: "dropped", allOf: [{ type: "string" }, { type: "number" }] }
    expect(merge(data)).toEqual({ allOf: [false], $id: "x", $schema: "http://json-schema.org/draft-07/schema#", definitions: { A: { type: "integer" } } })
    expect(merge(data, { unsatisfiable: "not-empty" }).allOf).toEqual([{ not: {} }])
  })

  it("B13.5.3 a contradiction without container siblings is plain false; allOf: [false] item likewise", () => {
    expect(merge({ properties: { a: { title: "t", allOf: [{ type: "string" }, { type: "number" }] } } }).properties.a).toBe(false)
    expect(merge({ definitions: { A: {} }, allOf: [false, { type: "string" }] })).toEqual({ allOf: [false], definitions: { A: {} } })
  })
})

describe("B13.6 resource limits (D-7, VR-03, VR-05, VR-06, VR-04)", () => {
  const branches = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ properties: { [prefix + i]: { type: "string" } } }))

  it("B13.6.1 VR-05 the branch budget is per merge() call across nested nodes", () => {
    const inner = { allOf: [{ oneOf: branches("a", 32) }, { oneOf: branches("b", 32) }] }
    const outer = { allOf: [{ oneOf: branches("c", 32).map((b) => ({ ...b, properties: { ...b.properties, n: inner } })) }, { oneOf: branches("d", 32) }] }
    const { value, ms } = timed(() => mergeReport(outer))
    expect(value.mergeErrors.map((e) => e.message)).toEqual([ErrorMessage.branchBudgetExceeded(1024, 1024)])
    expect(ms).toBeLessThan(5000)
    // the inner node is left unchanged
    expect(value.result.oneOf[0].allOf ?? value.result.oneOf[0].properties.n).toBeDefined()
  })

  it("B13.6.2 VR-05 the budget counts mergeCombinarySibling distribution", () => {
    const n = 2000
    const data = { anyOf: Array.from({ length: n }, (_, i) => ({ minimum: i })), oneOf: Array.from({ length: n }, (_, i) => ({ maximum: i })) }
    const { value, ms } = timed(() => mergeReport(data, { mergeCombinarySibling: true }))
    expect(value.mergeErrors.map((e) => e.message)).toEqual([ErrorMessage.branchBudgetExceeded(n * n, 1024)])
    expect(value.result).toEqual(data)
    expect(ms).toBeLessThan(5000)
    const small = mergeReport({ anyOf: [{ minimum: 1 }, { minimum: 2 }], oneOf: [{ maximum: 5 }, { maximum: 6 }] }, { mergeCombinarySibling: true })
    expect(small.mergeErrors).toEqual([])
    expect(small.result.anyOf).toHaveLength(2)
  })

  it("B13.6.3 VR-05 the exported jsonSchemaMergeResolver is bounded by the default budget", () => {
    const errors: any[] = []
    const ctx = { allOfItems: [], mergeRules: jsonSchemaMergeRules(), mergeError: (values: any[]) => errors.push(values) }
    const big = (p: string) => ({ oneOf: Array.from({ length: 64 }, (_, i) => ({ minimum: i, title: p + i })) })
    const { ms } = timed(() => jsonSchemaMergeResolver([big("a"), big("b"), big("c")], ctx))
    expect(ms).toBeLessThan(5000)
    expect(errors.length).toBeGreaterThan(0)
  })

  it("B13.6.4 VR-03 $ref fan-out: a target is inlined at most maxRefExpansion times, the output stays small", () => {
    const definitions: any = { L0: { type: "string" } }
    for (let i = 1; i <= 25; i++) {
      definitions["L" + i] = { type: "object", properties: {
        a: { allOf: [{ $ref: "#/definitions/L" + (i - 1) }, { description: "a" }] },
        b: { allOf: [{ $ref: "#/definitions/L" + (i - 1) }, { description: "b" }] },
      } }
    }
    const { value, ms } = timed(() => mergeReport({ definitions }))
    expect(ms).toBeLessThan(5000)
    const json = JSON.stringify(value.result)
    expect(json.length).toBeLessThan(5_000_000)
    expect(value.mergeErrors.some((e) => e.message === ErrorMessage.refExpansionExceeded("#/definitions/L0", 10000))).toBe(true)
    expectRefsResolve(value.result, value.result)
  })

  it("B13.6.5 maxRefExpansion keeps the $ref items of the node once a target is inlined N times", () => {
    const properties: any = {}
    for (let i = 0; i < 5; i++) { properties["p" + i] = { allOf: [{ $ref: "#/definitions/S" }, { description: "d" + i }] } }
    const { result, mergeErrors } = mergeReport({ definitions: { S: { type: "string" } }, properties }, { maxRefExpansion: 3 })
    expect(result.properties.p2).toEqual({ type: "string", description: "d2" })
    expect(result.properties.p3).toEqual({ allOf: [{ $ref: "#/definitions/S" }, { description: "d3" }] })
    expect(result.properties.p4).toEqual({ allOf: [{ $ref: "#/definitions/S" }, { description: "d4" }] })
    expect(mergeErrors.map((e) => [e.message, e.path])).toEqual([[ErrorMessage.refExpansionExceeded("#/definitions/S", 3), ["properties", "p3"]]])
    // B10.3.5: 4000 usages of one target are within the default (real-world maximum measured: 111, docs/VERIFICATION.md §9)
    const many: any = {}
    for (let i = 0; i < 4000; i++) { many["p" + i] = { allOf: [{ $ref: "#/definitions/S" }, { description: "d" + i }] } }
    expect(mergeReport({ definitions: { S: { type: "string" } }, properties: many }).mergeErrors).toEqual([])
  })

  it("B13.6.6 maxDepth: deeper nodes are copied without merging and reported once", () => {
    let deep: any = { allOf: [{ type: "string" }, { minLength: 1 }] }
    for (let i = 0; i < 30; i++) { deep = { type: "object", properties: { p: deep } } }
    const { result, mergeErrors } = mergeReport(deep, { maxDepth: 20 })
    let node = result
    for (let i = 0; i < 30; i++) { node = node.properties.p }
    expect(node).toEqual({ allOf: [{ type: "string" }, { minLength: 1 }] })
    expect(mergeErrors.map((e) => e.message)).toEqual([ErrorMessage.maxDepthExceeded(20)])
    let merged = merge(deep, { maxDepth: 100 })
    for (let i = 0; i < 30; i++) { merged = merged.properties.p }
    expect(merged).toEqual({ type: "string", minLength: 1 })
  })

  it("B13.6.7 VR-04 a 20 000-level plain chain is merged in linear time", () => {
    let plain: any = { type: "string" }
    for (let i = 0; i < 20000; i++) { plain = { type: "object", properties: { a: plain } } }
    const { value, ms } = timed(() => merge(plain, { maxDepth: 1e9 }))
    expect(value.type).toBe("object")
    expect(ms).toBeLessThan(3000)
  })

  it("B13.6.8 VR-06 20 000 nested allOf levels and a 20 000-step $ref chain do not overflow the stack", () => {
    let nested: any = { type: "string" }
    for (let i = 0; i < 20000; i++) { nested = { allOf: [nested, { minLength: i }] } }
    expect(merge(nested)).toEqual({ type: "string", minLength: 19999 })
    const chain: any = { definitions: {} }
    for (let i = 0; i < 20000; i++) { chain.definitions["d" + i] = { $ref: "#/definitions/d" + (i + 1) } }
    chain.definitions.d20000 = { type: "string" }
    chain.allOf = [{ $ref: "#/definitions/d0" }, { minLength: 1 }]
    const { result, refErrors } = mergeReport(chain)
    expect(refErrors).toEqual([])
    expect(result).toMatchObject({ type: "string", minLength: 1 })
    expect(createResolutionIndex(chain).resolvePointer("/definitions/d0")).toEqual({ $ref: "#/definitions/d1" })
  })
})

describe("B13.7 merger memo and output sharing (VR-33, VR-24, D-11)", () => {
  it("B13.7.1 VR-33 the memo of a merger is keyed by rules", () => {
    const merger = createMerger()
    const data = { allOf: [{ minimum: 1 }, { minimum: 5 }] }
    expect(merger.merge(data, { rules: jsonSchemaMergeRules("draft-04") })).toEqual({ minimum: 5 })
    const custom = jsonSchemaMergeRules("draft-06", { "/minimum": { $: (values: number[]) => Math.min(...values) } })
    expect(merger.merge(data, { rules: custom })).toEqual({ minimum: 1 })
  })

  it("B13.7.2 D-11 conjunctions of shared items are still shared between documents of one merger", () => {
    const merger = createMerger()
    const shared = { type: "string" }
    const extra = { minLength: 1 }
    const first: any = merger.merge({ properties: { a: { allOf: [shared, extra] } } })
    const second: any = merger.merge({ properties: { b: { allOf: [shared, extra] } } })
    expect(second.properties.b).toBe(first.properties.a)
  })

  it("B13.7.3 D-11 (VR-25) freezeOutput deep-freezes the result", () => {
    const merger = createMerger({ freezeOutput: true })
    const shared = { type: "string" }
    const first: any = merger.merge({ properties: { a: { allOf: [shared, { minLength: 1 }] }, b: { enum: [{ x: 1 }] } } })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.properties.a)).toBe(true)
    expect(Object.isFrozen(first.properties.b.enum[0])).toBe(true)
    expect(() => { "use strict"; first.properties.a.type = "X" }).toThrow()
    const second: any = merger.merge({ properties: { p: { allOf: [shared, { minLength: 1 }] } } })
    expect(second.properties.p.type).toBe("string")
    expect(Object.isFrozen(merge({ allOf: [{ type: "string" }] }))).toBe(false)
  })
})

describe("B13.8 reporting (VR-41, VR-37, D-6)", () => {
  it("B13.8.1 VR-41 a oneOf/anyOf that is unsatisfiable in the input is not reported", () => {
    expect(mergeReport({ oneOf: [false, false] }).mergeErrors).toEqual([])
    expect(mergeReport({ anyOf: [{ not: {} }] }, { unsatisfiable: "not-empty" }).mergeErrors).toEqual([])
    expect(mergeReport({ oneOf: [{ allOf: [{ type: "string" }, { type: "number" }] }, false] }).mergeErrors.map((e) => e.path)).toEqual([["oneOf"]])
  })

  it("B13.8.2 VR-37 a malformed allOf value is ignored and reported, the rest of the node is kept", () => {
    for (const allOf of [true, null, {}, "x", 1]) {
      const { result, mergeErrors } = mergeReport({ type: "string", allOf })
      expect(result).toEqual({ type: "string" })
      expect(mergeErrors.map((e) => e.message)).toEqual([ErrorMessage.malformedValue("allOf")])
    }
  })

  it("B13.8.3 VR-37 non-object allOf items are ignored and reported", () => {
    const { result, mergeErrors } = mergeReport({ allOf: [null, 1, "x", [], { type: "string" }, { minLength: 1 }] })
    expect(result).toEqual({ type: "string", minLength: 1 })
    expect(mergeErrors).toEqual([{ message: ErrorMessage.malformedValue("allOf item"), path: [], values: [null, 1, "x", []] }])
    expect(mergeReport({ allOf: [true, { type: "string" }] }).mergeErrors).toEqual([])
  })

  it("B13.8.4 VR-37 malformed anyOf / oneOf values are ignored and reported, never throw", () => {
    const anyOf = mergeReport({ allOf: [{ anyOf: true }, { anyOf: [{ type: "string" }] }, { anyOf: [{ minLength: 1 }] }] })
    expect(anyOf.result).toEqual({ anyOf: [{ type: "string", minLength: 1 }] })
    expect(anyOf.mergeErrors.map((e) => e.message)).toEqual([ErrorMessage.malformedValue("anyOf")])
    const oneOf = mergeReport({ allOf: [{ oneOf: {} }, { oneOf: null }] })
    expect(oneOf.result).toEqual({})
    expect(oneOf.mergeErrors.map((e) => e.values)).toEqual([[{}, null]])
    expect(() => merge({ allOf: [{ anyOf: null }, { anyOf: [{ type: "string" }] }], oneOf: true })).not.toThrow()
  })
})

describe("B13.9 API (VR-46, VR-47, VR-38)", () => {
  it("B13.9.1 VR-46 the group resolvers are exported", () => {
    expect(keywordGroups).toEqual([typeGroup, enumConstGroup, numericBoundsGroup, stringGroup, objectShapeGroup, arrayShapeGroup, dependenciesGroup, conditionalGroup])
    for (const group of keywordGroups) { expect(typeof group.resolve).toBe("function") }
  })

  it("B13.9.2 VR-38 a custom rule `$: jsonSchemaMergeResolver` without child rules fully merges its children", () => {
    const rules = jsonSchemaMergeRules("draft-06", { "/x-schema": { $: jsonSchemaMergeResolver } })
    const result = merge({ allOf: [{ "x-schema": { type: "string" } }, { "x-schema": { allOf: [{ minLength: 1 }, { maxLength: 3 }] } }] }, { rules })
    expect(result).toEqual({ "x-schema": { type: "string", minLength: 1, maxLength: 3 } })
  })

  it("B13.9.3 VR-38 jsonSchemaMergeResolver called directly merges children and reports conflicts", () => {
    const errors: any[] = []
    const ctx = { allOfItems: [], mergeRules: jsonSchemaMergeRules(), mergeError: (values: any[]) => errors.push(values) }
    expect(jsonSchemaMergeResolver([{ properties: { a: { type: "string" } } }, { properties: { a: { minLength: 1 } } }], ctx)).toEqual({ properties: { a: { type: "string", minLength: 1 } } })
    expect(jsonSchemaMergeResolver([{ properties: { a: { type: "string" } } }, { properties: { a: { type: "number" } } }], ctx)).toEqual({ properties: { a: false } })
    expect(errors).toEqual([["string", "number"]])
    expect(jsonSchemaMergeResolver([{ type: "string" }, false], ctx)).toBe(false)
    expect(jsonSchemaMergeResolver([true, {}], ctx)).toEqual({})
    expect(jsonSchemaMergeResolver([{ allOf: [{ type: "string" }, { minLength: 1 }] }], ctx)).toEqual({ type: "string", minLength: 1 })
  })
})

describe("B13.10 D-8 (VR-12) items with their own unevaluated* stay fragments", () => {
  const rules = jsonSchemaMergeRules("2020-12")

  it("B13.10.1 unevaluatedProperties: false next to another item's properties", () => {
    const data = { allOf: [{ properties: { a: {} }, unevaluatedProperties: false }, { properties: { b: {} } }] }
    const result = merge(clone(data), { rules })
    expectSameValidation(data, result, [{}, { a: 1 }, { b: 1 }, { a: 1, b: 1 }, { c: 1 }], "2020")
    expect(compile(result, "2020")({ b: 1 })).toBe(false)
    expect(result).toEqual({ properties: { b: {} }, allOf: [{ properties: { a: {} }, unevaluatedProperties: false }] })
  })

  it("B13.10.2 unevaluatedItems: false next to another item's prefixItems", () => {
    const data = { allOf: [{ prefixItems: [{}], unevaluatedItems: false }, { prefixItems: [{}, {}] }] }
    const result = merge(clone(data), { rules })
    expectSameValidation(data, result, [[], [1], [1, 2], [1, 2, 3]], "2020")
    expect(compile(result, "2020")([1, 2])).toBe(false)
  })

  it("B13.10.3 a $ref target carrying unevaluated* is kept as its $ref", () => {
    const data = { $defs: { Closed: { properties: { a: {} }, unevaluatedProperties: false } }, allOf: [{ $ref: "#/$defs/Closed" }, { properties: { b: {} } }] }
    const result = merge(clone(data), { rules })
    expect(result.allOf).toEqual([{ $ref: "#/$defs/Closed" }])
    expectSameValidation(data, result, [{}, { a: 1 }, { b: 1 }], "2020")
  })

  it("B13.10.4 the node's own unevaluated* is merged with the items", () => {
    const data = { unevaluatedProperties: false, allOf: [{ properties: { a: {} } }, { properties: { b: {} } }] }
    const result = merge(clone(data), { rules })
    expect(result).toEqual({ properties: { a: {}, b: {} }, unevaluatedProperties: false })
    expectSameValidation(data, result, [{}, { a: 1 }, { b: 1 }, { c: 1 }], "2020")
  })
})

// the simplification settings every group sees by default (four safe ones on, `simplify` off)
const SAFE_DEFAULTS = { dedupeAnyOf: true, dedupeFragments: true, dedupeCombinaryGroups: true, dropFalseBranches: true, simplify: false }

describe("B13.11 GroupContext plumbing", () => {
  it("B13.11.1 groups receive the resolved settings and a report callback bound to the node path", () => {
    const seen: GroupContext[] = []
    const original = typeGroup.resolve
    ;(typeGroup as any).resolve = (ctx: GroupContext) => {
      seen.push(ctx)
      ctx.report?.("custom problem", ["v"])
      return original(ctx)
    }
    try {
      const { mergeErrors } = mergeReport({ properties: { a: { allOf: [{ type: "string" }, { type: "string" }] } } }, { matchPatterns: false, branchBudget: 7, maxRefExpansion: 9, expansionBudget: 11, maxDepth: 99 })
      expect(seen[0].settings).toEqual({ unsatisfiable: "false", branchBudget: 7, matchPatterns: false, maxRefExpansion: 9, expansionBudget: 11, maxDepth: 99, ...SAFE_DEFAULTS })
      expect(mergeErrors).toEqual([{ message: "custom problem", path: ["properties", "a"], values: ["v"] }])
      seen.length = 0
      merge({ allOf: [{ type: "string" }, { type: "string" }] }, { matchPatterns: { maxNameLength: 10 }, unsatisfiable: "not-empty" })
      expect(seen[0].settings).toEqual({ unsatisfiable: "not-empty", branchBudget: 1024, matchPatterns: { maxPatternLength: 256, maxNameLength: 10 }, maxRefExpansion: 10000, expansionBudget: 2000000, maxDepth: 2000, ...SAFE_DEFAULTS })
    } finally {
      ;(typeGroup as any).resolve = original
    }
  })
})
