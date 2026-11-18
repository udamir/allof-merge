import { type JsonSchemaVersion, freezeRules, jsonSchemaMergeRules } from "./jsonschema.ts"
import { openApiJsonSchemaMergeRules } from "./openapi.ts"
import type { MergeRules } from "../types.ts"
import * as resolvers from "../resolvers/index.ts"
import { hasOwn } from "../safe.ts"
import { ErrorMessage } from "../errors.ts"
import { keyOnlyRule } from "../rule-lookup.ts"

export const asyncApiVersion = ["2.x", "3.0"] as const

export type AsyncApiVersion = typeof asyncApiVersion[number]

/**
 * The schema language a `schemaFormat` names (2.x message `schemaFormat`, 3.0 Multi Format Schema Object): the
 * AsyncAPI schema (the default, a JSON Schema draft-07 superset), a JSON Schema draft, an OpenAPI schema object, or
 * `undefined` for a format that is not JSON Schema (Avro, RAML, Protobuf, unknown, non-string).
 */
export type AsyncApiSchemaDialect = "asyncapi" | JsonSchemaVersion | "openapi-3.0" | "openapi-3.1"

const ASYNCAPI_FORMAT = /^application\/vnd\.aai\.asyncapi(?:\+json|\+yaml)?(?:\s*;.*)?$/
const JSON_SCHEMA_FORMAT = /^application\/schema(?:\+json|\+yaml)?(?:\s*;\s*version=([\w.-]+))?\s*$/
const OPENAPI_FORMAT = /^application\/vnd\.oai\.openapi(?:\+json|\+yaml)?(?:\s*;\s*version=([\d.]+))?\s*$/

export const asyncApiSchemaDialect = (schemaFormat: unknown): AsyncApiSchemaDialect | undefined => {
  if (schemaFormat === undefined) { return "asyncapi" }
  if (typeof schemaFormat !== "string") { return undefined }
  const value = schemaFormat.trim().toLowerCase()
  if (ASYNCAPI_FORMAT.test(value)) { return "asyncapi" }
  const jsonSchema = value.match(JSON_SCHEMA_FORMAT)
  if (jsonSchema) {
    const draft = jsonSchema[1]
    // 2019-09 uses the 2020-12 table; a missing or unknown draft is the AsyncAPI default dialect (draft-07)
    return draft === "draft-04" || draft === "draft-06" || draft === "2020-12" ? draft : draft === "2019-09" ? "2020-12" : "draft-07"
  }
  const openApi = value.match(OPENAPI_FORMAT)
  if (openApi) {
    return !openApi[1] || openApi[1].startsWith("3.0") ? "openapi-3.0" : "openapi-3.1"
  }
  return /json-schema/.test(value) ? "draft-07" : undefined
}

const NO_CUSTOM_RULES: MergeRules = Object.freeze({})
const EMPTY_RULES: MergeRules = Object.freeze({})

// binding fields the AsyncAPI bindings specifications define as Schema Objects, per protocol; bindings of other
// protocols are left untouched
export const asyncApiBindingSchemaFields: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ws: Object.freeze(["query", "headers"]),
  http: Object.freeze(["query", "headers"]),
  kafka: Object.freeze(["groupId", "clientId", "key"]),
  mqtt: Object.freeze(["correlationData"]),
  anypointmq: Object.freeze(["headers"]),
})

// the AsyncAPI Schema Object (2.x and 3.0): JSON Schema draft-07 plus `discriminator` (a property name string),
// `externalDocs` and `deprecated` (both already in the draft-07 table)
const buildAsyncApiSchemaRules = (customRules: MergeRules): MergeRules => {
  let rules: MergeRules
  const child = keyOnlyRule(() => rules)
  rules = jsonSchemaMergeRules("draft-07", {
    ...freezeRules({
      "/discriminator": { $: resolvers.last },
      // `discriminator` describes the branches of oneOf / anyOf: it stays next to them when siblings are distributed
      "/oneOf": {
        "/*": child,
        $: resolvers.mergeArray,
        sibling: ["definitions", "$defs", "$id", "$schema", "discriminator"],
      },
      "/anyOf": {
        "/*": child,
        $: resolvers.mergeArray,
        sibling: ["definitions", "$defs", "$id", "$schema", "discriminator"],
      },
    }),
    // the caller's schema rules win (same convention as jsonSchemaMergeRules); they are only referenced, not frozen
    ...customRules,
  })
  return rules
}

interface CustomRulesCache {
  dialects: Map<AsyncApiSchemaDialect, MergeRules>
  documents: Map<AsyncApiVersion, MergeRules>
}

const cache = new WeakMap<object, CustomRulesCache>()

const cacheFor = (customRules: MergeRules): CustomRulesCache => {
  let entry = cache.get(customRules)
  if (!entry) {
    entry = { dialects: new Map(), documents: new Map() }
    cache.set(customRules, entry)
  }
  return entry
}

const dialectRules = (dialect: AsyncApiSchemaDialect, customRules: MergeRules): MergeRules => {
  const { dialects } = cacheFor(customRules)
  let rules = dialects.get(dialect)
  if (!rules) {
    // without custom rules the shared default rule sets are returned (same identity as a direct call)
    const custom = customRules === NO_CUSTOM_RULES ? undefined : customRules
    rules = dialect === "asyncapi"
      ? buildAsyncApiSchemaRules(customRules)
      : dialect === "openapi-3.0"
        ? openApiJsonSchemaMergeRules("3.0.x", custom)
        : dialect === "openapi-3.1"
          ? openApiJsonSchemaMergeRules("3.1.x", custom)
          : jsonSchemaMergeRules(dialect, custom)
    dialects.set(dialect, rules)
  }
  return rules
}

/**
 * Schema rules for one schema written in `schemaFormat` (absent = the AsyncAPI schema): AsyncAPI schema rules
 * (draft-07 + `discriminator`), the JSON Schema draft rules, or the OpenAPI 3.0 / 3.1 schema rules; `undefined` for a
 * format that is not JSON Schema (Avro, RAML, Protobuf, unknown, non-string), whose value must be left untouched.
 * `customRules` are schema-level rules (like the second argument of jsonSchemaMergeRules). Memoized per
 * (dialect, customRules identity).
 */
export const asyncApiSchemaMergeRules = (schemaFormat?: unknown, customRules: MergeRules = NO_CUSTOM_RULES): MergeRules | undefined => {
  const dialect = asyncApiSchemaDialect(schemaFormat)
  return dialect ? dialectRules(dialect, customRules) : undefined
}

/**
 * The AsyncAPI version of a document from its own string `asyncapi` member: `"2.x"` for 2.<n>, `"3.0"` for 3.<n>
 * (a later 3.x minor uses the 3.0 rules), `undefined` otherwise (not an AsyncAPI 2/3 document).
 */
export const detectAsyncApiVersion = (doc: unknown): AsyncApiVersion | undefined => {
  if (!hasOwn(doc, "asyncapi")) { return undefined }
  const version = (doc as Record<string, unknown>).asyncapi
  if (typeof version !== "string") { return undefined }
  if (/^2\.\d/.test(version)) { return "2.x" }
  if (/^3\.\d/.test(version)) { return "3.0" }
  return undefined
}

/** A 3.0 Multi Format Schema Object: a plain object with an own `schemaFormat` member. */
export const isMultiFormatSchema = (value: unknown): value is { schemaFormat: unknown, schema?: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value) && hasOwn(value, "schemaFormat")

export type SchemaFormatUnwrap =
  // the schema to inline: the target itself (not a Multi Format Schema Object) or the wrapper's inner `schema`
  | { ok: true, schema: unknown }
  // a wrapper that must not be inlined: the `$ref` is kept and `message` is reported (onMergeError)
  | { ok: false, schemaFormat: unknown, message: string }

/**
 * Engine hook for a `$ref` allOf item of an AsyncAPI 3.0 document: a target that is a Multi Format
 * Schema Object (`{ schemaFormat, schema }`) is unwrapped when the format is the AsyncAPI schema or a JSON Schema
 * draft (its inner `schema` is merged); any other format (OpenAPI, Avro, Protobuf, RAML, unknown, non-string) or a
 * wrapper without `schema` is not inlined. Any other target is returned as it is.
 */
export const unwrapSchemaFormat = (target: unknown): SchemaFormatUnwrap => {
  if (!isMultiFormatSchema(target)) { return { ok: true, schema: target } }
  const { schemaFormat } = target
  const dialect = asyncApiSchemaDialect(schemaFormat)
  if (dialect && !dialect.startsWith("openapi") && hasOwn(target, "schema")) {
    return { ok: true, schema: target.schema }
  }
  const format = typeof schemaFormat === "string" ? schemaFormat : JSON.stringify(schemaFormat) ?? String(schemaFormat)
  return {
    ok: false,
    schemaFormat,
    message: hasOwn(target, "schema") ? ErrorMessage.schemaFormatNotMergeable(format) : ErrorMessage.schemaFormatWithoutSchema(),
  }
}

const buildBindingRules = (schema: MergeRules): MergeRules => {
  const rules: Record<string, MergeRules> = {}
  for (const [protocol, fields] of Object.entries(asyncApiBindingSchemaFields)) {
    rules[`/${protocol}`] = Object.fromEntries(fields.map((field) => [`/${field}`, schema]))
  }
  return rules as MergeRules
}

const buildAsyncApi2MergeRules = (customRules: MergeRules): MergeRules => {
  const schema = dialectRules("asyncapi", customRules)
  const bindings = buildBindingRules(schema)
  const bindingsMap: MergeRules = { "/*": bindings }
  const messageTrait: MergeRules = { "/headers": schema, "/bindings": bindings }

  // a message reads its own `schemaFormat`: the payload is merged with the rules of that format, a payload in a format
  // that is not JSON Schema (Avro, RAML, Protobuf, ...) is left untouched; headers are always AsyncAPI schemas.
  // `message.oneOf` (2.x operation message alternatives) lists messages, not schemas: the rule has no `$`, so it is
  // never merged or distributed as a schema oneOf
  const messages = new Map<MergeRules, MergeRules>()
  let message: (ctx: { value: unknown }) => MergeRules
  const messageWith = (payload: MergeRules): MergeRules => {
    let rules = messages.get(payload)
    if (!rules) {
      rules = freezeRules({
        "/payload": payload,
        "/headers": schema,
        "/bindings": bindings,
        "/traits": { "/*": messageTrait },
        "/oneOf": { "/*": message },
      } as MergeRules)
      messages.set(payload, rules)
    }
    return rules
  }
  message = ({ value }) => {
    const format = typeof value === "object" && value !== null && hasOwn(value, "schemaFormat") ? (value as any).schemaFormat : undefined
    return messageWith(asyncApiSchemaMergeRules(format, customRules) ?? EMPTY_RULES)
  }

  const operation: MergeRules = {
    "/message": message,
    "/bindings": bindings,
    "/traits": { "/*": { "/bindings": bindings } },
  }
  const parameters: MergeRules = { "/*": { "/schema": schema } }
  const channel: MergeRules = {
    "/parameters": parameters,
    "/publish": operation,
    "/subscribe": operation,
    "/bindings": bindings,
  }

  return freezeRules({
    "/servers": { "/*": { "/bindings": bindings } },
    "/channels": { "/*": channel },
    "/components": {
      "/schemas": { "/*": schema },
      "/servers": { "/*": { "/bindings": bindings } },
      "/channels": { "/*": channel },
      "/messages": { "/*": message },
      "/parameters": parameters,
      "/messageTraits": { "/*": messageTrait },
      "/operationTraits": { "/*": { "/bindings": bindings } },
      "/serverBindings": bindingsMap,
      "/channelBindings": bindingsMap,
      "/operationBindings": bindingsMap,
      "/messageBindings": bindingsMap,
    },
  } as MergeRules)
}

const buildAsyncApi3MergeRules = (customRules: MergeRules): MergeRules => {
  const schema = dialectRules("asyncapi", customRules)
  const bindings = buildBindingRules(schema)
  const bindingsMap: MergeRules = { "/*": bindings }

  // a schema site that admits a Multi Format Schema Object (components.schemas, message payload / headers): a plain
  // schema gets the AsyncAPI schema rules, a wrapper `{ schemaFormat, schema }` gets the rules of its format at
  // `schema` (nothing for a format that is not JSON Schema)
  const wrappers = new Map<MergeRules, MergeRules>()
  const wrapperWith = (inner: MergeRules): MergeRules => {
    let rules = wrappers.get(inner)
    if (!rules) {
      rules = Object.freeze({ "/schema": inner }) as MergeRules
      wrappers.set(inner, rules)
    }
    return rules
  }
  const schemaSite = ({ value }: { value: unknown }): MergeRules => isMultiFormatSchema(value)
    ? wrapperWith(asyncApiSchemaMergeRules(value.schemaFormat, customRules) ?? EMPTY_RULES)
    : schema

  const messageTrait: MergeRules = { "/headers": schemaSite, "/bindings": bindings }
  const message: MergeRules = {
    "/payload": schemaSite,
    "/headers": schemaSite,
    "/bindings": bindings,
    "/traits": { "/*": messageTrait },
  }
  // operation and reply `messages` are `$ref`s by the specification; an inline message is merged all the same
  const messages: MergeRules = { "/*": message }
  const reply: MergeRules = { "/messages": messages }
  const channel: MergeRules = { "/messages": messages, "/bindings": bindings }
  const operation: MergeRules = {
    "/messages": messages,
    "/reply": reply,
    "/bindings": bindings,
    "/traits": { "/*": { "/bindings": bindings } },
  }

  return freezeRules({
    "/servers": { "/*": { "/bindings": bindings } },
    "/channels": { "/*": channel },
    "/operations": { "/*": operation },
    "/components": {
      "/schemas": { "/*": schemaSite },
      "/servers": { "/*": { "/bindings": bindings } },
      "/channels": { "/*": channel },
      "/operations": { "/*": operation },
      "/messages": messages,
      "/messageTraits": { "/*": messageTrait },
      "/operationTraits": { "/*": { "/bindings": bindings } },
      "/replies": { "/*": reply },
      "/serverBindings": bindingsMap,
      "/channelBindings": bindingsMap,
      "/operationBindings": bindingsMap,
      "/messageBindings": bindingsMap,
    },
  } as MergeRules)
}

/**
 * Document rules of an AsyncAPI version: `"2.x"` (2.0–2.6) or `"3.0"`. `customRules` are schema-level rules applied
 * at every schema location of the document, whatever its `schemaFormat` (see asyncApiSchemaMergeRules). Memoized per
 * (version, customRules identity).
 */
export const asyncApiMergeRules = (version: AsyncApiVersion = "3.0", customRules: MergeRules = NO_CUSTOM_RULES): MergeRules => {
  const { documents } = cacheFor(customRules)
  let rules = documents.get(version)
  if (!rules) {
    rules = version === "2.x" ? buildAsyncApi2MergeRules(customRules) : buildAsyncApi3MergeRules(customRules)
    documents.set(version, rules)
  }
  return rules
}
