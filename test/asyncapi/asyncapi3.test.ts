import { describe, it, expect } from "vite-plus/test"
import { asyncApiMergeRules, merge } from "../../src/index.ts"
import { allOfPaths, collectErrors, loadAsyncApi } from "./utils.ts"

const rules = asyncApiMergeRules("3.0")
// a fresh copy per use: the engine shares the output of one input object between its occurrences
const twoParts = () => ({ allOf: [{ type: "object" }, { properties: { id: { type: "string" } } }] })
const merged = { type: "object", properties: { id: { type: "string" } } }
const AA = "application/vnd.aai.asyncapi+json;version=3.0.0"

describe("AsyncAPI 3.0 rules: schema locations", () => {
  it("merges components.schemas, channel messages and components.messages payload / headers", () => {
    const doc = {
      asyncapi: "3.0.0",
      channels: { c: { address: "a", messages: { m: { payload: twoParts(), headers: twoParts() } } } },
      components: {
        schemas: { s: twoParts() },
        messages: { m: { payload: twoParts(), headers: twoParts() } },
        channels: { c: { messages: { m: { payload: twoParts() } } } },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.channels.c.messages.m).toEqual({ payload: merged, headers: merged })
    expect(result.components.schemas.s).toEqual(merged)
    expect(result.components.messages.m).toEqual({ payload: merged, headers: merged })
    expect(result.components.channels.c.messages.m).toEqual({ payload: merged })
  })

  it("merges message traits headers (inline and components.messageTraits)", () => {
    const doc = {
      asyncapi: "3.0.0",
      components: {
        messages: { m: { traits: [{ headers: twoParts() }, { $ref: "#/components/messageTraits/t" }] } },
        messageTraits: { t: { headers: twoParts() } },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.components.messages.m.traits).toEqual([{ headers: merged }, { $ref: "#/components/messageTraits/t" }])
    expect(result.components.messageTraits.t.headers).toEqual(merged)
  })

  it("merges inline messages of operations, replies and components.replies / components.operations", () => {
    const doc = {
      asyncapi: "3.0.0",
      operations: {
        o: { action: "send", messages: [{ payload: twoParts() }], reply: { messages: [{ payload: twoParts() }] } },
      },
      components: {
        operations: { o: { action: "receive", messages: [{ headers: twoParts() }] } },
        replies: { r: { messages: [{ payload: twoParts() }] } },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.operations.o.messages).toEqual([{ payload: merged }])
    expect(result.operations.o.reply.messages).toEqual([{ payload: merged }])
    expect(result.components.operations.o.messages).toEqual([{ headers: merged }])
    expect(result.components.replies.r.messages).toEqual([{ payload: merged }])
  })

  it("leaves non-schema locations untouched (3.0 parameters have no schema)", () => {
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1", "x-schema": twoParts() },
      servers: { s: { host: "h", protocol: "kafka", variables: { v: { default: "x", allOf: [{ a: 1 }] } } } },
      channels: { c: { address: "a", parameters: { p: { enum: ["a"], allOf: [{ a: 1 }] } }, "x-ext": twoParts() } },
      operations: { o: { action: "send", channel: { $ref: "#/channels/c" }, "x-ext": twoParts() } },
      components: {
        parameters: { p: { description: "d", allOf: [{ a: 1 }] } },
        correlationIds: { c: { location: "$message.header#/id" } },
        securitySchemes: { k: { type: "httpApiKey", name: "k", in: "header" } },
      },
    }
    expect(merge(doc, { rules })).toEqual(doc)
  })
})

describe("AsyncAPI 3.0 rules: Multi Format Schema Object", () => {
  const sites = (value: () => unknown) => ({
    asyncapi: "3.0.0",
    channels: { c: { messages: { m: { payload: value(), headers: value() } } } },
    components: {
      schemas: { s: value() },
      messages: { m: { payload: value(), headers: value() } },
      messageTraits: { t: { headers: value() } },
    },
  })
  const values = (doc: any) => [
    doc.channels.c.messages.m.payload,
    doc.channels.c.messages.m.headers,
    doc.components.schemas.s,
    doc.components.messages.m.payload,
    doc.components.messages.m.headers,
    doc.components.messageTraits.t.headers,
  ]

  it.each([
    AA,
    "application/vnd.aai.asyncapi;version=3.0.0",
    "application/vnd.aai.asyncapi+yaml;version=3.0.0",
    "application/schema+json;version=draft-07",
    "application/schema+yaml;version=draft-07",
  ])("merges the inner schema of a %s wrapper and keeps schemaFormat", (schemaFormat) => {
    const result = merge(sites(() => ({ schemaFormat, schema: twoParts() })), { rules })
    for (const value of values(result)) {
      expect(value).toEqual({ schemaFormat, schema: merged })
    }
  })

  it("JSON Schema draft-04 wrapper uses the draft-04 rules", () => {
    const result: any = merge(sites(() => ({ schemaFormat: "application/schema+json;version=draft-04", schema: { allOf: [{ const: 1 }, { const: 2 }] } })), { rules })
    for (const value of values(result)) {
      expect(value.schema).toEqual({ const: 2 })
    }
  })

  it("JSON Schema 2020-12 wrapper uses the 2020-12 rules", () => {
    const schema = () => ({ allOf: [{ type: "array", prefixItems: [{ type: "string" }] }, { prefixItems: [{ minLength: 1 }] }] })
    const result: any = merge(sites(() => ({ schemaFormat: "application/schema+json;version=2020-12", schema: schema() })), { rules })
    for (const value of values(result)) {
      expect(value.schema).toEqual({ type: "array", prefixItems: [{ type: "string", minLength: 1 }] })
    }
  })

  it("OpenAPI 3.0 wrapper uses the OpenAPI 3.0 schema rules (nullable, int32/int64)", () => {
    const schema = () => ({
      type: "object",
      properties: {
        name: { allOf: [{ type: "string", nullable: true }, { type: "string" }] },
        count: { allOf: [{ type: "integer", format: "int64" }, { format: "int32" }] },
      },
    })
    const result: any = merge(sites(() => ({ schemaFormat: "application/vnd.oai.openapi;version=3.0.0", schema: schema() })), { rules })
    for (const value of values(result)) {
      expect(value.schema.properties).toEqual({ name: { type: "string" }, count: { type: "integer", format: "int32" } })
    }
  })

  it.each([
    ["application/vnd.apache.avro;version=1.9.0", () => ({ type: "record", name: "R", allOf: [{ a: 1 }, { b: 2 }], fields: [{ name: "allOf", type: "string" }] })],
    ["application/raml+yaml;version=1.0", () => ({ type: "object", allOf: [{ properties: { a: "string" } }, { properties: { b: "string" } }] })],
    ["application/vnd.google.protobuf;version=3", () => 'syntax = "proto3"; message allOf { string a = 1; }'],
    ["application/x-unknown", twoParts],
    [42, twoParts],
  ])("leaves a %p wrapper untouched", (schemaFormat, schema) => {
    const doc = sites(() => ({ schemaFormat, schema: schema() }))
    expect(merge(doc, { rules })).toEqual(doc)
  })

  it("a wrapper without schema, or with other members, is not merged as a schema", () => {
    const doc = {
      asyncapi: "3.0.0",
      components: {
        schemas: {
          noSchema: { schemaFormat: AA, allOf: [{ type: "string" }, { minLength: 1 }] },
          withSibling: { schemaFormat: AA, schema: twoParts(), "x-note": twoParts() },
        },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.components.schemas.noSchema).toEqual(doc.components.schemas.noSchema)
    expect(result.components.schemas.withSibling).toEqual({ schemaFormat: AA, schema: merged, "x-note": twoParts() })
  })

  it("a plain schema with a member named schema is not a wrapper", () => {
    const doc = { asyncapi: "3.0.0", components: { schemas: { s: { ...twoParts(), properties: { schema: { type: "string" } } } } } }
    const result: any = merge(doc, { rules })
    expect(result.components.schemas.s).toEqual({ type: "object", properties: { id: { type: "string" }, schema: { type: "string" } } })
  })
})

describe("AsyncAPI 3.0 rules: bindings", () => {
  const bindingsDoc = (bindings: () => Record<string, unknown>) => ({
    asyncapi: "3.0.0",
    servers: { s: { host: "h", protocol: "ws", bindings: bindings() } },
    channels: { c: { bindings: bindings(), messages: { m: { bindings: bindings(), traits: [{ bindings: bindings() }] } } } },
    operations: { o: { action: "send", bindings: bindings(), traits: [{ bindings: bindings() }] } },
    components: {
      servers: { s: { host: "h", protocol: "ws", bindings: bindings() } },
      serverBindings: { b: bindings() },
      channelBindings: { b: bindings() },
      operationBindings: { b: bindings() },
      messageBindings: { b: bindings() },
      operationTraits: { t: { bindings: bindings() } },
      messageTraits: { t: { bindings: bindings() } },
    },
  })
  const sites = (doc: any) => [
    doc.servers.s.bindings,
    doc.channels.c.bindings,
    doc.channels.c.messages.m.bindings,
    doc.channels.c.messages.m.traits[0].bindings,
    doc.operations.o.bindings,
    doc.operations.o.traits[0].bindings,
    doc.components.servers.s.bindings,
    doc.components.serverBindings.b,
    doc.components.channelBindings.b,
    doc.components.operationBindings.b,
    doc.components.messageBindings.b,
    doc.components.operationTraits.t.bindings,
    doc.components.messageTraits.t.bindings,
  ]

  it("merges the schema fields of ws, http, kafka, mqtt and anypointmq at every bindings location", () => {
    const result = merge(bindingsDoc(() => ({
      ws: { query: twoParts(), headers: twoParts(), bindingVersion: "0.1.0" },
      http: { query: twoParts(), headers: twoParts(), method: "GET" },
      kafka: { groupId: twoParts(), clientId: twoParts(), key: twoParts(), bindingVersion: "0.5.0" },
      mqtt: { correlationData: twoParts() },
      anypointmq: { headers: twoParts() },
    })), { rules })
    for (const site of sites(result)) {
      expect(site).toEqual({
        ws: { query: merged, headers: merged, bindingVersion: "0.1.0" },
        http: { query: merged, headers: merged, method: "GET" },
        kafka: { groupId: merged, clientId: merged, key: merged, bindingVersion: "0.5.0" },
        mqtt: { correlationData: merged },
        anypointmq: { headers: merged },
      })
    }
  })

  it("leaves unknown protocols and other fields of known protocols untouched", () => {
    const doc = bindingsDoc(() => ({
      amqp: { exchange: twoParts() },
      googlepubsub: { schema: twoParts() },
      sns: { policy: twoParts() },
      kafka: { topicConfiguration: twoParts() },
    }))
    expect(merge(doc, { rules })).toEqual(doc)
  })
})

describe("AsyncAPI 3.0 streetlights (kafka) with allOf", () => {
  const doc = loadAsyncApi("streetlights-kafka-3.0.yml")
  const { errors, onMergeError, onRefResolveError } = collectErrors()
  const result: any = merge(doc, { rules, onMergeError, onRefResolveError })

  it("merges every schema allOf; only non-schema locations keep theirs", () => {
    expect(errors).toEqual([])
    expect(allOfPaths(result)).toEqual([
      "/components/channels/firmwareUpdated/bindings/googlepubsub/schema/allOf",
      "/components/messages/firmwareUpdatedAvro/payload/schema/allOf",
    ])
  })

  it("produces the expected schemas", () => {
    const { schemas, messages, channels, messageTraits, operationTraits } = result.components
    expect(schemas.lightMeasuredPayload).toEqual({
      schemaFormat: AA,
      schema: {
        type: "object",
        properties: {
          sentAt: { $ref: "#/components/schemas/sentAt" },
          lumens: { type: "integer", minimum: 0, description: "Light intensity measured in lumens." },
        },
      },
    })
    expect(schemas.turnOnOffPayload.required).toEqual(["command"])
    expect(schemas.dimLightPayload.properties.percentage).toMatchObject({ type: "integer", minimum: 0, maximum: 100 })
    expect(messageTraits.commonHeaders.headers.required).toEqual(["my-app-header"])
    expect(operationTraits.kafka.bindings.kafka.clientId).toEqual({ type: "string", enum: ["my-app-id"] })
    expect(messages.firmwareUpdated.headers).toEqual({
      schemaFormat: AA,
      schema: {
        type: "object",
        properties: {
          "my-app-header": { type: "integer", minimum: 0, maximum: 100 },
          "x-firmware": { type: "string" },
        },
      },
    })
    expect(messages.firmwareUpdated.payload.required).toEqual(["version"])
    expect(messages.firmwareUpdated.bindings.kafka.key).toEqual({ type: "string", maxLength: 36 })
    expect(messages.firmwareUpdated.bindings.anypointmq.headers).toEqual({ type: "object", properties: { messageId: { type: "string" } } })
    expect(messages.firmwareUpdatedAvro).toEqual(doc.components.messages.firmwareUpdatedAvro)
    expect(channels.firmwareUpdated.bindings.ws.headers).toEqual({ type: "object", properties: { token: { type: "string" } } })
    expect(channels.firmwareUpdated.messages.firmwareUpdatedInline.payload).toEqual({
      schemaFormat: "application/schema+json;version=draft-07",
      schema: { type: "object", properties: { sentAt: { $ref: "#/components/schemas/sentAt" }, version: { type: "string" } } },
    })
    expect(result.operations.receiveFirmwareUpdate.bindings).toEqual({
      kafka: { groupId: { type: "string", enum: ["firmware-group"] } },
      http: { query: { type: "object", required: ["version"] } },
    })
  })

  it("keeps the non-schema parts of the document", () => {
    expect(result.info).toEqual(doc.info)
    expect(result.servers).toEqual(doc.servers)
    expect(result.channels).toEqual(doc.channels)
    expect(result.operations.turnOn).toEqual(doc.operations.turnOn)
    expect(result.operations.receiveFirmwareUpdate.reply).toEqual(doc.operations.receiveFirmwareUpdate.reply)
  })

  it("is idempotent and does not change the input", () => {
    expect(merge(result, { rules })).toEqual(result)
    expect(doc).toEqual(loadAsyncApi("streetlights-kafka-3.0.yml"))
  })
})
