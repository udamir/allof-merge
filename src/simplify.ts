import type { SimplifyOptions } from "./types.ts"
import { isEmptyObject, isPlainObject } from "./utils.ts"
import { hasOwn } from "./safe.ts"

/**
 * Form-changing simplifications of a merged schema node (the `simplify` option).
 * Every rule is an equivalence under the draft of the rule set and is guarded by the node's own `type`:
 *
 * - `redundantBounds` (draft-06+): `minimum` + `exclusiveMinimum` (and the upper pair) keep the tighter bound
 * - `contradictions`: an empty numeric interval (also: no integer in it for an integer-only type), `minLength >
 *   maxLength`, `minItems > maxItems`, `minContains > maxContains` (2020-12, with `contains`), `minProperties >
 *   maxProperties` or more `required` names than `maxProperties`: the kind is removed from `type` (with its bound
 *   keywords); no kind left -> contradiction. Untyped nodes are never touched (the bounds only restrict their kind)
 * - `enumByType`: `enum` members / a `const` that `type` cannot admit are removed; none left -> contradiction
 * - `contradictions`: `contains` unsatisfiable, array-only `type`, no `minContains: 0` -> contradiction
 * - `containsToMinItems` (draft-06/07 rule sets only, which have no `unevaluatedItems`): `contains: true` / `{}`
 *   without `minContains`/`maxContains` -> `minItems` at least 1
 * - `contradictions`: object-only `type`, a `required` name whose property schema is unsatisfiable (or that no
 *   `properties` / `patternProperties` entry admits under `additionalProperties: false`) -> contradiction
 *
 * GraphApi schema rules are excluded from the type-guarded rules (their `nullable` is not a type), OpenAPI 3.0 rules
 * read `nullable: true` as admitting `null` and skip the bounds rules for nullable nodes. Rule sets without a
 * draft marker (custom rule trees) only get the rules whose reading does not depend on the draft.
 *
 * The node is changed in place. Returns the conflicting keyword values when the node is a contradiction (the caller
 * writes it as `false` / `{ allOf: [false], containers }` and reports it), otherwise undefined.
 */

type Draft = "draft-04" | "draft-06" | "draft-07" | "2020-12" | undefined

const JSON_TYPES = new Set(["null", "boolean", "string", "number", "integer", "array", "object"])

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export interface SimplifyRules {
  draft: Draft
  graphApi: boolean          // GraphApi schema rules: type-guarded rules are skipped
  nullableType: boolean      // OpenAPI 3.0 schema rules: `nullable: true` admits null
}

const rulesInfo = new WeakMap<object, SimplifyRules>()

// the reading of a rule set: its draft marker (set by jsonSchemaMergeRules), GraphApi (`/args`), OpenAPI 3.0
// (`/nullable` in the type group)
export const simplifyRulesOf = (rules: Record<string, any>): SimplifyRules => {
  let info = rulesInfo.get(rules)
  if (!info) {
    const draft = typeof rules.draft === "string" ? rules.draft as Draft : undefined
    const nullable = rules["/nullable"]
    info = {
      draft,
      graphApi: hasOwn(rules, "/args"),
      nullableType: !!nullable && typeof nullable === "object" && nullable.group === "type",
    }
    rulesInfo.set(rules, info)
  }
  return info
}

// the type names of a node, or undefined when untyped / malformed / using a name that is not a JSON type
const typesOf = (node: Record<string, any>): string[] | undefined => {
  const { type } = node
  const list: unknown[] = typeof type === "string" ? [type] : Array.isArray(type) ? type : []
  if (!list.length || !list.every((name) => typeof name === "string" && JSON_TYPES.has(name))) { return undefined }
  return list as string[]
}

const admits = (types: Set<string>, value: unknown): boolean => {
  if (value === null) { return types.has("null") }
  switch (typeof value) {
    case "boolean": return types.has("boolean")
    case "string": return types.has("string")
    case "number": return types.has("number") || (types.has("integer") && Number.isInteger(value))
    case "object": return Array.isArray(value) ? types.has("array") : types.has("object")
    default: return false
  }
}

interface Bound { value: number, exclusive: boolean }

// the effective lower / upper numeric bound of a node, or "skip" when a bound keyword has the wrong form for the draft
const numericBounds = (node: Record<string, any>, draft: Draft): { lower?: Bound, upper?: Bound } | "skip" => {
  const side = (inclusiveKey: "minimum" | "maximum", exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum", lower: boolean): Bound | undefined | "skip" => {
    const inclusive = node[inclusiveKey]
    const exclusive = node[exclusiveKey]
    if (inclusive !== undefined && !isFiniteNumber(inclusive)) { return "skip" }
    if (draft === "draft-04" || (draft === undefined && typeof exclusive === "boolean")) {
      if (exclusive !== undefined && typeof exclusive !== "boolean") { return "skip" }
      return inclusive === undefined ? undefined : { value: inclusive, exclusive: exclusive === true }
    }
    if (exclusive !== undefined && !isFiniteNumber(exclusive)) { return "skip" }
    if (inclusive === undefined) { return exclusive === undefined ? undefined : { value: exclusive, exclusive: true } }
    if (exclusive === undefined) { return { value: inclusive, exclusive: false } }
    // the tighter of the two
    const exclusiveTighter = lower ? exclusive >= inclusive : exclusive <= inclusive
    return exclusiveTighter ? { value: exclusive, exclusive: true } : { value: inclusive, exclusive: false }
  }
  const lower = side("minimum", "exclusiveMinimum", true)
  const upper = side("maximum", "exclusiveMaximum", false)
  if (lower === "skip" || upper === "skip") { return "skip" }
  return { lower, upper }
}

const emptyInterval = (lower?: Bound, upper?: Bound): boolean => {
  if (!lower || !upper) { return false }
  return lower.value > upper.value || (lower.value === upper.value && (lower.exclusive || upper.exclusive))
}

const hasInteger = (lower?: Bound, upper?: Bound): boolean => {
  const first = !lower ? -Infinity : lower.exclusive ? Math.floor(lower.value) + 1 : Math.ceil(lower.value)
  const last = !upper ? Infinity : upper.exclusive ? Math.ceil(upper.value) - 1 : Math.floor(upper.value)
  return first <= last
}

const greater = (node: Record<string, any>, minKey: string, maxKey: string): boolean =>
  isFiniteNumber(node[minKey]) && isFiniteNumber(node[maxKey]) && node[minKey] > node[maxKey]

const NUMBER_BOUNDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]

export const simplifySchema = (
  node: Record<string, any>,
  rules: Record<string, any>,
  options: Required<SimplifyOptions>,
  isUnsatisfiable: (value: unknown) => boolean,
): unknown[] | undefined => {
  const { draft, graphApi, nullableType } = simplifyRulesOf(rules)
  const modern = draft === "draft-06" || draft === "draft-07" || draft === "2020-12"

  // x ≥ m ∧ x > e ≡ x > e when e ≥ m, else x ≥ m (and the same for the upper side)
  if (options.redundantBounds && modern) {
    if (isFiniteNumber(node.minimum) && isFiniteNumber(node.exclusiveMinimum)) {
      delete node[node.exclusiveMinimum >= node.minimum ? "minimum" : "exclusiveMinimum"]
    }
    if (isFiniteNumber(node.maximum) && isFiniteNumber(node.exclusiveMaximum)) {
      delete node[node.exclusiveMaximum <= node.maximum ? "maximum" : "exclusiveMaximum"]
    }
  }

  // contains: true ⇔ at least one item (arrays) — only where no unevaluatedItems can see the annotation
  if (options.containsToMinItems && (draft === "draft-06" || draft === "draft-07") && hasOwn(node, "contains")) {
    const { contains } = node
    if ((contains === true || isEmptyObject(contains)) && !hasOwn(node, "minContains") && !hasOwn(node, "maxContains")) {
      if (node.minItems === undefined || isFiniteNumber(node.minItems)) {
        delete node.contains
        node.minItems = Math.max(1, node.minItems ?? 0)
      }
    }
  }

  if (graphApi) { return undefined }
  let types = typesOf(node)
  if (!types) { return undefined }
  // OpenAPI 3.0: a typed node with `nullable: true` admits null as well
  const nullable = nullableType && node.nullable === true

  // a kind whose bounds admit nothing is removed from `type`
  if (options.contradictions && !nullable) {
    const removed = new Set<string>()
    const conflicting: string[] = []
    const remove = (kinds: string[], keys: string[]) => {
      for (const kind of kinds) { removed.add(kind) }
      conflicting.push(...keys)
    }
    if (types.includes("number") || types.includes("integer")) {
      const bounds = numericBounds(node, draft)
      if (bounds !== "skip") {
        if (emptyInterval(bounds.lower, bounds.upper)) {
          remove(["number", "integer"], NUMBER_BOUNDS)
        } else if (types.includes("integer") && !types.includes("number") && !hasInteger(bounds.lower, bounds.upper)) {
          remove(["integer"], NUMBER_BOUNDS)
        }
      }
    }
    if (types.includes("string") && greater(node, "minLength", "maxLength")) { remove(["string"], ["minLength", "maxLength"]) }
    if (types.includes("array")) {
      if (greater(node, "minItems", "maxItems")) { remove(["array"], ["minItems", "maxItems"]) }
      if (draft === "2020-12" && hasOwn(node, "contains") && greater(node, "minContains", "maxContains")) { remove(["array"], ["minContains", "maxContains"]) }
    }
    if (types.includes("object")) {
      if (greater(node, "minProperties", "maxProperties")) { remove(["object"], ["minProperties", "maxProperties"]) }
      const { required } = node
      if (Array.isArray(required) && isFiniteNumber(node.maxProperties) && new Set(required).size > node.maxProperties) {
        remove(["object"], ["maxProperties"])
      }
    }
    if (removed.size) {
      const remaining = types.filter((name) => !removed.has(name))
      if (!remaining.length) {
        return [...new Set(conflicting)].filter((key) => hasOwn(node, key)).map((key) => node[key])
      }
      node.type = remaining.length === 1 ? remaining[0] : remaining
      types = remaining
      // the bound keywords of a removed kind restrict nothing any more
      for (const key of new Set(conflicting)) { delete node[key] }
    }
  }

  const admitted = new Set(types)
  if (nullable) { admitted.add("null") }

  // enum / const members of a kind the type does not admit can never validate
  if (options.enumByType) {
    if (Array.isArray(node.enum)) {
      const members = node.enum.filter((member: unknown) => admits(admitted, member))
      if (!members.length) { return [node.type, node.enum] }
      if (members.length !== node.enum.length) { node.enum = members }
    }
    if (hasOwn(node, "const") && !admits(admitted, node.const)) { return [node.type, node.const] }
  }

  const arrayOnly = admitted.size === 1 && admitted.has("array")
  const objectOnly = admitted.size === 1 && admitted.has("object")

  if (options.contradictions && draft !== "draft-04" && arrayOnly && hasOwn(node, "contains") && isUnsatisfiable(node.contains)) {
    // every array needs an item valid against an unsatisfiable schema (unless minContains: 0 makes it vacuous)
    if (!(hasOwn(node, "minContains") && node.minContains === 0)) { return [node.type, node.contains] }
  }

  // a required property that no value can satisfy (typed objects only)
  if (options.contradictions && objectOnly && Array.isArray(node.required)) {
    const properties = isPlainObject(node.properties) ? node.properties : undefined
    const patterns = node.patternProperties
    const closed = (node.additionalProperties === false || isUnsatisfiable(node.additionalProperties)) && (patterns === undefined || isEmptyObject(patterns))
    for (const name of node.required) {
      if (typeof name !== "string") { continue }
      if (properties && hasOwn(properties, name)) {
        if (isUnsatisfiable(properties[name])) { return [node.required, properties[name]] }
      } else if (closed) {
        return [node.required, node.additionalProperties]
      }
    }
  }
  return undefined
}
