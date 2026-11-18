import type { GroupContext } from "../types.ts"
import { hasOwn } from "../safe.ts"

// a leaf module: used by the string group and by the format resolvers of resolvers/basic (which the string group
// imports), so it must not import either of them

type Report = GroupContext["report"]

// OpenAPI numeric format lattice: the key is a subset of the value (int32 ⊂ int64, float ⊂ double)
const NARROWER_FORMAT: Readonly<Record<string, string>> = Object.freeze({ int32: "int64", float: "double" })

/**
 * format: equal formats are kept; with `lattice` (the OpenAPI rule sets) the
 * numeric lattice picks the narrower format (int32 ∧ int64 → int32, float ∧ double → float, a rule-defined outcome);
 * any other combination of different formats (without `lattice` also int32 ∧ int64, overlapping pairs such as
 * `uri` ∧ `uri-reference`, unknown formats) is a contradiction: `undefined`. Formats that are not strings are ignored
 * and reported.
 */
export const mergeFormats = (values: unknown[], report?: Report, lattice = false): Record<string, unknown> | undefined => {
  const formats: string[] = []
  for (const value of values) {
    if (typeof value !== "string") {
      report?.("Malformed format value is ignored", [value], { code: "malformed-value", keyword: "format" })
      continue
    }
    if (!formats.includes(value)) { formats.push(value) }
  }
  if (!formats.length) { return {} }
  // drop every format that has a narrower one in the list
  const minimal = lattice
    ? formats.filter((format) => !formats.some((other) => hasOwn(NARROWER_FORMAT, other) && NARROWER_FORMAT[other] === format))
    : formats
  return minimal.length === 1 ? { format: minimal[0] } : undefined
}

