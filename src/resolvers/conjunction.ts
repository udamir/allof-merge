import type { MergeResolver, MergeRules } from "../types.ts"
import { isPlainObject } from "../utils.ts"
import { engine } from "../engine.ts"

// rules of a schema location: the location merges allOf (the clone pass merges a lazy `{ allOf }` there)
export const isAllOfMergeRule = (rules?: unknown): rules is MergeRules & { "/allOf": { $: MergeResolver } } => {
  const allOf = rules && typeof rules === "object" && (rules as any)["/allOf"]
  return !!allOf && typeof allOf === "object" && "$" in allOf
}

/**
 * Synchronous conjunction of schemas (compatibility export, also the `$` of the schema rules).
 * Returns `false` for a contradiction and never `undefined`. Called directly (or as the `$` of a custom rule
 * without child rules) it fully merges the conjunction including schema-valued children, as 0.6.8 did:
 * a nested merge with `ctx.mergeRules` (the JSON Schema rules when they do not merge allOf), the default
 * branch budget and limits, and `ctx.mergeError` for every reported problem. `$ref`s are resolved against the
 * conjunction itself only (pass already dereferenced schemas, or use `merge` with `source`).
 */
export const jsonSchemaMergeResolver: MergeResolver = (args, ctx) => {
  if (args.includes(false)) { return false }
  const items = args.filter((item) => isPlainObject(item) && Object.keys(item).length)
  if (!items.length) { return {} }
  const { createMerger, defaultSchemaRules } = engine
  if (!createMerger || !defaultSchemaRules) { throw new Error("allof-merge: the engine is not initialized (import the package entry)") }
  const rules = isAllOfMergeRule(ctx?.mergeRules) ? ctx.mergeRules : defaultSchemaRules()
  // issues of the nested merge are forwarded unchanged to the engine's node when it provides `forward` (which also
  // calls the node's legacy onMergeError as mergeError did); direct callers get every problem through mergeError
  const forward = ctx?.forward
  const merger = createMerger(forward ? { onIssue: forward } : { onMergeError: (_message, _path, values) => ctx?.mergeError?.(values) })
  return merger.merge(items.length === 1 ? items[0] : { allOf: items }, { rules })
}
