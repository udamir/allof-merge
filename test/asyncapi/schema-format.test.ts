import {
  asyncApiSchemaDialect,
  asyncApiSchemaMergeRules,
  jsonSchemaMergeRules,
  merge,
  openApiJsonSchemaMergeRules,
  unwrapSchemaFormat,
} from "../../src"

describe("AsyncAPI schemaFormat -> dialect", () => {
  it.each([
    [undefined, "asyncapi"],
    ["application/vnd.aai.asyncapi;version=2.6.0", "asyncapi"],
    ["application/vnd.aai.asyncapi+json;version=3.0.0", "asyncapi"],
    ["application/vnd.aai.asyncapi+yaml;version=3.0.0", "asyncapi"],
    ["Application/VND.AAI.AsyncAPI+JSON;version=2.0.0", "asyncapi"],
    ["  application/vnd.aai.asyncapi  ", "asyncapi"],
    ["application/schema+json;version=draft-07", "draft-07"],
    ["application/schema+yaml;version=draft-06", "draft-06"],
    ["application/schema+json;version=draft-04", "draft-04"],
    ["application/schema+json;version=2019-09", "2020-12"],
    ["application/schema+json;version=2020-12", "2020-12"],
    ["application/schema+json", "draft-07"],
    ["application/schema+json;version=draft-99", "draft-07"],
    ["application/vnd.oai.openapi;version=3.0.0", "openapi-3.0"],
    ["application/vnd.oai.openapi+json;version=3.0.3", "openapi-3.0"],
    ["application/vnd.oai.openapi+yaml", "openapi-3.0"],
    ["application/vnd.oai.openapi;version=3.1.0", "openapi-3.1"],
  ])("%s -> %s", (format, dialect) => {
    expect(asyncApiSchemaDialect(format)).toBe(dialect)
  })

  it.each([
    "application/vnd.apache.avro;version=1.9.0",
    "application/vnd.apache.avro+json;version=1.9.0",
    "application/raml+yaml;version=1.0",
    "application/vnd.google.protobuf;version=3",
    "application/x-unknown",
    "",
  ])("%s is not a JSON Schema format", (format) => {
    expect(asyncApiSchemaDialect(format)).toBeUndefined()
    expect(asyncApiSchemaMergeRules(format)).toBeUndefined()
  })

  it.each([[42], [null], [{ format: "x" }], [["application/schema+json"]]])("non-string schemaFormat %p is not mergeable", (format) => {
    expect(asyncApiSchemaDialect(format)).toBeUndefined()
    expect(asyncApiSchemaMergeRules(format)).toBeUndefined()
  })
})

describe("asyncApiSchemaMergeRules", () => {
  it("returns the JSON Schema draft rules for JSON Schema formats", () => {
    expect(asyncApiSchemaMergeRules("application/schema+json;version=draft-04")).toBe(jsonSchemaMergeRules("draft-04"))
    expect(asyncApiSchemaMergeRules("application/schema+json;version=draft-07")).toBe(jsonSchemaMergeRules("draft-07"))
    expect(asyncApiSchemaMergeRules("application/schema+json;version=2020-12")).toBe(jsonSchemaMergeRules("2020-12"))
  })

  it("returns the OpenAPI schema rules for OpenAPI formats", () => {
    expect(asyncApiSchemaMergeRules("application/vnd.oai.openapi;version=3.0.0")).toBe(openApiJsonSchemaMergeRules("3.0.x"))
    expect(asyncApiSchemaMergeRules("application/vnd.oai.openapi;version=3.1.0")).toBe(openApiJsonSchemaMergeRules("3.1.x"))
  })

  it("AsyncAPI schema rules are draft-07 based (items tuple, const) and shared by every AsyncAPI format", () => {
    const rules = asyncApiSchemaMergeRules()!
    expect(rules.tuple).toBe("items")
    expect(asyncApiSchemaMergeRules("application/vnd.aai.asyncapi;version=2.6.0")).toBe(rules)
    expect(asyncApiSchemaMergeRules("application/vnd.aai.asyncapi+json;version=3.0.0")).toBe(rules)
    expect(merge({ allOf: [{ const: 1 }, { const: 2 }] }, { rules })).toBe(false)
    expect(merge({ allOf: [{ type: "array", items: [{ type: "string" }] }, { items: [{ minLength: 1 }] }] }, { rules }))
      .toEqual({ type: "array", items: [{ type: "string", minLength: 1 }] })
  })

  it("AsyncAPI discriminator (a string) is kept next to oneOf when siblings are distributed", () => {
    const schema = {
      discriminator: "kind",
      required: ["kind"],
      oneOf: [{ properties: { kind: { const: "a" } } }, { properties: { kind: { const: "b" } } }],
    }
    expect(merge(schema, { rules: asyncApiSchemaMergeRules(), mergeCombinarySibling: true })).toEqual({
      discriminator: "kind",
      oneOf: [
        { properties: { kind: { const: "a" } }, required: ["kind"] },
        { properties: { kind: { const: "b" } }, required: ["kind"] },
      ],
    })
  })

  it("AsyncAPI discriminator from several allOf items: the last one wins", () => {
    expect(merge({ allOf: [{ discriminator: "a" }, { discriminator: "b" }] }, { rules: asyncApiSchemaMergeRules() }))
      .toEqual({ discriminator: "b" })
  })
})

describe("unwrapSchemaFormat (engine hook for $ref targets in AsyncAPI 3.0)", () => {
  const inner = { type: "object", properties: { id: { type: "string" } } }

  it("returns a target that is not a Multi Format Schema Object as it is", () => {
    for (const target of [inner, true, false, { $ref: "#/x" }, [1], null, "text"]) {
      expect(unwrapSchemaFormat(target)).toEqual({ ok: true, schema: target })
    }
  })

  it.each([
    "application/vnd.aai.asyncapi+json;version=3.0.0",
    "application/vnd.aai.asyncapi;version=2.6.0",
    "application/schema+json;version=draft-07",
    "application/schema+json;version=draft-04",
    "application/schema+yaml;version=2020-12",
  ])("unwraps the inner schema of format %s", (schemaFormat) => {
    const result = unwrapSchemaFormat({ schemaFormat, schema: inner })
    expect(result.ok).toBe(true)
    expect(result.ok && result.schema).toBe(inner)
  })

  it.each([
    "application/vnd.apache.avro;version=1.9.0",
    "application/vnd.google.protobuf;version=3",
    "application/raml+yaml;version=1.0",
    "application/x-unknown",
    "application/vnd.oai.openapi;version=3.0.0",
  ])("keeps a wrapper of format %s (reported)", (schemaFormat) => {
    const result = unwrapSchemaFormat({ schemaFormat, schema: inner })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.schemaFormat).toBe(schemaFormat)
    expect(!result.ok && result.message).toContain(schemaFormat)
  })

  it("keeps a wrapper with a non-string schemaFormat or without schema", () => {
    const nonString = unwrapSchemaFormat({ schemaFormat: 1, schema: inner })
    expect(nonString.ok).toBe(false)
    const noSchema = unwrapSchemaFormat({ schemaFormat: "application/vnd.aai.asyncapi;version=3.0.0" })
    expect(noSchema.ok).toBe(false)
    expect(!noSchema.ok && noSchema.message).toMatch(/without schema/)
  })

  it("an inherited schemaFormat does not make a wrapper", () => {
    const target = Object.create({ schemaFormat: "application/vnd.apache.avro" })
    target.type = "string"
    expect(unwrapSchemaFormat(target)).toEqual({ ok: true, schema: target })
  })
})
