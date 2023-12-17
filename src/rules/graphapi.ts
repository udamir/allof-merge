import { jsonSchemaMergeRules } from "./jsonschema"
import * as resolvers from "../resolvers"
import { MergeRules } from "../types"

const graphSchemaMergeRules: MergeRules = jsonSchemaMergeRules("draft-06", {
  "/args": () => graphSchemaMergeRules,
  "/nullable": { $: resolvers.alternative },
  "/specifiedByURL": { $: resolvers.last },
  "/values": {
    $: resolvers.mergeObjects,
    "/*": {
      $: resolvers.mergeObjects,
      "/description": { $: resolvers.last },
      "/deprecated": {
        $: resolvers.last,
        "/reason": { $: resolvers.last }
      }
    }
  },
  "/interfaces": {
    $: resolvers.mergeObjects,
    "/*": { $: resolvers.mergeObjects }
  },
  "/directives": {
    $: resolvers.mergeObjects,
    "/*": () => ({      
      ...graphSchemaMergeRules,
      "/meta": { $: resolvers.mergeObjects }
    })
  }
})

export const graphapiMergeRules: MergeRules = {
  "/queries": {
    "/*": () => graphSchemaMergeRules
  },
  "/mutations": {
    "/*": () => graphSchemaMergeRules
  },
  "/subscriptions": {
    "/*": () => graphSchemaMergeRules
  },
  "/components": {
    "/*": {
      "/*": graphSchemaMergeRules
    },
    "/directives": {
      "/*": {
        "/args": () => graphSchemaMergeRules,
      },
    },
  }
}
