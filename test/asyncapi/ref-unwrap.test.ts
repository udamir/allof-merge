import { asyncApiMergeRules, createMerger, merge } from "../../src"
import { collectErrors } from "./utils"

const AA = "application/vnd.aai.asyncapi+json;version=3.0.0"
const base = () => ({ type: "object", properties: { id: { type: "string" } } })

const doc3 = (wrapper: unknown) => ({
  asyncapi: "3.0.0",
  components: {
    schemas: {
      Mf: wrapper,
      User: { allOf: [{ $ref: "#/components/schemas/Mf" }, { required: ["id"] }] },
    },
  },
})

describe("$ref to a 3.0 Multi Format Schema Object inside allOf (F2.10, Q2-4)", () => {
  it.each([
    AA,
    "application/vnd.aai.asyncapi;version=3.0.0",
    "application/schema+json;version=draft-07",
    "application/schema+yaml;version=draft-07",
  ])("unwraps a %s wrapper: the inner schema is merged", (schemaFormat) => {
    const { errors, onMergeError, onRefResolveError } = collectErrors()
    const result: any = merge(doc3({ schemaFormat, schema: base() }), { rules: asyncApiMergeRules("3.0"), onMergeError, onRefResolveError })
    expect(result.components.schemas.User).toEqual({ ...base(), required: ["id"] })
    expect(result.components.schemas.Mf).toEqual({ schemaFormat, schema: base() })
    expect(errors).toEqual([])
  })

  it("unwraps through a $ref chain and an inner $ref", () => {
    const doc = {
      asyncapi: "3.0.0",
      components: {
        schemas: {
          Base: base(),
          Mf: { schemaFormat: AA, schema: { $ref: "#/components/schemas/Base" } },
          Alias: { $ref: "#/components/schemas/Mf" },
          User: { allOf: [{ $ref: "#/components/schemas/Alias" }, { required: ["id"] }] },
        },
      },
    }
    const result: any = merge(doc, { rules: asyncApiMergeRules("3.0") })
    expect(result.components.schemas.User).toEqual({ ...base(), required: ["id"] })
  })

  it("unwraps inside message payloads and headers", () => {
    const doc = {
      asyncapi: "3.0.0",
      components: {
        schemas: { Mf: { schemaFormat: AA, schema: base() } },
        messages: {
          m: {
            payload: { allOf: [{ $ref: "#/components/schemas/Mf" }, { required: ["id"] }] },
            headers: { schemaFormat: AA, schema: { allOf: [{ $ref: "#/components/schemas/Mf" }, { required: ["id"] }] } },
          },
        },
      },
    }
    const result: any = merge(doc, { rules: asyncApiMergeRules("3.0") })
    expect(result.components.messages.m.payload).toEqual({ ...base(), required: ["id"] })
    expect(result.components.messages.m.headers).toEqual({ schemaFormat: AA, schema: { ...base(), required: ["id"] } })
  })

  it("unwraps with auto-detected rules too", () => {
    const result: any = merge(doc3({ schemaFormat: AA, schema: base() }))
    expect(result.components.schemas.User).toEqual({ ...base(), required: ["id"] })
  })

  it.each([
    "application/vnd.apache.avro;version=1.9.0",
    "application/vnd.google.protobuf;version=3",
    "application/raml+yaml;version=1.0",
    "application/x-unknown",
    "application/vnd.oai.openapi;version=3.0.0",
  ])("keeps the $ref to a %s wrapper and reports it with onMergeError", (schemaFormat) => {
    const { errors, onMergeError } = collectErrors()
    const result: any = merge(doc3({ schemaFormat, schema: base() }), { rules: asyncApiMergeRules("3.0"), onMergeError })
    const user = result.components.schemas.User
    expect(user.required).toEqual(["id"])
    expect(user.allOf).toEqual([{ $ref: "#/components/schemas/Mf" }])
    expect(user.properties).toBeUndefined()
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain(schemaFormat)
    expect(errors[0].path).toEqual(["components", "schemas", "User"])
  })

  it("keeps the $ref to a wrapper with a non-string schemaFormat or without schema", () => {
    for (const wrapper of [{ schemaFormat: 7, schema: base() }, { schemaFormat: AA }]) {
      const { errors, onMergeError } = collectErrors()
      const result: any = merge(doc3(wrapper), { rules: asyncApiMergeRules("3.0"), onMergeError })
      expect(result.components.schemas.User.allOf).toEqual([{ $ref: "#/components/schemas/Mf" }])
      expect(errors.length).toBe(1)
    }
  })
})

describe("unwrapped targets and the link rules", () => {
  const doc = () => ({
    asyncapi: "3.0.0",
    components: {
      schemas: {
        Base: base(),
        Mf: { schemaFormat: AA, schema: { properties: { id: { type: "string" } }, allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { id: { minLength: 1 } } }] } },
        Avro: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record" } },
        P: { properties: { a: { $ref: "#/components/schemas/Mf/schema/properties/id" }, b: { $ref: "#/components/schemas/Mf/schema/allOf/0" } } },
        U: { allOf: [{ $ref: "#/components/schemas/Mf" }, { required: ["id"] }] },
        V: { allOf: [{ $ref: "#/components/schemas/Avro" }, { required: ["id"] }, { $ref: "#/components/schemas/Avro" }] },
      },
    },
  })

  it("a $ref into the inner schema of a wrapper follows the link rules (copy when stricter, link to the target's own place)", () => {
    const result: any = merge(doc())
    expect(result.components.schemas.Mf.schema).toEqual({ type: "object", properties: { id: { type: "string", minLength: 1 } } })
    expect(result.components.schemas.P.properties.a).toEqual({ type: "string" })
    expect(result.components.schemas.P.properties.b).toEqual({ $ref: "#/components/schemas/Base" })
    expect(result.components.schemas.U).toEqual({ type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"] })
  })

  it("the same kept wrapper reached twice is one fragment and one report", () => {
    const { errors, onMergeError } = collectErrors()
    const result: any = merge(doc(), { onMergeError })
    expect(result.components.schemas.V).toEqual({ required: ["id"], allOf: [{ $ref: "#/components/schemas/Avro" }] })
    expect(errors.length).toBe(1)
  })

  it("one merger: the unwrapped inner schema is merged per rules (wrapper site and allOf site)", () => {
    const merger = createMerger()
    const first: any = merger.merge(doc())
    const second: any = merger.merge(doc())
    expect(second).toEqual(first)
  })
})

describe("no unwrapping outside AsyncAPI 3.0 documents", () => {
  // these hold with and without the hook: { schemaFormat, schema } is an ordinary schema there
  const wrapper = () => ({ schemaFormat: AA, schema: base() })

  it("AsyncAPI 2.x: the target is merged as a schema", () => {
    const doc = { ...doc3(wrapper()), asyncapi: "2.6.0" }
    const result: any = merge(doc, { rules: asyncApiMergeRules("2.x") })
    expect(result.components.schemas.User).toEqual({ ...wrapper(), required: ["id"] })
  })

  it("JSON Schema document: the target is merged as a schema", () => {
    const doc = { definitions: { Mf: wrapper() }, allOf: [{ $ref: "#/definitions/Mf" }, { required: ["id"] }] }
    expect(merge(doc)).toEqual({ definitions: { Mf: wrapper() }, ...wrapper(), required: ["id"] })
  })
})
