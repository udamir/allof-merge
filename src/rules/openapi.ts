import { jsonSchemaMergeRules } from "./jsonschema"
import { MergeRules } from "../types"

export const openApiVersion = {
  "3.0.x": "3.0.x",
  "3.1.x": "3.1.x"
} as const

type OpenApiVersion = keyof typeof openApiVersion

const schemaMergeRules = (version: OpenApiVersion = openApiVersion["3.0.x"]) => {
  return version === openApiVersion["3.0.x"]
    ? jsonSchemaMergeRules("04")
    : jsonSchemaMergeRules("06")
}

const parametersMergeRules = (version: OpenApiVersion = openApiVersion["3.0.x"]): MergeRules => ({
  "/*": {
    "/schema": schemaMergeRules(version)
  }
})

const requestBodyMergeRules = (version: OpenApiVersion = openApiVersion["3.0.x"]): MergeRules => ({
  "/content": {
    "/*": {
      "/schema": schemaMergeRules(version),
      "/encoding": {
        "/headers": parametersMergeRules(version)
      }
    }
  }
})

const responsesMergeRules = (version: OpenApiVersion = openApiVersion["3.0.x"]): MergeRules => ({
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

export const openApiMergeRules = (version: OpenApiVersion = openApiVersion["3.0.x"]): MergeRules => ({
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
