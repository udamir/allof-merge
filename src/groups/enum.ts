import type { KeywordGroup } from "../types.ts"
import { deepEqual } from "../utils.ts"
import { mergeEnum } from "../resolvers/basic.ts"
import { hasOwn } from "../safe.ts"

/**
 * enum / const
 *
 * Members are compared structurally; the intersection keeps the first-seen order. Differing consts are a
 * contradiction; `const` next to `enum` is kept as it is (equivalent, even when the const is outside the enum).
 * An `enum` that is not an array is ignored and reported (D-6): it never overrides a valid enum.
 */
export const enumConstGroup: KeywordGroup = {
  name: "enumConst",
  keys: ["enum", "const"],
  resolve: ({ values, report }) => {
    const result: Record<string, unknown> = {}

    if (hasOwn(values, "const")) {
      const [first, ...rest] = values.const
      if (rest.some((v: unknown) => !deepEqual(v, first))) { return undefined }
      result.const = first
    }

    if (hasOwn(values, "enum")) {
      const lists: any[][] = []
      for (const list of values.enum) {
        if (Array.isArray(list)) {
          lists.push(list)
        } else {
          report?.("Malformed enum value is ignored", [list], { code: "malformed-value", keyword: "enum" })
        }
      }
      if (lists.length) {
        const members = lists.length === 1 ? lists[0] : mergeEnum(lists, undefined as any)
        if (members === undefined) { return undefined }
        result.enum = members
      }
    }

    return result
  },
}
