import { describe, it, test, expect } from "vite-plus/test"
import { openApiMergeRules } from "../../src/index.ts"
import { merge, clone, hasNoAllOf, mergeReport } from "./helpers.ts"

// B7 - OpenAPI 3.x rules

const inner = { allOf: [{ type: "string" }, { minLength: 1 }] }
const merged = { type: "string", minLength: 1 }

describe("B7.1 rule selection", () => {
  it("B7.1.1 auto-detects OpenAPI 3.0 and merges component schemas", () => {
    const result = merge({ openapi: "3.0.3", components: { schemas: { A: inner } } })
    expect(result.components.schemas.A).toEqual(merged)
  })

  it("B7.1.2 auto-detects OpenAPI 3.1", () => {
    const result = merge({ openapi: "3.1.0", components: { schemas: { A: inner } } })
    expect(result.components.schemas.A).toEqual(merged)
  })

  it("B7.1.3 openApiMergeRules() defaults to 3.0.x", () => {
    const result = merge({ components: { schemas: { A: { allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 1 }] } } } }, { rules: openApiMergeRules() })
    expect(result.components.schemas.A).toEqual({ minimum: 1, exclusiveMinimum: true })
  })

  it("B7.1.4 does not treat a document without openapi key as OpenAPI (components are not a schema location)", () => {
    const data = { components: { schemas: { A: inner } } }
    expect(merge(data)).toEqual(data)
  })
})

describe("B7.2 schema locations", () => {
  const doc = {
    openapi: "3.0.0",
    paths: {
      "/x": {
        parameters: [{ name: "p", in: "query", schema: clone(inner) }],
        get: {
          parameters: [{ name: "q", in: "query", schema: clone(inner) }],
          requestBody: { content: { "application/json": { schema: clone(inner) } } },
          responses: { "200": { headers: { h: { schema: clone(inner) } }, content: { "application/json": { schema: clone(inner) } } } },
        },
      },
    },
    components: {
      schemas: { A: clone(inner) },
      parameters: { p: { schema: clone(inner) } },
      headers: { h: { schema: clone(inner) } },
      responses: { r: { headers: { h: { schema: clone(inner) } }, content: { "a/b": { schema: clone(inner) } } } },
      requestBodies: { b: { content: { "a/b": { schema: clone(inner) } } } },
    },
  }

  it("B7.2.1 merges every supported schema location", () => {
    const result = merge(doc)
    expect(hasNoAllOf(result)).toBe(true)
    expect(result.paths["/x"].parameters[0].schema).toEqual(merged)
    expect(result.paths["/x"].get.parameters[0].schema).toEqual(merged)
    expect(result.paths["/x"].get.requestBody.content["application/json"].schema).toEqual(merged)
    expect(result.paths["/x"].get.responses["200"].headers.h.schema).toEqual(merged)
    expect(result.paths["/x"].get.responses["200"].content["application/json"].schema).toEqual(merged)
    expect(result.components.schemas.A).toEqual(merged)
    expect(result.components.parameters.p.schema).toEqual(merged)
    expect(result.components.headers.h.schema).toEqual(merged)
    expect(result.components.responses.r.headers.h.schema).toEqual(merged)
    expect(result.components.responses.r.content["a/b"].schema).toEqual(merged)
    expect(result.components.requestBodies.b.content["a/b"].schema).toEqual(merged)
  })

  it("B7.2.2 resolves $ref to components from schema locations", () => {
    const result = merge({ openapi: "3.0.0", components: { schemas: {
      A: { type: "object", properties: { x: { type: "string" } } },
      B: { allOf: [{ $ref: "#/components/schemas/A" }, { required: ["x"] }] },
    } } })
    expect(result.components.schemas.B).toEqual({ type: "object", properties: { x: { type: "string" } }, required: ["x"] })
  })

  it("B7.2.3 resolves $ref to a component parameter schema", () => {
    const result = merge({ openapi: "3.0.0", paths: { "/x": { get: { parameters: [{ name: "q", in: "query", schema: { allOf: [{ $ref: "#/components/schemas/A" }, { maxLength: 3 }] } }] } } }, components: { schemas: { A: { type: "string" } } } })
    expect(result.paths["/x"].get.parameters[0].schema).toEqual({ type: "string", maxLength: 3 })
  })

  // 0.x bug, fixed: callbacks, webhooks (3.1), components.pathItems and links are not covered by openApiMergeRules
  test("B7.2.4 merges schemas inside callbacks and webhooks", () => {
    const result = merge({
      openapi: "3.1.0",
      webhooks: { w: { post: { requestBody: { content: { "a/b": { schema: clone(inner) } } } } } },
      paths: { "/x": { get: { callbacks: { c: { "{$url}": { post: { requestBody: { content: { "a/b": { schema: clone(inner) } } } } } } } } } },
    })
    expect(result.webhooks.w.post.requestBody.content["a/b"].schema).toEqual(merged)
    expect(result.paths["/x"].get.callbacks.c["{$url}"].post.requestBody.content["a/b"].schema).toEqual(merged)
  })

  // 0.x bug, fixed: the encoding rule is "/encoding/headers/*/schema" but Encoding objects are keyed by property name ("/encoding/*/headers/*/schema"), so encoding header schemas are never merged
  test("B7.2.6 merges header schemas inside media type encoding objects", () => {
    const result = merge({ openapi: "3.0.0", paths: { "/x": { post: {
      requestBody: { content: { "multipart/form-data": { schema: { type: "object" }, encoding: { f: { headers: { h: { schema: clone(inner) } } } } } } },
      responses: { "200": { content: { "multipart/form-data": { schema: { type: "object" }, encoding: { f: { headers: { h: { schema: clone(inner) } } } } } } } },
    } } } })
    expect(result.paths["/x"].post.requestBody.content["multipart/form-data"].encoding.f.headers.h.schema).toEqual(merged)
    expect(result.paths["/x"].post.responses["200"].content["multipart/form-data"].encoding.f.headers.h.schema).toEqual(merged)
  })

  it("B7.2.5 leaves non-schema allOf untouched", () => {
    const data = { openapi: "3.0.0", info: { title: "t", version: "1", allOf: [{ a: 1 }, { a: 2 }] }, "x-root": { allOf: [{ a: 1 }, { a: 2 }] } }
    expect(merge(data)).toEqual(data)
  })
})

describe("B7.3 OpenAPI 3.0 keyword semantics", () => {
  const oas30 = (schema: any) => merge({ openapi: "3.0.0", components: { schemas: { A: schema } } }).components.schemas.A

  // (contract change): OAS 3.0.3 says nullable only has an effect "if type is explicitly defined within the same
  // Schema Object", so `{ nullable: false }` without `type` does not forbid null; the typed item allows string | null
  it("B7.3.1 nullable true ∧ untyped nullable false keeps null (untyped nullable has no effect)", () => {
    expect(oas30({ allOf: [{ type: "string", nullable: true }, { nullable: false }] })).toEqual({ type: "string", nullable: true })
    expect(oas30({ allOf: [{ type: "string", nullable: true }, { type: "string", nullable: false }] })).toEqual({ type: "string", nullable: false })
  })

  // 0.x bug, fixed: nullable has no rule in the OpenAPI 3.0 rule set, so the last value wins and null becomes acceptable
  test("B7.3.2 nullable false ∧ true is false", () => {
    expect(oas30({ allOf: [{ type: "string", nullable: false }, { nullable: true }] })).toEqual({ type: "string", nullable: false })
  })

  it("B7.3.3 boolean exclusiveMinimum with equal bounds is OR-ed", () => {
    expect(oas30({ allOf: [{ minimum: 5, exclusiveMinimum: true }, { minimum: 5 }] })).toEqual({ minimum: 5, exclusiveMinimum: true })
  })

  // 0.x bug, fixed: same defect as draft-04; 5 is valid for both items but rejected after merge
  test("B7.3.4 boolean exclusiveMinimum is dropped when a larger inclusive minimum wins", () => {
    const result = oas30({ allOf: [{ minimum: 1, exclusiveMinimum: true }, { minimum: 5 }] })
    expect(result.minimum).toBe(5)
    expect(result.exclusiveMinimum).not.toBe(true)
  })

  it("B7.3.5 discriminator objects are merged", () => {
    expect(oas30({ allOf: [{ discriminator: { propertyName: "t" } }, { discriminator: { mapping: { a: "#/components/schemas/B" } } }] }))
      .toEqual({ discriminator: { propertyName: "t", mapping: { a: "#/components/schemas/B" } } })
  })

  it("B7.3.6 x-* extensions: last wins", () => {
    expect(oas30({ allOf: [{ "x-a": 1, type: "object" }, { "x-a": 2 }] })).toEqual({ "x-a": 2, type: "object" })
  })

  it("B7.3.7 readOnly / writeOnly / deprecated are OR-ed, example objects merged", () => {
    expect(oas30({ allOf: [{ readOnly: true, example: { a: 1 } }, { readOnly: false, deprecated: true, example: { b: 2 } }] }))
      .toEqual({ readOnly: true, deprecated: true, example: { a: 1, b: 2 } })
  })

  // 0.x bug, fixed: the OpenAPI 3.0 "/items" rule is a function expecting a context argument but jsonSchemaMergeResolver calls it without arguments, so merging two "items" throws "Right side of assignment cannot be destructured"
  test("B7.3.8 merges two items schemas under OpenAPI 3.0 rules", () => {
    expect(oas30({ allOf: [{ items: { type: "string" } }, { items: { minLength: 1 } }] })).toEqual({ items: merged })
  })

  it("B7.3.9 merges a single items schema with nested allOf under OpenAPI 3.0 rules", () => {
    expect(oas30({ type: "array", items: clone(inner) })).toEqual({ type: "array", items: merged })
  })

  it("B7.3.10 merges enum and required in OpenAPI 3.0 schemas", () => {
    const result = oas30({ allOf: [{ enum: ["a", "b"], required: ["x"] }, { enum: ["b", "c"], required: ["y"] }] })
    expect(result.enum).toEqual(["b"])
    expect([...result.required].sort()).toEqual(["x", "y"])
  })
})

describe("B7.4 OpenAPI 3.1 keyword semantics", () => {
  const oas31 = (schema: any) => merge({ openapi: "3.1.0", components: { schemas: { A: schema } } }).components.schemas.A

  it("B7.4.1 exclusiveMinimum / exclusiveMaximum are numeric", () => {
    expect(oas31({ allOf: [{ exclusiveMinimum: 1 }, { exclusiveMinimum: 5 }] })).toEqual({ exclusiveMinimum: 5 })
  })

  it("B7.4.2 const is merged", () => {
    expect(oas31({ allOf: [{ const: 1 }, { const: 1 }] })).toEqual({ const: 1 })
  })

  it("B7.4.3 type arrays with null are intersected", () => {
    expect(oas31({ allOf: [{ type: ["string", "null"] }, { type: ["string", "number", "null"] }] })).toEqual({ type: ["string", "null"] })
  })

  it("B7.4.4 merges two items schemas under OpenAPI 3.1 rules", () => {
    expect(oas31({ allOf: [{ items: { type: "string" } }, { items: { minLength: 1 } }] })).toEqual({ items: merged })
  })
})

describe("B7.5 error hooks in OpenAPI documents", () => {
  it("B7.5.1 reports conflicts with the full document path", () => {
    const { mergeErrors } = mergeReport({ openapi: "3.0.0", components: { schemas: { A: { properties: { p: { allOf: [{ type: "string" }, { type: "number" }] } } } } } })
    expect(mergeErrors.map((e) => e.path)).toEqual([["components", "schemas", "A", "properties", "p"]])
  })

  it("B7.5.2 reports broken component refs with the full document path", () => {
    const { refErrors } = mergeReport({ openapi: "3.0.0", components: { schemas: { A: { allOf: [{ $ref: "#/components/schemas/Nope" }, { type: "object" }] } } } })
    expect(refErrors).toEqual([{ message: "Cannot resolve $ref", path: ["components", "schemas", "A"], ref: "#/components/schemas/Nope" }])
  })
})
