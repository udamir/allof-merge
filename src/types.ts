import type { JsonPath, CrawlRules, SyncCloneHook } from "json-crawl"

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
  // same as merge(value, options), reusing the resolution index and the merge memo of this merger
  merge: (value: unknown, options?: Pick<MergeOptions, "rules" | "source">) => unknown
  // the json-crawl clone hook (same as allOfResolverHook(options))
  hook: SyncCloneHook<{}>
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

export interface MergeContext {
  allOfItems: JsonSchema[]
  mergeRules: MergeRules
  mergeError: MergeError
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
  // report a non-fatal problem (malformed value, unmergeable keyword) at the node; populated by the engine
  report?: (message: string, values: any[]) => void
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
