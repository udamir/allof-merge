import type { GroupContext, KeywordGroup } from "../types"
import { getNodeRules } from "json-crawl"
import { conjunctPatterns, mergeOpenApiFormat } from "../resolvers/basic"
import { mergeFormats } from "./format"
import { hasOwn } from "../safe"
import { compilePattern } from "../utils"

export { mergeFormats } from "./format"

type Report = GroupContext["report"]

const isLength = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

const lengths = (values: unknown[], key: string, report?: Report): number[] => {
  const result: number[] = []
  for (const value of values) {
    if (isLength(value)) {
      result.push(value)
    } else {
      report?.(`Malformed ${key} value is ignored`, [value])
    }
  }
  return result
}

/**
 * minLength / maxLength / pattern / format
 *
 * Length bounds take the tightest value (an empty interval is kept, it is equivalent). Several patterns are
 * de-duplicated and conjoined into one lookahead expression; when a pattern cannot be combined safely
 * (backreferences, named groups, invalid syntax) the patterns are kept as allOf fragments instead. Malformed
 * values (non-integer lengths, non-string patterns/formats) are ignored and reported.
 */
export const stringGroup: KeywordGroup = {
  name: "string",
  keys: ["minLength", "maxLength", "pattern", "format"],
  resolve: ({ values, report, mergeRules, path }) => {
    const result: Record<string, unknown> = {}
    const fragments: unknown[] = []

    if (hasOwn(values, "minLength")) {
      const list = lengths(values.minLength, "minLength", report)
      if (list.length) { result.minLength = Math.max(...list) }
    }
    if (hasOwn(values, "maxLength")) {
      const list = lengths(values.maxLength, "maxLength", report)
      if (list.length) { result.maxLength = Math.min(...list) }
    }

    if (hasOwn(values, "pattern")) {
      const patterns: string[] = []
      for (const pattern of values.pattern) {
        if (typeof pattern === "string") {
          patterns.push(pattern)
        } else {
          report?.("Malformed pattern value is ignored", [pattern])
        }
      }
      if (patterns.length) {
        const pattern = conjunctPatterns(patterns)
        if (pattern !== undefined) {
          result.pattern = pattern
        } else {
          const invalid = patterns.filter((p) => compilePattern(p) === null)
          if (invalid.length) { report?.("Invalid pattern is kept as an allOf fragment", invalid) }
          fragments.push(...[...new Set(patterns)].map((p) => ({ pattern: p })))
        }
      }
    }

    if (hasOwn(values, "format")) {
      // the numeric lattice applies when the location's `format` rule is `mergeOpenApiFormat` (OpenAPI rule sets, D-14)
      const rule: any = mergeRules ? getNodeRules(mergeRules as any, "format", path ?? [], values.format[0]) : undefined
      const format = mergeFormats(values.format, report, !!rule && rule.$ === mergeOpenApiFormat)
      if (format.allOf) {
        fragments.push(...(format.allOf as unknown[]))
      } else if (hasOwn(format, "format")) {
        result.format = format.format
      }
    }

    if (fragments.length) { result.allOf = fragments }
    return result
  },
}
