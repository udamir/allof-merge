import type { MergeOptions, MergeRules, Merger } from "./types"

/**
 * Late-bound entry points of the engine. The schema rules carry `jsonSchemaMergeResolver` as their `$`, that resolver
 * runs a merger, and the merger picks the default rules: a module cycle (rules -> resolvers -> merge -> rules). The
 * resolver reaches the merger and the default rules through this leaf module instead; `merge.ts` and
 * `rules/jsonschema.ts` register them when they are evaluated (always the case through the package entry).
 */
export const engine: {
  createMerger?: (options?: MergeOptions) => Merger
  defaultSchemaRules?: () => MergeRules
} = {}
