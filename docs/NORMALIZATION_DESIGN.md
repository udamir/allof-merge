# allof-merge 1.0.0 × api-smart-diff 2.0 — normalization and issue reporting design (2026-11-17)

Design only: no source or test file of either repository was changed. Every number and output quoted below comes from probes run against `allof-merge-redesign/src` (ts-node, or an unminified esbuild bundle of `src` for timing and profiling) and against scratch copies of api-smart-diff-redesign (asd). The probe scripts are in `/tmp/amr-norm/` (`inventory.ts`, `inventory2.ts`, `asd-examples.ts`, `asd-b.ts`, `asd-c.ts`, `asd-d.ts`, `f7.ts`, `f10.ts`, `mode1.ts`, `diff-mode1.ts`, `opt-bench.mjs`, `oas-eq.mjs`, `hit.mjs`, `hit2.mjs`, `prof*.mjs`). Prototypes used only to measure feasibility live in `/tmp/amr-norm/src-opt` and `/tmp/amr-norm/amr-copy` (allof-merge fast path and F-10 fix) and `/tmp/amr-norm/asd-proto` (asd anchor fix and merge gate). Finding ids F-n refer to `docs/ASD2_COMPATIBILITY.md`, decision ids D-n to `docs/VERIFICATION.md` §7.

## 1. Requirements (user decisions, 2026-11-17)

| Id | Topic | Decision (verbatim) | What it requires |
|---|---|---|---|
| A | OpenAPI 3.0 `nullable` through `allOf` | "Asd should not normalize json, provided object should be normalized by allof merge" | asd stops choosing JSON Schema merge rules for OpenAPI / AsyncAPI schemas; allof-merge's document and schema rule sets apply (OpenAPI: strict 3.0.3 `nullable`, OpenAPI-only `int32`/`int64` and `float`/`double` lattice; AsyncAPI payload rules per `schemaFormat`; GraphApi rules). Expected asd result for `Name: { allOf: [{ $ref: Base }], nullable: true }`, `Base: { type: string }` against `{ type: string, nullable: true }`: "[Removed] nullable". |
| B | Things the merge cannot combine | first "Treat as impossible" (for `allOf: [{ type: string, format: date-time }, { format: date }]`), then as the library-wide rule: "All items which where ignored in merge should be highlighted as issue" | A complete, structured issue model: every place where the merge keeps something unmerged, drops or ignores input, resolves ambiguously, hits a limit, removes branches, collapses to `false`, copies instead of linking or keeps a node unmerged must produce an issue. The format rule itself is an open decision (§3.5, §8 Q1). |
| C | Impossible branches | "Impossible branches should be removed on normalization step, issues found on normalization step should be provided as errors/warnings" | `dropFalseBranches` / `dedupeAnyOf` stay on by default; asd must not switch them off (the F-1 adaptation of the compatibility report is rejected); every removal is an issue; asd forwards normalization issues as errors / warnings. Expected asd result for `oneOf: [{ allOf: [string, number] }, number]` against `oneOf: [number]`: no diff and a warning. |
| D | Mixed tuples in 2020-12 | "Accept current output" | `allOf: [{ prefixItems: [string] }, { items: [{ minLength: 1 }, number] }]` stays `{ prefixItems: [string], allOf: [{ items: [...] }] }`; per B the kept part is reported. |
| E | asd pipeline | "Both" | Two asd modes: (1) whole-document normalization once per input document with auto-selected allof-merge rules, issues forwarded, then the diff of the normalized documents; (2) per-node merging (`createMerger`, merge on every node, `source: root`) with allof-merge's rules and defaults, issues forwarded. F-12 must be solved by a correct fast-path condition, preferably inside allof-merge. |
| F | Remaining allof-merge fixes | (task) | F-10 (single-item `allOf` skips the branch simplifications, merge not idempotent), F-11 (per-node overhead ≈ 2× the 2026-11-15 draft; target: back to ≤ the 2026-11-15 numbers on gql-github and js-allof-200), F-7 (asd: bare `$ref: "#foo"` resolves to the root; route anchors through allof-merge's resolution index). |

## 2. Current state (probes)

### 2.1 What allof-merge reports today

`/tmp/amr-norm/inventory.ts` and `inventory2.ts` run 90 inputs through `merge` with both callbacks set. Summary of the cases that matter for B (output shortened, `s` = `{ type: string }`, `n` = `{ type: number }`):

| Input | Output | Reported today |
|---|---|---|
| `allOf: [{ type: string, format: date-time }, { format: date }]` | `{ type: string, allOf: [{ format: date-time }, { format: date }] }` | onMergeError "Different formats cannot be merged, kept as allOf" |
| OpenAPI 3.0 `allOf: [{ type: integer, format: int32 }, { format: int64 }]` | `{ type: integer, format: int32 }` | silent (lattice) |
| `allOf: [{ pattern: "(a)\\1" }, { pattern: "b" }]` | `{ allOf: [{ pattern: "(a)\\1" }, { pattern: "b" }] }` | **silent** |
| `allOf: [{ pattern: "(" }, { pattern: "b" }]` | same shape | onMergeError "Invalid pattern is kept as an allOf fragment" |
| `allOf: [{ contains: s }, { contains: n }]` | kept as two fragments | **silent** |
| 2020-12 `allOf: [{ if: s, then: … }, { if: n, then: … }]` | kept as two fragments | **silent** |
| 2020-12 item with `unevaluatedProperties: false` | kept as a fragment | **silent** |
| `patternProperties` × `additionalProperties: false` (no exact form) | object shapes kept as fragments | **silent** |
| `properties: { aaa }, additionalProperties: false` × `patternProperties: { "^(a+)+$": n }` (nested quantifier) | kept as fragments | **silent** |
| name longer than `matchPatterns.maxNameLength` | kept as fragments | **silent** |
| `allOf: [{ multipleOf: 0.1 }, { multipleOf: 1e-320 }]` | kept as fragments | onMergeError "Could not compute the least common multiple…" |
| 2020-12 `allOf: [{ prefixItems: [s] }, { items: [{ minLength: 1 }, n] }]` | `{ prefixItems: [s], allOf: [{ items: [...] }] }` | onMergeError "Array-valued items is not a tuple keyword under 2020-12, kept as allOf" |
| `allOf: [s, n]` | `false` | onMergeError "Could not merge values, they are probably incompatible" |
| `oneOf: [{ allOf: [s, n] }, n]` | `{ oneOf: [n] }` | **silent** (branch removed) |
| `anyOf: [{ allOf: [s, n] }]` | `false` | onMergeError at `["anyOf"]` |
| `anyOf: [s, s, n]` | `{ anyOf: [s, n] }` | **silent** (duplicate removed) |
| `allOf: [{ contains: n }, { contains: s }, { contains: n }]` | two fragments | **silent** (`dedupeFragments`) |
| `allOf: [{ oneOf: [s, n] }, { oneOf: [s, n] }]` | `{ oneOf: [s, n] }` | **silent** (`dedupeCombinaryGroups`) |
| 11 two-branch `oneOf` groups | unchanged | onMergeError "… 2048 combinations exceed the branch budget of 1024" |
| `allOf: [{ required: true }, { type: object }]` | `{ type: object, required: true }` | **silent, value kept** (a single malformed value is copied, only a second value triggers validation) |
| `allOf: [{ required: true }, { required: [a] }]` | `{ required: [a] }` | onMergeError with the generic conflict message "Could not merge values…" (the per-key resolver path drops the "malformed" message) |
| `allOf: [{ minLength: -1 }, { type: string }]` | `{ type: string }` | onMergeError "Malformed minLength value is ignored" (keyword groups validate single values, the per-key table does not) |
| `allOf: [{ uniqueItems: "hi" }, { type: array }]` | `{ type: array, uniqueItems: "hi" }` | **silent, value kept** |
| `allOf: { type: string }` / `allOf: [3, s]` / `enum: null` / `type: []` / `dependencies: 3` | malformed part ignored | onMergeError "Malformed … value is ignored" |
| `allOf: [{ $ref: "#/definitions/X" }, s]` (missing), `#/__proto__`, `ext.json#/X`, `#nope` | node kept with the `$ref` | onRefResolveError "Cannot resolve $ref" (also for the external ref) |
| `{ $ref: "#/nope", minLength: 1 }` with `mergeRefSibling` | unchanged | onRefResolveError; an external ref there is silent (D-9) |
| ref → ref cycle inside `allOf` | node kept | onRefResolveError |
| `definitions.A = { allOf: [{ $ref: A }, s] }` (self reference) | `A: { type: string }` | **silent** (the self item is skipped) |
| cyclic JavaScript value outside `source` | `{}` at the re-entry | onMergeError "Cyclic value outside the source document…" |
| `allOf: [{ "x-a": 1 }, { "x-a": 2 }]`, `title` A/B, `description`, `default`, `example` | last value | **silent** (D-19 last-wins) |
| OpenAPI 3.0 `allOf: [{ discriminator: { propertyName: a } }, { discriminator: { propertyName: b } }]` | `{ discriminator: { propertyName: b } }` | **silent** |
| draft-07 `allOf: [{ prefixItems: [s] }, { prefixItems: [n] }]` (unknown keyword there) | `{ prefixItems: [n] }` | **silent** |
| OpenAPI 3.0 `Name: { allOf: [{ $ref: Base }], nullable: true }`, `Base: { type: string }` | `Name: { type: string }` | **silent** (`nullable: true` has no effect under the strict 3.0.3 reading) |
| link through a merged `allOf` (`#/definitions/Pet/allOf/0/properties/id`) | rewritten to `#/definitions/Pet/properties/id` | **silent** |
| link into a member that the merge makes stricter | replaced by a copy | **silent** |
| link into an impossible branch (D-27) | copy `false` | reported as a contradiction at the link site |
| `$anchor` / `$id` of a `$ref`-inlined target | not copied | **silent** |
| `simplify: true`, `{ type: string } ∧ { enum: [a, 1] }` | `{ type: string, enum: [a] }` | **silent** |
| `maxRefExpansion: 2` with five usages | three usages keep `allOf: [$ref, …]` | onMergeError once per target |
| `expansionBudget: 5` | the rest keep their `$ref` | onMergeError once per call |
| `maxDepth: 10` under `properties` nesting | deeper nodes copied | onMergeError once per call |
| D-17 fallback (a limited `$ref` through a merged `allOf`) | node kept unmerged | onMergeError for the limit, **twice at the same path** (once per re-merge round); the kept-unmerged decision itself is silent |
| AsyncAPI 3 `$ref` to an Avro Multi Format Schema Object inside `allOf` | `$ref` kept as a fragment | onMergeError "Schema in format … cannot be merged into allOf" |

Reporting is also not repeatable across calls of one merger, which is how asd calls it. `inventory2.ts`: with `createMerger({ source: doc })`, the first `merge(doc.definitions.F)` reports the format conflict, a second call on the same node, and calls on `a: { allOf: [{ $ref: F }] }` and `b` (which reuse the memoized merge of `F`) are silent. Inside one whole-document merge the conflict of `F` is reported once (at `definitions/F`), while a contradiction `X` reached from `a` and `b` is reported three times (once per merged node, which is correct: they are different nodes).

### 2.2 What asd 2.0 reports today for the examples

`/tmp/amr-norm/asd-examples.ts` against `/tmp/asd2-compat` (asd 2.0 + allof-merge 1.0.0, no adaptations). "Prototype" is a whole-document normalization with `merge(doc)` (auto-selected allof-merge rules) followed by `apiCompare(normalizedBefore, normalizedAfter, { notMergeAllOf: true })`.

| Example | asd 2.0 today (per node, asd-chosen JSON Schema rules) | Prototype (document normalized by allof-merge) |
|---|---|---|
| A: OAS 3.0 `{ type: string, nullable: true }` → `{ allOf: [{ $ref: Base }], nullable: true }` | no diffs | breaking remove `…/requestBody/…/schema/nullable` "[Removed] nullable in Request Body content (application/json)"; non-breaking remove `…/responses/200/…/schema/nullable` "[Removed] nullable in Response 200 content (application/json)" |
| B: `{ type: string, format: date }` → `{ allOf: [{ type: string, format: date-time }, { format: date }] }` | non-breaking remove `type` "[Removed] type definition `string`"; non-breaking remove `format` "[Removed] value format `date`"; unclassified add `allOf` "[Added] `allOf`" | the same three diffs (allof-merge keeps the fragments) |
| B': OAS 3.0 `{ type: integer, format: int32 }` → `{ allOf: [{ type: integer, format: int64 }, { format: int32 }] }` | 6 diffs (remove `type`, remove `format`, unclassified add `allOf`, in request and response) | no diffs (OpenAPI lattice) |
| C: `{ oneOf: [{ allOf: [s, n] }, n] }` → `{ oneOf: [n] }` | breaking remove `oneOf/0` "[Removed] oneOf schema" | no diffs |
| C': `p: { oneOf: [{ allOf: [s, n] }, n, s] }` wrapped in an `allOf` on one side (F-1) | breaking remove `properties/p/oneOf/0` | no diffs |
| C'': `{ anyOf: [s, n] }` → `{ anyOf: [s, s, n] }` | annotation replace "[Replaced] schema with an equivalent schema (the same values are valid)" | no diffs |
| D: 2020-12 `{ prefixItems: [s] }` → `{ allOf: [{ prefixItems: [s] }, { items: [{ minLength: 1 }, n] }] }` | non-breaking remove `prefixItems` "[Removed] tuple item schemas"; unclassified add `allOf` | **breaking add `items/0`, breaking add `items/1`** (wrong: `merge(doc)` picked draft-06 rules for a 2020-12 document, see §2.3); with `jsonSchemaMergeRules("2020-12")` the same two diffs as today plus the report "Array-valued items is not a tuple keyword under 2020-12, kept as allOf" |
| F-7: 2020-12 `q: { $ref: "#foo" }`, `$defs/A` (`$anchor: foo`) `string` → `number` | breaking replace `$defs/A/type` only | (unchanged, asd-side bug) |

### 2.3 Gaps found by the probes beyond the compatibility report

- `selectMergeRules` ignores `$schema`: a JSON Schema document is always merged with draft-06 rules, so the 2020-12 document of example D is read with the draft-06 tuple semantics in a whole-document merge. It also ignores OpenAPI 3.1 `jsonSchemaDialect`, and the version test `/3.+/` accepts strings like `"13"` or `"30"`.
- Reporting is not deterministic per call in fragment mode (memo hits are silent, §2.1), the D-17 fallback reports the same limit twice, single malformed values on the per-key path are kept silently, and the per-key resolvers (`resolvers/basic.ts`, `resolvers/items.ts`, `resolvers/conjunction.ts`) pass only values to `mergeError`, so their specific messages ("Malformed required value", tuple kept) arrive as the generic "Could not merge values" message.
- asd's own compare transforms synthesize `allOf` nodes (`mergeRefSibling` in `jsonSchema.utils.ts` turns `{ $ref, siblings }` into `allOf: [{ $ref }, siblings]`; the combinator sibling lifting builds `allOf: [sibling, branch]` branches). A whole-document normalization alone does not remove them (§4.1, corpus differential).

### 2.4 Performance today

Node 26.13, best of 9 to 15 runs, unminified esbuild bundles (`/tmp/amr-norm/opt-bench.mjs`, `oas-eq.mjs`, `hit.mjs`):

| Workload | 2026-11-15 draft | 1.0.0 `src` |
|---|---|---|
| gql-github (GraphApi 0.6.0 fixture, 19 431 nodes, 4 482 `$ref`, 0 `allOf`) whole document | 23.5–25.3 ms | 43.4–48.3 ms |
| js-allof-200, 200 per-node merges with one merger (asd's pattern) | 3.1–3.4 ms | 4.8–5.1 ms |
| js-allof-200 whole document | 3.6–4.2 ms | 16.8–18.7 ms |
| oas-github (14 MB, 87 `allOf`) whole document | 135.8–152.1 ms | 236.2–247.4 ms |
| 200 repeated per-node calls on a warm merger (all memo hits) | 0.27 ms | 0.64–0.68 ms |
| 613 calls on nodes without `allOf` | 1.25 ms | 2.06 ms |

For reference, json-crawl's `syncClone` of gql-github with a no-op hook and the GraphApi rules costs 22.3 ms (12.2 ms without rules) and `structuredClone` 14.3 ms, so the draft's whole-document merge of a document without `allOf` was essentially one rule-aware clone. CPU profiles (`node --cpu-prof`, self time): gql-github — json-crawl rule resolution (`getNodeRules`, which builds a merged rule object per node with `Object.assign` of `/*` and the exact rule) 14.3 %, GC 12.5 %, `visit` 10.6 %, `popFrames` 10.1 %, `decodeSegment` 5.9 % and `ownersOf` 2.5 % (the D-22 owner check for every `$ref`), `doneSet` 4.7 %; oas-github — `popFrames` 14.5 %, `visit` 10.9 %, rule resolution 10.1 %, GC 9.9 %, `doneSet` 6.9 %, while `intersect` (the actual merging) is 2.5 % inclusive; js-allof-200 per node — `visit` 12.2 %, GC 10.8 %, rule resolution 7.6 %, `mergeObjectShape` 7.2 %, `intersect` 5.1 %. The overhead is frame bookkeeping for nodes that need no work.

In asd, js-allof-200 makes 800 merge calls per compare (200 `allOf` nodes, on both sides, each merged twice) that take 16.1 of 37.4 ms; oas-github makes 0 calls (asd's unchanged-subtree skip never reaches an `allOf`), oas-petstore 0 (`/tmp/amr-norm/count.ts`).

## 3. allof-merge changes

### 3.1 Principle and categories

Rule: every deviation of the output from "each keyword of each input item merged into one equivalent keyword" is an issue, unless the consumer asked for it by an explicit option (`refAnnotations: "omit"`, `dropFalseBranches: false`, …). Issues fall into seven categories, each with a default severity:

| Category | Meaning | Default severity |
|---|---|---|
| `input` | the input is invalid or unusable: a malformed keyword value ignored, a malformed `allOf`, a broken or cyclic `$ref`, a cyclic value outside `source`, an invalid regular expression | error |
| `unresolved` | a reference the merge cannot follow by design (external `$ref`) | warning |
| `contradiction` | a conjunction no value satisfies, written as `false` (or `{ not: {} }` / `{ allOf: [false], containers }`) | warning (open, §8 Q3) |
| `kept` | parts kept unmerged as `allOf` fragments or `$ref`s because they have no exact merged form (formats, backreference patterns, `contains`, `if`/`then`/`else`, `unevaluated*`, object shapes, `multipleOf`, legacy tuples, non-JSON-Schema `schemaFormat`, nodes kept for link validity) | warning |
| `limit` | a resource limit stopped the merge of a node (`branchBudget`, `maxRefExpansion`, `expansionBudget`, `maxDepth`; the `matchPatterns` caps are a `kept` reason) | warning |
| `removed` | content removed from the output although the meaning is kept: impossible `oneOf`/`anyOf` branches (warning, decision C), duplicate branches / fragments / groups, identity keywords of inlined targets, the self item of a self-referencing `allOf` (info) | warning or info per code |
| `rewritten` | a semantically neutral rewrite a reader may notice: a link rewritten to its merged location, a `$ref` replaced by a copy, the OpenAPI format lattice narrowing a pair, an opt-in `simplify` rule, a last-wins choice between different values | info (last-wins: open, §8 Q2) |

### 3.2 Issue type and API

```ts
export type MergeIssueSeverity = "error" | "warning" | "info"
export type MergeIssueCategory = "input" | "unresolved" | "contradiction" | "kept" | "limit" | "removed" | "rewritten"

export interface MergeIssue {
  code: MergeIssueCode              // stable identifier, table §3.3
  severity: MergeIssueSeverity
  category: MergeIssueCategory
  message: string                   // human-readable; the legacy message where one exists (§3.4)
  path: JsonPath                    // output location, relative to the merged value (what onMergeError receives today)
  sourcePointer?: string            // JSON pointer of the input node in `source` ("#/components/schemas/Pet"); absent when the node is not part of `source`
  keyword?: string                  // the keyword concerned ("format", "oneOf", "allOf", …)
  values?: unknown[]                // the values involved (conflicting values, removed branch, malformed value)
  refs?: string[]                   // `$ref`s through which the involved items were reached, outermost first
  reason?: string                   // sub-cause for a code with several causes (object-shape-kept: "pattern-interaction" | "match-limit" | "nested-quantifier" | "test-budget"; unsatisfiable: "type" | "enum" | "const" | "bounds" | "format" | "false-item" | "simplify")
  decision?: string                 // design decision behind the behaviour ("D-2", "D-18", "Q3-1", …)
}

export interface MergeOptions {
  // ... existing options ...
  onIssue?: (issue: MergeIssue) => void   // every issue at or above `issueLevel`
  issueLevel?: MergeIssueSeverity         // minimum severity delivered to onIssue / mergeWithIssues (default "warning")
  formatConflict?: "keep" | "disjoint" | "unsatisfiable" // §3.5 (default "keep")
}

// per-call override of the sink, so one cached merger can serve callers with different contexts (asd: one merger per
// document and rule set, issues attributed to the compared node and side)
export interface Merger {
  merge: (value: unknown, options?: Pick<MergeOptions, "rules" | "source" | "onIssue">) => unknown
  hook: SyncCloneHook<{}>
  needsMerge: (value: unknown, options?: Pick<MergeOptions, "rules" | "source">) => boolean // §3.6
}

export const mergeWithIssues = (value: unknown, options?: MergeOptions): { result: unknown, issues: MergeIssue[] }
export const MERGE_ISSUES: Readonly<Record<MergeIssueCode, { severity: MergeIssueSeverity, category: MergeIssueCategory }>>
```

Emission is centralized in one `emit(c, code, at, details)` function per call. It applies the severity filter before it builds the object (no sink or below `issueLevel`: no allocation), de-duplicates, records the issue for replay, calls `onIssue`, and calls the legacy callback mapped to the code (§3.4). Every current call site (§3.4) and every new site passes a code instead of a message; keyword groups and per-key resolvers get `report(code, values, details?)` in `GroupContext` / `MergeContext` (the old `report(message, values)` / `mergeError(values)` signatures stay as adapters that emit `merge-conflict` for custom resolvers).

De-duplication: one issue per `(code, sourcePointer ?? path, keyword)` per `merge()` call; `path` is the first output location. Limits keep their once-per-target / once-per-call reporting. This also removes the double D-17 report.

Replay (deterministic reporting per call): an issue raised while a frame is on the stack is recorded on that frame; `popFrames` stores the frame's issues (with paths relative to the frame) next to the output in a merger-level `WeakMap<output, RecordedIssue[]>` and appends them to the parent frame, as `outputCounts` already does for inlining counts; memo entries keep the issues of their merge. When an output is reused (`doneGet` hit, memo hit, container-output cache, the per-merger result cache of §3.8), its recorded issues are replayed with the current location as path prefix, through the same de-duplication. Result: `merger.merge(x)` reports the same issues on every call, whatever was merged before. Recording costs nothing when no sink is configured; with a sink it is one array per frame that has issues (issues are rare: 24 legacy reports over the 5 212 asd corpus variants).

Paths: `path` stays the output path relative to the merged value (backward compatible). `sourcePointer` is the input location the consumer can show or map: the node being merged for node-level issues, the inlined target for issues inside it (via `ResolutionIndex.pointerOf`), absent for values outside `source` (asd passes transformed copies of nodes in per-node mode, so asd composes its own path, §4.4). `refs` lists the `$ref` chain of the involved items (`collectItems` already tracks `origin` / `via` per work item).

Performance cost: zero without a sink (one branch per emission site); with a sink, recording and replay cost one `WeakMap` lookup per shared output. The fast path (§3.6) is not affected because clean subtrees raise no issues.

### 3.3 Issue codes

Legacy: which callback fires today (M = `onMergeError`, R = `onRefResolveError`, — = silent). Codes marked "fix" change today's behaviour slightly (see the notes).

| Code | Severity | Category | Trigger and example | Legacy | Decision |
|---|---|---|---|---|---|
| `malformed-value` | error | input | a keyword value of the wrong type is ignored (`required: true`, `enum: null`, `type: []`, `minLength: -1`, `uniqueItems: "hi"`, `nullable: 1`, a non-schema `properties` member, `dependencies: 3`, non-array `oneOf`); fix: also a single malformed value on the per-key path, which is copied silently today | M | D-6 |
| `malformed-allof` | error | input | `allOf` is not an array: ignored, the rest of the node kept | M | D-6 |
| `malformed-allof-item` | error | input | an `allOf` item that is not a schema (`allOf: [3, s]`) | M | D-6 |
| `broken-ref` | error | input | a local `$ref` that does not resolve (missing target, inherited member `#/__proto__`, unknown anchor `#nope`, empty or non-string `$ref`); the node keeps the `$ref` | R | AM-15, VR-36, VR-42 |
| `ref-cycle` | error | input | a ref → ref chain that comes back to itself | R | VR-40 |
| `cyclic-value` | error | input | a cyclic JavaScript value outside `source`, replaced by `{}` | M | D-4b |
| `pattern-invalid` | error | input | an invalid regular expression, kept as a `pattern` fragment | M | D-6 |
| `external-ref` | warning | unresolved | an external `$ref` in `allOf` (reported as `broken-ref` by R today) or with siblings under `mergeRefSibling` (silent today, D-9) | R / — | D-9 |
| `unsatisfiable` | warning | contradiction | a conjunction no value satisfies becomes `false` (`allOf: [s, n]`, disjoint `enum`, different `const`, a `false` item, `simplify` bound contradictions; with `formatConflict` also formats, §3.5); not raised inside a `oneOf`/`anyOf` branch (that is `branch-removed`) | M | AM-01, D-10 |
| `unsatisfiable-combinator` | warning | contradiction | every `oneOf`/`anyOf` branch became impossible, the node is `false` (`anyOf: [{ allOf: [s, n] }]`) | M | VR-41 |
| `branch-removed` | warning | removed | an impossible branch removed by `dropFalseBranches` (`oneOf: [{ allOf: [s, n] }, n]` → `oneOf: [n]`; `oneOf: [false, n]`); `values` = the original branch, `path` = its index before removal | — | decision C, Q3-1 |
| `branch-kept-for-link` | warning | kept | an impossible branch not removed because a pointer of the output targets a later branch (`simplifyMerged` skips tainted branches) | — | D-27 |
| `format-conflict` | warning | kept | differing formats kept as `allOf: [{ format: a }, { format: b }]` (`date-time` ∧ `date`; under JSON Schema / GraphApi rules also `int32` ∧ `int64`) | M | D-2, D-14 |
| `pattern-kept` | warning | kept | patterns that cannot be conjoined safely (backreferences, named groups) kept as fragments | — | AM-03 |
| `contains-kept` | warning | kept | different `contains` kept as fragments | — | AM-12 |
| `conditional-kept` | warning | kept | several `if`/`then`/`else` kept as fragments | — | VR-39 |
| `unevaluated-kept` | warning | kept | an item with its own `unevaluatedProperties`/`unevaluatedItems` kept as a fragment (`$ref` item stays `{ $ref }`) | — | D-8 |
| `object-shape-kept` | warning | kept | `properties`/`patternProperties`/`additionalProperties` shapes kept as fragments; `reason`: `pattern-interaction`, `match-limit` (pattern or name over `matchPatterns` limits, or matching disabled), `nested-quantifier`, `test-budget` (100 000 tests per node) | — | D-3, D-5 |
| `multipleof-kept` | warning | kept | `multipleOf` values without an exact least common multiple | M | VR-01 |
| `tuple-kept` | warning | kept | 2020-12: an array-valued `items` combined with other array shapes kept as `allOf: [{ items, additionalItems? }]` (example D) | M | D-18 |
| `schema-format-kept` | warning | kept | AsyncAPI 3: `$ref` inside `allOf` to a Multi Format Schema Object of a non-JSON-Schema format or without `schema`, kept as a fragment | M | Q2-4 |
| `kept-for-link` | warning | kept | D-17 fallback: a rewritable node kept unmerged (its members merged) because a `$ref` that could be neither linked nor copied points through it | — | D-17 |
| `branch-budget` | warning | limit | a `oneOf`/`anyOf` product (or a `mergeCombinarySibling` distribution) over the remaining `branchBudget`; the node is left unchanged | M | D-7, VR-05 |
| `ref-expansion-limit` | warning | limit | a `$ref` target inlined more than `maxRefExpansion` times; once per target | M | D-7, D-15 |
| `expansion-budget` | warning | limit | `expansionBudget` exhausted; once per call | M | D-7, D-15 |
| `max-depth` | warning | limit | nodes deeper than `maxDepth` copied without merging; once per call | M | D-7 |
| `nullable-overridden` | warning | rewritten | OpenAPI 3.0: `nullable: true` has no effect because another item with a `type` and without `nullable: true` forbids `null` (example A) | — | D-1, D-13 |
| `anyof-duplicate-removed` | info | removed | identical `anyOf` branches kept once (`anyOf: [s, s, n]`) | — | Q3-1 |
| `fragment-duplicate-removed` | info | removed | identical kept `allOf` parts kept once | — | Q3-1 |
| `combinator-group-deduplicated` | info | removed | identical `oneOf`/`anyOf` groups combined once before the product | — | Q3-1 |
| `identity-dropped` | info | removed | `$id`/`id`/`$anchor`/`$dynamicAnchor`/`$schema`/`$vocabulary` of an inlined target not copied | — | (CHANGELOG) |
| `self-reference-skipped` | info | removed | an `allOf` item that resolves to the node itself is skipped (`A = { allOf: [{ $ref: A }, s] }` → `{ type: string }`) | — | — |
| `link-rewritten` | info | rewritten | a `$ref` rewritten to the matching merged location (also a shifted branch index) | — | D-22, D-23, D-27 |
| `link-copied` | info | rewritten | a `$ref` replaced by a copy of its original target (stricter merged location, a dropped member, a distributed `oneOf`) | — | D-20, D-22 |
| `format-narrowed` | info | rewritten | OpenAPI lattice: `int32` ∧ `int64` → `int32`, `float` ∧ `double` → `float` | — | D-14 |
| `simplified` | info | rewritten | an opt-in `simplify` rule rewrote a merged node (`reason`: `enumByType`, `redundantBounds`, `containsToMinItems`, `typeListPruned`) | — | Q3-2 |
| `keyword-last-wins` | info (open) | rewritten | different values of a keyword merged by last-wins: unknown and vendor keywords, annotations (`title`, `description`, `default`, `example`), `discriminator`, an unknown-in-this-draft keyword (`prefixItems` under draft-07) | — | D-19 (§8 Q2) |
| `merge-conflict` | warning | contradiction | a custom per-key resolver called `mergeError` (code of last resort for user rules) | M | — |

Not issues: `refAnnotations: "omit"` / a key list (the consumer asked for it); a `oneOf`/`anyOf` that is already impossible in the input (VR-41, no merge involved); `false` items of a user's `allOf` reported once as `unsatisfiable` (not once per item).

### 3.4 Call-site inventory and backward compatibility

Every current reporting site (`grep -n "onMergeError\|onRefResolveError\|report\|mergeError" src`), with its new code:

| Site | Today | Code |
|---|---|---|
| `merge.ts:420` `reportBudget` | M expansionBudgetExceeded | `expansion-budget` |
| `merge.ts:557` `share` | M refExpansionExceeded | `ref-expansion-limit` |
| `merge.ts:694` `cycleRef` | M cyclicValue | `cyclic-value` |
| `merge.ts:841` `distribute` | M branchBudgetExceeded | `branch-budget` |
| `merge.ts:1043` depth check | M maxDepthExceeded | `max-depth` |
| `merge.ts:1063` combinary exit hook | M mergeError | `unsatisfiable-combinator` |
| `merge.ts:1105` | M malformedValue("allOf") | `malformed-allof` |
| `merge.ts:1142`, `1146` (unevaluated copy) | M limit messages | `ref-expansion-limit`, `expansion-budget` |
| `merge.ts:1159` (`mergeRefSibling`, broken) | R | `broken-ref` (local) / `external-ref` (new, external) |
| `merge.ts:1182` | M malformedValue("allOf item") | `malformed-allof-item` |
| `merge.ts:1190–1194` `collected.limited` | M limit messages | `ref-expansion-limit`, `expansion-budget` |
| `merge.ts:1197–1199` `collected.unmergeable` (`rules/asyncapi.ts:167`) | M schemaFormat messages | `schema-format-kept` |
| `merge.ts:1201–1204` `collected.broken` | R | `broken-ref`, `ref-cycle`, `external-ref` (the `resolve` reason is available) |
| `merge.ts:1276–1280` `report` (intersect, silent inside branches) | M message or mergeError | per message, below; contradictions inside a branch stay silent (they become `branch-removed`) |
| `merge.ts:1325` `simplifyMerged` → `simplifySchema` conflict | M mergeError | `unsatisfiable` (`reason: "simplify"`) |
| `merge.ts:1337` `fragmentMerge` (relink siblings and targets) | callbacks switched off | stays silent: the clone pass reports these values already, or they are discarded; a copy made by relink replays the issues recorded for the target |
| `intersect.ts:170` group returned `undefined` | M values | `unsatisfiable` (`reason` from the group: type, enum/const, bounds) |
| `intersect.ts:198` non-array `oneOf`/`anyOf` | M malformedValue | `malformed-value` |
| `intersect.ts:217` branch product | M branchBudgetExceeded | `branch-budget` |
| `intersect.ts:233`, `236` per-key `mergeError` | M generic | resolvers get `report(code, values)`: `malformed-value` from `resolvers/basic.ts:11` (fix: today the generic conflict message), `tuple-kept` from `resolvers/items.ts:23` (fix: message dropped today), the nested merger of `resolvers/conjunction.ts:26` forwards issues unchanged (fix), `merge-conflict` for custom resolvers |
| `intersect.ts:249` resolver returned `undefined` | M generic | `unsatisfiable` |
| `groups/type.ts:39`, `98` | M malformed nullable / type | `malformed-value` |
| `groups/enum.ts:31`, `groups/dependencies.ts:26/48/65/97`, `groups/array.ts:133/180`, `groups/string.ts:20/56`, `groups/format.ts:22`, `groups/numeric.ts:36/40/79`, `groups/object.ts:22/32/45` | M malformed … | `malformed-value` |
| `groups/array.ts:67` | M legacy items kept | `tuple-kept` |
| `groups/string.ts:65` | M invalid pattern kept | `pattern-invalid` |
| `groups/format.ts:33` | M formats kept | `format-conflict` |
| `groups/numeric.ts:86` | M multipleOf kept | `multipleof-kept` |

Silent sites that get an emission:

| Site | Code |
|---|---|
| `merge.ts` `simplifyMerged` branch filter (`dropFalseBranches`) | `branch-removed`; the tainted-branch `continue` → `branch-kept-for-link` |
| `merge.ts` `simplifyMerged` `dedupeValues` for `anyOf` | `anyof-duplicate-removed` |
| `intersect.ts` final `dedupeValues(allOfFragments)` and `merge.ts` fragment dedupe | `fragment-duplicate-removed` |
| `intersect.ts` `dedupeCombinaryGroups` | `combinator-group-deduplicated` |
| `resolvers/basic.ts:144` `mergePattern` and `groups/string.ts:66` (valid but unsafe patterns) | `pattern-kept` |
| `groups/array.ts` `mergeContains` / `resolvers/items.ts:51` | `contains-kept` |
| `groups/conditional.ts`, `resolvers/basic.ts:248` | `conditional-kept` |
| `merge.ts` `collectItems` `hasUnevaluated` | `unevaluated-kept` |
| `groups/object.ts` every `return objectShapeFragments(shapes)` (pattern interaction, `UNKNOWN` match result, `MAX_PATTERN_TESTS`) | `object-shape-kept` with `reason` |
| `merge.ts` `collectItems` `seen.has(item)` for the node itself | `self-reference-skipped` |
| `merge.ts` `withoutIdentity` returning a copy | `identity-dropped` |
| `merge.ts` `relink` `decide` → link / no candidate (copy kept) | `link-rewritten` / `link-copied` |
| `merge.ts` `mergeWith` D-17 loop (`keepUnmerged` grows) | `kept-for-link` |
| `groups/format.ts` lattice narrowing | `format-narrowed` |
| `groups/type.ts` OpenAPI 3.0 nullable resolution | `nullable-overridden` |
| `simplify.ts` non-conflict rewrites | `simplified` |
| `intersect.ts` per-key `last` (default and `"/?"` fallback) with differing values | `keyword-last-wins` (open, §8 Q2) |
| `intersect.ts` single value on the per-key path (`values.length === 1`) | `malformed-value` for keywords with a validator (fix, §8 Q9) |

Backward compatibility: `onMergeError(message, path, values)` and `onRefResolveError(message, path, ref)` keep their signatures and keep firing for exactly the codes marked M / R in §3.3, with the same messages (`ErrorMessage`) and the same `path` / `values`. New codes never call the legacy callbacks, so a consumer that counts `onMergeError` calls sees no new calls. Two legacy outputs change because they were defects: the duplicated D-17 limit report disappears, and the per-key malformed values report "Malformed … value is ignored" instead of the generic conflict message (and a single malformed value is reported at all, §8 Q9). An external `$ref` inside `allOf` gets the new code `external-ref`, and R still fires for it with the same message as today. `onIssue` and the legacy callbacks can be set together; the legacy callbacks are not subject to `issueLevel` or replay (they behave as today: once, when the merge is computed).

### 3.5 The format rule (open decision, §8 Q1)

The user's example `allOf: [{ type: string, format: date-time }, { format: date }]` can be read in three ways. Under an asserting validator no string is both an RFC 3339 `date-time` and a `full-date`, so the conjunction is impossible. Under 2019-09 / 2020-12 the default vocabulary makes `format` an annotation, so the conjunction is valid for every string. For custom formats (`format: x-sku`) the library cannot know. Options:

| Option | Output for `date-time` ∧ `date` | Output for `x-sku` ∧ `x-ean` | Issue | asd result for example B |
|---|---|---|---|---|
| (a) keep (1.0.0 today) | `{ type: string, allOf: [{ format: date-time }, { format: date }] }` | fragments | `format-conflict` warning | "[Removed] type `string`", "[Removed] format `date`" (non-breaking), "[Added] `allOf`" (unclassified) + warning |
| (b) unsatisfiable for every pair outside the active lattice | `false` | `false` | `unsatisfiable` warning, `reason: "format"` | "[Replaced] schema with `false` (no value is valid)", breaking in a request and a response |
| (c) disjoint table: `false` only for pairs of known formats with disjoint value sets, keep otherwise | `false` | fragments + `format-conflict` | `unsatisfiable` (`reason: "format"`) / `format-conflict` | as (b) for this example |
| (d) last-wins (0.6.8) | `{ type: string, format: date }` | `{ format: x-ean }` | `keyword-last-wins` | no diff + info issue |

The disjoint table for (c) would hold the standard formats whose value sets are pairwise disjoint: `date`, `time`, `date-time`, `duration`, `ipv4`, `ipv6`, `uuid`. Formats with overlapping sets (`email` / `idn-email`, `uri` / `iri` / `uri-reference`, `hostname` / `idn-hostname`) are never disjoint, and the numeric pairs keep their per-rule-set treatment (lattice under OpenAPI rules, kept under JSON Schema rules).

Recommendation: a merge option `formatConflict: "keep" | "disjoint" | "unsatisfiable"`, library default `"keep"` (no output change against 1.0.0, the principle "ignored → issue" is met by the warning), and asd passes `"disjoint"`. That gives the user's "impossible" for date-time ∧ date, keeps custom formats visible as kept parts with a warning, and does not invent contradictions for annotation-only formats outside the table. The memo key needs no change because `formatConflict` is a merger option (fixed for the merger's lifetime); consumers that cache mergers add it to their key.

### 3.6 Fast path: when a subtree needs no work

"No `allOf`" is not a correct skip condition any more: with the default simplifications `{ anyOf: [s, s, n] }` and `{ oneOf: [false, n] }` change without any `allOf`, and with the sibling options a `$ref` with siblings or a `oneOf` with siblings changes too. The correct condition, evaluated per input subtree under the merger's settings: a subtree is **clean** when it contains none of

1. a node with an own `allOf` (any value: a malformed one is reported);
2. with `mergeRefSibling`, a `$ref` with siblings;
3. with `mergeCombinarySibling`, a `oneOf`/`anyOf` with distributable siblings, or two combinator keys whose distribution has a cost (`distributionCost > 0`);
4. with `dropFalseBranches`, a `oneOf`/`anyOf` with a literally unsatisfiable branch (`false`; also `{ not: {} }` under `unsatisfiable: "not-empty"`);
5. with `dedupeAnyOf`, an `anyOf` with two structurally equal branches (checked with `canonicalKey` only for arrays of two or more objects);
6. in a whole-document merge, a `$ref` whose pointer runs through a non-clean node (`ownersOf` restricted to non-clean owners);
7. an object that is already on the scan path (identity cycle: the clone must write cycle `$ref`s);
8. nesting beyond a scan guard (iterative scan; a subtree deeper than `maxDepth` is not clean).

Branches that become impossible only by merging always contain an `allOf` (rule 1) or a sibling form (rules 2–3), so the condition is complete. `simplify` runs only on merged nodes and malformed values are only validated inside merges, so neither adds a condition.

A clean subtree is written as an iterative own-property-safe deep copy (no frames, no rule resolution, no `ownersOf`), registered in the call's `done` memo and shared per input instance within the merger, so "one input object maps to one output object" (D-11) still holds. The flag is memoized per input object in a `WeakMap` (inputs must not be mutated while a merger is in use, as documented). `merger.needsMerge(value)` exposes the same predicate for consumers that want to skip the call (asd's gate, §4.2).

Prototype (`/tmp/amr-norm/src-opt`, measured with `opt-bench.mjs` / `oas-eq.mjs`, outputs compared with `JSON.stringify`):

| Workload | 2026-11-15 draft | 1.0.0 | 1.0.0 + fast path (+ the P1 ownersOf guard of §3.8) | Output identical |
|---|---|---|---|---|
| gql-github whole document | 24.1–25.3 ms | 43.4–48.3 ms | 22.3–24.2 ms | yes |
| oas-github whole document | 135.8–152.1 ms | 236.2–247.4 ms | 87.7–90.5 ms | yes |
| js-allof-200 whole document | 3.6–4.2 ms | 16.8–18.7 ms | 4.2–4.3 ms | yes |
| js-allof-200, 200 per-node merges | 3.1–3.4 ms | 4.8–5.1 ms | 3.7 ms | yes |
| oas-petstore whole document | 0.3–0.4 ms | 0.5–0.6 ms | 0.4 ms | yes |

The allof-merge suite (36 files, fuzz excluded) against the prototype gives 937 pass / 2 fail. Both failures point at shortcuts of the prototype that the real change must not take: B9.2.17 expects one output instance per input instance (the prototype's clean copies used their own cache instead of the call's `done` memo), and B13.6.2 expects the `mergeCombinarySibling` budget report for `{ anyOf: [40], oneOf: [40] }` (the prototype's scan missed rule 3's "two combinator keys" case).

### 3.7 F-10: simplifications on the single-item path

`visit` returns `{ value: single }` without an exit hook when an `allOf` reduces to one item (`schemas.length === 1 && !fragments.length`), so `simplifyMerged` never runs for that node. Fix: return `{ value: single, exitHook: () => simplifyMerged(c, frame, state.node, nodeKey, rules, report) }` with the same silent-inside-branch contradiction report as the multi-item path. Prototype (`/tmp/amr-norm/amr-copy`, `f10.ts`):

| Input | 1.0.0 | With the fix | `merge(merge(x))` equal |
|---|---|---|---|
| `{ allOf: [{ anyOf: [s, s, n] }] }` | `{ anyOf: [s, s, n] }` | `{ anyOf: [s, n] }` | yes (was no) |
| `{ allOf: [{ anyOf: [s, s, n] }, {}] }` | `{ anyOf: [s, s, n] }` | `{ anyOf: [s, n] }` | yes (was no) |
| `{ allOf: [{ oneOf: [false, n] }, {}] }` | `{ oneOf: [false, n] }` | `{ oneOf: [n] }` | yes (was no) |
| `{ allOf: [{ oneOf: [{ allOf: [s, n] }, n] }] }` | (same defect) | `{ oneOf: [n] }` | yes |

The suite result does not change with the fix (same 937 / 2 as above). The fuzz generator gets the single-item forms (`allOf: [X]`, `allOf: [X, {}]`) so the idempotence property covers them.

### 3.8 F-11: per-node and whole-document overhead

Measured hot spots and the changes, in order of effect:

| Change | Hot spot it removes | Evidence |
|---|---|---|
| Fast path for clean subtrees (§3.6) | frames, `doneSet`, rule resolution and `ownersOf` for nodes without work (≈ 99 % of oas-github's 274 890 nodes lie in subtrees without `allOf`) | gql-github 43–48 → 22–24 ms, oas-github 236–247 → 88–91 ms |
| P1: `ownersOf` only in whole-document mode (`c.ownerRefs` is read only there) and only against non-clean owners | `parseRef` / `decodeSegment` for every `$ref` (5.9 % + 2.5 % on gql-github) | included above |
| Per-merger result cache for fragment mode: `WeakMap<value, Map<rules, { output, issues }>>` per `source`, valid because a merger's options are fixed and `source` must not change | the fixed cost of a `merge()` call (new `CallState` with 18 collections, resolution-index lookup, `syncClone` setup, `detectAsyncApiVersion`) on repeated calls; asd calls the same node several times | 200 warm calls 0.64–0.68 ms (draft 0.27 ms) → 0.008 ms |
| Lazy whole-document-only call state (`sites`, `siteNodes`, `sitePositions`, `owners`, `shifts`, `rewritten`) and `asyncApi3` cached per resolution index | allocations and GC (10.8 % on the per-node bench) | estimate: −0.2 to −0.4 ms on js-allof-200 per node |
| json-crawl (`../json-crawl-fix`): memoize the merged child rules per `(rules object, key)` when neither the exact rule nor `/*` / `/**` / `/^` is a function | `getNodeRules` builds a merged rule object per node with `Object.assign` (7.6–14.3 % self) | estimate: −10 % on rule-aware clones; separate json-crawl change, before its 0.6.0 publication |
| `mergeObjectShape` plain path: when no shape has patterns and every `additionalProperties` is open, a direct property union | 13 % inclusive on js-allof-200 per node | estimate: −0.2 ms on js-allof-200 per node |

Targets (gate for the change): gql-github whole document ≤ 24.5 ms (met by the prototype), js-allof-200 per node ≤ 3.4 ms (prototype 3.7 ms; the result cache and the lazy state close the rest), and no fixture slower than the 2026-11-15 draft in asd's bench (`/tmp/asd-bench`, `scripts/bench.js`, 20 warm-ups, 11 runs, min).

### 3.9 Rule auto-selection

`selectMergeRules` (used by `merge(doc)` and by asd's document mode) gets: `$schema` detection for JSON Schema documents (draft-04 → `"draft-04"`, draft-06 → `"draft-06"`, draft-07 → `"draft-07"`, 2019-09 and 2020-12 → `"2020-12"`, unknown → `"draft-06"` as today); OpenAPI 3.1 `jsonSchemaDialect` (a 3.1 document declaring draft-07 schemas gets draft-07 schema rules); an exact version test (`/^3\.0(\.\d+)?$/` → `"3.0.x"`, `/^3\.[1-9]\d*(\.\d+)?$/` → `"3.1.x"`) instead of `/3.+/`. Fragment merges keep `options.rules` / `callOptions.rules`; a new helper `schemaMergeRulesFor(dialect)` (`"draft-04" | "draft-06" | "draft-07" | "2020-12" | "openapi-3.0" | "openapi-3.1" | "asyncapi-schema" | schemaFormat string`) returns the schema-level rule set allof-merge would use at a schema location of that dialect, so consumers that merge single schemas (asd's node mode) do not maintain their own mapping.

## 4. api-smart-diff changes

### 4.1 Two modes

New `CompareOptions.normalization?: "node" | "document"` (default `"node"`); `notMergeAllOf: true` keeps switching merging off in both. Measured with the 1.0.0 `src` bundle as normalizer (`/tmp/amr-norm/mode1.ts`, Bun, min of 7):

| Fixture | node (today) | document: normalize + compare | Diffs |
|---|---|---|---|
| js-allof-200 | 27.8 ms | 9.2 + 8.7 = 17.9 ms | 482 = 482 |
| gql-github (0.5.1 input) | 220.5 ms | 96.2 + 206.6 = 302.8 ms (57.4 ms normalize with the fast path) | 20 = 20 |
| gql-repo-pair | 3.0 ms | 1.3 + 2.5 = 3.8 ms | 7 = 7 |
| oas-petstore | 4.6 ms | 2.8 + 3.7 = 6.4 ms | 87 = 87 |
| oas-github | 151.5 ms | 410.6 + 167.6 = 578.2 ms (≈ 2 × 88 ms normalize with the fast path) | 68 = 68 |
| aa2-events | 2.5 ms | 0.8 + 1.8 = 2.6 ms | 29 = 29 |
| js-repo-pair | 1.9 ms | 0.7 + 1.7 = 2.4 ms | 23 = 23 |

Document mode normalizes everything, while node mode benefits from asd's unchanged-subtree skip (0 merge calls on oas-github). A corpus differential of document mode without any per-node merge (`/tmp/amr-norm/diff-mode1.ts`, 5 212 variants) changes 44 variants of 17 cases, which shows what document mode must still do per node:

| Cause | Cases | Consequence for the design |
|---|---|---|
| asd's compare transforms synthesize `allOf` (`$ref` siblings → `allOf: [{ $ref }, siblings]`; combinator sibling lifting) | JS-REF-008 … 011, JS-FRK-002, JS-REF-104, JS-JSD-061, OAS-OTK-003 | document mode keeps the per-node merge step for nodes that still need work after normalization (the fast path makes the rest free); in the longer run asd should pass `mergeRefSibling: true` to the document normalization (as node mode does) instead of synthesizing `allOf` |
| bound contradictions allof-merge does not collapse without `simplify` (`allOf: [string 5..7, string 2..4]`) | JS-JSD-025 | asd keeps its `isUnsatisfiable` reading of merged nodes (AD-37) in both modes, or passes `simplify: { contradictions: true }` |
| `anyOf: [false, false]` vs `false` | JS-JSD-050 | expected by decision C: no diff (was "[Replaced] schema with the equivalent `false`") plus a warning |
| the usage index loses `$ref`s that the merge inlined (`allOf: [{ $ref: Money }]`) | X-TBAPI-001 (`[Added] schema component Money` non-breaking → unclassified) | document mode builds the usage index (`src/core/usage.ts`) from the original documents |

| Aspect | `normalization: "node"` (default) | `normalization: "document"` |
|---|---|---|
| What is merged | every schema node pair the walk compares, lazily, with `merger.merge(node, { source: root, onIssue })` | each input document once with `merge(doc, { onIssue })` (rules from `selectMergeRules`), then node mode on the normalized documents for whatever still needs work |
| Rules | per dialect from `schemaMergeRulesFor` (§4.2) | auto-selected document rules; a forced `version` / `profile` / `engine` option passes explicit rules |
| When to use | CI and large documents with few changes (the default): cost grows with the changed part | viewers and reports that want one normalized document and the complete issue list; documents with many `allOf` changes |
| Performance | as today, plus the allof-merge fast path | measured above: faster on `allOf`-heavy small documents, ≈ 2× slower on large unchanged documents |
| Issues | only for nodes asd compares (unchanged subtrees are never merged) | for the whole of both documents |
| Diff paths | paths of the input documents (fragment mode leaves `$ref`s untouched, D-25) | paths of the normalized documents: equal to the input paths except below merged `allOf` (`…/allOf/1/properties/id` → `…/properties/id`) and inside copies (a copied target is reported at the usage) |
| `merged` | original values (2.0 contract) | normalized values where the normalization rewrote a node (allOf merged, links rewritten, copies); asd documents this; an origin map from allof-merge (output node → input pointer) is a possible follow-up |
| `$ref` resolution and `ResolutionIndex` (`src/core/session.ts`) | against the original roots; merged results carry unchanged `$ref`s | against the normalized roots only; rewritten links resolve there by construction (D-22), and `refResults` (keyed by `(scope, bRef, aRef)`) sees the rewritten pointers on both sides |
| Copies (D-20, D-22) | none (fragment mode) | a usage that became a copy is compared inline: POLICY-57 (declaration-only reporting for the same `$ref` on both sides) no longer applies there, so a change inside the target can also be reported at the copy |
| Usage index / component classification | original documents | must be built from the original documents (X-TBAPI-001) |
| Issue forwarding | per call, side and compare path known | per document, `path` is the normalized-document path, `sourcePointer` the original location |

### 4.2 Rules delegation (decision A) and the merge gate

- Remove asd's merge-rule mapping (`mergeRulesForDraft`, which maps OpenAPI 3.0 to draft-04 and OpenAPI 3.1 to 2020-12 JSON Schema rules) and take the schema rules from allof-merge: OpenAPI 3.0 / 3.1 `schemaMergeRulesFor("openapi-3.0" | "openapi-3.1")` (= `openApiJsonSchemaMergeRules`: strict 3.0.3 `nullable`, lattice, `discriminator`); AsyncAPI payloads and headers `schemaMergeRulesFor(schemaFormat)` (= `asyncApiSchemaMergeRules`); JSON Schema `schemaMergeRulesFor(draft)` from `$schema` or the `version` option; GraphApi `graphapiMergeRules` (document-level, as today). Concretely: `JsonSchemaRulesOptions` gets `mergeRules?: MergeRules`, `jsonSchemaRules` passes it to `jsonSchemaMergeAllOf`, and `openApiSchemaRules` / the AsyncAPI payload rule selection (`asyncapi.schema.ts:233`) set it. The F-2 adaptation (lattice-only custom rules) is not needed.
- Do not set `dropFalseBranches: false` / `dedupeAnyOf: false` (compatibility §6.1 is rejected). Instead the gate changes: today `jsonSchemaMergeAllOf` merges only a node with an own `allOf` (`hasAllOf`); it must merge every node for which `merger.needsMerge(node)` is true, so a `oneOf`/`anyOf` node is simplified before asd maps its branches. A prototype gate in asd (`/tmp/amr-norm/asd-proto`, "own `allOf`, or a `oneOf`/`anyOf` with a literal `false`, a duplicate, or a branch whose subtree needs work") gives the C results of §4.6 and 5 866 pass / 9 fail of 5 877: JS-JSD-061 (6 variants) and B9.5 (De Morgan: asd's set-level normalization of `not` / `anyOf` expects the combinator unmerged) and OAS-OTK-003 (2 variants: discriminated `oneOf` wrapped in `allOf` with a default). These need investigation during implementation (probably: run the set-level equivalence check before the merge, or keep a combinator whose only work is inside a negation unmerged). A first version that merged the whole subtree at the topmost node with work also broke F9 (4 000-level schema, timeout), so the gate must stay per node.
- Sibling options are compare semantics, not normalization: node mode keeps `mergeRefSibling: true` and `mergeCombinarySibling: false` for JSON Schema / OpenAPI / AsyncAPI (ISSUE-149) and `mergeRefSibling: false` for GraphApi (ISSUE-53, AD-28); everything else uses allof-merge's defaults (§8 Q7).
- F-12: asd's own "skip when no `allOf`" scan is dropped; the GraphApi merge relies on the library fast path (measured 22.3–24.2 ms for gql-github, the same as the scan-based adaptation's target).

### 4.3 Merger cache key

`getSessionMerger` key: `ruleSetId(rules)|mergeRefSibling|mergeCombinarySibling|refAnnotations|dedupeAnyOf|dedupeFragments|dedupeCombinaryGroups|dropFalseBranches|simplifyKey|formatConflict|unsatisfiable|issueLevel`, where `simplifyKey` is `false` or the sorted enabled rule names. asd sets most of them to constants today, but the key must name them so that a future option cannot mix memos. The issue sink is per call (`merge(node, { source, onIssue })`) and therefore not part of the key.

### 4.4 Issue forwarding

`CompareError` gets four optional fields and one kind; existing kinds keep their meaning and get `severity: "error"`:

```ts
export type CompareErrorKind = "classify" | "annotate" | "ref" | "transform" | "mapping" | "compare" | "normalize"
export interface CompareError {
  kind: CompareErrorKind
  message: string
  path: JsonPath
  scope: CompareScope
  error?: unknown
  severity?: "error" | "warning" | "info"   // default "error"
  code?: string                             // allof-merge issue code for kind "normalize"
  side?: CompareSide                        // which document the normalization issue belongs to
  source?: JsonPath                         // original location (from sourcePointer) when it differs from path
}
CompareOptions.issueLevel?: "error" | "warning" | "info"   // minimum severity forwarded (default "warning")
```

Mapping from `MergeIssue` to `CompareError`:

| `MergeIssue` | `CompareError` |
|---|---|
| `code`, `severity`, `message` | `kind: "normalize"`, same `code` and `severity`, `message` prefixed with the side ("after: Different formats cannot be merged, kept as allOf") |
| node mode `path` (relative to the merged node) | `ctx[side].path` + `issue.path` (the compare path in that side's document) |
| document mode `path` | `issue.path` (normalized-document path) |
| `sourcePointer` | `source` (parsed to a path) when it differs from `path` |
| `values`, `refs`, `reason` | `error: issue` (the whole issue object) |
| — | `scope`: the compare scope of the node (node mode) or `"document"` (document mode) |

De-duplication in asd: one forwarded issue per `(side, code, source ?? path, keyword)` per `apiCompare` call (node mode merges the same node for both scopes and for the re-normalization pass; replay makes every call report, so asd must de-duplicate). The `normalization: "document"` mode forwards everything once per document.

Result channel (open, §8 Q4): recommended is the existing `onError` / `result.errors` with `severity`. Because the README's CI example `if (errors?.length || count("breaking")) process.exit(1)` would then fail on warnings, the README and the CHANGELOG change it to `errors?.some((e) => (e.severity ?? "error") === "error")`.

### 4.5 F-7: anchors

`resolveRefUncached` (`src/core/session.ts`) sends a pointer that does not start with `/` (allof-merge `isAnchorPointer`) straight to `indexOf(document).resolvePointer(pointer)` and takes the target's path from `index.pointerOf(target)`, instead of `pointerToPath("foo")` → `[]` → the root. Prototype in `/tmp/amr-norm/asd-proto` (`f7.ts`):

| 2020-12 case | asd 2.0 today | With the fix |
|---|---|---|
| `q: { $ref: "#foo" }` both sides, `$defs/A` (`$anchor: foo`) `string` → `number` | breaking replace `$defs/A/type` | breaking replace `$defs/A/type`; breaking replace `properties/q/type` "[Replaced] type definition of `q` from `string` to `number`" |
| `q: #foo` → `q: #bar`, `$defs/B` (`$anchor: bar`) `string` → `number` | breaking replace `$defs/B/type`; unclassified replace `properties/q/$ref` | breaking replace `$defs/B/type`; annotation replace `properties/q/$anchor`; breaking replace `properties/q/type` |
| `q: #foo` → `q: { type: number }` | unclassified remove `properties/q/$ref`; breaking add `properties/q/type` | annotation remove `properties/q/$anchor`; breaking replace `properties/q/type` |

Two follow-ups show up: a usage whose `$ref` names the same anchor on both sides should be declaration-only like `#/$defs/A` (POLICY-57 normalizes `#foo` and `#/$defs/A` to different keys today), and the identity keywords of a resolved target (`$anchor`, `$id`) should not be compared at the usage (§8 Q11). New asd ISSUE entry plus tests for the three rows.

### 4.6 Expected asd output, before and after

"After" assumes the recommendations (node mode, allof-merge rules and defaults, `formatConflict: "disjoint"`, issue level "warning"). Document mode gives the same diffs for these examples (§4.1).

| Example | asd 2.0 today | After |
|---|---|---|
| A (OAS 3.0 nullable via `allOf: [$ref Base]`) | no diffs | breaking remove `…/requestBody/…/schema/nullable` "[Removed] nullable in Request Body content (application/json)"; non-breaking remove `…/responses/200/…/schema/nullable`; warning `nullable-overridden` (after side) |
| B (`date` → `allOf: [date-time, date]`) | 3 diffs (non-breaking remove `type`, non-breaking remove `format`, unclassified add `allOf`) | breaking replace (root) "[Replaced] schema with `false` (no value is valid)"; warning `unsatisfiable` (`reason: "format"`, after side). With the library default `"keep"` instead: today's 3 diffs plus warning `format-conflict` |
| B' (OAS `int32` vs `allOf: [int64, int32]`) | 6 diffs | no diffs (info `format-narrowed` only at issue level "info") |
| C (`oneOf: [{ allOf: [s, n] }, n]` → `oneOf: [n]`) | breaking remove `oneOf/0` | no diffs; warning `branch-removed` at `oneOf/0` (before side) |
| C' (F-1 wrapped vs unwrapped) | breaking remove `properties/p/oneOf/0` | no diffs; warning `branch-removed` on both sides |
| C'' (`anyOf: [s, n]` → `anyOf: [s, s, n]`) | annotation replace "equivalent schema" | no diffs; info `anyof-duplicate-removed` (shown only at level "info") |
| D (2020-12 mixed tuple) | non-breaking remove `prefixItems` "[Removed] tuple item schemas"; unclassified add `allOf` | the same two diffs (accepted); warning `tuple-kept` (after side) |
| E (modes) | per node only | both modes; equal diffs on the 7 measured fixtures; document mode differs on 17 corpus cases until the per-node step of §4.1 is kept |
| F-7 (bare anchor) | change reported at `$defs/A/type` only | also at `properties/q/type` (§4.5) |

### 4.7 Documentation and reports

asd `CHANGELOG.md`: dependency line (allof-merge rules per dialect, impossible branches removed, `normalization` option, `normalize` errors with `severity`), the README CI example, the bundle size (F-13: re-measure, the issue model adds an estimated 2–3 KB min+gzip to allof-merge), `docs/DESIGN_PROPOSALS.md` (F-8 wording), `docs/TEST_PLAN.md` / `docs/ANALYSIS.md` (new ISSUEs: anchor resolution, merge gate, issue forwarding, document mode), `docs/DECISIONS_REVIEW_2.0.0.md` (new AD rows for the modes and the forwarding), the compat report (`bun test/compat/report.ts --write`: JS-JSD-050 moves from "annotation" to "no diff", the C-type cases change; re-check every family stays at 100 %), and `docs/BENCHMARK.md` (B2 rerun). allof-merge: README (options `onIssue`, `issueLevel`, `formatConflict`, `mergeWithIssues`, `needsMerge`, issue table, `$schema` detection), CHANGELOG 1.0.0 (issue model, fast path, F-10, the two legacy-report fixes), `docs/VERIFICATION.md` §9 (new measurements), `docs/ASD2_COMPATIBILITY.md` (decisions section, done).

## 5. Compatibility and migration for other consumers

| Consumer | Uses | What changes |
|---|---|---|
| api-model-tree (behind api-doc-viewer and api-diff-viewer; pins allof-merge ^0.5.3 today) | `merge(value, { source, mergeRefSibling: true, mergeCombinarySibling: true, rules })` | on its 1.0.0 upgrade: nothing new is required (`onIssue` is optional, legacy callbacks unchanged). Output changes: F-10 simplifies single-item `allOf`s with duplicate or impossible branches (fewer tabs in a `oneOf` view, intended); a single malformed value is dropped instead of copied (§8 Q9); JSON Schema documents merged without `rules` follow their `$schema` (a 2020-12 document's array `items` is now kept as a fragment instead of a tuple). It can show issues next to the rendered node (`path` / `sourcePointer`). |
| json-schema-tree | `merge(schema, {})` | only the `$schema` detection (output changes for 2019-09 / 2020-12 documents with tuples) and F-10 |
| api-diff-viewer | `apiMerge` from api-smart-diff 1.0.6 | asd 2.0 removed `apiMerge` (CHANGELOG): the viewer migrates to `apiCompare(...).merged` anyway. Document mode changes `merged` to normalized content; node mode keeps the original values. `CompareError.severity` is additive; a viewer that lists `result.errors` should group by severity. |
| api-doc-viewer | through api-model-tree | as api-model-tree |
| code generators (`merge(doc)`) | whole-document merge | `$schema` / `jsonSchemaDialect` detection, F-10, faster merges; `mergeWithIssues` gives them a list to fail a build on |
| custom rule authors | `mergeError(values)` in resolvers, `report(message, values)` in groups | keep working (mapped to `merge-conflict` / the message); `report(code, values)` is the new form |

Semver: all additions are options, fields and exports; the two legacy-report fixes and the output changes (F-10, malformed single values, `$schema` detection) go into the 1.0.0 CHANGELOG output-contract section, which is still unreleased.

## 6. Test plan

allof-merge (new `test/audit/b20.issues.test.ts`, `b21.fast-path.test.ts`, additions to `b16.decisions.test.ts` and the fuzz suite):

| # | Case | Expected |
|---|---|---|
| I1 | one test per code of §3.3 with the example input of the table | exactly one issue with that code, severity and category; `path`, `keyword`, `values` as listed; `sourcePointer` for a whole-document merge |
| I2 | every legacy site of §3.4 | `onMergeError` / `onRefResolveError` receive the same message, path and values as today (snapshot of the current outputs taken before the change), except the two documented fixes |
| I3 | new codes | never reach the legacy callbacks |
| I4 | `issueLevel` "error" / "warning" / "info" | filtering; no issue object is created below the level (spy on `MergeIssue` construction through a counting `onIssue`) |
| I5 | replay: `createMerger({ source })`, `merge(F)` twice, `merge(a)` with `a: allOf [$ref F]` | the `format-conflict` issue on every call; per-call `onIssue` overrides the merger's |
| I6 | de-duplication: the same conflict reached through two `$ref`s in one whole-document merge | one issue, `path` = first occurrence; the D-17 fallback reports its limit once |
| I7 | `mergeWithIssues` | `{ result, issues }` equal to `merge` + collected `onIssue` |
| I8 | `formatConflict` "keep" / "disjoint" / "unsatisfiable" | outputs of the §3.5 table for `date-time` ∧ `date`, `x-sku` ∧ `x-ean`, `email` ∧ `idn-email`, OpenAPI `int32` ∧ `int64` |
| I9 | `branch-removed` / `anyof-duplicate-removed` / `branch-kept-for-link` | issues for `oneOf: [{ allOf: [s, n] }, n]`, `anyOf: [s, s, n]` and the D-27 tainted case |
| I10 | `nullable-overridden` | OpenAPI 3.0 `allOf: [{ $ref: Base }], nullable: true` |
| I11 | `object-shape-kept` reasons | one case per reason |
| P1 | fast path equivalence | for every test resource, the fuzz corpus and the asd bench fixtures: output with the fast path deep-equal to the output without it (internal flag), and one output instance per input instance (B9.2.17) |
| P2 | fast-path conditions | one document per rule 1–8 of §3.6 that must not be skipped (incl. `{ anyOf: [40], oneOf: [40] }` with `mergeCombinarySibling`, B13.6.2) |
| P3 | `needsMerge` | true / false for the same inputs |
| P4 | performance gates | gql-github whole document ≤ 24.5 ms, js-allof-200 per node ≤ 3.4 ms, oas-github whole document ≤ 150 ms (bench script, not a unit test) |
| F10 | single-item forms | the §3.7 table; fuzz generator emits `allOf: [X]` / `allOf: [X, {}]`; idempotence property |
| S1 | `$schema` / `jsonSchemaDialect` detection | draft-04 / 06 / 07 / 2019-09 / 2020-12 / unknown; OpenAPI 3.1 with a draft-07 dialect; `openapi: "13.0"` not OpenAPI 3 |

api-smart-diff (blocks follow `docs/TEST_PLAN.md`):

| # | Case | Expected |
|---|---|---|
| N1 | example A in OpenAPI 3.0, request and response | the two `nullable` removals; one `normalize` warning `nullable-overridden`, side after |
| N2 | example B, `formatConflict` as decided | §4.6 row B; one `normalize` issue |
| N3 | example B' | no diffs |
| N4 | examples C, C', C'', `oneOf: [false, n]` → `oneOf: [n]` | no diffs; warnings as §4.6 |
| N5 | example D | the two diffs; warning `tuple-kept` |
| N6 | F-7 rows of §4.5 | as listed (new ISSUE) |
| N7 | forwarding | `kind: "normalize"`, `severity`, `code`, `side`, `path` = compare path + issue path, `source`; de-duplicated across scopes; `issueLevel` filtering; `onError` vs `result.errors` |
| N8 | mode equivalence | node vs document mode: identical diffs on the bench fixtures and on the corpus minus a documented list (JS-JSD-050 changes by decision C in both modes) |
| N9 | document mode specifics | usage index from the original documents (X-TBAPI-001 stays non-breaking); synthesized `allOf` still merged (JS-REF-008 … 011, JS-FRK-002, JS-REF-104, JS-JSD-061, OAS-OTK-003 unchanged); `merged` holds normalized values; a copied usage reports the inner change |
| N10 | merger cache key | two compares in one session with different `refAnnotations` / `formatConflict` do not share mergers |
| N11 | the 9 tests the gate breaks today (JS-JSD-061 × 6, B9.5, OAS-OTK-003 × 2) | unchanged expectations after the fix of §4.2 |
| N12 | performance | F-block tests, X-PERF-001, gate B2 bench rerun; F9 (4 000 levels) within its limit |

## 7. Effort, risk and order

| Step | Repo | Effort | Risk |
|---|---|---|---|
| 1. Issue model: types, `emit`, codes table, migration of the §3.4 sites, the two legacy fixes, silent sites | allof-merge | 2.5–3 days | medium: many sites; mitigated by the I2 snapshot test |
| 2. Replay and de-duplication | allof-merge | 1 day | medium: interacts with memo / done / container caches |
| 3. `formatConflict` | allof-merge | 0.5 day | low |
| 4. `$schema` / `jsonSchemaDialect` detection, `schemaMergeRulesFor` | allof-merge | 0.5 day | low (output change for 2020-12 documents, documented) |
| 5. Fast path + `needsMerge` | allof-merge | 1–1.5 days | medium: D-11 sharing and the link machinery; P1/P2 equivalence tests |
| 6. F-10 | allof-merge | 0.5 day | low (prototype passes the suite) |
| 7. F-11 rest (result cache, lazy call state, `mergeObjectShape` plain path) + json-crawl rule memo | allof-merge, json-crawl | 1.5–2 days | low–medium |
| 8. Docs, CHANGELOG, VERIFICATION §9, rebuild | allof-merge | 1 day | low |
| 9. Rules delegation and gate (incl. the 9 tests) | asd | 1.5–2 days | medium: classification changes in the corpus |
| 10. Issue forwarding, `CompareError` fields, README CI example | asd | 1 day | low |
| 11. F-7 anchor fix (+ follow-ups after Q11) | asd | 0.5 day | low |
| 12. Document mode | asd | 2–3 days | medium–high: `merged` contract, usage index, copies vs POLICY-57 |
| 13. Tests, compat report, bench, docs | asd | 1.5–2 days | low |

Order: json-crawl rule memo (with its 0.6.0 release) → allof-merge steps 6, 4, 5, 1, 2, 3, 7, 8 → publish allof-merge 1.0.0 → asd steps 11, 9, 10, 13 (release blocker set) → asd step 12 (document mode; can ship in 2.0.0 or follow in 2.1.0 without breaking anything, since node mode is the default).

## 8. Open questions for the user

Q1. **Two different formats in one `allOf`.** Input `{ allOf: [{ type: string, format: date-time }, { format: date }] }` (no string is both a date-time and a date), and a custom pair `{ allOf: [{ format: x-sku }, { format: x-ean }] }` (unknown meaning). Options: (a) keep both as `allOf` parts with a warning (today's output, asd reports "[Removed] type", "[Removed] format", "[Added] allOf"); (b) treat every differing pair as impossible: both inputs become `false` with a warning, asd reports "[Replaced] schema with `false`" (breaking); (c) impossible only for well-known formats with disjoint values (date, time, date-time, duration, ipv4, ipv6, uuid): the first input becomes `false`, the custom pair is kept with a warning; (d) last format wins (the old 0.6.8 behaviour) with an info issue. Recommendation: a merge option with (a) as the library default and (c) chosen by api-smart-diff. Refs: §3.5, D-2, D-14.

Q2. **Different values of a keyword that is merged by "last wins".** Inputs `{ allOf: [{ title: A }, { title: B }] }` → `{ title: B }`; `{ allOf: [{ "x-owner": team-a }, { "x-owner": team-b }] }` → `team-b`; OpenAPI `{ allOf: [{ discriminator: { propertyName: kind } }, { discriminator: { propertyName: type } }] }` → `type`; draft-07 `{ allOf: [{ prefixItems: [string] }, { prefixItems: [number] }] }` → `[number]` (unknown keyword in draft-07). Is the dropped value "ignored" in the sense of "highlight as issue"? Options: (a) no issue (today); (b) an info issue for every differing last-wins value; (c) a warning for `discriminator`, vendor and unknown keywords and an info issue for annotations (`title`, `description`, `default`, `example`). Recommendation: (c). Refs: D-19, code `keyword-last-wins`.

Q3. **How serious is "no value is valid".** Input `{ properties: { id: { allOf: [{ type: string }, { type: number }] } } }` → `id: false`. The schema is still valid JSON Schema, but probably not what the author meant. Options: (a) warning (issue level "warning"; CI fails only on errors); (b) error. Recommendation: (a), with errors reserved for invalid input (malformed values, broken or cyclic `$ref`). Refs: codes `unsatisfiable`, `unsatisfiable-combinator`.

Q4. **Where api-smart-diff puts warnings.** Today `result.errors` (or `onError`) only holds real errors, and the README tells CI scripts to fail when it is non-empty. With normalization warnings, the example `{ oneOf: [{ allOf: [string, number] }, number] }` → `{ oneOf: [number] }` produces no diff but one warning. Options: (a) one list `errors` with a `severity` field per entry (CI scripts filter `severity === "error"`; README updated); (b) a separate `result.warnings` list and `onWarning` callback, `errors` unchanged. Recommendation: (a). Refs: §4.4.

Q5. **Issues for parts that did not change.** Before and after are the same OpenAPI document, and `components.schemas.Date` holds `allOf: [{ format: date-time }, { format: date }]`. In node mode asd never merges unchanged parts, so no warning is reported; in document mode the warning is reported once per document. Options: (a) accept: node mode reports only what it compares, document mode reports everything; (b) node mode also scans both whole documents for issues (costs about one document normalization, §4.1 timings). Recommendation: (a). Refs: §4.1.

Q6. **Default api-smart-diff mode.** Large documents with few changes (GitHub REST: node mode 151 ms, document mode about 330 ms after the speed-ups) versus `allOf`-heavy small documents (js-allof-200: 27.8 ms vs 17.9 ms). Options: (a) node mode by default, document mode on request; (b) document mode by default. Recommendation: (a). Refs: §4.1.

Q7. **"allof-merge defaults" and the `$ref`-sibling options.** asd reads `{ $ref: Name, maxLength: 3 }` as "Name and at most 3 characters" (it merges `$ref` siblings in JSON Schema, OpenAPI and AsyncAPI) and keeps GraphApi `{ $ref, description }` usages nominal; allof-merge's default is not to merge `$ref` siblings outside `allOf`. Options: (a) keep asd's sibling settings (compare semantics) and take every other default from allof-merge; (b) use allof-merge's defaults for these too (`{ $ref: Name, maxLength: 3 }` would then be compared as written, and asd's own transform would keep wrapping it into `allOf`). Recommendation: (a). Refs: §4.2, ISSUE-53, AD-28.

Q8. **Information-level issues.** A link rewritten to its merged location, a duplicate `anyOf` branch removed, `int32` ∧ `int64` narrowed to `int32`, an `$id` of an inlined target dropped: nothing is lost, but the output differs from the input. Options: (a) not delivered by default (`issueLevel: "warning"`), available with `issueLevel: "info"`; (b) delivered by default. Recommendation: (a). Refs: §3.3.

Q9. **A single malformed value.** Input `{ allOf: [{ required: true }, { type: object }] }`. Today the output is `{ type: object, required: true }` without a report, while `{ allOf: [{ required: true }, { required: [a] }] }` drops `true` and reports. Options: (a) always drop the malformed value and report an error; (b) keep a lone value as written (today) but report it; (c) keep today's behaviour. Recommendation: (a). Refs: D-6, code `malformed-value`.

Q10. **Document mode `merged` content.** In document mode the compared documents are normalized, so `result.merged` would show `{ type: string, format: int32 }` where the input had `allOf: [{ $ref: Int }, { format: int32 }]`. Options: (a) accept and document (node mode keeps original values); (b) allof-merge provides an origin map so asd can rebuild original values (extra work, 1–2 days). Recommendation: (a) for 2.0.0, (b) only if a viewer needs it. Refs: §4.1.

Q11. **Identity keywords after the anchor fix.** Before `q: { $ref: "#foo" }` (target has `$anchor: foo`, `type: string`), after `q: { $ref: "#bar" }` (target has `$anchor: bar`, `type: number`). With the fix asd reports "[Replaced] annotation ($anchor) of `q`" besides the type change, and a usage naming the same anchor on both sides reports a change inside the target at the usage as well as at the declaration. Options: (a) ignore the target's `$anchor` / `$id` at usages and treat anchor references like pointer references for declaration-only reporting; (b) keep the output of the fix. Recommendation: (a). Refs: §4.5, F-7, POLICY-57.

## 9. User decisions (2026-11-18)

| Question | Decision |
|---|---|
| Q1 formats | Always impossible: any two different `format` values in one conjunction make the schema `false` (also overlapping pairs such as `uri` ∧ `uri-reference`, and unknown formats), reported as an issue. Replaces "keep parts" (D-2) and the proposed `formatConflict` option. Confirmed exception: the OpenAPI numeric narrowing (int32 ∧ int64 → int32, float ∧ double → float) stays under the OpenAPI rules and is not an issue (rule-defined); every other differing pair → `false` + error. |
| Q2 last-wins conflicts | No issue: "only issue should be highlighted, do not need info — it is part of rules". A value resolved by a merge rule (last wins for title/description/x-*/discriminator/unknown keywords, or any custom rule) is not "ignored" and is not reported. |
| Q8 info level | No info-level issues at all (follows from Q2): rule-defined outcomes (link rewrites, dedupes, numeric format narrowing, dropped identity keywords of inlined targets) are not issues. Severities are only `error` and `warning`. |
| Q3 contradiction severity | Error: a schema that can match nothing (`allOf: [{type: string}, {type: number}]` → `false`) is reported with severity `error`. |
| Q4 asd delivery | One list: asd's `errors` / `onError` carry normalization issues with `kind: "normalize"`, `severity`, `code`, `side`; README CI example filters `severity === "error"`. |
| Q5 unchanged parts in per-schema mode | Report only what is compared; whole-document mode reports everything. |
| Q6 default asd mode | Per-schema (`normalization: "node"`); whole-document on request. |
| Q7 `$ref` siblings in asd | Keep asd's settings (merge siblings in JSON Schema / OpenAPI / AsyncAPI, GraphApi refs nominal); every other default from allof-merge. |
| Q9 lone malformed value | Always drop and report an error. |
| Q10 `merged` in whole-document mode | Accept normalized content; document it. |
| Q11 anchor refs in asd | Treat like pointer refs: ignore the target's `$anchor`/`$id` at usages, report changes inside the target once at its declaration. |

Severity consequences to settle in implementation (self-decided unless the user objects): errors — contradictions (incl. format conflicts and impossible combinators), malformed values, broken/cyclic `$ref`; warnings — anything kept unmerged as `allOf` parts (backreference patterns, several `contains`, several if/then/else, `unevaluated*` items, patternProperties × additionalProperties fallbacks, multipleOf without exact LCM, 2020-12 array `items`, non-JSON schemaFormat wrappers), limits hit (branch budget, ref expansion, expansion budget, max depth, pattern-matching caps), impossible branches removed (the branch itself was a contradiction → reported as warning at the branch since the combinator stays satisfiable), nodes kept unmerged for `$ref` validity, copies made instead of links.

## 10. Implementation status in allof-merge (2026-11-18)

Implemented in this repository (steps 1–8 of §7; the api-smart-diff steps 9–13 are not part of this repository and are not started). The §9 decisions supersede §3 where they differ: two severities only (`error`, `warning`), no info-level codes, no `formatConflict` option.

| Design item | Status | Where |
|---|---|---|
| Issue type, `onIssue`, `issueLevel`, `mergeWithIssues`, `MERGE_ISSUES`, per-call `onIssue` | done | `src/issues.ts`, `src/merge.ts` (`emit`, `offer`, `mergeWithIssues`) |
| Codes | 28 codes (§3.3 without the info codes and `format-conflict`, plus `reason: "invalid-pattern"` for `object-shape-kept`) | `MERGE_ISSUES`, README "Issues" |
| Legacy callbacks | fire for the M / R codes with the old messages; new codes never reach them; the D-17 double report and the generic per-key message are fixed | `emit`, `test/audit/b21.issues.test.ts` B21.2 |
| Replay and de-duplication | issues recorded per output (frames, memo entries, result cache) and replayed with the current path; one issue per (code, node, keyword, ref, reason) per call; D-17 rounds share their keys, so each issue (and legacy call) is delivered once per merge | `record`, `replay`, `carry` |
| Q1 formats | different formats → `false` + `unsatisfiable` (`reason: "format"`); OpenAPI lattice unchanged, no issue | `src/groups/format.ts` |
| Q3 contradiction severity | `error` | `MERGE_ISSUES` |
| Q9 lone malformed value | dropped + `malformed-value` for the validated per-key keywords | `singleValueValidators`, `src/intersect.ts` |
| `nullable-overridden` | warning (kept: an input value without effect is "ignored" in the sense of decision B) | `src/groups/type.ts` |
| `link-copied` | warning (§9 last paragraph); `link-rewritten` is not an issue (Q8) | `relink` |
| Fast path (§3.6, rules 1–8) and `needsMerge` | done; scan and copy fused in one post-order pass, copies shared per merger | `scan`, `cleanCopy`, `refsKeepMeaning` |
| P1 `ownersOf` guard | done (only nodes whose subtree needs work are owners; the visit-time check runs in whole-document mode only) | `ownersOf` |
| Per-merger result cache (fragment mode) | done | `results` in `createMerger` |
| F-10 | done | single-item exit hook in `visit` |
| §3.9 rule auto-selection, `schemaMergeRulesFor` | done (`$schema`, `jsonSchemaDialect`, exact OpenAPI versions; `jsonSchemaDraftOf`) | `selectMergeRules` |
| Lazy whole-document call state, `mergeObjectShape` plain path | not done (the targets are met without them) | — |
| json-crawl rule memo | done in json-crawl 1.0.0 by its own work (rules resolved without per-node closures, `a8bab8a`) | `vendor/json-crawl-1.0.0-a8bab8a.tgz` |
| Tests (§6 I1–I11, P1–P3, F10, S1) | done | `test/audit/b21.issues.test.ts`, `test/audit/b22.fast-path.test.ts` |

Measurements (esbuild bundles of `src`, Node 26.13, min of 15, the asd bench fixtures): GraphApi github whole document 46 → 17 ms (target ≤ 24.5), oas-github 232 → 120 ms (target ≤ 150), js-allof-200 per node 6.5 → 3.6 ms (the target 3.4 ms was set on a machine where the baseline was 4.8–5.1 ms; relative to the baseline the target is met), 200 warm per-node calls 1.2 → 0.04 ms; identical outputs on all three documents.

Deviation to note: `format` constrains strings only, so with a format-asserting validator the Q1 output `false` rejects non-string instances that `{ allOf: [{ format: date }, { format: email }] }` accepts when no `type` excludes them. The fuzz oracle skips such cases (`decidedFormatDeviation` in `test/fuzz/oracle.ts`).
