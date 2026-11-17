import type { JsonPath, CrawlRules, SyncCloneHook } from "json-crawl"
import type { IssueHint, MergeIssue, MergeIssueCode, MergeIssueSeverity } from "./issues"

export type { IssueHint, MergeIssue, MergeIssueCategory, MergeIssueCode, MergeIssueInfo, MergeIssueSeverity } from "./issues"

export type JsonSchema = any
export type MergeRules = CrawlRules<MergeRule>

// representation of a contradictory (unsatisfiable) schema in the output
export type UnsatisfiableMode = "false" | "not-empty"

// node-level annotations of `$ref` targets inlined into a merged node (#222): "merge" (default) promotes them as
// before; "omit" drops `title`, `description`, `$comment` that arrive only through a `$ref`; a list drops the listed
// keys (an entry ending with `*` is a prefix, e.g. "x-*"). The node's own values always stay
export type RefAnnotations = "merge" | "omit" | readonly string[]

export interface MergeOptions {
  source?: any                    // source JsonSchema if merging only part of it
  rules?: MergeRules              // custom merge rules
  mergeRefSibling?: boolean       // merge $ref and sibling content
  mergeCombinarySibling?: boolean // merge oneOf, anyOf sibling content
  onMergeError?: (message: string, path: JsonPath, values: any[]) => void
  onRefResolveError?: (message: string, path: JsonPath, ref: string) => void
  onIssue?: (issue: MergeIssue) => void // every issue at or above `issueLevel` (see MERGE_ISSUES); reported on every call
  issueLevel?: MergeIssueSeverity  // minimum severity delivered to onIssue / mergeWithIssues (default "warning": all)
  unsatisfiable?: UnsatisfiableMode // how a contradiction is written: boolean `false` (default) or `{ not: {} }`
  branchBudget?: number           // max number of oneOf/anyOf combinations produced by one merge() call (default 1024)
  matchPatterns?: boolean | PatternMatchLimits // match property names against other items' patternProperties (default true, with default limits)
  maxRefExpansion?: number        // max number of times one $ref target is inlined per merge() call before the $ref is kept (default 10000)
  expansionBudget?: number        // max number of schema nodes copied in by $ref inlining per merge() call before $refs are kept (default 2000000)
  maxDepth?: number               // max nesting depth that is merged; deeper nodes are copied without merging (default 2000)
  freezeOutput?: boolean          // deep-freeze the merged output (default false)
  refAnnotations?: RefAnnotations // annotations inherited through $ref: "merge" (default), "omit" or a key list (#222)
  // always-safe simplifications of merged nodes (equivalences; each default true)
  dedupeAnyOf?: boolean           // identical anyOf branches of a merged node are kept once (never oneOf)
  dedupeFragments?: boolean       // identical allOf parts kept in a merged node are kept once
  dedupeCombinaryGroups?: boolean // identical oneOf/anyOf groups are combined once before the cartesian product
  dropFalseBranches?: boolean     // impossible (false) oneOf/anyOf branches of a merged node are removed; all of them
                                  // impossible -> the node is a contradiction
  // form-changing simplifications of merged nodes (exact, default off): true = all rules, or a selection
  simplify?: boolean | SimplifyOptions
}

// the opt-in rules of the `simplify` option (each exact under the draft of the rule set)
export interface SimplifyOptions {
  enumByType?: boolean            // enum / const members the node's type cannot admit are removed (empty -> false)
  contradictions?: boolean        // typed bounds contradictions -> false (or the kind removed from a type list),
                                  // typed required + false property -> false, contains: false with array type -> false
  redundantBounds?: boolean       // redundant inclusive / exclusive bound pairs (draft-06+) -> the tighter one
  containsToMinItems?: boolean    // contains: true / {} -> minItems >= 1 (draft-06/07 rule sets only: no unevaluatedItems)
}

export interface PatternMatchLimits {
  maxPatternLength?: number       // patterns longer than this are not executed (default 256)
  maxNameLength?: number          // property names longer than this are not matched (default 256)
}

// MergeOptions with defaults applied, handed to keyword groups
export interface ResolvedMergeSettings {
  unsatisfiable: UnsatisfiableMode
  branchBudget: number
  matchPatterns: false | Required<PatternMatchLimits>
  maxRefExpansion: number
  expansionBudget: number
  maxDepth: number
  dedupeAnyOf: boolean
  dedupeFragments: boolean
  dedupeCombinaryGroups: boolean
  dropFalseBranches: boolean
  simplify: Required<SimplifyOptions> | false
}

export interface Merger {
  // same as merge(value, options), reusing the resolution index and the merge memo of this merger; `onIssue` replaces
  // the merger's sink for this call (one merger can serve callers with different contexts)
  merge: (value: unknown, options?: Pick<MergeOptions, "rules" | "source" | "onIssue">) => unknown
  // the json-crawl clone hook (same as allOfResolverHook(options))
  hook: SyncCloneHook<{}>
  // whether merge(value, options) can produce anything but a plain copy of `value` (or report an issue other than a
  // limit): false for subtrees without allOf and without the forms the merger's options rewrite
  needsMerge: (value: unknown, options?: Pick<MergeOptions, "source">) => boolean
}

export interface RefNode {
  $ref: string
  [key: string]: any
}

export interface AnyOfNode {
  anyOf: any[]
  [key: string]: any
}

export interface OneOfNode {
  oneOf: any[]
  [key: string]: any
}

export type MergeError = (values: any[]) => void

// a report with an issue code (the engine fills it in; `mergeError(values)` is the same as `report("merge-conflict", values)`)
export type MergeReport = (code: MergeIssueCode, values: any[], details?: { message?: string, keyword?: string, reason?: string }) => void

export interface MergeContext {
  allOfItems: JsonSchema[]
  mergeRules: MergeRules
  mergeError: MergeError
  // report an issue with a code (populated by the engine; optional for direct callers)
  report?: MergeReport
  // forward an issue of a nested merge, its path relative to this node (populated by the engine)
  forward?: (issue: MergeIssue) => void
  // the keyword being merged (populated by the engine)
  key?: string
  path?: JsonPath
  // resolved merge options (populated by the engine; optional for direct callers)
  settings?: ResolvedMergeSettings
}

export type MergeResolver = (args: any[], ctx: MergeContext) => any
export type MergeRule = {
  "$"?: MergeResolver
  sibling?: string[]
  group?: string
  // schema rules only: the tuple keyword of the rule set (D-18) — "items" (draft-04/06/07) or "prefixItems" (2020-12)
  tuple?: "items" | "prefixItems"
  // schema rules only: the draft of the keyword table ("draft-04" | "draft-06" | "draft-07" | "2020-12")
  draft?: string
}

// context handed to a keyword group resolver
export interface GroupContext {
  // all schema items of the node (booleans and empty schemas already removed)
  items: Record<string, any>[]
  // values of the keys owned by the group, in item order: key -> values
  values: Record<string, any[]>
  mergeRules: MergeRules
  path: JsonPath
  // resolved merge options (populated by the engine; optional for direct callers of group resolvers)
  settings?: ResolvedMergeSettings
  // report a non-fatal problem (malformed value, unmergeable keyword) at the node; populated by the engine. Without a
  // hint the report is a "merge-conflict" issue (custom groups); built-in groups pass the issue code
  report?: (message: string, values: any[], hint?: IssueHint) => void
}

// a group resolver returns the merged keys it owns, or undefined when the conjunction is contradictory
export type GroupResolver = (ctx: GroupContext) => Record<string, any> | undefined

export interface KeywordGroup {
  name: string
  keys: readonly string[]
  resolve: GroupResolver
}

// kept for type compatibility with 0.x
export interface AllOfRef {
  pointer: string
  data: string
  refs: string[]
}

// kept for type compatibility with 0.x
export interface NormalizeResponse {
  allOfItems: any[]
  brokenRefs: string[]
}
