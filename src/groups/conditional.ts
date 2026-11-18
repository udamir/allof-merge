import type { KeywordGroup } from "../types.ts"
import { ISSUE_MESSAGES } from "../issues.ts"

const KEYS = ["if", "then", "else"] as const

/**
 * if / then / else (draft-07+)
 *
 * Two conditionals have no closed intersection form, so when more than one item carries `if`
 * every item's conditional triple is kept as an allOf fragment. A single `if` is kept as is.
 */
export const conditionalGroup: KeywordGroup = {
  name: "conditional",
  keys: KEYS,
  resolve: ({ items, values, report }) => {
    const owners = items.filter((item) => KEYS.some((key) => key in item))
    const result: Record<string, unknown> = {}
    if (owners.length <= 1) {
      for (const key of KEYS) {
        if (key in values) { result[key] = values[key][0] }
      }
      return result
    }
    report?.(ISSUE_MESSAGES["conditional-kept"]!, owners.map((item) => item.if), { code: "conditional-kept", keyword: "if" })
    result.allOf = owners.map((item) => {
      const fragment: Record<string, unknown> = {}
      for (const key of KEYS) {
        if (key in item) { fragment[key] = item[key] }
      }
      return fragment
    })
    return result
  },
}
