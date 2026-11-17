import type { JsonPath } from "json-crawl"

/*
 * Issue model (docs/NORMALIZATION_DESIGN.md §3, user decisions §9): every place where the output deviates from "each
 * keyword of each input item merged into one equivalent keyword" without the consumer asking for it is an issue. An
 * outcome a merge rule defines (last-wins annotations and vendor keys, the OpenAPI numeric format lattice, removed
 * duplicates, rewritten links, dropped identity keywords of inlined targets) is not an issue. There are two
 * severities: `error` (invalid input, a schema no value satisfies) and `warning` (parts kept unmerged, limits hit,
 * impossible branches removed, copies made instead of links).
 */

export type MergeIssueSeverity = "error" | "warning"

export type MergeIssueCategory = "input" | "unresolved" | "contradiction" | "kept" | "limit" | "removed" | "rewritten"

export type MergeIssueCode =
  | "malformed-value"
  | "malformed-allof"
  | "malformed-allof-item"
  | "broken-ref"
  | "ref-cycle"
  | "cyclic-value"
  | "pattern-invalid"
  | "external-ref"
  | "unsatisfiable"
  | "unsatisfiable-combinator"
  | "branch-removed"
  | "branch-kept-for-link"
  | "pattern-kept"
  | "contains-kept"
  | "conditional-kept"
  | "unevaluated-kept"
  | "object-shape-kept"
  | "multipleof-kept"
  | "tuple-kept"
  | "schema-format-kept"
  | "kept-for-link"
  | "branch-budget"
  | "ref-expansion-limit"
  | "expansion-budget"
  | "max-depth"
  | "nullable-overridden"
  | "link-copied"
  | "merge-conflict"

export interface MergeIssue {
  code: MergeIssueCode              // stable identifier (MERGE_ISSUES)
  severity: MergeIssueSeverity
  category: MergeIssueCategory
  message: string                   // human-readable; the legacy onMergeError / onRefResolveError message where one exists
  path: JsonPath                    // output location, relative to the merged value (what onMergeError receives)
  sourcePointer?: string            // JSON pointer ("#/components/schemas/Pet") of the input node in `source` where the
                                    // issue surfaces; absent when that node is not part of `source`
  keyword?: string                  // the keyword concerned ("format", "oneOf", "allOf", ...)
  values?: unknown[]                // the values involved (conflicting values, removed branch, malformed value)
  ref?: string                      // the `$ref` concerned (broken, cyclic, external, limited, copied)
  reason?: string                   // sub-cause of a code with several causes (see MERGE_ISSUES)
}

// legacy callback a code is delivered to besides onIssue: onMergeError ("merge") or onRefResolveError ("ref")
export type LegacyCallback = "merge" | "ref"

export interface MergeIssueInfo {
  severity: MergeIssueSeverity
  category: MergeIssueCategory
  legacy?: LegacyCallback
  description: string
}

const info = (severity: MergeIssueSeverity, category: MergeIssueCategory, description: string, legacy?: LegacyCallback): MergeIssueInfo =>
  Object.freeze(legacy ? { severity, category, legacy, description } : { severity, category, description })

/** Every issue code with its severity, category, legacy callback and meaning. */
export const MERGE_ISSUES: Readonly<Record<MergeIssueCode, MergeIssueInfo>> = Object.freeze({
  "malformed-value": info("error", "input", "A keyword value of the wrong type is ignored", "merge"),
  "malformed-allof": info("error", "input", "allOf is not an array: it is ignored, the rest of the node is kept", "merge"),
  "malformed-allof-item": info("error", "input", "An allOf item that is not a schema is ignored", "merge"),
  "broken-ref": info("error", "input", "A local $ref does not resolve: the node keeps the $ref", "ref"),
  "ref-cycle": info("error", "input", "A $ref -> $ref chain comes back to itself: the node keeps the $ref", "ref"),
  "cyclic-value": info("error", "input", "A cyclic JavaScript value outside the source document is replaced by {}", "merge"),
  "pattern-invalid": info("error", "input", "An invalid regular expression is kept as a pattern fragment", "merge"),
  "external-ref": info("warning", "unresolved", "An external $ref cannot be merged: the $ref is kept", "ref"),
  "unsatisfiable": info("error", "contradiction", "No value satisfies the conjunction: the schema is false (reason: type, enum, const, bounds, format, false-item, simplify)", "merge"),
  "unsatisfiable-combinator": info("error", "contradiction", "Every oneOf / anyOf branch became impossible: the schema is false", "merge"),
  "branch-removed": info("warning", "removed", "An impossible oneOf / anyOf branch is removed (dropFalseBranches)"),
  "branch-kept-for-link": info("warning", "kept", "An impossible branch is kept because a pointer of the output targets a later branch"),
  "pattern-kept": info("warning", "kept", "Patterns that cannot be conjoined safely (backreferences, named groups) are kept as allOf parts"),
  "contains-kept": info("warning", "kept", "Different contains are kept as allOf parts"),
  "conditional-kept": info("warning", "kept", "Several if / then / else are kept as allOf parts"),
  "unevaluated-kept": info("warning", "kept", "An item with its own unevaluatedProperties / unevaluatedItems is kept as an allOf part"),
  "object-shape-kept": info("warning", "kept", "properties / patternProperties / additionalProperties are kept as allOf parts (reason: pattern-interaction, match-limit, nested-quantifier, invalid-pattern, test-budget)"),
  "multipleof-kept": info("warning", "kept", "multipleOf values without an exact least common multiple are kept as allOf parts", "merge"),
  "tuple-kept": info("warning", "kept", "2020-12: an array-valued items is kept as an allOf part", "merge"),
  "schema-format-kept": info("warning", "kept", "AsyncAPI 3: a $ref to a schema in a format that is not JSON Schema is kept as an allOf part", "merge"),
  "kept-for-link": info("warning", "kept", "A node is kept unmerged because a $ref of the output points through it"),
  "branch-budget": info("warning", "limit", "oneOf / anyOf combinations exceed the branch budget: the node is left unchanged", "merge"),
  "ref-expansion-limit": info("warning", "limit", "A $ref target is inlined more than maxRefExpansion times: the $ref is kept", "merge"),
  "expansion-budget": info("warning", "limit", "$ref inlining exceeds expansionBudget: the remaining $refs are kept", "merge"),
  "max-depth": info("warning", "limit", "Nodes deeper than maxDepth are copied without merging", "merge"),
  "nullable-overridden": info("warning", "rewritten", "OpenAPI 3.0: nullable: true has no effect because another item with a type forbids null"),
  "link-copied": info("warning", "rewritten", "A $ref whose target the merge rewrote is replaced by a copy of its original target"),
  "merge-conflict": info("warning", "contradiction", "A custom merge rule reported a conflict (mergeError / report without an issue code)", "merge"),
})

export const ISSUE_MESSAGES: Readonly<Partial<Record<MergeIssueCode, string>>> = Object.freeze({
  "branch-removed": "Impossible branch is removed",
  "branch-kept-for-link": "Impossible branch is kept: a $ref of the output points to a later branch",
  "pattern-kept": "Patterns with backreferences or named groups cannot be conjoined, kept as allOf",
  "contains-kept": "Different contains cannot be merged, kept as allOf",
  "conditional-kept": "Several if/then/else cannot be merged, kept as allOf",
  "unevaluated-kept": "An item with its own unevaluatedProperties/unevaluatedItems cannot be merged, kept as allOf",
  "object-shape-kept": "Object shapes cannot be merged exactly, kept as allOf",
  "kept-for-link": "Node is kept unmerged: a $ref of the output points through it",
  "nullable-overridden": "nullable: true has no effect: another allOf item with a type does not allow null",
  "link-copied": "$ref is replaced by a copy of its target: the merged location has a different value",
  "external-ref": "External $ref cannot be merged, kept",
})

const SEVERITY_RANK: Readonly<Record<MergeIssueSeverity, number>> = Object.freeze({ warning: 0, error: 1 })

// whether an issue of `severity` is delivered at `level`
export const atLevel = (severity: MergeIssueSeverity, level: MergeIssueSeverity): boolean => SEVERITY_RANK[severity] >= SEVERITY_RANK[level]

// the hint a keyword group or a resolver passes with a report: the code and its details
export interface IssueHint {
  code: MergeIssueCode
  keyword?: string
  reason?: string
}
