import { describe, it, expect } from "vite-plus/test"

import { jsonSchemaMergeRules, merge, mergeWithIssues, type MergeContext, type MergeRules } from "../../src/index.ts"
import { keyOnlyRule } from "../../src/rule-lookup.ts"

// B23 - the contracts that the performance work must keep: paths seen by rules and resolvers, rule lookup caching,
// key order, scan termination on shared and cyclic inputs

// a schema whose allOf sits `levels` properties deep: path ["properties", "p0", …, "properties", "p<levels-1>"]
const nested = (levels: number, leaf: unknown): { schema: Record<string, unknown>, path: string[] } => {
  let schema: unknown = leaf
  const path: string[] = []
  for (let i = levels - 1; i >= 0; i--) { schema = { type: "object", properties: { [`p${i}`]: schema } } }
  for (let i = 0; i < levels; i++) { path.push("properties", `p${i}`) }
  return { schema: schema as Record<string, unknown>, path }
}

describe("B23.1 paths of rules and resolvers", () => {
  it.each([3, 100])("B23.1.1 a custom resolver reads the node's path (%i levels deep)", (levels) => {
    const seen: unknown[] = []
    const rules = jsonSchemaMergeRules("draft-07", {
      "/x-a": { $: (values: unknown[], ctx?: MergeContext) => { seen.push(ctx?.path); return values[values.length - 1] } },
    })
    const { schema, path } = nested(levels, { allOf: [{ "x-a": 1 }, { "x-a": 2 }] })
    const result = merge(schema, { rules }) as any
    expect(seen).toEqual([path])
    let node = result
    for (let i = 0; i < levels; i++) { node = node.properties[`p${i}`] }
    expect(node).toEqual({ "x-a": 2 })
  })

  it.each([3, 100])("B23.1.2 a function rule (not key-only) gets the node's path and value (%i levels deep)", (levels) => {
    const calls: { key: unknown, path: unknown }[] = []
    const rules = jsonSchemaMergeRules("draft-07", {
      "/x-*": (ctx: any) => {
        calls.push({ key: ctx.key, path: [...ctx.path] })
        return { $: (values: unknown[]) => values[0] }
      },
    })
    const { schema, path } = nested(levels, { allOf: [{ "x-b": 1 }, { "x-b": 2 }] })
    const result = merge(schema, { rules }) as any
    expect(calls).toContainEqual({ key: "x-b", path })
    let node = result
    for (let i = 0; i < levels; i++) { node = node.properties[`p${i}`] }
    expect(node).toEqual({ "x-b": 1 })
  })

  it("B23.1.3 the issue path of a deep contradiction is the node's path", () => {
    const { schema, path } = nested(90, { allOf: [{ type: "string" }, { type: "number" }] })
    const { issues } = mergeWithIssues(schema)
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([["unsatisfiable", path]])
  })

  it.each([3, 100])("B23.1.4 a resolver context has an own enumerable path that survives a spread (%i levels deep)", (levels) => {
    const contexts: MergeContext[] = []
    const rules = jsonSchemaMergeRules("draft-07", {
      "/x-c": { $: (values: unknown[], ctx?: MergeContext) => { contexts.push(ctx!); return values[0] } },
    })
    const { schema, path } = nested(levels, { allOf: [{ "x-c": 1 }, { "x-c": 2 }] })
    merge(schema, { rules })
    const [ctx] = contexts
    expect(Object.keys(ctx)).toEqual(["allOfItems", "mergeRules", "path", "settings", "key", "mergeError", "report", "forward"])
    expect({ ...ctx }.path).toEqual(path)
    ctx.path = ["changed"]
    expect(ctx.path).toEqual(["changed"])
  })
})

describe("B23.2 rule lookups", () => {
  it("B23.2.1 a hand-written rules object (not frozen) is read again on every merge", () => {
    const rules: Record<string, any> = { "/x-d": { $: (values: unknown[]) => values[0] }, "/allOf": { $: () => undefined } }
    const schema = { allOf: [{ "x-d": 1 }, { "x-d": 2 }] }
    expect(merge(schema, { rules: rules as MergeRules })).toEqual({ "x-d": 1 })
    rules["/x-d"] = { $: (values: unknown[]) => values[values.length - 1] }
    expect(merge(schema, { rules: rules as MergeRules })).toEqual({ "x-d": 2 })
  })

  it("B23.2.2 a key-only rule is resolved by key", () => {
    const first = { $: (values: unknown[]) => values[0] }
    const last = { $: (values: unknown[]) => values[values.length - 1] }
    const rules = jsonSchemaMergeRules("draft-07", { "/x-*": keyOnlyRule(({ key }: { key: string | number }) => key === "x-first" ? first : last) })
    expect(merge({ allOf: [{ "x-first": 1, "x-other": 1 }, { "x-first": 2, "x-other": 2 }] }, { rules })).toEqual({ "x-first": 1, "x-other": 2 })
  })

  it("B23.2.3 vendor keys beyond the lookup cache size merge like the others", () => {
    const items = [0, 1].map((n) => Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`x-k${i}`, n])))
    const result = merge({ allOf: items }) as Record<string, number>
    expect(Object.keys(result)).toHaveLength(1500)
    expect(Object.values(result).every((value) => value === 1)).toBe(true)
  })
})

describe("B23.3 key order", () => {
  it("B23.3.1 integer-like keys come first in ascending order, the others in order of first appearance", () => {
    const result = merge({ allOf: [{ b: 1, "10": 1, "x-a": 1 }, { "2": 1, a: 1, "01": 1 }] }) as Record<string, unknown>
    expect(Object.keys(result)).toEqual(["2", "10", "b", "x-a", "a", "01"])
  })
})

describe("B23.4 scan termination", () => {
  it("B23.4.1 a lattice with 2^40 paths over 41 objects merges in linear time", () => {
    let node: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < 40; i++) { node = { type: "object", properties: { a: node, b: node } } }
    const input = { allOf: [node, { required: ["a"] }] }
    const started = performance.now()
    const result = merge(input) as any
    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.required).toEqual(["a"])
    expect(result.properties.a).toBe(result.properties.b)
  })

  it("B23.4.2 a cyclic JavaScript input with shared members is merged and the output is not cyclic", () => {
    const shared: Record<string, unknown> = { type: "object" }
    shared.properties = { self: shared, other: { allOf: [shared, { required: ["self"] }] } }
    const result = merge({ allOf: [{ properties: { a: shared, b: shared } }, { type: "object" }] })
    expect(() => JSON.stringify(result)).not.toThrow()
  })
})
