import { JSON_ROOT_KEY, type JsonPath, type SyncCloneHook, syncClone } from "json-crawl"

import type { MergeOptions, MergeRule, MergeRules, Merger, RefAnnotations } from "./types"
import { asyncApiMergeRules, detectAsyncApiVersion, graphapiMergeRules, jsonSchemaMergeRules, openApiMergeRules, unwrapSchemaFormat } from "./rules"
import { dedupeValues, deepEqual, isAnchorPointer, isAnyOfNode, isEmptyObject, isOneOfNode, isPlainObject, isRefNode, parseRef } from "./utils"
import { buildPointer } from "./pointer"
import { type ResolutionIndex, type ResolveResult, createResolutionIndex } from "./resolve"
import { mergeCombinarySibling } from "./resolvers/combinary"
import { productBranches } from "./resolvers/basic"
import { UNCHANGED, intersect, isAllOfMergeRule, resolveMergeSettings } from "./intersect"
import { containerOrigin } from "./groups/common"
import { ErrorMessage } from "./errors"
import { simplifySchema } from "./simplify"
import { engine } from "./engine"
import { hasOwn, safeClone, safeSet } from "./safe"

export { DEFAULT_BRANCH_BUDGET } from "./intersect"

const isContainerKey = (key: unknown): key is "properties" | "patternProperties" => key === "properties" || key === "patternProperties"

// key under which the clone of the current node is written into `state.node`: json-crawl passes `key: undefined`
// for the root only, and syncClone keeps the root's clone under JSON_ROOT_KEY ("#") of its holder object
const cloneKey = (key: string | number | undefined): string | number => key === undefined ? JSON_ROOT_KEY : key

// siblings that other parts of a document may point into: kept next to a contradiction (D-10, VR-32)
const CONTAINER_SIBLINGS = ["definitions", "$defs", "components", "$id", "id", "$anchor", "$dynamicAnchor", "$schema", "$vocabulary"]

// annotations "omit" drops when they arrive only through a $ref (#222)
export const DEFAULT_OMITTED_ANNOTATIONS: readonly string[] = Object.freeze(["title", "description", "$comment"])

// predicate of the inherited annotation keys to drop (undefined: "merge", nothing is dropped)
const inheritedKeyFilter = (option: RefAnnotations | undefined): ((key: string) => boolean) | undefined => {
  const list = option === "omit" ? DEFAULT_OMITTED_ANNOTATIONS : Array.isArray(option) ? option : undefined
  if (!list) { return undefined }
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const entry of list) {
    if (typeof entry !== "string" || !entry) { continue }
    if (entry.endsWith("*")) {
      prefixes.push(entry.slice(0, -1))
    } else {
      exact.add(entry)
    }
  }
  if (!exact.size && !prefixes.length) { return undefined }
  return (key) => exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))
}

export const selectMergeRules = (data: unknown): MergeRules => {
  if (typeof data !== "object" || !data) { return jsonSchemaMergeRules() }
  const doc = data as Record<string, unknown>

  if (hasOwn(doc, "openapi") && typeof doc.openapi === "string" && /3.+/.test(doc.openapi)) {
    const version = doc.openapi.startsWith("3.1") ? "3.1.x" : "3.0.x"
    return openApiMergeRules(version)
  }
  const asyncApiVersion = detectAsyncApiVersion(doc)
  if (asyncApiVersion) { return asyncApiMergeRules(asyncApiVersion) }
  // if ("swagger" in data && typeof data.swagger === "string" && /2.+/.test(data?.swagger)) return swagger2MergeRules
  if (hasOwn(doc, "graphapi") && typeof doc.graphapi === "string") return graphapiMergeRules
  return jsonSchemaMergeRules()
}

export const merge = (value: unknown, options?: MergeOptions) => {
  return createMerger(options).merge(value)
}

export const allOfResolverHook = (options?: MergeOptions): SyncCloneHook<{}> => {
  return createMerger(options).hook
}

// members of a rewritten node that keep their meaning: container siblings are kept next to a merged node and next to
// a contradiction (D-10), so a pointer into them (`#/definitions/A/definitions/B`) does not run "through" the node
const UNAFFECTED_MEMBERS = new Set(["definitions", "$defs", "components"])

// every distinct local $ref string of `output` (iterative, each instance visited once); `skip` holds $ref nodes the
// merge emitted itself (cycle re-entries to output locations, rewritten links), which are valid by construction
const collectLocalRefs = (output: unknown, skip?: WeakSet<object>): Set<string> => {
  const refs = new Set<string>()
  if (typeof output !== "object" || output === null) { return refs }
  const seen = new Set<object>()
  const stack: object[] = [output]
  while (stack.length) {
    const node = stack.pop() as Record<string, unknown>
    if (seen.has(node)) { continue }
    seen.add(node)
    if (!Array.isArray(node) && typeof node.$ref === "string" && !parseRef(node.$ref).filePath && !skip?.has(node)) { refs.add(node.$ref) }
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (typeof child === "object" && child !== null && !seen.has(child)) { stack.push(child) }
    }
  }
  return refs
}

// the decoded segments of a local `$ref` / pointer
const segmentsOf = (ref: string): string[] => parseRef(ref).jsonPath

// `prefix` is a proper prefix of `segments`
const isPrefix = (prefix: string[], segments: string[]): boolean => {
  if (prefix.length >= segments.length) { return false }
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== segments[i]) { return false }
  }
  return true
}

const isCombinaryKey = (key: unknown): key is "oneOf" | "anyOf" => key === "oneOf" || key === "anyOf"

const hasUnevaluated = (item: Record<string, unknown>): boolean => hasOwn(item, "unevaluatedProperties") || hasOwn(item, "unevaluatedItems")

interface SplitNode {
  allOf?: unknown[]              // the allOf array (undefined when absent or not an array)
  sibling: Record<string, any>   // every other key
  hasSibling: boolean
}

interface MemoEntry {
  origin: object                 // the input node whose merge created the entry
  source: unknown                // the document of the call that created the entry
  frame?: Frame                  // the frame that created the entry (its output location, for D-4 re-entries)
  node?: unknown
  done: boolean
  aborted?: boolean              // the run that created the entry was interrupted
}

interface TrieNode {
  next: WeakMap<object, TrieNode>
  entry?: MemoEntry
}

// memo of merge results keyed by the identity tuple of the merged items; weakly keyed, so that entries of items
// that are no longer reachable are collected (VR-24)
class TupleMemo {
  private root: TrieNode = { next: new WeakMap() }

  get(items: object[]): MemoEntry | undefined {
    let node = this.root
    for (const item of items) {
      const next = node.next.get(item)
      if (!next) { return undefined }
      node = next
    }
    return node.entry && !node.entry.aborted ? node.entry : undefined
  }

  set(items: object[], entry: MemoEntry): void {
    let node = this.root
    for (const item of items) {
      let next = node.next.get(item)
      if (!next) {
        next = { next: new WeakMap() }
        node.next.set(item, next)
      }
      node = next
    }
    node.entry = entry
  }
}

// never the clone of a node: popping down to it finishes every frame
const FLUSH = Object.freeze({})

// separates the merged items from the kept (unevaluated*) fragments in a memo key
const FRAGMENT_MARK = Object.freeze({})

// one object node on the current clone path
interface Frame {
  value: object                                 // the input node
  holder: Record<string | number, unknown>      // the output container its clone is written into
  key: string | number
  depth: number                                 // path length of the node
  rewalk: boolean                               // a container cloned again inside its own subtree (cycle)
  noMerge: boolean                              // copied without merging (maxDepth / maxRefExpansion)
  counts?: Map<object, number>                  // $ref targets inlined in this subtree -> times
  sharedCounts?: boolean                        // `counts` is another output's map (copy before writing)
  tainted?: boolean                             // the subtree holds a cycle $ref into the call's source (or into the
                                                // call's output, or a D-22 site: then the output is local to the call)
  at: At                                        // the hook context (its path is the output location of the node)
  rules: unknown                                // the node's rules (the done memo is per rules)
  site?: Site                                   // the node is a $ref replaced by a copy of its target (D-22)
}

// a `$ref` whose pointer runs through a node the merge rewrites, replaced by a copy of the original target during the
// clone pass; after the pass the copy becomes a link again when the merged output holds an equal value (D-22, D-23)
interface Site {
  node: Record<string, any>                     // the input $ref node
  rest: Record<string, any> | null              // its siblings
  rules: MergeRules                             // the node's rules
  path: string                                  // output pointer where the copy was built
  candidates: string[]                          // pointers whose merged value may equal the target: the pointer itself
                                                // and its matching location (allOf member segments removed)
}

interface CallState {
  index: ResolutionIndex
  memo: TupleMemo
  budget: { remaining: number }
  stack: Frame[]
  active: Map<object, Frame>                    // input nodes of the frames (the current path) -> their first frame
  done: WeakMap<object, DoneEntry>              // input node -> finished output per rules (shared, like json-crawl's
                                                // safe clone; the same instance under other rules is merged again)
  outputCounts: WeakMap<object, Map<object, number>>
  finished: WeakSet<object>                     // outputs already finished by the frame that created them
  inlined: Map<object, number>                  // $ref target -> logical inlinings in this call
  expanded: number                              // schema nodes copied in by $ref inlining in this call (expansionBudget)
  reported: Set<unknown>
  rewritten: Set<object>                        // input nodes the merge rewrote: allOf merged, $ref sibling merged,
                                                // oneOf/anyOf sibling distributed (D-17, D-20, D-21)
  ownerRefs: boolean                            // a $ref whose pointer runs through a rewritable node was met or written
  owners: Map<string, object[]>                 // $ref -> the rewritable nodes its pointer runs through (memo)
  wholeDocument: boolean                        // refs resolve against the value being cloned (no other source)
  sites: Map<object, Site>                      // output copy -> its site (D-22)
  siteNodes: Map<object, Site>                  // input $ref node -> its site
  sitePositions: { holder: Record<string | number, unknown>, key: string | number, site: Site }[] // non-object copies
  asyncApi3: boolean                            // AsyncAPI 3.x source: $ref targets that are Multi Format Schema
                                                // Objects are unwrapped or kept (Q2-4)
  shifts: WeakMap<object, Partial<Record<"oneOf" | "anyOf", (number | undefined)[]>>> // output node -> old branch
                                                // index -> new index, for branches dropFalseBranches / dedupeAnyOf
                                                // moved (undefined: removed), D-27
}

// finished outputs of one input node, per rules identity (usually one)
interface DoneEntry {
  rules: unknown
  output: unknown
  more?: { rules: unknown, output: unknown }[]
}

const NOT_DONE: unique symbol = Symbol("not done")

const doneGet = (done: WeakMap<object, DoneEntry>, value: object, rules: unknown): unknown => {
  const entry = done.get(value)
  if (!entry) { return NOT_DONE }
  if (entry.rules === rules) { return entry.output }
  const other = entry.more?.find((item) => item.rules === rules)
  return other ? other.output : NOT_DONE
}

const doneSet = (done: WeakMap<object, DoneEntry>, value: object, rules: unknown, output: unknown) => {
  const entry = done.get(value)
  if (!entry) {
    done.set(value, { rules, output })
  } else if (entry.rules !== rules && !entry.more?.some((item) => item.rules === rules)) {
    (entry.more ??= []).push({ rules, output })
  }
}

interface InlinedTarget {
  target: object
  ref: string
}

interface Collected {
  items: any[]
  broken: string[]
  withoutSibling: number
  fragments: object[]
  targets: InlinedTarget[]
  malformed: unknown[]
  unmergeable: { message: string, ref: string }[] // $refs to schemas in a format that is not JSON Schema (kept, Q2-4)
  limited?: InlinedTarget & { budget: boolean } // a target already inlined maxRefExpansion times, or the expansion
                                                // budget is spent (collecting stopped)
}

type RefOrigin = { $ref: string }

// where a problem is reported: the hook context, whose `path` is read only when a callback needs it
type At = { readonly path: JsonPath }

interface Work {
  item: unknown
  nodeLevel: boolean       // the node's own sibling content (its unevaluated* may be merged)
  chain?: Set<object>      // $ref nodes followed to reach this item (a chain never branches, so it is shared)
  origin?: RefOrigin       // first $ref item of the chain
  via?: string             // the $ref that resolved to this item
  inlined?: boolean        // reached through a $ref: the item's identity keywords are not copied
  inherited?: boolean      // reached through a $ref that is merged (not a reference resolution): the item's
                           // annotations listed by refAnnotations are not copied (#222)
  resolution?: boolean     // a $ref item whose target is read as the item's own content (a D-22 copy, a oneOf/anyOf
                           // branch distributed by mergeCombinarySibling): its target keeps its annotations
}

// identity keywords: only the merged node's own survive; those of $ref-inlined items would duplicate ids/anchors
const IDENTITY_KEYS = ["$id", "id", "$anchor", "$dynamicAnchor", "$schema", "$vocabulary"]

const isIdentityKey = (item: Record<string, unknown>, key: string): boolean =>
  IDENTITY_KEYS.includes(key) && (key !== "id" || typeof item.id === "string")

// deep-freezes a value once per instance (shared instances and already frozen subtrees are skipped)
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) { return value }
  const stack: object[] = [value as unknown as object]
  while (stack.length) {
    const node = stack.pop() as Record<string, unknown>
    if (Object.isFrozen(node)) { continue }
    Object.freeze(node)
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (typeof child === "object" && child !== null && !Object.isFrozen(child)) { stack.push(child) }
    }
  }
  return value
}

/**
 * Creates a reusable merger: the resolution index (per `source` instance), the merge memo (per rules, per source and
 * per item-identity tuple) and the sibling-spread cache live for the lifetime of the merger, so repeated `merge` calls
 * on the same document (or the same `hook` used with several `syncClone` calls) share the work and the merged instances.
 *
 * Output contract: the result never contains cyclic JavaScript references. Every cycle re-entry (an object that is
 * being cloned higher up the path, or a conjunction that is being merged higher up the path) is written as
 * `{ $ref: "#<pointer>" }` to the location of the originating node in `source` (the unmerged original, which is
 * semantically equal); when that pointer runs through a node the merge rewrites, a whole-document merge points to the
 * output location of the re-entered node instead (D-22); when the node is not part of `source` the conjunction is
 * kept as `allOf` (D-4, D-4b). Links stay links (D-22, D-23): in a whole-document merge, a `$ref` whose pointer runs
 * through a node the merge rewrites is rewritten to the matching merged location when the value there equals the
 * original target, and replaced by a copy of the target otherwise (see `relink`).
 * With `syncClone` and the raw `hook`, pass `{ unsafe: true }` (as `merge` does) so that json-crawl's own identity memo
 * does not reintroduce shared cyclic instances.
 */
export const createMerger = (options: MergeOptions = {}): Merger => {
  const { mergeRefSibling, mergeCombinarySibling: mergeCombinary, onMergeError, onRefResolveError } = options
  const settings = resolveMergeSettings(options)
  const notEmpty = settings.unsatisfiable === "not-empty"

  const unsatisfiable = (): unknown => notEmpty ? { not: {} } : false
  const isUnsatisfiable = (value: unknown): boolean => {
    return value === false || (notEmpty && isPlainObject(value) && Object.keys(value).length === 1 && isEmptyObject(value.not))
  }

  const indexes = new WeakMap<object, ResolutionIndex>()
  // rules -> memo (VR-33: a memo never answers for other rules). Merged conjunctions are shared across documents
  // (D-11), except outputs holding a cycle `$ref` into their own document (`tainted`)
  let memos = new WeakMap<object, TupleMemo>()
  const tainted = new WeakSet<object>()
  // outputs holding a pointer into their own call's output (a cycle re-entry to an output location, a D-22 site):
  // never reused by another call
  const localOwner = new WeakMap<object, CallState>()
  // $ref nodes the merge emitted that are valid by construction (rule 3 / D-17 does not look at them)
  const ownRefs = new WeakSet<object>()

  // a finished output (memo entry, container cache) may be written into the current call's output
  const reusable = (c: CallState, output: unknown, source: unknown): boolean => {
    if (typeof output !== "object" || output === null || !tainted.has(output)) { return true }
    const owner = localOwner.get(output)
    return owner ? owner === c : source === c.index.source
  }
  // finished output of a `properties`-like container, per input container (for copies made by the groups)
  let containerOutput = new WeakMap<object, { output: object, source: unknown, rules: unknown }>()
  // whole-document merge (D-17): rewritable nodes kept unmerged because a $ref of the output points through them
  let keepUnmerged: Set<object> | undefined
  const splitCache = new WeakMap<object, SplitNode>()
  const refRestCache = new WeakMap<object, Record<string, any> | null>()
  const inProgress = new Set<MemoEntry>()
  // $ref-inlined item -> its copy without identity keywords (stable, so memo keys stay stable), and back
  const identityFree = new WeakMap<object, Record<string, any>>()
  const identityOrigin = new WeakMap<object, object>()

  // refAnnotations (#222): $ref-inlined item -> its copy without identity keywords and without the inherited
  // annotations (stable, like identityFree)
  const dropInherited = inheritedKeyFilter(options.refAnnotations)
  const inheritedFree = new WeakMap<object, Record<string, any>>()
  // allOf nodes made by distributing oneOf/anyOf siblings -> the branch they hold (its $ref target keeps its annotations)
  const distributedBranch = new WeakMap<object, unknown>()

  const withoutInherited = (item: Record<string, any>): Record<string, any> => {
    if (!dropInherited) { return withoutIdentity(item) }
    let cached = inheritedFree.get(item)
    if (cached) { return cached }
    const keys = Object.keys(item)
    if (!keys.some((key) => isIdentityKey(item, key) || dropInherited(key))) { return item }
    cached = {}
    for (const key of keys) {
      if (!isIdentityKey(item, key) && !dropInherited(key)) { safeSet(cached, key, item[key]) }
    }
    inheritedFree.set(item, cached)
    identityOrigin.set(cached, item)
    return cached
  }

  const withoutIdentity = (item: Record<string, any>): Record<string, any> => {
    let cached = identityFree.get(item)
    if (cached) { return cached }
    const keys = Object.keys(item)
    if (!keys.some((key) => isIdentityKey(item, key))) { return item }
    cached = {}
    for (const key of keys) {
      if (!isIdentityKey(item, key)) { safeSet(cached, key, item[key]) }
    }
    identityFree.set(item, cached)
    identityOrigin.set(cached, item)
    return cached
  }

  // number of object / array nodes of an input subtree: what one inlining of it copies at most (expansionBudget).
  // Iterative, cycle safe, memoized per target, counting stops just above the budget
  const weights = new WeakMap<object, number>()
  const weightOf = (target: object): number => {
    let weight = weights.get(target)
    if (weight !== undefined) { return weight }
    weight = 0
    const seen = new Set<object>()
    const stack: object[] = [target]
    while (stack.length && weight <= settings.expansionBudget) {
      const node = stack.pop() as Record<string, unknown>
      if (seen.has(node)) { continue }
      seen.add(node)
      weight++
      for (const key of Object.keys(node)) {
        const child = node[key]
        if (typeof child === "object" && child !== null) { stack.push(child) }
      }
    }
    weights.set(target, weight)
    return weight
  }

  const reportBudget = (c: CallState, at: At, values: unknown[]) => {
    reportOnce(c, "expansionBudget", ErrorMessage.expansionBudgetExceeded(settings.expansionBudget), at, values)
  }

  // the document refs are resolved against: options.source, a per-call override, or the root of the current clone
  let configuredSource: unknown = options.source
  let hasConfiguredSource = options.source !== undefined

  const indexFor = (document: unknown): ResolutionIndex => {
    if (!isPlainObject(document) && !Array.isArray(document)) { return createResolutionIndex(document) }
    let cached = indexes.get(document)
    if (!cached) {
      cached = createResolutionIndex(document)
      indexes.set(document, cached)
    }
    return cached
  }

  const memoFor = (rules: unknown): TupleMemo => {
    if (typeof rules !== "object" || rules === null) { return new TupleMemo() }
    let memo = memos.get(rules)
    if (!memo) {
      memo = new TupleMemo()
      memos.set(rules, memo)
    }
    return memo
  }

  const abortInProgress = () => {
    for (const entry of inProgress) { entry.aborted = true }
    inProgress.clear()
  }

  const newCall = (index: ResolutionIndex, rules: unknown): CallState => ({
    index,
    memo: memoFor(rules),
    budget: { remaining: settings.branchBudget },
    stack: [],
    active: new Map(),
    done: new WeakMap(),
    outputCounts: new WeakMap(),
    finished: new WeakSet(),
    inlined: new Map(),
    expanded: 0,
    reported: new Set(),
    rewritten: new Set(),
    ownerRefs: false,
    owners: new Map(),
    wholeDocument: false,
    sites: new Map(),
    siteNodes: new Map(),
    sitePositions: [],
    asyncApi3: detectAsyncApiVersion(index.source) === "3.0",
    shifts: new WeakMap(),
  })

  let call: CallState = newCall(createResolutionIndex(undefined), undefined)

  const split = (node: Record<string, any>): SplitNode => {
    let cached = splitCache.get(node)
    if (!cached) {
      const sibling: Record<string, any> = {}
      let hasSibling = false
      for (const key of Object.keys(node)) {
        if (key === "allOf") { continue }
        safeSet(sibling, key, node[key])
        hasSibling = true
      }
      cached = { allOf: Array.isArray(node.allOf) ? node.allOf : undefined, sibling, hasSibling }
      splitCache.set(node, cached)
    }
    return cached
  }

  // sibling content of a $ref node (null when the node is a bare $ref)
  const refRest = (node: Record<string, any>): Record<string, any> | null => {
    let cached = refRestCache.get(node)
    if (cached === undefined) {
      const rest: Record<string, any> = {}
      let hasRest = false
      for (const key of Object.keys(node)) {
        if (key === "$ref") { continue }
        safeSet(rest, key, node[key])
        hasRest = true
      }
      cached = hasRest ? rest : null
      refRestCache.set(node, cached)
    }
    return cached
  }

  // resolves a $ref and follows ref -> ref chains (cycle safe)
  const resolveChain = (index: ResolutionIndex, $ref: string): ResolveResult => {
    const visited = new Set<string>()
    let ref = $ref
    for (;;) {
      if (visited.has(ref)) { return { ok: false, reason: "cycle" } }
      visited.add(ref)
      const resolved = index.resolve(ref)
      if (!resolved.ok || !isRefNode(resolved.target)) { return resolved }
      ref = resolved.target.$ref
    }
  }

  const reportOnce = (c: CallState, token: unknown, message: string, at: At, values: unknown[]) => {
    if (c.reported.has(token)) { return }
    c.reported.add(token)
    onMergeError?.(message, at.path, values)
  }

  // adds `counts` to a frame; the map is shared until the frame has to change it (copy on write)
  const addCounts = (frame: Frame | undefined, counts: Map<object, number>) => {
    if (!frame) { return }
    if (!frame.counts) {
      frame.counts = counts
      frame.sharedCounts = true
      return
    }
    if (frame.sharedCounts) {
      frame.counts = new Map(frame.counts)
      frame.sharedCounts = false
    }
    for (const [target, count] of counts) {
      frame.counts.set(target, (frame.counts.get(target) ?? 0) + count)
    }
  }

  // a finished output is about to be written again (shared): its inlined $ref targets count again (VR-03);
  // returns false when a target would exceed maxRefExpansion (the caller then does not share)
  const share = (c: CallState, output: unknown, frame: Frame | undefined, at: At): boolean => {
    if (typeof output !== "object" || output === null) { return true }
    if (frame && tainted.has(output)) { frame.tainted = true }
    const counts = c.outputCounts.get(output)
    if (!counts) { return true }
    let weight = 0
    for (const [target, count] of counts) {
      if ((c.inlined.get(target) ?? 0) + count > settings.maxRefExpansion) {
        const pointer = c.index.pointerOf(target)
        reportOnce(c, target, ErrorMessage.refExpansionExceeded(pointer === undefined ? "(inline)" : `#${pointer}`, settings.maxRefExpansion), at, [target])
        return false
      }
      weight += count * weightOf(target)
    }
    if (c.expanded + weight > settings.expansionBudget) {
      reportBudget(c, at, [])
      return false
    }
    c.expanded += weight
    for (const [target, count] of counts) {
      c.inlined.set(target, (c.inlined.get(target) ?? 0) + count)
    }
    addCounts(frame, counts)
    return true
  }

  // pops the frames of finished nodes: the parent of the visited node is the frame whose clone is `container`
  // (the state.node json-crawl hands to the children); no path is read (json-crawl builds deep paths lazily, VR-04)
  const popFrames = (c: CallState, container: unknown) => {
    const { stack } = c
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top.holder[top.key] === container) { break }
      const frame = stack.pop() as Frame
      if (!frame.rewalk) { c.active.delete(frame.value) }
      const output = frame.holder[frame.key]
      if (!frame.rewalk && !frame.noMerge) { doneSet(c.done, frame.value, frame.rules, output) }
      // the inlining counts belong to the output instance the frame created; a frame that wrote an already finished
      // (shared) instance must not replace that instance's counts, or every reuse would count the chain again
      const owned = typeof output === "object" && output !== null && !c.finished.has(output)
      if (owned) { c.finished.add(output as object) }
      if (frame.counts) {
        if (owned) { c.outputCounts.set(output as object, frame.counts) }
        addCounts(stack[stack.length - 1], frame.counts)
      }
      if (frame.site && !c.siteNodes.has(frame.value)) {
        // the copy that replaced a D-22 $ref (a $ref left in place — broken, limited, a cycle — is not a copy)
        c.siteNodes.set(frame.value, frame.site)
        if (typeof output === "object" && output !== null) {
          if (!hasOwn(output, "$ref") && !c.sites.has(output)) { c.sites.set(output, frame.site) }
        } else if (output !== undefined) {
          c.sitePositions.push({ holder: frame.holder, key: frame.key, site: frame.site })
        }
      }
      if (frame.tainted) {
        if (typeof output === "object" && output !== null) {
          tainted.add(output)
          if (c.wholeDocument) { localOwner.set(output, c) }
        }
        const parent = stack[stack.length - 1]
        if (parent) { parent.tainted = true }
      }
    }
  }

  // a node whose shape the merge rewrites (its members then no longer mean what they meant in the input): an own
  // allOf, a $ref with siblings under mergeRefSibling, a oneOf/anyOf with distributable siblings under
  // mergeCombinarySibling. Decided from the input alone, before the node is visited
  const isDistributable = (node: Record<string, any>): boolean => !!mergeCombinary && (isAnyOfNode(node) || isOneOfNode(node)) &&
    Object.keys(node).some((key) => !isCombinaryKey(key) && !CONTAINER_SIBLINGS.includes(key))
  // a node with oneOf / anyOf branches that dropFalseBranches / dedupeAnyOf may remove (branch indexes shift, or the
  // node becomes a contradiction)
  const isPrunable = (node: Record<string, any>): boolean =>
    (settings.dropFalseBranches && Array.isArray(node.oneOf) && node.oneOf.length > 0 && hasOwn(node, "oneOf")) ||
    ((settings.dropFalseBranches || settings.dedupeAnyOf) && Array.isArray(node.anyOf) && node.anyOf.length > 0 && hasOwn(node, "anyOf"))
  const isRewritable = (node: Record<string, any>): boolean => {
    if (Array.isArray(node.allOf) && hasOwn(node, "allOf")) { return true }
    if (mergeRefSibling && isRefNode(node) && refRest(node)) { return true }
    return isDistributable(node) || isPrunable(node)
  }

  // the rewritable nodes a local $ref pointer runs through (`#/definitions/A/properties/x` -> A when A has an allOf;
  // `#/definitions/A/allOf/0` -> A), walked in the call's source like the resolution index does (intermediate $refs
  // are followed). The target itself is not "run through", nor are container members (UNAFFECTED_MEMBERS). Empty
  // for external refs, anchors and pointers that do not resolve (memoized per call)
  const ownersOf = (c: CallState, ref: string): object[] => {
    let owners = c.owners.get(ref)
    if (owners) { return owners }
    owners = []
    const { filePath, pointer, jsonPath } = parseRef(ref)
    if (!filePath && jsonPath.length && !isAnchorPointer(pointer)) {
      let value: unknown = c.index.source
      const followed = new Set<object>()
      let i = 0
      while (i < jsonPath.length) {
        const segment = jsonPath[i]
        if (Array.isArray(value)) {
          const at = Number(segment)
          if (segment === "" || !Number.isInteger(at) || at < 0 || at >= value.length) { break }
          value = value[at]
          i++
          continue
        }
        if (!isPlainObject(value)) { break }
        if (!UNAFFECTED_MEMBERS.has(segment) && isRewritable(value) && !owners.includes(value)) { owners.push(value) }
        if (hasOwn(value, segment)) {
          value = value[segment]
          i++
          continue
        }
        // intermediate $ref: the remaining segments apply to its target
        if (!isRefNode(value) || followed.has(value)) { break }
        followed.add(value)
        const resolved = c.index.resolve(value.$ref)
        if (!resolved.ok) { break }
        value = resolved.target
      }
      // a pointer that does not resolve is a broken ref: nothing runs through
      if (i < jsonPath.length) { owners = [] }
    }
    if (c.owners.size > 10_000) { c.owners.clear() }
    c.owners.set(ref, owners)
    return owners
  }

  // pointer to the output location of `frame` (whole-document merge: the merged value written there means what the
  // input node of the frame means, so a pointer to it is valid and keeps its meaning by construction)
  const outputRef = (frame: Frame): Record<string, string> => {
    const ref = { $ref: `#${buildPointer(frame.at.path)}` }
    ownRefs.add(ref)
    return ref
  }

  // the placeholder written where an object being cloned higher up the path is met again: a $ref to the source location
  // of the node (D-4b); when that pointer runs through a node the merge rewrites (it would dangle or mean the merged
  // value), a whole-document merge points to the output location of the frame being re-entered instead (D-22)
  const cycleRef = (c: CallState, node: object, at: At): unknown => {
    const pointer = c.index.pointerOf(node)
    const frame = c.active.get(node)
    if (pointer !== undefined) {
      const ref = `#${pointer}`
      if (!ownersOf(c, ref).length) { return { $ref: ref } }
      if (c.wholeDocument && frame) { return outputRef(frame) }
      c.ownerRefs = true
      return { $ref: ref }
    }
    onMergeError?.(ErrorMessage.cyclicValue(), at.path, [])
    return {}
  }

  // the location in the merged output that matches a pointer of the input: every `allOf/<i>` step of a node with an
  // own allOf is removed (its members are merged into the node), e.g. `#/A/allOf/1/properties/id` -> `#/A/properties/id`.
  // The pointer is walked in the call's source like ownersOf (intermediate $refs followed); `pointer` is undefined when
  // nothing was removed, `direct` is false when an intermediate $ref was followed
  const matchingRef = (c: CallState, ref: string): { pointer?: string, direct: boolean } => {
    const { jsonPath } = parseRef(ref)
    const out: string[] = []
    let value: unknown = c.index.source
    const followed = new Set<object>()
    let changed = false
    let i = 0
    while (i < jsonPath.length) {
      const segment = jsonPath[i]
      if (Array.isArray(value)) {
        value = value[Number(segment)]
        out.push(segment)
        i++
        continue
      }
      if (!isPlainObject(value)) { return { direct: false } }
      if (segment === "allOf" && Array.isArray(value.allOf) && hasOwn(value, "allOf") && i + 1 < jsonPath.length) {
        value = value.allOf[Number(jsonPath[i + 1])]
        changed = true
        i += 2
        continue
      }
      if (hasOwn(value, segment)) {
        value = value[segment]
        out.push(segment)
        i++
        continue
      }
      if (!isRefNode(value) || followed.has(value)) { return { direct: false } }
      followed.add(value)
      const resolved = c.index.resolve(value.$ref)
      if (!resolved.ok) { return { direct: false } }
      value = resolved.target
    }
    return { pointer: changed ? `#${buildPointer(out)}` : undefined, direct: !followed.size }
  }

  // locations of the merged output that may hold the original target of a D-22 $ref, in order of preference: the
  // pointer itself; its matching location (when reached without intermediate $refs); the matching location of the
  // target's own place in the source (e.g. `#/Pet/allOf/0/properties/id` with `allOf/0: { $ref: Base }` ->
  // `#/Base/properties/id`); the matching location through intermediate $refs
  const linkCandidates = (c: CallState, ref: string, target: unknown): string[] => {
    const candidates = [ref]
    const add = (candidate: string | undefined) => { if (candidate && !candidates.includes(candidate)) { candidates.push(candidate) } }
    const matching = matchingRef(c, ref)
    if (matching.direct) { add(matching.pointer) }
    const at = typeof target === "object" && target !== null ? c.index.pointerOf(target) : undefined
    if (at !== undefined) {
      const own = `#${at}`
      add(matchingRef(c, own).pointer ?? own)
    }
    add(matching.pointer)
    return candidates
  }

  // a contradiction keeps the node's container siblings (definitions, $defs, $id, …) that refs may point into
  const contradiction = (sibling: Record<string, any> | undefined): unknown => {
    if (!sibling) { return unsatisfiable() }
    let result: Record<string, any> | undefined
    for (const key of CONTAINER_SIBLINGS) {
      if (!hasOwn(sibling, key) || (key === "id" && typeof sibling.id !== "string")) { continue }
      result ??= { allOf: [unsatisfiable()] }
      safeSet(result, key, sibling[key])
    }
    return result ?? unsatisfiable()
  }

  // the simplifications of a merged node, run when its subtree is finished (the children are final): impossible
  // oneOf/anyOf branches removed (dropFalseBranches), identical anyOf branches once (dedupeAnyOf), the opt-in
  // `simplify` rules. A node that turns out to be a contradiction is written as one (D-10 container siblings kept).
  // `report` is the node's contradiction report (silent inside a oneOf/anyOf branch)
  const simplifyMerged = (c: CallState, frame: Frame, holder: Record<string | number, unknown>, key: string | number, rules: MergeRules, report?: (values: unknown[]) => void, merged = true) => {
    const out = holder[key]
    if (!isPlainObject(out)) { return }
    if (!merged && keepUnmerged?.has(frame.value)) { return }
    // the children's outputs are recorded (done memo, taint) before the node is rewritten
    popFrames(c, out)
    let conflict: unknown[] | undefined
    for (const combinaryKey of ["oneOf", "anyOf"] as const) {
      const branches = out[combinaryKey]
      if (!Array.isArray(branches) || !branches.length || !hasOwn(out, combinaryKey) || !(rules as Record<string, unknown>)[`/${combinaryKey}`]) { continue }
      let next: unknown[] = branches
      if (settings.dropFalseBranches) { next = next.filter((branch) => !isUnsatisfiable(branch)) }
      // A ∨ A ≡ A (never for oneOf: oneOf [A, A, B] ≡ ¬A ∧ B)
      if (combinaryKey === "anyOf" && settings.dedupeAnyOf) { next = dedupeValues(next) }
      if (next.length === branches.length) { continue }
      if (!next.length) {
        // every branch impossible: the node is a contradiction (already reported by the branch array when the merge
        // made the branches impossible)
        conflict = []
        break
      }
      // a branch holding a pointer target of this call's output (a cycle re-entry, a D-22 copy) keeps its index
      let first = 0
      while (branches[first] === next[first]) { first++ }
      if (branches.slice(first).some((branch) => typeof branch === "object" && branch !== null && tainted.has(branch))) { continue }
      // where every branch went (D-27): a kept branch to its new index, a duplicate anyOf branch to the equal one kept
      const moved = branches.map((branch) => {
        const at = next.indexOf(branch)
        if (at >= 0 || isUnsatisfiable(branch)) { return at >= 0 ? at : undefined }
        const equal = next.findIndex((kept) => deepEqual(kept, branch))
        return equal >= 0 ? equal : undefined
      })
      const shifts = c.shifts.get(out) ?? {}
      shifts[combinaryKey] = moved
      c.shifts.set(out, shifts)
      safeSet(out, combinaryKey, next)
      c.rewritten.add(frame.value)
    }
    if (conflict) { c.rewritten.add(frame.value) }
    if (!conflict && merged && settings.simplify) {
      conflict = simplifySchema(out, rules as Record<string, any>, settings.simplify, isUnsatisfiable)
      if (conflict) { report?.(conflict) }
    }
    // a contradiction replaces the node's subtree: not when that subtree holds pointer targets of the call's output
    if (conflict && !frame.tainted) { safeSet(holder, key, contradiction(out)) }
  }

  // a node that is not merged: only its impossible / duplicate oneOf/anyOf branches are removed (when it has any)
  const pruneOnly = (c: CallState, frame: Frame, node: Record<string, any>, holder: Record<string | number, unknown>, key: string | number, rules: MergeRules) => {
    if (!isPrunable(node) || keepUnmerged?.has(node)) { return undefined }
    return { exitHook: () => simplifyMerged(c, frame, holder, key, rules, undefined, false) }
  }

  // combinations a oneOf/anyOf sibling distribution creates: branches × the combinary members in the pushed-down rest
  const distributionCost = (node: Record<string, any>, combinaryKey: "anyOf" | "oneOf", rule: MergeRule): number => {
    const siblingKeys = rule.sibling ?? []
    let members = 0
    for (const key of Object.keys(node)) {
      if (key === combinaryKey || siblingKeys.includes(key) || !isCombinaryKey(key)) { continue }
      if (Array.isArray(node[key])) { members += node[key].length }
    }
    return members ? node[combinaryKey].length * members : 0
  }

  const distribute = (c: CallState, node: Record<string, any>, combinaryKey: "anyOf" | "oneOf", rule: MergeRule, at: At): unknown => {
    const cost = distributionCost(node, combinaryKey, rule)
    if (cost) {
      if (cost > c.budget.remaining) {
        onMergeError?.(ErrorMessage.branchBudgetExceeded(cost, settings.branchBudget), at.path, [node[combinaryKey]])
        return node
      }
      c.budget.remaining -= cost
    }
    const result = mergeCombinarySibling(node as any, combinaryKey, rule)
    if (dropInherited && result !== node) {
      // the branch keeps the annotations of its $ref target (doc viewers label branches by them, #222)
      for (const branch of (result as Record<string, any>)[combinaryKey] as { allOf: unknown[] }[]) {
        distributedBranch.set(branch, branch.allOf[branch.allOf.length - 1])
      }
    }
    return result
  }

  // expands the allOf items of `node`: $ref items are replaced from the index, nested allOf is flattened,
  // `true` and empty schemas are dropped, `false` is kept, duplicates and the node itself are skipped.
  // Iterative (VR-06). Items carrying their own unevaluated* are kept whole as fragments (D-8, VR-12).
  // `ownItem`: an item whose $ref target is read as the node's own content (true: every item, a D-22 copy; an object:
  // that item, the branch of a distributed oneOf/anyOf), whose annotations refAnnotations keeps
  const collectItems = (c: CallState, items: unknown[], node: object, sibling?: Record<string, any>, ownItem?: unknown): Collected => {
    const seen = new Set<object>([node])
    const out: any[] = []
    const broken: string[] = []
    const fragments: object[] = []
    const targets: InlinedTarget[] = []
    const malformed: unknown[] = []
    const unmergeable: Collected["unmergeable"] = []
    const work: Work[] = []
    let limited: Collected["limited"]

    // weight of the targets collected so far (committed only when the node is merged)
    let pending = 0
    // a $ref target is inlined once more; stops collecting when it is already inlined maxRefExpansion times or the
    // call's expansion budget would be exceeded (D-7)
    const inline = (target: object, ref: string): boolean => {
      const overTarget = (c.inlined.get(target) ?? 0) + 1 > settings.maxRefExpansion
      const weight = overTarget ? 0 : weightOf(target)
      if (overTarget || c.expanded + pending + weight > settings.expansionBudget) {
        limited = { target, ref, budget: !overTarget }
        work.length = 0
        return false
      }
      pending += weight
      targets.push({ target, ref })
      return true
    }

    const run = () => {
      while (work.length) {
        const { item, nodeLevel, chain, origin, via, inlined, inherited, resolution } = work.pop() as Work
        if (item === false) {
          out.push(false)
          continue
        }
        if (!isPlainObject(item)) {
          if (item !== true && item !== undefined) { malformed.push(item) }
          continue
        }
        if (seen.has(item)) { continue }
        seen.add(item)

        if (!nodeLevel && hasUnevaluated(item)) {
          fragments.push(origin ? { $ref: origin.$ref } : item)
          continue
        }

        if (hasOwn(item, "$ref") && !isRefNode(item)) {
          // an empty or non-string $ref cannot be resolved: a broken ref, the node is kept (VR-42)
          broken.push(typeof item.$ref === "string" ? item.$ref : String(item.$ref))
          out.push(origin ?? item)
          continue
        }

        if (isRefNode(item)) {
          const resolved = c.index.resolve(item.$ref)
          let target = resolved.ok ? resolved.target : undefined
          // a ref -> ref chain that comes back to one of its own refs is a cycle (VR-40)
          if (!resolved.ok || target === item || (isRefNode(target) && chain?.has(target))) {
            broken.push(item.$ref)
            out.push(origin ?? item)
            continue
          }
          if (c.asyncApi3) {
            // AsyncAPI 3.x Multi Format Schema Object: the inner schema of an AsyncAPI / JSON Schema format is inlined,
            // any other format keeps the $ref as an allOf fragment and is reported (Q2-4)
            const unwrapped = unwrapSchemaFormat(target)
            if (!unwrapped.ok) {
              // the same wrapper reached twice is kept and reported once
              if (seen.has(target as object)) { continue }
              seen.add(target as object)
              fragments.push({ $ref: (origin ?? item).$ref })
              unmergeable.push({ message: unwrapped.message, ref: (origin ?? item).$ref })
              const rest = refRest(item)
              if (rest) { work.push({ item: rest, nodeLevel, inlined, inherited }) }
              continue
            }
            target = unwrapped.schema
          }
          const rest = refRest(item)
          if (rest) { work.push({ item: rest, nodeLevel, inlined, inherited }) }
          const followed = chain ?? new Set<object>()
          followed.add(item)
          work.push({ item: target, nodeLevel: false, chain: followed, origin: origin ?? (item as RefOrigin), via: item.$ref, inlined: true, inherited: resolution ? inherited : true, resolution })
          continue
        }

        if (hasOwn(item, "allOf")) {
          if (via && !inline(item, via)) { break }
          const parts = split(item)
          if (!parts.allOf) { malformed.push(item.allOf) }
          if (parts.hasSibling) { work.push({ item: parts.sibling, nodeLevel, inlined, inherited }) }
          if (parts.allOf) {
            // the components of a oneOf/anyOf product branch are branches themselves: a $ref component keeps its target's
            // annotations (D-26)
            const components = productBranches.has(item) || undefined
            for (let i = parts.allOf.length - 1; i >= 0; i--) { work.push({ item: parts.allOf[i], nodeLevel: false, inlined, inherited, resolution: components }) }
          }
          continue
        }

        let empty = true
        for (const _key in item) {
          empty = false
          break
        }
        if (empty || (via && !inline(item, via))) { continue }
        out.push(inherited ? withoutInherited(item) : inlined ? withoutIdentity(item) : item)
      }
    }

    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      work.push({ item, nodeLevel: false, resolution: ownItem === true || (ownItem !== undefined && ownItem === item) })
    }
    run()
    const withoutSibling = out.length
    // the sibling content is one more item (a $ref sibling is resolved like any other item)
    if (sibling && !limited) {
      work.push({ item: sibling, nodeLevel: true })
      run()
    }
    return { items: out, broken, withoutSibling, fragments, targets, malformed, unmergeable, limited }
  }

  const commitTargets = (c: CallState, frame: Frame, targets: InlinedTarget[]) => {
    if (!targets.length) { return }
    if (!frame.counts || frame.sharedCounts) {
      frame.counts = new Map(frame.counts ?? [])
      frame.sharedCounts = false
    }
    for (const { target } of targets) {
      c.expanded += weightOf(target)
      c.inlined.set(target, (c.inlined.get(target) ?? 0) + 1)
      frame.counts.set(target, (frame.counts.get(target) ?? 0) + 1)
    }
  }

  const visit: SyncCloneHook<{}> = (ctx) => {
    const { value, key, rules, state } = ctx
    if (key === undefined) {
      // a new clone run starts: finish the previous run (raw hook usage), pick the resolution index and forget memo
      // entries left by an interrupted run
      if (!inProgress.size) { popFrames(call, FLUSH) }
      abortInProgress()
      call = newCall(indexFor(hasConfiguredSource ? configuredSource : value), rules)
      call.wholeDocument = !hasConfiguredSource || configuredSource === value
    }
    const c = call
    if (c.stack.length) { popFrames(c, state.node) }

    if (typeof value !== "object" || value === null) { return }

    const nodeKey = cloneKey(key)
    const parent = c.stack.length ? c.stack[c.stack.length - 1] : undefined
    const depth = parent ? parent.depth + 1 : 0
    let rewalk = false
    let forceNoMerge = false

    if (c.active.has(value)) {
      // cycle re-entry (D-4b): a schema becomes a $ref to its source location; a container (properties map, …) is
      // cloned again, its members then meet the cycle themselves
      if (Array.isArray(value) || !rules || isAllOfMergeRule(rules)) {
        if (parent) { parent.tainted = true }
        safeSet(state.node, nodeKey, cycleRef(c, value, ctx))
        return { done: true }
      }
      rewalk = true
    } else if (doneGet(c.done, value, rules) !== NOT_DONE) {
      const output = doneGet(c.done, value, rules)
      if (share(c, output, parent, ctx)) {
        safeSet(state.node, nodeKey, output)
        // the same $ref node met again: another position of its (non-object) copy
        const site = c.siteNodes.get(value)
        if (site && (typeof output !== "object" || output === null)) { c.sitePositions.push({ holder: state.node, key: nodeKey, site }) }
        return { done: true }
      }
      forceNoMerge = true
    }

    const tooDeep = depth > settings.maxDepth
    if (tooDeep && !parent?.noMerge) {
      reportOnce(c, "maxDepth", ErrorMessage.maxDepthExceeded(settings.maxDepth), ctx, [])
    }
    const frame: Frame = { value, holder: state.node, key: nodeKey, depth, rewalk, noMerge: forceNoMerge || tooDeep || !!parent?.noMerge, at: ctx, rules }
    c.stack.push(frame)
    if (!rewalk) { c.active.set(value, frame) }

    // a $ref of the output whose pointer runs through a rewritable node (also one copied without merging): checked
    // after the clone pass of a whole-document merge (D-17)
    if (!Array.isArray(value) && isRefNode(value) && ownersOf(c, value.$ref).length) { c.ownerRefs = true }

    if (frame.noMerge) { return }

    if (Array.isArray(value)) {
      // every branch made unsatisfiable by merging: the combinary itself is a contradiction worth reporting;
      // a combinary that was already unsatisfiable in the input is not (VR-41)
      if (value.length && isCombinaryKey(key) && rules && !value.every(isUnsatisfiable)) {
        return {
          exitHook: () => {
            const branches = state.node[key]
            if (Array.isArray(branches) && branches.length && branches.every(isUnsatisfiable)) {
              onMergeError?.(ErrorMessage.mergeError(), ctx.path, value)
            }
          }
        }
      }
      return
    }

    const node = value as Record<string, any>

    if (!isAllOfMergeRule(rules)) {
      if (isContainerKey(key) && rules) {
        const origin = containerOrigin.get(node)
        if (origin) {
          // a copy of a container whose original (or an earlier copy) is already cloned: the members are the same
          // instances, so their outputs are reused and the re-walk is skipped
          const cached = containerOutput.get(origin)
          // an output holding a cycle $ref into another document is not reused for this one
          const output = cached && cached.rules === rules && reusable(c, cached.output, cached.source) ? cached.output : undefined
          if (output && share(c, output, frame, ctx)) {
            safeSet(state.node, nodeKey, safeClone(output))
            return { done: true }
          }
          return { exitHook: () => { if (!output) { containerOutput.set(origin, { output: state.node[key] as object, source: c.index.source, rules }) } } }
        }
        // remember the finished output of an original container
        return { exitHook: () => { containerOutput.set(node, { output: state.node[key] as object, source: c.index.source, rules }) } }
      }
      return
    }

    let items: unknown[]
    let sibling: Record<string, any> | undefined
    let ownItem: unknown

    if (hasOwn(node, "allOf")) {
      // D-17: a $ref of the output points through this allOf, the node is kept unmerged (its members are merged)
      if (keepUnmerged?.has(node)) { return }
      c.rewritten.add(node)
      const parts = split(node)
      if (!parts.allOf) {
        // allOf of a wrong type is ignored and reported (D-6); the rest of the node is kept
        onMergeError?.(ErrorMessage.malformedValue("allOf"), ctx.path, [node.allOf])
        return { value: parts.sibling }
      }
      items = parts.allOf
      sibling = parts.hasSibling ? parts.sibling : undefined
      // a oneOf/anyOf product branch: every component is a branch whose $ref target keeps its annotations (D-26);
      // a branch distributed by mergeCombinarySibling: that branch
      ownItem = productBranches.has(node) || distributedBranch.get(node)
    } else if (c.wholeDocument && isRefNode(node) && !(mergeRefSibling && refRest(node)) && ownersOf(c, node.$ref).length) {
      // D-22 / D-23: a $ref whose pointer runs through a node the merge rewrites would dangle (through an allOf member,
      // into a member a contradiction drops) or silently mean the merged, stricter value (a sibling member of a merged
      // node). During the pass it is replaced by a copy of the ORIGINAL target, inlined like a one-item allOf and merged
      // in its own right (its own allOf merged, cycles follow D-4/D-4b, limits apply); after the pass (relink) the copy
      // becomes a link to the matching merged location again when the value there is equal. A broken or external ref
      // and a non-schema target are left as they are
      const owners = ownersOf(c, node.$ref)
      const resolved = resolveChain(c.index, node.$ref)
      if (!resolved.ok || !(isPlainObject(resolved.target) || typeof resolved.target === "boolean")) { return }
      // ... unless every rewritable node on the way is kept unmerged (D-17): then the pointer keeps its meaning
      if (keepUnmerged && owners.every((owner) => keepUnmerged!.has(owner))) { return }
      const rest = refRest(node)
      frame.site = { node, rest, rules, path: buildPointer(ctx.path), candidates: linkCandidates(c, node.$ref, resolved.target) }
      // the copy and everything around it is specific to this call's output (relink rewrites it in place)
      frame.tainted = true
      items = [{ $ref: node.$ref }]
      sibling = undefined
      // a reference resolution, not a merge: the target keeps its annotations (refAnnotations, #222)
      ownItem = true
      // the siblings apply next to the reference in every draft (D-24, author intent; draft-04/06/07 and OpenAPI 3.0
      // validators would ignore them): the copy is the conjunction of the target and the siblings
      if (rest) { sibling = rest }
      const target = resolved.target
      if (!sibling && isPlainObject(target) && hasUnevaluated(target)) {
        // a target with its own unevaluated* would stay a `{ $ref }` fragment as an allOf item: the copy is the target
        // itself, merged as the node (exact: nothing else is conjoined with it)
        const ref = node.$ref
        if ((c.inlined.get(target) ?? 0) + 1 > settings.maxRefExpansion) {
          reportOnce(c, target, ErrorMessage.refExpansionExceeded(ref, settings.maxRefExpansion), ctx, [ref])
          return
        }
        if (c.expanded + weightOf(target) > settings.expansionBudget) {
          reportBudget(c, ctx, [ref])
          return
        }
        commitTargets(c, frame, [{ target, ref }])
        items = []
        sibling = withoutIdentity(target)
      }
    } else if (mergeRefSibling && isRefNode(node)) {
      const rest = refRest(node)
      if (!rest || keepUnmerged?.has(node)) { return }
      // a broken or external $ref with siblings is left as it is (D-9, VR-35)
      const resolved = resolveChain(c.index, node.$ref)
      if (!resolved.ok) {
        if (resolved.reason !== "external") { onRefResolveError?.(ErrorMessage.refResolveError(), ctx.path, node.$ref) }
        return
      }
      // $ref with sibling content: allOf of the reference and the siblings
      c.rewritten.add(node)
      items = [{ $ref: node.$ref }]
      sibling = rest
    } else if (mergeCombinary) {
      // D-17: a $ref of the output points through this node, its siblings are not distributed
      if (keepUnmerged?.has(node)) { return }
      if (isDistributable(node)) { c.rewritten.add(node) }
      const combinaryKey = isAnyOfNode(node) && rules["/anyOf"] ? "anyOf" : isOneOfNode(node) && rules["/oneOf"] ? "oneOf" : undefined
      if (!combinaryKey) { return pruneOnly(c, frame, node, state.node, nodeKey, rules) }
      const distributed = distribute(c, node, combinaryKey, rules[`/${combinaryKey}`] as MergeRule, ctx)
      if (distributed === node) { return pruneOnly(c, frame, node, state.node, nodeKey, rules) }
      return { value: distributed, exitHook: () => simplifyMerged(c, frame, state.node, nodeKey, rules) }
    } else {
      return pruneOnly(c, frame, node, state.node, nodeKey, rules)
    }

    const collected = collectItems(c, items, node, sibling, ownItem)

    if (collected.malformed.length) {
      onMergeError?.(ErrorMessage.malformedValue("allOf item"), ctx.path, collected.malformed)
    }

    // maxRefExpansion: a target inlined too often keeps its $ref items, the node is left as it is (D-7, VR-03)
    if (collected.limited) {
      c.rewritten.delete(node)
      const { target, ref, budget } = collected.limited
      if (budget) {
        reportBudget(c, ctx, [ref])
      } else {
        reportOnce(c, target, ErrorMessage.refExpansionExceeded(ref, settings.maxRefExpansion), ctx, [ref])
      }
      return
    }

    for (const { message, ref } of collected.unmergeable) {
      onMergeError?.(message, ctx.path, [ref])
    }

    if (collected.broken.length) {
      for (const ref of collected.broken) {
        onRefResolveError?.(ErrorMessage.refResolveError(), ctx.path, ref)
      }
      commitTargets(c, frame, collected.targets)
      // the node keeps its structure: siblings stay in place, resolvable items are resolved, broken ones stay `$ref`
      const allOf = [...collected.items.slice(0, collected.withoutSibling), ...collected.fragments]
      const result: Record<string, any> = sibling ? safeClone(sibling) : {}
      safeSet(result, "allOf", allOf)
      return { value: result }
    }

    const schemas = collected.items
    const { fragments } = collected

    if (schemas.includes(false)) { return { value: contradiction(sibling) } }
    if (!schemas.length && !fragments.length) { return { value: {} } }

    if (schemas.length === 1 && !fragments.length) {
      const single = schemas[0]
      const original = identityOrigin.get(single) ?? single
      // the conjunction is one node that is being cloned higher up the path: reference it
      if (c.active.has(original)) {
        frame.tainted = true
        safeSet(state.node, nodeKey, cycleRef(c, original, ctx))
        return { done: true }
      }
      if (doneGet(c.done, single, rules) !== NOT_DONE) {
        let output = doneGet(c.done, single, rules)
        if (!share(c, output, frame, ctx)) { return }
        commitTargets(c, frame, collected.targets)
        // a D-22 copy is its own instance (relink replaces it by identity, never the location it was shared from)
        if (frame.site && typeof output === "object" && output !== null) { output = safeClone(output) }
        safeSet(state.node, nodeKey, output)
        return { done: true }
      }
      commitTargets(c, frame, collected.targets)
      return { value: single }
    }

    const memoKey: object[] = fragments.length ? [...schemas, FRAGMENT_MARK, ...fragments] : schemas
    let entry = c.memo.get(memoKey)
    // an output with a cycle $ref into another document is not reused for this one
    // an output with a cycle $ref into another document (or into another call's output) is not reused here
    if (entry?.done && !reusable(c, entry.node, entry.source)) { entry = undefined }
    if (entry) {
      if (entry.done) {
        if (!share(c, entry.node, frame, ctx)) { return }
        const output = frame.site && typeof entry.node === "object" && entry.node !== null ? safeClone(entry.node) : entry.node
        safeSet(state.node, nodeKey, output)
        return { done: true }
      }
      // the same conjunction is being merged higher up the current path (D-4): reference the source location of the
      // node that started it (the unmerged original, semantically equal); when that pointer runs through a node the
      // merge rewrites, a whole-document merge references the output location of that node's frame (D-22);
      // outside source keep this node's allOf
      const pointer = c.index.pointerOf(entry.origin)
      if (pointer !== undefined && ownersOf(c, `#${pointer}`).length && c.wholeDocument && entry.frame) {
        frame.tainted = true
        safeSet(state.node, nodeKey, outputRef(entry.frame))
        return { done: true }
      }
      if (pointer === undefined) {
        c.rewritten.delete(node)
        return
      }
      frame.tainted = true
      if (ownersOf(c, `#${pointer}`).length) { c.ownerRefs = true }
      return { value: { $ref: `#${pointer}` } }
    }

    commitTargets(c, frame, collected.targets)

    // contradictions inside a oneOf/anyOf branch are legitimate (the branch is just impossible): not reported
    const silent = typeof key === "number" && !!parent && isCombinaryKey(parent.key)
    const report = (values: any[], message?: string) => {
      if (message || !silent) {
        onMergeError?.(message ?? ErrorMessage.mergeError(), ctx.path, values)
      }
    }

    let result: unknown
    if (!schemas.length) {
      const kept = settings.dedupeFragments ? dedupeValues(fragments) : fragments
      result = kept.length === 1 ? kept[0] : { allOf: [...kept] }
    } else {
      const merged = schemas.length === 1
        ? safeClone(schemas[0] as Record<string, any>)
        : intersect(schemas, {
            mergeRules: rules,
            path: ctx.path,
            branchBudget: settings.branchBudget,
            budget: c.budget,
            settings,
            report,
            mergeNested: (values, nestedRules) => createMerger({ ...options, source: c.index.source, freezeOutput: false }).merge({ allOf: values }, { rules: nestedRules }),
          })
      if (merged === UNCHANGED) {
        c.rewritten.delete(node)
        return
      }
      if (merged === false) { return { value: contradiction(sibling) } }
      if (fragments.length) {
        const allOf = Array.isArray(merged.allOf) ? [...merged.allOf, ...fragments] : [...fragments]
        safeSet(merged, "allOf", settings.dedupeFragments ? dedupeValues(allOf) : allOf)
      }
      result = merged
    }

    if (mergeCombinary && isPlainObject(result)) {
      if (isAnyOfNode(result) && rules["/anyOf"]) {
        result = distribute(c, result, "anyOf", rules["/anyOf"] as MergeRule, ctx)
      } else if (isOneOfNode(result) && rules["/oneOf"]) {
        result = distribute(c, result, "oneOf", rules["/oneOf"] as MergeRule, ctx)
      }
    }

    const created: MemoEntry = { origin: node, source: c.index.source, done: false, frame }
    c.memo.set(memoKey, created)
    inProgress.add(created)

    return {
      value: result,
      exitHook: () => {
        simplifyMerged(c, frame, state.node, nodeKey, rules, (values) => report(values))
        created.node = state.node[nodeKey]
        created.done = true
        created.frame = undefined
        inProgress.delete(created)
      }
    }
  }

  // values that are not part of the clone pass (the siblings of a link, a target compared on its own) are merged in
  // fragment mode against the call's source, without reporting (the pass reported them already or they are discarded)
  const fragmentMerge = (c: CallState, value: unknown, rules: MergeRules): unknown => {
    return createMerger({ ...options, source: c.index.source, freezeOutput: false, onMergeError: undefined, onRefResolveError: undefined }).merge(value, { rules })
  }

  // replaces every occurrence of a key of `map` in the output below `holder` (by identity; frozen subtrees are outputs
  // of earlier calls and hold no copy of this call)
  const replaceAll = (holder: Record<string | number, unknown>, map: Map<unknown, unknown>) => {
    const root = holder[JSON_ROOT_KEY]
    if (map.has(root)) {
      safeSet(holder, JSON_ROOT_KEY, map.get(root))
      return
    }
    if (typeof root !== "object" || root === null) { return }
    const seen = new Set<object>()
    const stack: object[] = [root]
    while (stack.length) {
      const node = stack.pop() as Record<string, unknown>
      if (seen.has(node) || Object.isFrozen(node)) { continue }
      seen.add(node)
      for (const key of Object.keys(node)) {
        const child = node[key]
        if (typeof child !== "object" || child === null) { continue }
        if (map.has(child)) {
          safeSet(node, key, map.get(child))
        } else if (!seen.has(child)) {
          stack.push(child)
        }
      }
    }
  }

  /**
   * D-22 / D-23, after the clone pass of a whole-document merge: every copy that replaced a `$ref` (a site) becomes a
   * link again when the merged output holds the same value at the pointer itself or at its matching location (allOf
   * member segments removed). "Same" is structural deep equality (key order ignored, `$ref` strings compared literally)
   * between the output value at that location and the original target merged on its own in this call (the copy; for a
   * `$ref` with siblings, the target merged without them). All decisions are taken on the output as the pass left it;
   * a pointer into a copy that became a link is then rewritten to the same place below the link's target, and a link
   * that does not resolve in the final output is turned back into its copy.
   */
  const relink = (c: CallState, holder: Record<string | number, unknown>) => {
    popFrames(c, FLUSH)
    if (!c.sites.size && !c.sitePositions.length) { return }
    const index = createResolutionIndex(holder[JSON_ROOT_KEY])

    // D-27: a candidate whose path runs through oneOf / anyOf branches that dropFalseBranches / dedupeAnyOf moved, with
    // the new indexes (undefined when nothing moved, or the branch was removed); walked in the output
    const shifted = (candidate: string): string | undefined => {
      const segments = segmentsOf(candidate)
      const out: string[] = []
      let value: unknown = holder[JSON_ROOT_KEY]
      let changed = false
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]
        if (typeof value !== "object" || value === null) { return undefined }
        const moved = isCombinaryKey(segment) && !Array.isArray(value) && i + 1 < segments.length ? c.shifts.get(value)?.[segment] : undefined
        if (moved) {
          const at = Number(segments[i + 1])
          const to = Number.isInteger(at) && at >= 0 ? moved[at] : undefined
          if (to === undefined) { return undefined }
          if (to !== at) { changed = true }
          out.push(segment, String(to))
          value = (value as Record<string, unknown[]>)[segment][to]
          i++
          continue
        }
        if (!hasOwn(value, segment)) { return undefined }
        out.push(segment)
        value = (value as Record<string, unknown>)[segment]
      }
      return changed ? `#${buildPointer(out)}` : undefined
    }

    const decide = (copy: unknown, site: Site): string | undefined => {
      const own = segmentsOf(`#${site.path}`)
      let reference: unknown = copy
      const candidates: string[] = []
      for (const candidate of site.candidates) {
        // the branch the pointer meant, at its new index, before whatever the old index holds now
        const moved = shifted(candidate)
        if (moved && !candidates.includes(moved)) { candidates.push(moved) }
        if (!candidates.includes(candidate)) { candidates.push(candidate) }
      }
      for (const candidate of candidates) {
        const segments = segmentsOf(candidate)
        // never a link to the copy itself or into it
        if ((segments.length === own.length && segments.every((segment, i) => segment === own[i])) || isPrefix(own, segments)) { continue }
        const resolved = index.resolve(candidate)
        if (!resolved.ok || (typeof copy === "object" && resolved.target === copy)) { continue }
        if (site.rest && reference === copy) { reference = fragmentMerge(c, { allOf: [{ $ref: site.node.$ref }] }, site.rules) }
        // `true` merges to `{}` (the same schema)
        if (deepEqual(resolved.target, reference) || (resolved.target === true && isEmptyObject(reference))) { return candidate }
      }
      return undefined
    }

    const linkOf = (site: Site, target: string): Record<string, unknown> => {
      const link: Record<string, unknown> = {}
      if (site.rest) {
        // the siblings as they are (merged in their own right): the same reading as the input $ref
        const rest = fragmentMerge(c, site.rest, site.rules)
        const siblings: Record<string, any> = isPlainObject(rest) ? rest : site.rest
        for (const key of Object.keys(site.node)) {
          if (key === "$ref") {
            safeSet(link, "$ref", target)
          } else if (hasOwn(siblings, key)) {
            safeSet(link, key, siblings[key])
          }
        }
        for (const key of Object.keys(siblings)) {
          if (!hasOwn(link, key)) { safeSet(link, key, siblings[key]) }
        }
      } else {
        safeSet(link, "$ref", target)
      }
      ownRefs.add(link)
      return link
    }

    const links = new Map<unknown, unknown>()     // copy -> link
    const copies = new Map<object, unknown>()     // link -> copy (to turn a link back)
    // pointers below a copy that became a link move below the link's target, except into the link's own siblings
    const converted: { from: string[], to: string[], siblings: Record<string, unknown> }[] = []
    for (const [copy, site] of c.sites) {
      const target = decide(copy, site)
      if (target === undefined) { continue }
      const link = linkOf(site, target)
      links.set(copy, link)
      copies.set(link, copy)
      converted.push({ from: segmentsOf(`#${site.path}`), to: segmentsOf(target), siblings: link })
    }
    for (const { holder: at, key, site } of c.sitePositions) {
      const copy = at[key]
      if (typeof copy === "object" && copy !== null) { continue }
      const target = decide(copy, site)
      if (target === undefined) { continue }
      const link = linkOf(site, target)
      safeSet(at, key, link)
      copies.set(link, copy)
      converted.push({ from: segmentsOf(`#${site.path}`), to: segmentsOf(target), siblings: link })
    }
    if (!copies.size) { return }
    if (links.size) { replaceAll(holder, links) }

    // pointers into a copy that became a link: the same place below the link's target (equal value)
    const root = holder[JSON_ROOT_KEY]
    if (typeof root === "object" && root !== null) {
      const seen = new Set<object>()
      const stack: object[] = [root]
      while (stack.length) {
        const node = stack.pop() as Record<string, unknown>
        if (seen.has(node) || Object.isFrozen(node)) { continue }
        seen.add(node)
        if (!Array.isArray(node) && typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
          let segments = segmentsOf(node.$ref)
          let changed = false
          for (let round = 0; round <= converted.length; round++) {
            const move = converted.find(({ from, siblings }) => isPrefix(from, segments) && !hasOwn(siblings, segments[from.length]))
            if (!move) { break }
            segments = [...move.to, ...segments.slice(move.from.length)]
            changed = true
          }
          if (changed) {
            node.$ref = `#${buildPointer(segments)}`
            ownRefs.add(node)
          }
        }
        for (const key of Object.keys(node)) {
          const child = node[key]
          if (typeof child === "object" && child !== null && !seen.has(child)) { stack.push(child) }
        }
      }
    }

    // a link that does not resolve in the final output (a pathological chain of links) is turned back into its copy
    for (let round = 0; round <= copies.size; round++) {
      const finalIndex = createResolutionIndex(holder[JSON_ROOT_KEY])
      const failed = new Map<unknown, unknown>()
      for (const [link, copy] of copies) {
        if (!finalIndex.resolve((link as Record<string, string>).$ref).ok) { failed.set(link, copy) }
      }
      if (!failed.size) { break }
      for (const link of failed.keys()) { copies.delete(link as object) }
      replaceAll(holder, failed)
    }
  }

  // the raw hook: a whole-document clone relinks its D-22 copies when the root is finished
  const hook: SyncCloneHook<{}> = (ctx) => {
    const response = visit(ctx)
    if (ctx.key !== undefined || !call.wholeDocument) { return response }
    const c = call
    const holder = ctx.state.node as Record<string | number, unknown>
    const finish = () => relink(c, holder)
    if (!response) { return { exitHook: finish } }
    const previous = response.exitHook
    return { ...response, exitHook: previous ? () => { previous(); finish() } : finish }
  }

  const mergeWith = (value: unknown, callOptions?: Pick<MergeOptions, "rules" | "source">): unknown => {
    const rules: MergeRules = callOptions?.rules ?? options.rules ?? selectMergeRules(value)
    const previousSource = configuredSource
    const previousHasSource = hasConfiguredSource
    if (callOptions && "source" in callOptions) {
      configuredSource = callOptions.source
      hasConfiguredSource = callOptions.source !== undefined
    }
    let completed = false
    // whole-document mode: refs are resolved against the merged value itself, so the output must resolve them (D-17)
    const wholeDocument = !hasConfiguredSource || configuredSource === value
    try {
      let result: unknown
      for (;;) {
        // unsafe: the hook keeps its own identity memo (shared outputs) and cycle detection
        result = syncClone(value, hook, { rules, unsafe: true })
        // finish the frames of the last path (done memo, inlining counts, cycle-$ref taint)
        popFrames(call, FLUSH)
        if (!wholeDocument || !call.ownerRefs || !call.rewritten.size) { break }
        // D-17 fallback: a $ref left in the output that D-22 could neither link nor copy (kept by maxRefExpansion /
        // expansionBudget / maxDepth, outside a schema location, inside the siblings of a link) whose pointer runs
        // through a node the merge rewrote would dangle or resolve to the merged value: keep those nodes unmerged and
        // merge again (each round keeps at least one more node, so this terminates)
        const keep = new Set(keepUnmerged ?? [])
        for (const ref of collectLocalRefs(result, ownRefs)) {
          for (const owner of ownersOf(call, ref)) {
            if (call.rewritten.has(owner)) { keep.add(owner) }
          }
        }
        if (keep.size === (keepUnmerged?.size ?? 0)) { break }
        keepUnmerged = keep
        // the memo and the container cache hold outputs merged without the kept nodes
        memos = new WeakMap()
        containerOutput = new WeakMap()
      }
      completed = true
      return options.freezeOutput ? deepFreeze(result) : result
    } finally {
      if (keepUnmerged) {
        // outputs merged with kept nodes are not shared with later calls
        keepUnmerged = undefined
        memos = new WeakMap()
        containerOutput = new WeakMap()
      }
      configuredSource = previousSource
      hasConfiguredSource = previousHasSource
      // an interrupted run (a hook threw) leaves entries without a result: forget them
      if (!completed) { abortInProgress() }
      call.stack.length = 0
      call.active.clear()
    }
  }

  return { merge: mergeWith, hook }
}

// the merger of the exported jsonSchemaMergeResolver (late-bound, see engine.ts)
engine.createMerger = createMerger
