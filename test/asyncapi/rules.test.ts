import {
  asyncApiMergeRules,
  asyncApiSchemaMergeRules,
  asyncApiVersion,
  createMerger,
  detectAsyncApiVersion,
  jsonSchemaMergeRules,
  merge,
  type MergeRules,
} from "../../src"

const twoParts = () => ({ allOf: [{ type: "object" }, { properties: { id: { type: "string" } } }] })

describe("detectAsyncApiVersion", () => {
  it.each([
    ["2.0.0", "2.x"],
    ["2.3.0", "2.x"],
    ["2.6.0", "2.x"],
    ["3.0.0", "3.0"],
    ["3.1.0", "3.0"],
  ])("asyncapi %s -> %s", (asyncapi, version) => {
    expect(detectAsyncApiVersion({ asyncapi })).toBe(version)
  })

  it.each([["1.2.0"], ["4.0.0"], [""], ["latest"], [2], [null], [undefined]])("asyncapi %p -> undefined", (asyncapi) => {
    expect(detectAsyncApiVersion({ asyncapi })).toBeUndefined()
  })

  it("only an own asyncapi member counts", () => {
    expect(detectAsyncApiVersion(Object.create({ asyncapi: "2.6.0" }))).toBeUndefined()
    expect(detectAsyncApiVersion(null)).toBeUndefined()
    expect(detectAsyncApiVersion("asyncapi: 2.6.0")).toBeUndefined()
    expect(detectAsyncApiVersion([])).toBeUndefined()
  })

  it("exports the version list", () => {
    expect(asyncApiVersion).toEqual(["2.x", "3.0"])
  })
})

describe("asyncApiMergeRules: memoization and freezing", () => {
  it("returns the same rules object for the same (version, customRules)", () => {
    const custom: MergeRules = {}
    expect(asyncApiMergeRules("2.x")).toBe(asyncApiMergeRules("2.x"))
    expect(asyncApiMergeRules("3.0")).toBe(asyncApiMergeRules("3.0"))
    expect(asyncApiMergeRules()).toBe(asyncApiMergeRules("3.0"))
    expect(asyncApiMergeRules("2.x")).not.toBe(asyncApiMergeRules("3.0"))
    expect(asyncApiMergeRules("2.x", custom)).toBe(asyncApiMergeRules("2.x", custom))
    expect(asyncApiMergeRules("2.x", custom)).not.toBe(asyncApiMergeRules("2.x"))
    expect(asyncApiSchemaMergeRules(undefined, custom)).toBe(asyncApiSchemaMergeRules("application/vnd.aai.asyncapi", custom))
  })

  it.each(asyncApiVersion)("%s rules are deep-frozen, also the rules returned by function rules", (version) => {
    const rules: any = asyncApiMergeRules(version)
    const seen = new Set<object>()
    const ctx = (value: unknown) => ({ key: "x", path: ["x"], value })
    const values = [undefined, { schemaFormat: "application/vnd.apache.avro" }, { schemaFormat: "application/schema+json;version=draft-04", schema: {} }]
    const check = (node: any, depth: number) => {
      if (depth > 12 || typeof node !== "object" || node === null || seen.has(node)) { return }
      seen.add(node)
      expect(Object.isFrozen(node)).toBe(true)
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === "function") {
          // function rules (message / Multi Format Schema Object sites) and lazy schema thunks; `$` is a resolver
          if (!key.startsWith("/")) { continue }
          for (const value of values) { check(child(ctx(value)), depth + 1) }
        } else {
          check(child, depth + 1)
        }
      }
    }
    check(rules, 0)
    expect(() => { rules["/channels"] = {} }).toThrow(TypeError)
    expect(() => { rules["/components"]["/schemas"]["/*"] = {} }).toThrow(TypeError)
  })

  it("schema rules are frozen and caller custom rules are not frozen", () => {
    const custom: MergeRules = { "/x-a": { $: (args: any[]) => args.join("+") } }
    const rules = asyncApiSchemaMergeRules(undefined, custom)!
    expect(Object.isFrozen(rules)).toBe(true)
    expect(Object.isFrozen(custom)).toBe(false)
    expect(Object.isFrozen(custom["/x-a"])).toBe(false)
  })
})

describe("asyncApiMergeRules: custom schema rules", () => {
  const joinTitles = { $: (args: any[]) => args.join(" & ") }
  const custom: MergeRules = { "/title": joinTitles }
  const titled = () => ({ allOf: [{ title: "a" }, { title: "b" }] })

  it("2.x: applied at AsyncAPI, JSON Schema and OpenAPI payloads, headers, parameters, bindings and nested schemas", () => {
    const doc = {
      asyncapi: "2.6.0",
      channels: { c: { parameters: { p: { schema: titled() } }, bindings: { ws: { query: titled() } } } },
      components: {
        schemas: { s: { type: "object", properties: { n: titled() } } },
        messages: {
          a: { payload: titled(), headers: titled() },
          j: { schemaFormat: "application/schema+json;version=draft-04", payload: titled() },
          o: { schemaFormat: "application/vnd.oai.openapi;version=3.0.0", payload: titled() },
          avro: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", payload: titled() },
        },
      },
    }
    const result: any = merge(doc, { rules: asyncApiMergeRules("2.x", custom) })
    const ab = { title: "a & b" }
    expect(result.channels.c.parameters.p.schema).toEqual(ab)
    expect(result.channels.c.bindings.ws.query).toEqual(ab)
    expect(result.components.schemas.s.properties.n).toEqual(ab)
    expect(result.components.messages.a).toEqual({ payload: ab, headers: ab })
    expect(result.components.messages.j.payload).toEqual(ab)
    expect(result.components.messages.o.payload).toEqual(ab)
    expect(result.components.messages.avro.payload).toEqual(titled())
    // without custom rules the last title wins
    const plain: any = merge(doc, { rules: asyncApiMergeRules("2.x") })
    expect(plain.components.messages.a.payload).toEqual({ title: "b" })
  })

  it("3.0: applied at plain schemas and inside JSON-Schema-like Multi Format Schema Objects", () => {
    const doc = {
      asyncapi: "3.0.0",
      components: {
        schemas: {
          plain: titled(),
          wrapped: { schemaFormat: "application/schema+json;version=2020-12", schema: titled() },
          openapi: { schemaFormat: "application/vnd.oai.openapi;version=3.1.0", schema: titled() },
          avro: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: titled() },
        },
        messageBindings: { b: { kafka: { key: titled() } } },
      },
    }
    const result: any = merge(doc, { rules: asyncApiMergeRules("3.0", custom) })
    const ab = { title: "a & b" }
    expect(result.components.schemas.plain).toEqual(ab)
    expect(result.components.schemas.wrapped.schema).toEqual(ab)
    expect(result.components.schemas.openapi.schema).toEqual(ab)
    expect(result.components.schemas.avro.schema).toEqual(titled())
    expect(result.components.messageBindings.b.kafka.key).toEqual(ab)
  })

  it("custom rules override the AsyncAPI discriminator rule", () => {
    const rules = asyncApiMergeRules("2.x", { "/discriminator": joinTitles })
    const doc = { asyncapi: "2.6.0", components: { schemas: { s: { allOf: [{ discriminator: "a" }, { discriminator: "b" }] } } } }
    expect((merge(doc, { rules }) as any).components.schemas.s).toEqual({ discriminator: "a & b" })
  })
})

describe("createMerger reuse with AsyncAPI and JSON Schema rules (F2.13)", () => {
  it("memoizes per rules object: results are not mixed", () => {
    const doc = { asyncapi: "2.6.0", components: { schemas: { s: twoParts() } } }
    const merger = createMerger()
    const asJsonSchema: any = merger.merge(doc, { rules: jsonSchemaMergeRules() })
    const asAsyncApi: any = merger.merge(doc, { rules: asyncApiMergeRules("2.x") })
    const again: any = merger.merge(doc, { rules: jsonSchemaMergeRules() })
    expect(asJsonSchema.components.schemas.s).toEqual(twoParts())
    expect(asAsyncApi.components.schemas.s).toEqual({ type: "object", properties: { id: { type: "string" } } })
    expect(again).toEqual(asJsonSchema)
  })
})
