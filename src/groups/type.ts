import type { GroupContext, KeywordGroup } from "../types"
import { intersectTypes } from "../resolvers/basic"
import { hasOwn } from "../safe"

// a well-formed `type` value as a list of type names; undefined when malformed (ignored and reported). Unknown
// type names are kept: they match nothing, so they make the intersection empty as before
const typeList = (type: unknown): string[] | undefined => {
  if (typeof type === "string") { return [type] }
  if (Array.isArray(type) && type.length && type.every((t) => typeof t === "string")) { return type }
  return undefined
}

const asType = (types: string[]): string | string[] => types.length === 1 ? types[0] : types

/**
 * OpenAPI 3.0 `type` + `nullable` (active when the `/nullable` rule is tagged with the `type` group, which the
 * OpenAPI 3.0 schema rules do).
 *
 * OAS 3.0.3: "A true value adds null to the allowed types specified by the type keyword, only if type is
 * explicitly defined within the same Schema Object". So an item with a `type` allows `type ∪ {null}` when its
 * `nullable` is true and only `type` when it is false or absent (strict, D-1); an item without `type` does not
 * restrict the type at all, whatever its `nullable` says. The conjunction keeps the types every typed item
 * allows; when only null is left the result is `{ type: T, nullable: true, enum: [null] }` (valid OAS 3.0; `T` is
 * the first type of the first typed item), with `enum: [null]` as an allOf fragment when an `enum`/`const` is
 * also present (that keyword is merged by its own group).
 */
const resolveNullable = (ctx: GroupContext, types: (string[] | undefined)[]): Record<string, unknown> | undefined => {
  const { items } = ctx
  const result: Record<string, unknown> = {}

  let allowed: string[] | undefined
  let nullAllowed = true
  let firstType: string | undefined
  let explicitFalse = false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    let nullable = hasOwn(item, "nullable") ? item.nullable : undefined
    if (nullable !== undefined && typeof nullable !== "boolean") {
      ctx.report?.("Malformed nullable value is ignored", [nullable])
      nullable = undefined
    }
    if (nullable === false) { explicitFalse = true }
    const list = types[i]
    if (!list) { continue }
    firstType ??= list.find((t) => t !== "null")
    const own = list.filter((t) => t !== "null")
    const itemNull = list.includes("null") || nullable === true
    allowed = allowed ? intersectTypes(allowed, own) : own
    nullAllowed = nullAllowed && itemNull
  }

  if (!allowed) {
    // no typed item: nullable has no effect; kept as the strict conjunction of the items' values
    if (items.every((item) => hasOwn(item, "nullable") && item.nullable === true)) {
      result.nullable = true
    } else if (explicitFalse) {
      result.nullable = false
    }
    return result
  }

  if (allowed.length) {
    result.type = asType(allowed)
    if (nullAllowed) {
      result.nullable = true
    } else if (explicitFalse) {
      result.nullable = false
    }
    return result
  }

  if (!nullAllowed || firstType === undefined) { return undefined }
  // only null satisfies every item
  result.type = firstType
  result.nullable = true
  if (items.some((item) => hasOwn(item, "enum") || hasOwn(item, "const"))) {
    result.allOf = [{ enum: [null] }]
  } else {
    result.enum = [null]
  }
  return result
}

// `type` over the JSON Schema type lattice: integer ∧ number = integer; an empty intersection is a contradiction.
// Malformed `type` values (not a string / non-empty list of strings) are ignored and reported.
export const typeGroup: KeywordGroup = {
  name: "type",
  keys: ["type", "nullable"],
  resolve: (ctx) => {
    const { items, values } = ctx
    const originals: unknown[] = []
    const types = items.map((item) => {
      if (!hasOwn(item, "type")) { return undefined }
      const list = typeList(item.type)
      if (list) {
        originals.push(item.type)
      } else {
        ctx.report?.("Malformed type value is ignored", [item.type])
      }
      return list
    })

    if (hasOwn(values, "nullable")) { return resolveNullable(ctx, types) }

    const lists = types.filter((list): list is string[] => list !== undefined)
    if (!lists.length) { return {} }
    if (lists.length === 1) { return { type: originals[0] } }
    const merged = lists.reduce((r, v) => intersectTypes(r, v))
    return merged.length ? { type: asType(merged) } : undefined
  },
}
