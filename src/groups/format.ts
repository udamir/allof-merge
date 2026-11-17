import type { GroupContext } from "../types"
import { hasOwn } from "../safe"

// a leaf module: used by the string group and by the format resolvers of resolvers/basic (which the string group
// imports), so it must not import either of them

type Report = GroupContext["report"]

// OpenAPI numeric format lattice: the key is a subset of the value (int32 ⊂ int64, float ⊂ double)
const NARROWER_FORMAT: Readonly<Record<string, string>> = Object.freeze({ int32: "int64", float: "double" })

/**
 * format (D-2, D-14): equal formats are kept; with `lattice` (the OpenAPI rule sets) the numeric lattice picks the
 * narrower format (int32 ∧ int64 → int32, float ∧ double → float); any other combination of different formats
 * (without `lattice` also int32 ∧ int64) is kept as `allOf: [{ format: a }, …]` fragments and reported. Formats that
 * are not strings are ignored and reported.
 */
export const mergeFormats = (values: unknown[], report?: Report, lattice = false): Record<string, unknown> => {
  const formats: string[] = []
  for (const value of values) {
    if (typeof value !== "string") {
      report?.("Malformed format value is ignored", [value])
      continue
    }
    if (!formats.includes(value)) { formats.push(value) }
  }
  if (!formats.length) { return {} }
  // drop every format that has a narrower one in the list
  const minimal = lattice
    ? formats.filter((format) => !formats.some((other) => hasOwn(NARROWER_FORMAT, other) && NARROWER_FORMAT[other] === format))
    : formats
  if (minimal.length === 1) { return { format: minimal[0] } }
  report?.("Different formats cannot be merged, kept as allOf", minimal)
  return { allOf: minimal.map((format) => ({ format })) }
}

