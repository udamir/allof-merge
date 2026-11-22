/*
 * B24 — keepSourceOrder (#234): the keys of a merged node, the members of its merged maps (`properties`, `$defs`, ...)
 * and of its `required` / `enum` appear in the order they are first written in the source. A node's parts are read
 * key by key: an own keyword where the node writes it, the `$ref` target where it writes `$ref`, the `allOf` members
 * where it writes `allOf`. Which value wins is unchanged (own keywords win), and the output stays equivalent. Default
 * (off): `allOf` members first, then the `$ref` target, then the node's own keywords.
 */
import { describe, it, expect } from "vite-plus/test"
import { allOfResolverHook, createMerger, jsonSchemaMergeRules } from "../../src/index.ts"
import { syncClone } from "json-crawl"
import { clone, deepFreeze, expectSameValidation, isJsonSerializable, merge } from "./helpers.ts"

const S = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const openapi = (schemas: Record<string, unknown>) => ({ openapi: "3.1.0", components: { schemas } })
const keys = (value: unknown) => Object.keys(value as object)

// the #234 example
const doc234 = () => openapi({
  base: { properties: { fromRef: { type: "string" } } },
  target: {
    properties: { own: { type: "string" } },
    $ref: "#/components/schemas/base",
    allOf: [{ properties: { fromMember: {} } }],
  },
})

describe("B24.1 the #234 example", () => {
  it("B24.1.1 default: allOf members, then the $ref target, then the own keywords", () => {
    const out = merge(doc234(), { mergeRefSibling: true })
    expect(keys(out.components.schemas.target.properties)).toEqual(["fromMember", "fromRef", "own"])
  })

  it("B24.1.2 keepSourceOrder: the order the parts are written in", () => {
    const out = merge(doc234(), { mergeRefSibling: true, keepSourceOrder: true })
    expect(keys(out.components.schemas.target.properties)).toEqual(["own", "fromRef", "fromMember"])
    // only the order differs
    expect(out).toEqual(merge(doc234(), { mergeRefSibling: true }))
  })

  it("B24.1.3 a $ref with siblings and no allOf", () => {
    const doc = openapi({
      base: { properties: { fromRef: {} } },
      before: { properties: { own: {} }, $ref: "#/components/schemas/base" },
      after: { $ref: "#/components/schemas/base", properties: { own: {} } },
    })
    const out = merge(doc, { mergeRefSibling: true, keepSourceOrder: true })
    expect(keys(out.components.schemas.before.properties)).toEqual(["own", "fromRef"])
    expect(keys(out.components.schemas.after.properties)).toEqual(["fromRef", "own"])
    expect(keys(merge(doc, { mergeRefSibling: true }).components.schemas.before.properties)).toEqual(["fromRef", "own"])
  })
})

describe("B24.2 placement", () => {
  it("B24.2.1 own keywords are placed one by one around $ref and allOf", () => {
    const out = merge({
      definitions: { base: { description: "base", properties: { b: {} } } },
      title: "own",
      $ref: "#/definitions/base",
      required: ["a"],
      allOf: [{ type: "object", properties: { m: {} } }],
      properties: { a: {} },
    }, { mergeRefSibling: true, keepSourceOrder: true })
    expect(keys(out)).toEqual(["definitions", "title", "description", "properties", "required", "type"])
    // the target's properties come where the node writes $ref, the own ones last
    expect(keys(out.properties)).toEqual(["b", "m", "a"])
  })

  it("B24.2.2 own keywords written before allOf come first", () => {
    const schema = { properties: { own: {} }, allOf: [{ properties: { m1: {} } }, { properties: { m2: {} } }] }
    expect(keys(merge(schema).properties)).toEqual(["m1", "m2", "own"])
    expect(keys(merge(schema, { keepSourceOrder: true }).properties)).toEqual(["own", "m1", "m2"])
  })

  it("B24.2.3 own keywords written after allOf: same as the default", () => {
    const schema = { allOf: [{ properties: { m: {} } }], properties: { own: {} } }
    expect(keys(merge(schema, { keepSourceOrder: true }).properties)).toEqual(["m", "own"])
  })

  it("B24.2.4 nested parts follow their own written order (members, $ref targets, nested allOf)", () => {
    const doc = openapi({
      A: { properties: { a2: {} }, allOf: [{ properties: { a1: {} } }] },
      B: { allOf: [{ properties: { b1: {} } }], properties: { b2: {} } },
      node: {
        properties: { own: {} },
        allOf: [
          { properties: { m: {} }, allOf: [S("A")] },
          S("B"),
        ],
      },
    })
    const out = merge(doc, { keepSourceOrder: true })
    expect(keys(out.components.schemas.node.properties)).toEqual(["own", "m", "a2", "a1", "b1", "b2"])
    expect(keys(merge(doc).components.schemas.node.properties)).toEqual(["a1", "a2", "m", "b1", "b2", "own"])
  })

  it("B24.2.5 a $ref sibling of a $ref target is placed by the target's key order", () => {
    const doc = openapi({
      base: { properties: { b: {} } },
      mid: { properties: { mid: {} }, $ref: "#/components/schemas/base" },
      node: { allOf: [S("mid")], properties: { own: {} } },
    })
    const out = merge(doc, { keepSourceOrder: true })
    expect(keys(out.components.schemas.node.properties)).toEqual(["mid", "b", "own"])
  })
})

describe("B24.3 nested merged schemas", () => {
  it("B24.3.1 a property written in several parts merges in source order too", () => {
    const doc = openapi({
      base: { properties: { shared: { properties: { r: {} }, required: ["r"] } } },
      node: { properties: { shared: { properties: { o: {} }, required: ["o"] } }, $ref: "#/components/schemas/base" },
    })
    const out = merge(doc, { mergeRefSibling: true, keepSourceOrder: true })
    const shared = out.components.schemas.node.properties.shared
    expect(keys(shared.properties)).toEqual(["o", "r"])
    expect(shared.required).toEqual(["o", "r"])
    expect(keys(merge(doc, { mergeRefSibling: true }).components.schemas.node.properties.shared.properties)).toEqual(["r", "o"])
  })

  it("B24.3.2 deeper levels, items and $defs", () => {
    const out = merge({
      $defs: { own: { properties: { x: {} } } },
      properties: { p: { properties: { q: { properties: { own: {} } } } } },
      items: { properties: { i1: {} } },
      allOf: [{
        $defs: { member: {}, own: { properties: { y: {} } } },
        properties: { p: { properties: { q: { properties: { member: {} } } } } },
        items: { properties: { i2: {} } },
      }],
    }, { keepSourceOrder: true })
    expect(keys(out.$defs)).toEqual(["own", "member"])
    expect(keys(out.$defs.own.properties)).toEqual(["x", "y"])
    expect(keys(out.properties.p.properties.q.properties)).toEqual(["own", "member"])
    expect(keys(out.items.properties)).toEqual(["i1", "i2"])
  })

  it("B24.3.3 a property conjoined with additionalProperties of another part", () => {
    const schema = {
      properties: { name: { properties: { own: {} } } },
      allOf: [{ properties: { other: {} }, additionalProperties: { properties: { extra: {} } } }],
    }
    expect(keys(merge(schema).properties.name.properties)).toEqual(["extra", "own"])
    expect(keys(merge(schema, { keepSourceOrder: true }).properties.name.properties)).toEqual(["own", "extra"])
  })
})

describe("B24.4 which value wins is unchanged", () => {
  it("B24.4.1 own annotations win wherever they are written", () => {
    const doc = openapi({
      base: { title: "Base", description: "base", default: 1, "x-kind": "base", properties: { p: { title: "base p" } } },
      node: { title: "Own", description: "own", default: 2, "x-kind": "own", properties: { p: { title: "own p" } }, $ref: "#/components/schemas/base" },
    })
    const node = merge(doc, { mergeRefSibling: true, keepSourceOrder: true }).components.schemas.node
    expect(node).toEqual({ title: "Own", description: "own", default: 2, "x-kind": "own", properties: { p: { title: "own p" } } })
    expect(keys(node)).toEqual(["title", "description", "default", "x-kind", "properties"])
  })

  it("B24.4.2 the last allOf member still wins among members", () => {
    const out = merge({ allOf: [{ title: "first" }, { title: "second" }] }, { keepSourceOrder: true })
    expect(out).toEqual({ title: "second" })
  })

  it("B24.4.3 custom rules receive the values in the default order", () => {
    const seen: unknown[][] = []
    const rules = { "/x-list": { $: (values: unknown[]) => { seen.push(values); return values.flat() } } }
    const schema = { "x-list": ["own"], allOf: [{ "x-list": ["member"] }] }
    const out = merge(schema, { keepSourceOrder: true, rules: { ...jsonSchemaMergeRules(), ...rules } })
    expect(seen).toEqual([[["member"], ["own"]]])
    expect(out["x-list"]).toEqual(["member", "own"])
  })
})

describe("B24.5 required and enum", () => {
  it("B24.5.1 required in order of first appearance in the source", () => {
    const schema = { required: ["own"], allOf: [{ required: ["m", "own"] }] }
    expect(merge(schema).required).toEqual(["m", "own"])
    expect(merge(schema, { keepSourceOrder: true }).required).toEqual(["own", "m"])
  })

  it("B24.5.2 enum (an intersection) in the order of the first part that writes it", () => {
    const schema = { enum: ["c", "b", "a", { o: 1 }], allOf: [{ enum: [{ o: 1 }, "a", "b", "c"] }] }
    expect(merge(schema).enum).toEqual([{ o: 1 }, "a", "b", "c"])
    expect(merge(schema, { keepSourceOrder: true }).enum).toEqual(["c", "b", "a", { o: 1 }])
  })

  it("B24.5.3 large object enums stay fast", () => {
    const list = Array.from({ length: 20000 }, (_, i) => ({ id: i }))
    const start = performance.now()
    const out = merge({ enum: clone(list).reverse(), allOf: [{ enum: list }] }, { keepSourceOrder: true })
    expect(performance.now() - start).toBeLessThan(2000)
    expect(out.enum[0]).toEqual({ id: 19999 })
  })

  it("B24.5.4 many parts and keys stay fast", () => {
    const allOf = Array.from({ length: 10000 }, (_, i) => ({ properties: { [`p${i}`]: {} }, [`x-k${i}`]: i }))
    const start = performance.now()
    const out = merge({ properties: { own: {} }, allOf }, { keepSourceOrder: true })
    expect(performance.now() - start).toBeLessThan(3000)
    expect(keys(out.properties).slice(0, 2)).toEqual(["own", "p0"])
    expect(keys(out.properties)).toHaveLength(10001)
  })
})

describe("B24.6 combinations with other options", () => {
  it("B24.6.1 mergeCombinarySibling: a branch is placed where the node writes oneOf", () => {
    const schema = { oneOf: [{ properties: { branch: {} } }], properties: { own: {} }, type: "object" }
    const def = merge(schema, { mergeCombinarySibling: true })
    expect(keys(def.oneOf[0].properties)).toEqual(["own", "branch"])
    const out = merge(schema, { mergeCombinarySibling: true, keepSourceOrder: true })
    expect(keys(out.oneOf[0].properties)).toEqual(["branch", "own"])
    expect(out).toEqual(def)
  })

  it("B24.6.2 oneOf products: each branch follows the source order of its components", () => {
    const out = merge({
      oneOf: [{ properties: { own: {} } }],
      allOf: [{ oneOf: [{ properties: { member: {} } }] }],
    }, { keepSourceOrder: true })
    expect(keys(out.oneOf[0].properties)).toEqual(["own", "member"])
  })

  it("B24.6.3 parts kept in allOf come after the merged keys", () => {
    const out = merge({
      properties: { own: {} },
      allOf: [{ contains: { type: "string" } }, { contains: { type: "number" } }],
    }, { keepSourceOrder: true })
    expect(keys(out)).toEqual(["properties", "allOf"])
  })

  it("B24.6.4 freezeOutput, refAnnotations and the raw hook", () => {
    const frozen = merge(deepFreeze(doc234()), { mergeRefSibling: true, keepSourceOrder: true, freezeOutput: true, refAnnotations: "omit" })
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(keys(frozen.components.schemas.target.properties)).toEqual(["own", "fromRef", "fromMember"])
    const schema = { definitions: { base: { properties: { fromRef: {} } } }, properties: { own: {} }, $ref: "#/definitions/base" }
    const hooked = syncClone(schema, allOfResolverHook({ mergeRefSibling: true, keepSourceOrder: true }), { rules: jsonSchemaMergeRules(), circular: false }) as any
    expect(keys(hooked.properties)).toEqual(["own", "fromRef"])
  })
})

describe("B24.7 shared work", () => {
  it("B24.7.1 the same parts written in two orders give two orders", () => {
    // both nodes conjoin the same two targets for `s`; only the written order differs
    const doc = openapi({
      S1: { properties: { one: {} } },
      S2: { properties: { two: {} } },
      T: { properties: { s: S("S2") } },
      ownFirst: { properties: { s: S("S1") }, $ref: "#/components/schemas/T" },
      refFirst: { $ref: "#/components/schemas/T", properties: { s: S("S1") } },
    })
    const out = merge(doc, { mergeRefSibling: true, keepSourceOrder: true })
    expect(keys(out.components.schemas.ownFirst.properties.s.properties)).toEqual(["one", "two"])
    expect(keys(out.components.schemas.refFirst.properties.s.properties)).toEqual(["two", "one"])
  })

  it("B24.7.2 a reused merger gives the same output", () => {
    const merger = createMerger({ mergeRefSibling: true, keepSourceOrder: true })
    const first = merger.merge(doc234()) as any
    const second = merger.merge(doc234()) as any
    expect(keys(second.components.schemas.target.properties)).toEqual(keys(first.components.schemas.target.properties))
  })

  it("B24.7.3 the input is not modified", () => {
    const doc = doc234()
    const copy = clone(doc)
    merge(doc, { mergeRefSibling: true, keepSourceOrder: true })
    expect(doc).toEqual(copy)
    expect(keys(doc.components.schemas.target)).toEqual(keys(copy.components.schemas.target))
  })
})

describe("B24.8 equivalence", () => {
  it("B24.8.1 the output validates like the input", () => {
    const schema = {
      definitions: { base: { type: "object", required: ["b"], properties: { b: { type: "string" }, n: { minimum: 1 } } } },
      required: ["a"],
      properties: { a: { type: "integer" }, n: { maximum: 5 } },
      $ref: "#/definitions/base",
      allOf: [{ properties: { m: { enum: ["x", "y"] } }, required: ["m"] }],
    }
    const out = merge(schema, { mergeRefSibling: true, keepSourceOrder: true })
    expect(isJsonSerializable(out)).toBe(true)
    expect(keys(out.properties)).toEqual(["a", "n", "b", "m"])
    const instances = [
      { a: 1, b: "s", m: "x" }, { a: 1, b: "s", m: "z" }, { a: 1, b: 2, m: "x" }, { a: 1, m: "x" },
      { a: 1, b: "s", m: "x", n: 3 }, { a: 1, b: "s", m: "x", n: 0 }, { a: 1, b: "s", m: "x", n: 6 }, "str",
    ]
    // the input's $ref siblings apply in every draft (author intent): compare against their conjunction
    const { $ref, definitions, ...own } = schema
    expectSameValidation({ definitions, allOf: [{ $ref }, own] }, out, instances)
  })

  it("B24.8.2 integer-like property names still come first (JavaScript key order)", () => {
    const out = merge({ properties: { b: {} }, allOf: [{ properties: { 200: {}, a: {} } }] }, { keepSourceOrder: true })
    expect(keys(out.properties)).toEqual(["200", "b", "a"])
  })
})
