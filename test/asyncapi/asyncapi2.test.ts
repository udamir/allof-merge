import { describe, it, expect } from "vite-plus/test"
import { asyncApiMergeRules, merge } from "../../src/index.ts"
import { yaml } from "../helpers/index.ts"
import { allOfPaths, collectErrors, loadAsyncApi } from "./utils.ts"

const rules = asyncApiMergeRules("2.x")
const twoParts = { allOf: [{ type: "object" }, { properties: { id: { type: "string" } } }] }
const merged = { type: "object", properties: { id: { type: "string" } } }

describe("AsyncAPI 2.x rules: schema locations", () => {
  it("AsyncAPI 2 example: parameter schema, components.schemas, payload, headers merged; Avro payload untouched", () => {
    const doc = yaml`
      asyncapi: 2.6.0
      channels:
        user/signedup:
          parameters:
            userId: { schema: { allOf: [{ type: string }, { minLength: 1 }] } }
          subscribe: { message: { $ref: "#/components/messages/UserSignedUp" } }
      components:
        schemas:
          Base: { type: object, properties: { id: { type: string } } }
          User: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { name: { type: string } } }] }
        messages:
          UserSignedUp:
            payload: { allOf: [{ $ref: "#/components/schemas/User" }, { required: [id] }] }
            headers: { allOf: [{ type: object }, { properties: { h: { type: string } } }] }
          Avro:
            schemaFormat: application/vnd.apache.avro;version=1.9.0
            payload: { type: record, name: U, fields: [{ name: allOf, type: string }] }
    ` as any
    const result: any = merge(doc, { rules })
    expect(result.channels["user/signedup"].parameters.userId.schema).toEqual({ type: "string", minLength: 1 })
    expect(result.components.schemas.User).toEqual({ type: "object", properties: { id: { type: "string" }, name: { type: "string" } } })
    expect(result.components.messages.UserSignedUp.payload).toEqual({
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id"],
    })
    expect(result.components.messages.UserSignedUp.headers).toEqual({ type: "object", properties: { h: { type: "string" } } })
    expect(result.components.messages.Avro).toEqual(doc.components.messages.Avro)
  })

  it("merges inline channel operation messages (publish and subscribe)", () => {
    const doc = {
      asyncapi: "2.0.0",
      channels: {
        a: {
          publish: { message: { payload: twoParts, headers: twoParts } },
          subscribe: { message: { payload: twoParts } },
        },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.channels.a.publish.message).toEqual({ payload: merged, headers: merged })
    expect(result.channels.a.subscribe.message).toEqual({ payload: merged })
  })

  it("merges every message of a message-level oneOf, which itself is not a schema oneOf", () => {
    const doc = {
      asyncapi: "2.6.0",
      channels: {
        a: {
          subscribe: {
            message: {
              description: "not a schema sibling",
              oneOf: [
                { name: "m1", payload: twoParts },
                { name: "m2", headers: twoParts, payload: { allOf: [{ type: "string" }, { maxLength: 3 }] } },
              ],
            },
          },
        },
      },
    }
    const result: any = merge(doc, { rules, mergeCombinarySibling: true })
    expect(result.channels.a.subscribe.message).toEqual({
      description: "not a schema sibling",
      oneOf: [
        { name: "m1", payload: merged },
        { name: "m2", headers: merged, payload: { type: "string", maxLength: 3 } },
      ],
    })
  })

  it("merges components.messages, messageTraits headers and message traits headers", () => {
    const doc = {
      asyncapi: "2.4.0",
      components: {
        messages: { m: { payload: twoParts, traits: [{ headers: twoParts }, { $ref: "#/components/messageTraits/t" }] } },
        messageTraits: { t: { headers: twoParts } },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.components.messages.m).toEqual({ payload: merged, traits: [{ headers: merged }, { $ref: "#/components/messageTraits/t" }] })
    expect(result.components.messageTraits.t).toEqual({ headers: merged })
  })

  it("merges components.parameters schemas and components.channels (2.3+)", () => {
    const doc = {
      asyncapi: "2.3.0",
      components: {
        parameters: { p: { schema: twoParts } },
        channels: { c: { parameters: { q: { schema: twoParts } }, publish: { message: { payload: twoParts } } } },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.components.parameters.p.schema).toEqual(merged)
    expect(result.components.channels.c).toEqual({ parameters: { q: { schema: merged } }, publish: { message: { payload: merged } } })
  })

  it("leaves non-schema locations untouched", () => {
    const doc = {
      asyncapi: "2.6.0",
      info: { title: "t", version: "1", "x-schema": twoParts },
      servers: { s: { url: "u", protocol: "kafka", variables: { v: { default: "x", allOf: [{ a: 1 }] } } } },
      channels: { a: { description: "d", "x-ext": twoParts, subscribe: { operationId: "o", "x-ext": twoParts } } },
      components: { securitySchemes: { k: { type: "apiKey", in: "user" } }, correlationIds: { c: { location: "$message.header#/id" } } },
    }
    expect(merge(doc, { rules })).toEqual(doc)
  })

  it("keeps a discriminator next to a payload oneOf with mergeCombinarySibling", () => {
    const doc = {
      asyncapi: "2.6.0",
      components: {
        messages: {
          m: {
            payload: {
              discriminator: "kind",
              required: ["kind"],
              oneOf: [{ properties: { kind: { const: "a" } } }, { properties: { kind: { const: "b" } } }],
            },
          },
        },
      },
    }
    const result: any = merge(doc, { rules, mergeCombinarySibling: true })
    expect(result.components.messages.m.payload).toEqual({
      discriminator: "kind",
      oneOf: [
        { properties: { kind: { const: "a" } }, required: ["kind"] },
        { properties: { kind: { const: "b" } }, required: ["kind"] },
      ],
    })
  })
})

describe("AsyncAPI 2.x rules: message schemaFormat", () => {
  const message = (schemaFormat: unknown, payload: unknown) => ({
    asyncapi: "2.6.0",
    components: { messages: { m: { schemaFormat, payload, headers: twoParts } } },
  })

  it.each([
    "application/vnd.aai.asyncapi;version=2.6.0",
    "application/vnd.aai.asyncapi+json;version=2.6.0",
    "application/vnd.aai.asyncapi+yaml;version=2.6.0",
    "application/schema+json;version=draft-07",
  ])("merges a %s payload", (schemaFormat) => {
    const result: any = merge(message(schemaFormat, twoParts), { rules })
    expect(result.components.messages.m.payload).toEqual(merged)
  })

  it("JSON Schema draft-04 payload uses the draft-04 rules (no const keyword)", () => {
    const payload = { allOf: [{ const: 1 }, { const: 2 }] }
    const draft04: any = merge(message("application/schema+json;version=draft-04", payload), { rules })
    expect(draft04.components.messages.m.payload).toEqual({ const: 2 })
    const asyncapi: any = merge(message(undefined, payload), { rules })
    expect(asyncapi.components.messages.m.payload).toBe(false)
  })

  it("JSON Schema 2020-12 payload uses the 2020-12 rules (prefixItems tuple)", () => {
    const payload = { allOf: [{ type: "array", prefixItems: [{ type: "string" }] }, { prefixItems: [{ minLength: 1 }] }] }
    const result: any = merge(message("application/schema+json;version=2020-12", payload), { rules })
    expect(result.components.messages.m.payload).toEqual({ type: "array", prefixItems: [{ type: "string", minLength: 1 }] })
  })

  it("OpenAPI 3.0 payload uses the OpenAPI 3.0 schema rules (nullable D-1, int32/int64 formats)", () => {
    const payload = {
      type: "object",
      properties: {
        name: { allOf: [{ type: "string", nullable: true }, { type: "string" }] },
        count: { allOf: [{ type: "integer", format: "int64" }, { format: "int32" }] },
      },
    }
    const openapi: any = merge(message("application/vnd.oai.openapi;version=3.0.0", payload), { rules })
    expect(openapi.components.messages.m.payload.properties).toEqual({
      name: { type: "string" },
      count: { type: "integer", format: "int32" },
    })
    // the same payload as an AsyncAPI schema: nullable is not an AsyncAPI keyword, int formats are not narrowed
    const asyncapi: any = merge(message(undefined, payload), { rules, onMergeError: () => {} })
    expect(asyncapi.components.messages.m.payload.properties.name).toEqual({ type: "string", nullable: true })
    expect(asyncapi.components.messages.m.payload.properties.count.format).toBeUndefined()
  })

  it.each([
    ["application/vnd.apache.avro;version=1.9.0", { type: "record", name: "R", allOf: [{ a: 1 }, { b: 2 }], fields: [{ name: "allOf", type: "string" }] }],
    ["application/raml+yaml;version=1.0", { type: "object", allOf: [{ properties: { a: "string" } }, { properties: { b: "string" } }] }],
    ["application/vnd.google.protobuf;version=3", 'syntax = "proto3"; message allOf { string a = 1; }'],
    // a fresh copy: the engine shares the output of one input object between its occurrences (see the report)
    ["application/x-unknown", structuredClone(twoParts)],
    [42, structuredClone(twoParts)],
  ])("leaves a %p payload untouched; headers are still merged", (schemaFormat, payload) => {
    const doc = message(schemaFormat, payload)
    const result: any = merge(doc, { rules })
    expect(result.components.messages.m.payload).toEqual(payload)
    expect(result.components.messages.m.headers).toEqual(merged)
  })

  it("schemaFormat of an inline oneOf message applies to that message only", () => {
    const doc = {
      asyncapi: "2.6.0",
      channels: {
        a: {
          publish: {
            message: {
              oneOf: [
                { schemaFormat: "application/vnd.apache.avro;version=1.9.0", payload: twoParts },
                { payload: structuredClone(twoParts) },
              ],
            },
          },
        },
      },
    }
    const result: any = merge(doc, { rules })
    expect(result.channels.a.publish.message.oneOf).toEqual([
      { schemaFormat: "application/vnd.apache.avro;version=1.9.0", payload: twoParts },
      { payload: merged },
    ])
  })
})

describe("AsyncAPI 2.x rules: bindings", () => {
  const bindingsDoc = (bindings: Record<string, unknown>) => ({
    asyncapi: "2.6.0",
    servers: { s: { url: "u", protocol: "ws", bindings } },
    channels: {
      c: {
        bindings,
        subscribe: { bindings, traits: [{ bindings }], message: { bindings, traits: [{ bindings }] } },
      },
    },
    components: {
      serverBindings: { b: bindings },
      channelBindings: { b: bindings },
      operationBindings: { b: bindings },
      messageBindings: { b: bindings },
      operationTraits: { t: { bindings } },
      messageTraits: { t: { bindings } },
    },
  })

  const sites = (doc: any) => [
    doc.servers.s.bindings,
    doc.channels.c.bindings,
    doc.channels.c.subscribe.bindings,
    doc.channels.c.subscribe.traits[0].bindings,
    doc.channels.c.subscribe.message.bindings,
    doc.channels.c.subscribe.message.traits[0].bindings,
    doc.components.serverBindings.b,
    doc.components.channelBindings.b,
    doc.components.operationBindings.b,
    doc.components.messageBindings.b,
    doc.components.operationTraits.t.bindings,
    doc.components.messageTraits.t.bindings,
  ]

  it("merges the schema fields of ws, http, kafka, mqtt and anypointmq at every bindings location", () => {
    const bindings = {
      ws: { query: twoParts, headers: twoParts, method: "GET", bindingVersion: "0.1.0" },
      http: { query: twoParts, headers: twoParts, type: "request" },
      kafka: { groupId: twoParts, clientId: twoParts, key: twoParts, bindingVersion: "0.4.0" },
      mqtt: { correlationData: twoParts, qos: 1 },
      anypointmq: { headers: twoParts },
    }
    const result = merge(bindingsDoc(bindings), { rules })
    for (const site of sites(result)) {
      expect(site).toEqual({
        ws: { query: merged, headers: merged, method: "GET", bindingVersion: "0.1.0" },
        http: { query: merged, headers: merged, type: "request" },
        kafka: { groupId: merged, clientId: merged, key: merged, bindingVersion: "0.4.0" },
        mqtt: { correlationData: merged, qos: 1 },
        anypointmq: { headers: merged },
      })
    }
  })

  it("leaves unknown protocols and other fields of known protocols untouched", () => {
    const bindings = {
      amqp: { exchange: twoParts, queue: { name: "q", allOf: [{ a: 1 }] } },
      googlepubsub: { schema: twoParts },
      "x-custom": { headers: twoParts },
      kafka: { topicConfiguration: twoParts, schemaIdLocation: "payload" },
      mqtt: { lastWill: twoParts },
    }
    const doc = bindingsDoc(bindings)
    expect(merge(doc, { rules })).toEqual(doc)
  })
})

describe("AsyncAPI 2.6 streetlights (kafka) with allOf", () => {
  const doc = loadAsyncApi("streetlights-kafka-2.6.yml")
  const { errors, onMergeError, onRefResolveError } = collectErrors()
  const result: any = merge(doc, { rules, onMergeError, onRefResolveError })

  it("merges every schema allOf; only non-schema locations keep theirs", () => {
    expect(errors).toEqual([])
    expect(allOfPaths(result)).toEqual([
      "/channels/smartylighting.streetlights.1.0.event.{streetlightId}.firmware.updated/publish/bindings/amqp/exchange/allOf",
      "/components/messages/firmwareUpdatedAvro/payload/allOf",
    ])
  })

  it("produces the expected schemas", () => {
    const { schemas, messages, parameters, messageTraits, operationTraits } = result.components
    expect(schemas.lightMeasuredPayload).toEqual({
      type: "object",
      properties: {
        sentAt: { $ref: "#/components/schemas/sentAt" },
        lumens: { type: "integer", minimum: 0, description: "Light intensity measured in lumens." },
      },
    })
    expect(schemas.turnOnOffPayload.required).toEqual(["command"])
    expect(schemas.dimLightPayload.properties.percentage).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Percentage to which the light should be dimmed to.",
    })
    expect(parameters.streetlightId.schema).toEqual({ type: "string", minLength: 1 })
    expect(messageTraits.commonHeaders.headers.required).toEqual(["my-app-header"])
    expect(operationTraits.kafka.bindings.kafka.clientId).toEqual({ type: "string", enum: ["my-app-id"] })
    expect(messages.firmwareUpdated.payload.required).toEqual(["version"])
    expect(messages.firmwareUpdated.headers.properties["x-firmware"]).toEqual({ type: "string" })
    expect(messages.firmwareUpdated.bindings.kafka.key).toEqual({ type: "string", maxLength: 36 })
    expect(messages.firmwareUpdated.bindings.mqtt.correlationData).toEqual({ type: "string", format: "uuid" })
    expect(messages.firmwareUpdatedAvro).toEqual(doc.components.messages.firmwareUpdatedAvro)

    const channel = result.channels["smartylighting.streetlights.1.0.event.{streetlightId}.firmware.updated"]
    expect(channel.bindings.ws.query).toEqual({ type: "object", properties: { token: { type: "string" } } })
    expect(channel.publish.bindings.http.query).toEqual({ type: "object", required: ["version"] })
    expect(channel.publish.bindings.kafka.groupId).toEqual({ type: "string", enum: ["firmware-group"] })
    expect(channel.publish.message.oneOf[2].payload.properties.version).toEqual({ type: "string" })
  })

  it("keeps the non-schema parts of the document", () => {
    expect(result.info).toEqual(doc.info)
    expect(result.servers).toEqual(doc.servers)
    expect(result.components.securitySchemes).toEqual(doc.components.securitySchemes)
    expect(Object.keys(result.channels)).toEqual(Object.keys(doc.channels))
  })

  it("is idempotent and does not change the input", () => {
    expect(merge(result, { rules })).toEqual(result)
    expect(doc).toEqual(loadAsyncApi("streetlights-kafka-2.6.yml"))
  })
})
