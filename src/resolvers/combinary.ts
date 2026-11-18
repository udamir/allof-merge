import type { AnyOfNode, MergeRule, OneOfNode } from "../types.ts"
import { popValues } from "../utils.ts"
import { safeClone, safeSet } from "../safe.ts"

// pushes the non-whitelisted sibling keys of a oneOf/anyOf node into every branch as an allOf conjunction
// (own-property safe: user keys such as `__proto__` are copied as data, never through spread / `in`)
export const mergeCombinarySibling = (value: AnyOfNode | OneOfNode, combinaryKey: "anyOf" | "oneOf", rule: MergeRule) => {
  const siblingKeys = rule.sibling || []

  const combinary = value[combinaryKey]
  const rest: Record<string, unknown> = safeClone(value)
  delete rest[combinaryKey]
  const sibling = popValues(rest, siblingKeys)

  if (!Object.keys(rest).length) { return value }
  const result: Record<string, unknown> = {}
  safeSet(result, combinaryKey, combinary.map((item: any) => ({ allOf: [rest, item] })))
  for (const key of Object.keys(sibling)) { safeSet(result, key, sibling[key]) }
  return result
}
