import { freezeRules, jsonSchemaMergeRules } from "./jsonschema.ts"
import type { MergeRules } from "../types.ts"
import * as resolvers from "../resolvers/index.ts"

const NO_CUSTOM_RULES: MergeRules = Object.freeze({})
const cache = new WeakMap<object, MergeRules>()

const buildGraphapiMergeRules = (customRules: MergeRules): MergeRules => {
  let directiveRules: MergeRules | undefined

  // GraphApi keeps its own nullable semantics (OR, untagged: `type` is merged per key whenever nullable is present)
  const graphSchemaMergeRules: MergeRules = jsonSchemaMergeRules("draft-06", {
    ...freezeRules({
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
        "/*": () => directiveRules ?? (directiveRules = Object.freeze({
          ...graphSchemaMergeRules,
          "/meta": Object.freeze({ $: resolvers.mergeObjects })
        }))
      },
    }),
    // the caller's schema rules win over the GraphApi ones (same convention as jsonSchemaMergeRules); they belong to
    // the caller and are only referenced, not frozen
    ...customRules,
  })

  return freezeRules({
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
  })
}

/**
 * GraphApi document rules with custom schema-level rules (like the second argument of jsonSchemaMergeRules), applied
 * at every schema location of the document. Memoized per customRules identity; without custom rules it returns
 * `graphapiMergeRules`.
 */
export const createGraphapiMergeRules = (customRules: MergeRules = NO_CUSTOM_RULES): MergeRules => {
  let rules = cache.get(customRules)
  if (!rules) {
    rules = buildGraphapiMergeRules(customRules)
    cache.set(customRules, rules)
  }
  return rules
}

export const graphapiMergeRules: MergeRules = createGraphapiMergeRules()
