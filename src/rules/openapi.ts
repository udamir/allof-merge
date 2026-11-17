import { type JsonSchemaVersion, freezeRules, jsonSchemaMergeRules } from "./jsonschema"
import type { MergeRules } from "../types"
import * as resolvers from "../resolvers"

export const openApiVersion = ["3.0.x", "3.1.x"] as const

export type OpenApiVersion = typeof openApiVersion[number]

const NO_CUSTOM_RULES: MergeRules = Object.freeze({})
// keyed by `${version}|${schema draft}`
const schemaRulesCache = new Map<string, WeakMap<object, MergeRules>>()
const documentRulesCache = new Map<string, WeakMap<object, MergeRules>>()

// memoized per (version and schema draft, customRules identity)
const cached = (cache: Map<string, WeakMap<object, MergeRules>>, version: string, customRules: MergeRules, build: () => MergeRules): MergeRules => {
  let byCustomRules = cache.get(version)
  if (!byCustomRules) {
    byCustomRules = new WeakMap()
    cache.set(version, byCustomRules)
  }
  let rules = byCustomRules.get(customRules)
  if (!rules) {
    rules = build()
    byCustomRules.set(customRules, rules)
  }
  return rules
}

const customJsonSchemaMergeRules = (version: JsonSchemaVersion, customRules: MergeRules): MergeRules => {
  let rules: MergeRules
  const child = () => rules
  rules = jsonSchemaMergeRules(version, {
    ...freezeRules({
      // OpenAPI 3.0 `nullable` is merged with `type` by the type group (D-1): absent on a typed item = false, an
      // item without `type` does not restrict null; OpenAPI 3.1 has no nullable keyword (annotation, AND)
      ...version === "draft-04" ? { "/nullable": { $: resolvers.and, group: "type" } } : {},
      "/discriminator": { $: resolvers.mergeObjects },
      // int32 ⊂ int64 / float ⊂ double narrowing is OpenAPI-only (D-14)
      "/format": { $: resolvers.mergeOpenApiFormat, group: "string" },
      "/oneOf": {
        "/*": child,
        $: resolvers.mergeArray,
        sibling: ["discriminator"],
      },
      "/anyOf": {
        "/*": child,
        $: resolvers.mergeArray,
        sibling: ["discriminator"],
      },
    }),
    // the caller's schema rules win over the OpenAPI ones (same convention as jsonSchemaMergeRules); they belong to
    // the caller and are only referenced, not frozen
    ...customRules,
  })
  return rules
}

// the JSON Schema draft of an OpenAPI version's schemas: 3.0 follows draft-04, 3.1 defaults to 2020-12 and may declare
// another draft (`jsonSchemaDialect`)
const schemaDraftOf = (version: OpenApiVersion, dialect?: JsonSchemaVersion): JsonSchemaVersion =>
  version === "3.0.x" ? "draft-04" : dialect ?? "2020-12"

/**
 * Schema rules of an OpenAPI version: 3.0 schemas follow draft-04 (boolean exclusive bounds), 3.1 schemas are JSON
 * Schema 2020-12 unless `dialect` (the document's `jsonSchemaDialect`) names another draft. `customRules` are
 * schema-level rules (like the second argument of jsonSchemaMergeRules) applied at every schema location. Memoized
 * per (version, dialect, customRules identity).
 */
export const openApiJsonSchemaMergeRules = (version: OpenApiVersion, customRules: MergeRules = NO_CUSTOM_RULES, dialect?: JsonSchemaVersion): MergeRules => {
  const draft = schemaDraftOf(version, dialect)
  return cached(schemaRulesCache, `${version}|${draft}`, customRules, () => customJsonSchemaMergeRules(draft, customRules))
}

const buildOpenApiMergeRules = (version: OpenApiVersion, customRules: MergeRules, dialect?: JsonSchemaVersion): MergeRules => {
  const schema = openApiJsonSchemaMergeRules(version, customRules, dialect)

  // Parameter / Header objects: schema or content media types
  const parameter: MergeRules = {
    "/schema": schema,
    "/content": {
      "/*": {
        "/schema": schema,
      },
    },
  }
  const parameters: MergeRules = { "/*": parameter }

  const mediaType: MergeRules = {
    "/schema": schema,
    "/encoding": {
      "/*": {
        "/headers": parameters,
      },
    },
  }
  const content: MergeRules = { "/*": mediaType }
  const requestBody: MergeRules = { "/content": content }
  const responses: MergeRules = {
    "/*": {
      "/headers": parameters,
      "/content": content,
    },
  }

  let pathItem: MergeRules
  const operation: MergeRules = {
    "/parameters": parameters,
    "/requestBody": requestBody,
    "/responses": responses,
    "/callbacks": {
      "/*": {
        "/*": () => pathItem,
      },
    },
  }
  pathItem = {
    "/*": operation,
    "/parameters": parameters,
  }

  return freezeRules({
    "/paths": {
      "/*": pathItem,
    },
    "/webhooks": {
      "/*": pathItem,
    },
    "/components": {
      "/schemas": {
        "/*": schema,
      },
      "/responses": responses,
      "/parameters": parameters,
      "/requestBodies": {
        "/*": requestBody,
      },
      "/headers": parameters,
      "/pathItems": {
        "/*": pathItem,
      },
      "/callbacks": {
        "/*": {
          "/*": pathItem,
        },
      },
    },
  })
}

/**
 * Document rules of an OpenAPI version. `customRules` are schema-level rules applied at every schema location of the
 * document (see openApiJsonSchemaMergeRules); `dialect` is the draft of 3.1 schemas (`jsonSchemaDialect`, default
 * 2020-12). Memoized per (version, dialect, customRules identity).
 */
export const openApiMergeRules = (version: OpenApiVersion = "3.0.x", customRules: MergeRules = NO_CUSTOM_RULES, dialect?: JsonSchemaVersion): MergeRules => {
  const draft = schemaDraftOf(version, dialect)
  return cached(documentRulesCache, `${version}|${draft}`, customRules, () => buildOpenApiMergeRules(version, customRules, dialect))
}
