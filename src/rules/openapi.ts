import { jsonSchemaMergeRules } from "./jsonschema"
import * as resolvers from "../resolvers"
import { MergeRules } from "../types"

export const openApiVersion = ["3.0.x", "3.1.x"] as const

export type OpenApiVersion = typeof openApiVersion[number]

const schemaMergeRules = (version: OpenApiVersion) => {
  return version === "3.0.x"
    ? { 
      ...jsonSchemaMergeRules("draft-04"),
      "/items": () => ({
        ...jsonSchemaMergeRules("draft-04"),
        "$": resolvers.itemsMergeResolver,
      }),
    }
    : jsonSchemaMergeRules("draft-06")
}

const parametersMergeRules = (version: OpenApiVersion): MergeRules => ({
  "/*": {
    "/schema": schemaMergeRules(version)
  }
})

const requestBodyMergeRules = (version: OpenApiVersion): MergeRules => ({
  "/content": {
    "/*": {
      "/schema": schemaMergeRules(version),
      "/encoding": {
        "/headers": parametersMergeRules(version)
      }
    }
  }
})

const responsesMergeRules = (version: OpenApiVersion): MergeRules => ({
  "/*": {
    "/headers": parametersMergeRules(version),
    "/content": {
      "/*": {
        "/schema": schemaMergeRules(version),
        "/encoding": {
          "/headers": parametersMergeRules(version)
        }
      }
    },
  }
})

export const openApiMergeRules = (version: OpenApiVersion = "3.0.x"): MergeRules => ({
  "/paths": {
    "/*": {
      "/*": {
        "/parameters": parametersMergeRules(version),
        "/requestBody": requestBodyMergeRules(version),
        "/responses": responsesMergeRules(version),
      },
      "/parameters": parametersMergeRules(version),
    },
  },
  "/components": {
    "/schemas": {
      "/*": schemaMergeRules(version)
    },
    "/responses": responsesMergeRules(version),
    "/parameters": parametersMergeRules(version),
    "/requestBodies": {
      "/*": requestBodyMergeRules(version)
    },
    "/headers": parametersMergeRules(version),
  }
})
