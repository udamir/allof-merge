import { describe, it, expect } from "vite-plus/test"
import { asyncApiMergeRules, jsonSchemaMergeRules, merge, selectMergeRules } from "../../src/index.ts"
import { loadAsyncApi } from "./utils.ts"

const twoParts = () => ({ allOf: [{ type: "object" }, { properties: { id: { type: "string" } } }] })
const merged = { type: "object", properties: { id: { type: "string" } } }

describe("AsyncAPI auto-detection (F2.11)", () => {
  it.each([
    ["2.0.0", "2.x"],
    ["2.6.0", "2.x"],
    ["3.0.0", "3.0"],
    ["3.1.0", "3.0"],
  ] as const)("asyncapi %s selects the %s rules", (asyncapi, version) => {
    expect(selectMergeRules({ asyncapi })).toBe(asyncApiMergeRules(version))
  })

  it.each([["1.2.0"], [2], [null]])("asyncapi %p selects the JSON Schema rules", (asyncapi) => {
    expect(selectMergeRules({ asyncapi })).toBe(jsonSchemaMergeRules())
  })

  it("an inherited asyncapi member is not detected", () => {
    expect(selectMergeRules(Object.create({ asyncapi: "2.6.0" }))).toBe(jsonSchemaMergeRules())
  })

  it("merge(doc) merges a 2.x document without explicit rules", () => {
    const doc = { asyncapi: "2.6.0", components: { schemas: { s: twoParts() }, messages: { m: { payload: twoParts() } } } }
    expect(merge(doc)).toEqual({ asyncapi: "2.6.0", components: { schemas: { s: merged }, messages: { m: { payload: merged } } } })
  })

  it("merge(doc) merges a 3.0 document without explicit rules", () => {
    const doc = {
      asyncapi: "3.0.0",
      components: { schemas: { s: { schemaFormat: "application/vnd.aai.asyncapi+json;version=3.0.0", schema: twoParts() } } },
    }
    expect((merge(doc) as any).components.schemas.s.schema).toEqual(merged)
  })

  it.each([
    ["streetlights-kafka-2.6.yml", "2.x"],
    ["streetlights-kafka-3.0.yml", "3.0"],
  ] as const)("merge(%s) equals the merge with explicit %s rules", (file, version) => {
    const doc = loadAsyncApi(file)
    expect(merge(doc)).toEqual(merge(doc, { rules: asyncApiMergeRules(version) }))
  })

  it("a 1.x document is merged as one JSON Schema (nested allOf untouched)", () => {
    const doc = { asyncapi: "1.2.0", components: { schemas: { s: twoParts() } } }
    expect(merge(doc)).toEqual(doc)
  })
})
