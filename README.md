# allof-merge
<img alt="npm" src="https://img.shields.io/npm/v/allof-merge"> <img alt="npm" src="https://img.shields.io/npm/dm/allof-merge?label=npm"> ![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/udamir/allof-merge/ci.yml)
 <img alt="npm type definitions" src="https://img.shields.io/npm/types/allof-merge"> ![Coveralls branch](https://img.shields.io/coverallsCoverage/github/udamir/allof-merge) <img alt="GitHub" src="https://img.shields.io/github/license/udamir/allof-merge">

Merge schemas with allOf into a more readable composed schema free from allOf.

## Features
- Safe merging of schemas combined with allOf in whole document
- Fastest implementation - up to x3 times faster than other popular libraries, linear in document depth and in the number of `$ref` usages
- Merged schema does not validate more or less than the original schema
- A contradictory conjunction becomes the boolean schema `false` (or `{ not: {} }`), never a silently dropped keyword
- Correctly merge additionalProperties, patternProperties and properties taking into account common validations
- Correctly merge items, additionalItems and prefixItems taking into account common validations (tuple keywords per draft)
- Keyword-aware merging of `type` (integer ⊂ number), numeric bounds (incl. draft-04 boolean exclusive flags), `pattern`, `enum`/`const`, `contains`, `dependencies`/`dependentRequired`/`dependentSchemas`, `if`/`then`/`else`
- Supports custom rules to merge other document types and JsonSchema versions (draft-04, draft-06, draft-07, 2020-12), incl. rules for vendor keys (`x-go-type`) and key prefixes (`x-`) in JSON Schema, OpenAPI and GraphApi documents
- Supports input with circular references (javaScript references); the output is never a cyclic object
- Supports $refs and circular $refs either (internal references only, incl. `$anchor` / `$id: "#name"` plain-name fragments)
- Bounded work on hostile input: per-call branch budget, `$ref` expansion limits, depth limit, bounded pattern matching (no ReDoS), prototype-safe handling of `__proto__` / `constructor` keys
- Correctly merge of $refs with sibling content (optionally)
- Correctly merge of combinaries (anyOf, oneOf) with sibling content (optionally)
- AsyncAPI 2.x and 3.x documents (auto-detected): payloads and headers per `schemaFormat`, Multi Format Schema Objects, schema fields of protocol bindings
- Control over annotations inherited through `$ref` (`refAnnotations`): keep a `$ref` target's `title` / `description` out of the schemas that extend it (code generators)
- Always-safe simplifications of the merged output (duplicate `anyOf` branches, duplicate kept `allOf` parts, repeated `oneOf`/`anyOf` groups, impossible branches), each switchable, plus opt-in exact `simplify` rules (enum filtered by type, typed bound contradictions, redundant bounds, …)
- Reusable merger (`createMerger`) that shares the resolution index and merged results between calls
- Typescript syntax support out of the box
- No dependencies (except json-crawl 1.0, inlined in the bundles), can be used in nodejs or browser

## Works perfectly with specifications:

- [JsonSchema](https://json-schema.org/draft/2020-12/json-schema-core.html)
- [OpenApi 3.x](https://github.com/OAI/OpenAPI-Specification/blob/main/versions/3.0.3.md)
- [GraphApi](https://github.com/udamir/graphapi)
- ~~Swagger 2.x~~ (roadmap)
- [AsyncApi 2.x](https://www.asyncapi.com/docs/reference/specification/v2.6.0)
- [AsyncApi 3.x](https://www.asyncapi.com/docs/reference/specification/v3.0.0)

## Other libraries
There are some libraries that can merge schemas combined with allOf. One of the most popular is [mokkabonna/json-schema-merge-allof](https://www.npmjs.com/package/json-schema-merge-allof), but it has some limitatons: Does not support circular $refs and no Typescript syntax out of the box.

## External $ref
If schema contains an external $ref, you should bundle it via [api-ref-bundler](https://github.com/udamir/api-ref-bundler) first.

## Installation
```SH
npm install allof-merge --save
```

## Usage

### Nodejs
```ts
import { merge } from 'allof-merge'

const data = {
  type: ['object', 'null'],
  additionalProperties: {
    type: 'string',
    minLength: 5
  },
  allOf: [{
    type: ['array', 'object'],
    additionalProperties: {
      type: 'string',
      minLength: 10,
      maxLength: 20
    }
  }]
}

const onMergeError = (msg) => {
  throw new Error(msg)
}

const merged = merge(data, { onMergeError })

console.log(merged)
// {
//   type: 'object',
//   additionalProperties: {
//     type: 'string',
//     minLength: 10,
//     maxLength: 20
//   }
// }

```

### Browsers

A browser version of `allof-merge` is also available via CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/allof-merge@latest/browser/allof-merge.min.js"></script>
```

Reference `allof-merge.min.js` in your HTML and use the global variable `AllOfMerge`.
```HTML
<script>
  var merged = AllOfMerge.merge({ /* ... */ })
</script>
```

## Documentation

### `merge(data: any, options?: MergeOptions)`
Create a copy of `data` with merged allOf schemas. Rules are selected from the input unless `options.rules` is given (`selectMergeRules`): `openapi: "3.0"` / `"3.0.x"` → OpenAPI 3.0 rules, `openapi: "3.1.x"` or a later 3.x → OpenAPI 3.1 rules (with the draft named by `jsonSchemaDialect` for the schemas, 2020-12 by default), `asyncapi: 2.x` / `3.x` → AsyncAPI rules, `graphapi` → GraphApi rules, otherwise JSON Schema rules of the draft named by `$schema` (draft-04, draft-06, draft-07, 2019-09 and 2020-12 → the 2020-12 rules; draft-06 when `$schema` is absent or unknown). Version strings are matched exactly: `openapi: "13.0"` is not OpenAPI 3.

### `mergeWithIssues(data: any, options?: MergeOptions): { result, issues }`
`merge` that also returns the issues of the merge (see "Issues"), at or above `options.issueLevel`.

```ts
import { mergeWithIssues } from 'allof-merge'

const { result, issues } = mergeWithIssues(document)
for (const issue of issues) {
  console.log(issue.severity, issue.code, issue.sourcePointer ?? issue.path.join("/"), issue.message)
}
if (issues.some((issue) => issue.severity === "error")) { process.exit(1) }
```

### `createMerger(options?: MergeOptions): { merge, hook, needsMerge }`
Creates a reusable merger. `merger.merge(data, { rules?, source?, onIssue? })` behaves like `merge` (`onIssue` replaces the merger's sink for that call, so one cached merger can serve callers with different contexts), and `merger.hook` is the json-crawl clone hook (same as `allOfResolverHook(options)`). `merger.needsMerge(value)` tells whether merging `value` can produce anything but a plain copy: false for a subtree without `allOf` and without the forms the merger's options rewrite (a `$ref` with siblings under `mergeRefSibling`, a `oneOf`/`anyOf` with siblings under `mergeCombinarySibling`, a literal `false` branch under `dropFalseBranches`, duplicate `anyOf` branches under `dedupeAnyOf`), so a consumer can skip the call. The merger keeps its resolution index (per `source` instance), the memo of merged conjunctions (per rules object) and the sibling-spread cache for its lifetime, so calling it for many nodes of one document (or for several documents sharing `$ref` targets) costs about one merge of the whole document.

- Merged conjunctions of the same item instances share their output instance between calls (and within one result), and so do copies of subtrees that need no merging; a repeated `merger.merge(node, { source })` call returns the result of the first call (and reports the same issues). Do not mutate results in place when you reuse a merger, or pass `freezeOutput: true` to get deep-frozen results. A server that caches one merger for documents of different tenants should use `freezeOutput: true` or a merger per tenant.
- The input documents must not be mutated while a merger is in use: the resolution index and the memo are keyed by object identity and are not invalidated (create a new merger after changing a document).
- When the raw `hook` (or `allOfResolverHook`) is used with json-crawl's `syncClone`, pass `{ circular: false }` (as `merge` does): the hook keeps its own identity memo and cycle detection, and json-crawl's identity memo would otherwise reintroduce shared cyclic instances. The raw hook runs one clone pass: it rewrites links (D-22, see Output contract) when the root is finished, but it does not apply the D-17 fallback re-merge; use `merge`/`merger.merge` for whole documents.

```ts
import { createMerger } from 'allof-merge'

const merger = createMerger({ source: document })
const merged = merger.merge(document.components.schemas.Pet)
```


### Merge options
```ts
interface MergeOptions {
  // source document if merging only part of it
  // (optional) default = data
  source?: any          
  
  // custom merge rules
  // (optional) default = auto select based on the input (jsonSchemaMergeRules, openApiMergeRules, graphapiMergeRules)
  rules?: MergeRules    

  // merge $ref with sibling content
  // (optional) default = false
  mergeRefSibling?: boolean  

  // merge anyOf/oneOf with sibling content
  // (optional) default = false
  mergeCombinarySibling?: boolean  

  // Merge error hook, called on any merge conflicts
  onMergeError?: (message: string, path: JsonPath, values: any[]) => void

  // Ref resolve error hook, called on broken ref
  onRefResolveError?: (message: string, path: JsonPath, ref: string) => void

  // every issue of the merge (see "Issues"): parts the merge drops, ignores or keeps unmerged,
  // invalid input, contradictions, limits; reported on every call of a merger
  onIssue?: (issue: MergeIssue) => void

  // minimum severity delivered to onIssue / mergeWithIssues
  // (optional) default = "warning" (every issue)
  issueLevel?: "error" | "warning"

  // representation of a contradictory (unsatisfiable) schema in the output:
  // "false" writes the boolean schema false, "not-empty" writes { not: {} }
  // (optional) default = "false"
  unsatisfiable?: "false" | "not-empty"

  // maximum number of oneOf/anyOf combinations produced by one merge() call
  // (all nodes together, incl. the mergeCombinarySibling distribution); above it
  // the node is left unchanged and onMergeError is called
  // (optional) default = 1024
  branchBudget?: number

  // match property names against the patternProperties of other items
  // (needed to merge properties with another item's additionalProperties);
  // patterns/names longer than the limits and patterns with nested quantifiers
  // are never executed - the object shapes are then kept as allOf fragments
  // (optional) default = true ({ maxPatternLength: 256, maxNameLength: 256 })
  matchPatterns?: boolean | { maxPatternLength?: number, maxNameLength?: number }

  // maximum number of times one $ref target is inlined per merge() call;
  // further usages keep their allOf with the $ref and onMergeError is called once per target
  // (optional) default = 10000
  maxRefExpansion?: number

  // maximum number of schema nodes copied in by $ref inlining per merge() call
  // (the size of every inlined target counts); above it the remaining nodes keep
  // their allOf with the $ref and onMergeError is called once
  // (optional) default = 2000000
  expansionBudget?: number

  // nodes deeper than this are copied without merging (onMergeError once)
  // (optional) default = 2000
  maxDepth?: number

  // deep-freeze the merged output
  // (optional) default = false
  freezeOutput?: boolean

  // annotations that a merged node gets only through a $ref (#222):
  // "merge" promotes them (the target's title becomes the title of the schema that extends it),
  // "omit" drops title, description and $comment (DEFAULT_OMITTED_ANNOTATIONS),
  // a list drops the listed keys (an entry ending with "*" is a prefix, e.g. "x-*");
  // the node's own values always stay
  // (optional) default = "merge"
  refAnnotations?: "merge" | "omit" | string[]

  // always-safe simplifications (equivalences), each one on by default:
  // identical anyOf branches are kept once (never oneOf branches)
  dedupeAnyOf?: boolean            // (optional) default = true
  // identical allOf parts that are kept next to the merged keywords are kept once
  dedupeFragments?: boolean        // (optional) default = true
  // identical oneOf/anyOf groups of different allOf items are combined once,
  // before the cartesian product is computed and counted against branchBudget
  dedupeCombinaryGroups?: boolean  // (optional) default = true
  // impossible (false) oneOf/anyOf branches are removed; when every branch is
  // impossible the node is a contradiction (false)
  dropFalseBranches?: boolean      // (optional) default = true

  // form-changing simplifications of merged nodes (exact, see "Simplifications"):
  // true = every rule, or a selection
  // (optional) default = false
  simplify?: boolean | {
    enumByType?: boolean           // enum / const members the type cannot admit are removed
    contradictions?: boolean       // typed contradictions become false (or the kind leaves the type list)
    redundantBounds?: boolean      // minimum + exclusiveMinimum (draft-06+) -> the tighter bound
    containsToMinItems?: boolean   // contains: true / {} -> minItems >= 1 (draft-06/07 rules only)
  }
}
```

A merger's options are fixed for its lifetime, so its memo and caches never mix results of different `refAnnotations` / simplification settings. A consumer that caches mergers (or merged output) per option set must include these options in its cache key.

The limits keep the work and the output size bounded for hostile input (exponential `$ref` fan-out, deep nesting, huge `oneOf` products). The defaults are far above what real documents need: the GitHub REST (14 MB), Stripe, Asana, Kubernetes and Bitbucket specifications inline one target at most 111 times and copy at most 4 777 nodes in total.

### Issues

Every place where the output is not "each keyword of each `allOf` item merged into one equivalent keyword" is reported as an issue, unless an option asked for it (`refAnnotations: "omit"`, `dropFalseBranches: false`, …) or a merge rule defines the outcome (last-wins annotations and vendor keys, the OpenAPI numeric format lattice, duplicates removed by the dedupe options, links rewritten to their merged location, identity keywords of inlined targets): those are not issues.

```ts
interface MergeIssue {
  code: MergeIssueCode              // stable identifier, table below (MERGE_ISSUES)
  severity: "error" | "warning"
  category: "input" | "unresolved" | "contradiction" | "kept" | "limit" | "removed" | "rewritten"
  message: string                   // the onMergeError / onRefResolveError message where one exists
  path: JsonPath                    // output location relative to the merged value (what onMergeError receives)
  sourcePointer?: string            // "#/components/schemas/Pet": the input node in `source` where the issue surfaces
  keyword?: string                  // the keyword concerned ("format", "oneOf", "allOf", …)
  values?: unknown[]                // the values involved
  ref?: string                      // the $ref concerned
  reason?: string                   // sub-cause (unsatisfiable, object-shape-kept)
}
```

| Code | Severity | When | Legacy callback |
|---|---|---|---|
| `malformed-value` | error | a keyword value of the wrong type is ignored (`required: true`, `enum: null`, `minLength: -1`, …), also a lone one | onMergeError |
| `malformed-allof` | error | `allOf` is not an array (ignored, the rest of the node is kept) | onMergeError |
| `malformed-allof-item` | error | an `allOf` item that is not a schema | onMergeError |
| `broken-ref` | error | a local `$ref` that does not resolve (the node keeps it) | onRefResolveError |
| `ref-cycle` | error | a `$ref` → `$ref` chain that comes back to itself | onRefResolveError |
| `cyclic-value` | error | a cyclic JavaScript value outside `source`, replaced by `{}` | onMergeError |
| `pattern-invalid` | error | an invalid regular expression, kept as a `pattern` part | onMergeError |
| `unsatisfiable` | error | no value satisfies the conjunction, the schema is `false`; `reason`: `type`, `enum`, `const`, `bounds`, `format`, `false-item`, `simplify` (not raised inside a `oneOf`/`anyOf` branch) | onMergeError (not for `false-item`) |
| `unsatisfiable-combinator` | error | every `oneOf`/`anyOf` branch became impossible | onMergeError |
| `external-ref` | warning | an external `$ref` in `allOf` (or next to siblings under `mergeRefSibling`) is kept | onRefResolveError (in `allOf` only) |
| `branch-removed` | warning | an impossible `oneOf`/`anyOf` branch is removed (`path` is its index before removal) | — |
| `branch-kept-for-link` | warning | an impossible branch is kept because a pointer of the output targets a later branch | — |
| `pattern-kept` | warning | patterns with backreferences / named groups kept as `allOf` parts | — |
| `contains-kept` | warning | different `contains` kept as `allOf` parts | — |
| `conditional-kept` | warning | several `if`/`then`/`else` kept as `allOf` parts | — |
| `unevaluated-kept` | warning | an item with its own `unevaluatedProperties`/`unevaluatedItems` kept as an `allOf` part | — |
| `object-shape-kept` | warning | object shapes kept as `allOf` parts; `reason`: `pattern-interaction`, `match-limit`, `nested-quantifier`, `invalid-pattern`, `test-budget` | — |
| `multipleof-kept` | warning | `multipleOf` values without an exact least common multiple | onMergeError |
| `tuple-kept` | warning | 2020-12: an array-valued `items` kept as an `allOf` part | onMergeError |
| `schema-format-kept` | warning | AsyncAPI 3: a `$ref` to a schema in a non-JSON-Schema format kept as an `allOf` part | onMergeError |
| `kept-for-link` | warning | a node kept unmerged because a `$ref` of the output points through it (D-17) | — |
| `branch-budget` | warning | `oneOf`/`anyOf` combinations over `branchBudget` | onMergeError |
| `ref-expansion-limit` | warning | a `$ref` target inlined more than `maxRefExpansion` times (once per target) | onMergeError |
| `expansion-budget` | warning | `expansionBudget` exhausted (once per call) | onMergeError |
| `max-depth` | warning | nodes deeper than `maxDepth` copied without merging (once per call) | onMergeError |
| `nullable-overridden` | warning | OpenAPI 3.0: `nullable: true` has no effect because another item with a `type` forbids `null` | — |
| `link-copied` | warning | a `$ref` replaced by a copy of its original target (the merged location holds a different value, D-22) | — |
| `merge-conflict` | warning | a custom resolver called `ctx.mergeError(values)` or a custom group reported without a code | onMergeError |

`onMergeError` and `onRefResolveError` keep their signatures and fire for the codes in the last column with the same messages as before; new codes never reach them. A merger reports the same issues on every call: issues are recorded with the output that raised them and replayed (with the current location) when a memoized output is reused. Within one call an issue is delivered once per code, node and keyword. Custom resolvers can report with a code: `ctx.report?.(code, values, { message, keyword, reason })`; custom groups pass a hint as the third argument of `report(message, values, { code })`.

### Annotations inherited through `$ref` (`refAnnotations`)
By default the merged node of `{ allOf: [{ $ref: Base }, …] }` gets every keyword of `Base`, annotations included, so a code generator that names classes by `title` sees `Derived` titled `Base` (#222). `refAnnotations: "omit"` drops `title`, `description` and `$comment` that arrive only through a `$ref` (also through the target's own `allOf` members); a list such as `["title", "x-*"]` drops exactly those keys (`*` at the end is a prefix). The rest of the target is merged as before.

```ts
const doc = { components: { schemas: {
  Base:    { title: "Base", description: "Base entity", type: "object", properties: { id: { type: "string", title: "Id" } } },
  Derived: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { name: { type: "string" } } }] },
  Titled:  { title: "Titled", allOf: [{ $ref: "#/components/schemas/Base" }] },
} } }
merge(doc, { refAnnotations: "omit" })
// Derived: { type: "object", properties: { id: { type: "string", title: "Id" }, name: { type: "string" } } }
// Titled:  { type: "object", properties: { … }, title: "Titled" }
```

- The node's own annotations always stay: its siblings (`Titled.title`), siblings of a `$ref` allOf item (`{ allOf: [{ $ref: Base, title: "Explicit" }] }`), inline `allOf` members (written in place, last wins as before), the siblings merged by `mergeRefSibling` (`{ $ref: Base, description: "override" }` keeps `description: "override"`). A key present on the node and through the `$ref` keeps the node's value.
- Values inside the target (`Base.properties.id.title`) are not node-level and stay.
- A reference resolution is not a merge: a `$ref` that the link rules replace by a copy of its target keeps the target's annotations, and with `mergeCombinarySibling` a `oneOf`/`anyOf` branch that is a `$ref` keeps its target's `title`/`description` (documentation viewers label branches by them).
- A branch of a `oneOf`/`anyOf` product (groups multiplied, D-26) keeps the annotations of its `$ref` components, like a single `$ref` branch; where several components carry the same annotation, the keyword's merge rule decides as for any other merge. `allOf: [{ oneOf: [{ $ref: Cat }, { $ref: Dog }] }, { oneOf: [{ $ref: Indoor }] }]` (titles `Cat`, `Dog`, `Indoor`) gives two branches titled `Indoor` with the default last-wins `title` rule, `Cat` and `Dog` with a custom `"/title": { $: (values) => values[0] }`, `Cat & Indoor` with `(values) => values.join(" & ")`. The same holds when `mergeCombinarySibling` distributes the node's siblings into such branches. Annotations of `$ref`s at the node level (`allOf: [{ $ref: Base }, { oneOf: … }]`) and of `$ref`s inside a component's own `allOf` are still dropped.
- Annotations do not validate: the output validates exactly like the input.

### Simplifications
The merge removes redundant forms it would otherwise produce. Four of them are always equivalences and are on by default (each can be switched off): `dedupeAnyOf` (`A ∨ A ≡ A`; never applied to `oneOf`, where `oneOf [A, A, B]` means `¬A ∧ B`), `dedupeFragments` (`A ∧ A ≡ A` for the parts kept as `allOf` fragments: different `contains`, `if`/`then`/`else`, formats, `{ $ref }` items with their own `unevaluated*`), `dedupeCombinaryGroups` (identical, order-sensitive `oneOf`/`anyOf` groups of different items are combined once: `allOf: [G, G, G]` with `G = { oneOf: [string, number, boolean] }` gives `G`'s three branches instead of 27, and six copies of a 4-branch group no longer exceed the branch budget) and `dropFalseBranches` (an impossible branch never counts for `oneOf` or `anyOf`: `{ oneOf: [string, false, number] }` → `{ oneOf: [string, number] }`; every branch impossible → the node is a contradiction, `false` or `{ allOf: [false], $defs: … }`). The two branch rules apply to every `oneOf`/`anyOf` at a schema location of the merged output, the two dedupes to merged nodes. A `$ref` into a branch whose index shifts links the branch at its new index (D-27): `X = { oneOf: [<impossible>, { type: integer }, { type: boolean }] }` → `X = { oneOf: [{ type: integer }, { type: boolean }] }`, `{ $ref: "#/…/X/oneOf/2" }` → `{ $ref: "#/…/X/oneOf/1" }`, also below the branch (`…/anyOf/3/properties/a` → `…/anyOf/2/properties/a`) and through nested shifted lists; a pointer to an `anyOf` duplicate that `dedupeAnyOf` removed links the equal branch that is kept; a pointer to a removed impossible branch is a copy of it (`false`). Positions of kept `allOf` fragments are not addressable by input pointers (an input `allOf/<i>` step is matched by removing it), so `dedupeFragments` shifts nothing a pointer can target.

`simplify` (off by default) adds rules that change the output form more visibly. Every rule is exact under the draft of the rule set (checked by the property-based test, `npm run test:fuzz`) and runs on merged nodes only, never on schemas the merge did not rewrite; consumers that diff merged against unmerged schemas should keep it off.

| Rule | Example input (`allOf` items) | Output with `simplify: true` | Guard |
|---|---|---|---|
| `enumByType` | `{ type: string }`, `{ enum: [a, 1, null] }` | `{ type: string, enum: [a] }`; `{ type: null }`, `{ const: 0 }` → `false` | typed nodes only; OpenAPI 3.0 `nullable: true` admits `null`; not under GraphApi rules |
| `contradictions` (bounds) | `{ type: number, minimum: 15 }`, `{ maximum: 10 }` | `false` (reported) | the type admits only the bounded kind; untyped bounds (`{ minimum: 15, maximum: 10 }` accepts `"x"`) stay silently |
| `contradictions` (multi-type) | `{ type: [number, string], minimum: 15 }`, `{ maximum: 10 }` | `{ type: string }` | the kind and its bounds leave the type list; `integer` with no integer in the interval too |
| `contradictions` (counts) | `minLength > maxLength`, `minItems > maxItems`, `minProperties > maxProperties`, more `required` names than `maxProperties`, `minContains > maxContains` (2020-12) | `false` or the kind removed | typed nodes only |
| `contradictions` (required) | `{ type: object, required: [a] }`, `{ properties: { a: false } }` | `false` | object-only type; also a required name `additionalProperties: false` rejects (no `patternProperties`) |
| `contradictions` (contains) | `{ type: array }`, `{ contains: false }` | `false` | array-only type, no `minContains: 0` |
| `containsToMinItems` | `{ type: array, contains: true }`, `{ minItems: 0 }` | `{ type: array, minItems: 1 }` | draft-06/07 rule sets only (with `unevaluatedItems`, 2020-12, `contains` marks items as evaluated) |
| `redundantBounds` | `{ minimum: 5, exclusiveMinimum: 3 }`, `{ maximum: 10, exclusiveMaximum: 10 }` | `{ minimum: 5, exclusiveMaximum: 10 }` | draft-06+ (draft-04 has boolean flags) |

Never applied, because they are not equivalences: deduplicating `oneOf` branches, dropping `contains: true` (`[]` is rejected by it), collapsing untyped contradictions, dropping an `if` without `then`/`else` (2020-12 `unevaluated*` sees its annotations).

### Output contract
- A contradiction (`type: string ∧ type: number`, disjoint `enum`, different `const`, `allOf` with `false`, …) is written as `false` (or `{ not: {} }` with `unsatisfiable: "not-empty"`); a property with an impossible schema stays in `properties` as `false`. `onMergeError` is called with the conflicting values.
- An impossible `oneOf`/`anyOf` branch is removed (`dropFalseBranches`, default); when every branch is impossible the node is a contradiction and `onMergeError` is called once for the combinary (not when the input combinary was already impossible). With `dropFalseBranches: false` impossible branches stay in the array as `false` (the earlier 1.0.0 contract). Identical `anyOf` branches are kept once (`dedupeAnyOf`), see "Simplifications".
- `enum` and `required` keep the first-seen order without duplicates; the `allOf` items come first, then the node's own (sibling) keywords: `{ required: ["a"], allOf: [{ required: ["b"] }] }` → `["b", "a"]`.
- Several `pattern`s are conjoined into one expression (`^(?=[\s\S]*?(?:p1))(?=[\s\S]*?(?:p2))[\s\S]*$`); when that is not possible (backreferences, named groups) they are kept as `allOf: [{ pattern }, …]`. Several different `contains` and several `if`/`then`/`else` are kept as `allOf` fragments as well, because they have no single-keyword form.
- Two different `format`s in one conjunction are a contradiction: the schema is `false` (`unsatisfiable`, `reason: "format"`), also for overlapping pairs (`uri` ∧ `uri-reference`) and unknown formats. Only the OpenAPI rule sets apply the numeric lattice `int32 ∧ int64` → `int32`, `float ∧ double` → `float` (not an issue). Note that `format` constrains strings only, so for a validator that asserts formats `{ allOf: [{ format: date }, { format: email }] }` without a `type` still accepts numbers, which `false` does not.
- Keywords that have no single-keyword form are kept as `allOf` fragments next to the merged keywords (always equivalent, reported as `*-kept` warnings): legacy array-valued `items` under the 2020-12 rules (see Supported rules), `multipleOf` values whose least common multiple cannot be computed exactly, object shapes whose `patternProperties`/`additionalProperties` interaction has no exact merged form (or whose names cannot be matched within the `matchPatterns` limits), items carrying their own `unevaluatedProperties`/`unevaluatedItems` (a `$ref` item stays `{ $ref }`), different `contains`, `if`/`then`/`else`, patterns with backreferences.
- A contradiction next to container siblings (`definitions`, `$defs`, `components`, `$id`, `id`, `$anchor`, `$dynamicAnchor`, `$schema`, `$vocabulary`) keeps them: `{ allOf: [false], $defs: … }`, so refs into them stay valid; without such siblings it is plain `false`.
- A broken or external `$ref` inside `allOf` leaves the node in place (siblings untouched, resolvable items resolved, the broken ones kept as `{ $ref }`) and calls `onRefResolveError` (broken local refs only). An empty or non-string `$ref` inside `allOf` is a broken ref. With `mergeRefSibling`, a broken or external `$ref` with siblings is left as it is. A ref -> ref cycle and a ref to an inherited member (`#/constructor`, `#/__proto__`) are broken refs.
- Links stay links (D-22, D-23): every `$ref` that resolves in the input still resolves after a whole-document merge (`merge(doc)`, or `source` is the merged value) and keeps its meaning. A `$ref` outside `allOf` is not touched unless its pointer runs through a node the merge rewrites (a node with its own `allOf`; with `mergeRefSibling` also a `$ref` with siblings, with `mergeCombinarySibling` also a `oneOf`/`anyOf` with siblings; with `dropFalseBranches` / `dedupeAnyOf` also a node with `oneOf` / `anyOf` branches, whose indexes may shift); a pointer to the rewritten node itself and pointers into its `definitions` / `$defs` / `components` stay as they are. Such a `$ref` (bare or with siblings) is:
  - **rewritten to the matching location** of the merged output when the value there is the same as the original target: `{ $ref: "#/components/schemas/Pet/allOf/1/properties/id", description: "pet id" }` → `{ $ref: "#/components/schemas/Pet/properties/id", description: "pet id" }`; `#/definitions/A/properties/x` stays `#/definitions/A/properties/x` when merging `A` leaves `x` unchanged; a pointer through a `$ref` member (`#/components/schemas/Pet/allOf/0/properties/id` with `allOf/0: { $ref: Base }`) links the target's own place (`#/components/schemas/Base/properties/id`). The candidates, in order: the pointer itself, the pointer with every `allOf/<i>` step removed, the target's own location (with `allOf/<i>` steps removed), the pointer with `allOf/<i>` steps removed through intermediate `$ref`s; each of them is tried first with the new indexes of `oneOf`/`anyOf` branches that `dropFalseBranches` / `dedupeAnyOf` moved (D-27). "The same" is structural deep equality (key order ignored, `$ref` strings compared literally; `true` equals `{}`) between the merged output's value at the candidate and the original target merged on its own in the same call (for a `$ref` with siblings: the target without the siblings). Equality is a sufficient check, not a full equivalence test: an equivalent but differently written value is copied, never linked wrongly;
  - **replaced by a copy of the original target** (merged on its own) otherwise, e.g. `Pet = { allOf: [{ properties: { id: { type: integer } } }, { properties: { id: { minimum: 1 } } }] }` and `{ $ref: "#/components/schemas/Pet/allOf/0/properties/id" }` → `{ type: integer }` (the merged `Pet.properties.id` is `{ type: integer, minimum: 1 }`); a pointer into a member a contradiction drops (`LegacyId = { allOf: [string, number], properties: { code: { type: string, maxLength: 8 } } }` → `LegacyId: false`, `{ $ref: "…/LegacyId/properties/code" }` → `{ type: string, maxLength: 8 }`, D-20); a pointer into a `oneOf`/`anyOf` node whose siblings `mergeCombinarySibling` distributed. Siblings of the `$ref` apply next to it in every draft (D-24, see "`$ref` siblings" below), so the copy is the conjunction of the target and the siblings. With `mergeRefSibling` a `$ref` with siblings is merged with the original target as before.
  - Copies are merged in their own right (their own `allOf`, limits and cycle rules apply). A copy whose target lies inside the copy itself (a root `{ $ref, definitions }` pointing into one of its own definitions) stays a copy. A pointer below a copy that became a link moves below the link's target.
  - Fragment mode (`source` given and not the merged value): every pointer resolves against the unchanged `source`, so it keeps its meaning there; such `$ref`s are left as they are (no rewrite, no copy).
- The output is never a cyclic JavaScript object and is always JSON-serializable. A cycle re-entry (a `$ref` cycle through `allOf`, a cyclic JavaScript input, or a conjunction that is being merged higher up the path) is written as `{ $ref: "#<pointer>" }` to the source location of the node where the cycle started (the unmerged original, which is semantically equal), e.g. `{ $ref: "#/components/schemas/Foo" }`. When that pointer runs through a node the merge rewrites, a whole-document merge points to the output location of the re-entered node instead (its merged value means the same): `Node = { allOf: [{ properties: { child: { $ref: "#/definitions/Node/allOf/0" }, v: … } }, { required: [v] }] }` → `Node.properties.child` is a copy of `allOf/0` whose inner `child` is `{ $ref: "#/definitions/Node/properties/child" }`, and `Node` is merged (before D-22 it was kept unmerged, D-17). In fragment mode cycle pointers always resolve against `source`. A cyclic value that is not part of `source` is replaced by `{}` and reported.
- Fallback (D-17): a `$ref` left in the output that can be neither linked nor copied — one kept by `maxRefExpansion` / `expansionBudget` / `maxDepth`, one outside a schema location, one inside the siblings of a link — and whose pointer runs through a node the merge rewrote keeps that node unmerged (its members are still merged) and the document is merged again, so every output `$ref` resolves to what it meant in the input.
- `$ref` siblings apply in every draft (D-24, author intent): `{ $ref: Name, maxLength: 3 }` means "`Name` and at most 3 characters" under every rule set, also under draft-04/06/07, OpenAPI 3.0 and GraphApi rules, whose validators would ignore every sibling of `$ref`. This is an intentional deviation from those drafts: authors write siblings next to `$ref` because they mean them. Example with the default (draft-06) rules: `{ definitions: { Name: { type: string } }, allOf: [{ $ref: "#/definitions/Name", maxLength: 3 }, { minLength: 1 }] }` → `{ definitions: …, type: string, minLength: 1, maxLength: 3 }` (a draft-07 validator would accept `"abcd"` for the input, the merged schema rejects it). The same holds for a node with both `$ref` and `allOf` (the `allOf` applies), for `mergeRefSibling`, and for the copies the link rules make. A `$ref` with siblings outside `allOf` is left as it is unless `mergeRefSibling` is set (or the link rules copy it).
- Identity keywords (`$id`, `id`, `$anchor`, `$dynamicAnchor`, `$schema`, `$vocabulary`) of `$ref`-inlined items are not copied into the merged node (they would duplicate ids/anchors); the node's own identity keywords stay.
- Malformed keyword values (`required: true`, `enum: null`, `anyOf: {}`, non-object `allOf` items, `multipleOf: "abc"`, …) are ignored, the valid parts are merged and `onMergeError` is called; the merge never throws on them. A lone malformed value is dropped too (`{ allOf: [{ required: true }, { type: object }] }` → `{ type: object }`).
- Every usage of one `$ref` target (and every repeated conjunction of the same items) shares the merged output instance; use `freezeOutput: true` if the result is post-processed by code that might mutate it. One input instance used at locations with different rules (a YAML alias or a JS-built document using the same object under `info` and under `components/schemas`) is cloned once per rule set: it is merged only where schema rules apply.
- Property names such as `__proto__`, `constructor` and `prototype` are ordinary own keys of the output; output objects always have `Object.prototype` as their prototype.

#### OpenAPI 3.0 `nullable`
OpenAPI 3.0 rules follow the 3.0.3 wording ("`nullable: true` adds `null` to the type, only if `type` is explicitly defined within the same Schema Object"): an item with a `type` and without `nullable: true` forbids `null`, an item without `type` does not restrict it. So `{ type: string, nullable: true } ∧ { type: string }` → `{ type: string }`, `{ type: string, nullable: true } ∧ { minLength: 1 }` keeps `nullable: true`, and two nullable items with conflicting types leave only `null` (`{ type: string, nullable: true, enum: [null] }`). The idiom `allOf: [{ $ref: Base }], nullable: true` therefore no longer yields a nullable schema when `Base` has a `type`. JSON Schema rules keep `nullable` as an AND of the flags that are present (an item without `nullable` does not change it), GraphApi rules as an OR.

#### AsyncAPI
`asyncapi: 2.x` documents get `asyncApiMergeRules("2.x")`, `asyncapi: 3.x` documents `asyncApiMergeRules("3.0")` (auto-detected by `merge`, `selectMergeRules` and `detectAsyncApiVersion`). Schema locations: `components.schemas`, message `payload` and `headers` (also in `components.messages`, message traits, inline messages of channels/operations/replies), 2.x channel `parameters.*.schema`, and the schema fields of protocol bindings. The AsyncAPI Schema Object is JSON Schema draft-07 plus `discriminator` (kept next to `oneOf`/`anyOf` when `mergeCombinarySibling` distributes siblings). A payload is merged with the rules of its `schemaFormat` (2.x: the message's `schemaFormat`; 3.x: the Multi Format Schema Object `{ schemaFormat, schema }` at the payload, headers or `components.schemas` entry):

| `schemaFormat` | Rules | `$ref` to such a 3.x wrapper inside `allOf` |
|---|---|---|
| absent, `application/vnd.aai.asyncapi[+json\|+yaml][;version=…]` | AsyncAPI schema (draft-07 + `discriminator`) | the inner `schema` is merged |
| `application/schema[+json\|+yaml];version=draft-04` / `draft-06` / `draft-07` / `2020-12` (`2019-09` → 2020-12; no or unknown version → draft-07) | `jsonSchemaMergeRules(draft)` | the inner `schema` is merged |
| `application/vnd.oai.openapi[+json\|+yaml];version=3.0.x` (or no version) / `3.1.x` | `openApiJsonSchemaMergeRules("3.0.x" / "3.1.x")` | `$ref` kept as an `allOf` part + `onMergeError` |
| Avro, Protobuf, RAML, any other or non-string value | not merged (left untouched) | `$ref` kept as an `allOf` part + `onMergeError` |

A wrapper without `schema` is not a schema either (`$ref` kept and reported). `asyncApiSchemaMergeRules(schemaFormat, customRules?)` returns the rules of one format (`undefined` for a format that is not JSON Schema), `asyncApiSchemaDialect(schemaFormat)` the dialect name, `unwrapSchemaFormat(target)` the engine's unwrapping decision. Bindings: the schema fields of the protocols `ws` (`query`, `headers`), `http` (`query`, `headers`), `kafka` (`groupId`, `clientId`, `key`), `mqtt` (`correlationData`) and `anypointmq` (`headers`) are merged at every bindings location (`asyncApiBindingSchemaFields`, the same list as api-smart-diff); other protocols and other fields are left untouched. `message.oneOf` of 2.x lists messages, not schemas, and is never merged as a schema `oneOf`.

### Supported rules
You can find supported rules in the src/rules directory of this repository:
- `jsonSchemaMergeRules(version: "draft-04" | "draft-06" | "draft-07" | "2020-12", customRules?)` — default `"draft-06"`; draft-06, draft-07 and 2020-12 share one keyword table (a superset incl. `dependentRequired`, `dependentSchemas`, `unevaluatedProperties`, `unevaluatedItems`, `minContains`/`maxContains`, `if`/`then`/`else`), draft-04 has boolean exclusive bounds and no `const`/`propertyNames`/`contains`/`$defs`. The tuple keywords are read per draft (D-18): under draft-04/06/07 an array `items` (with `additionalItems`) is the tuple and `prefixItems` is an unknown keyword (last-wins); under 2020-12 `prefixItems` (with an `items` schema as the rest) is the tuple, an array-valued `items` is legacy and is kept as an `allOf` fragment `{ items, additionalItems? }` with `onMergeError` when it has to be combined with other array shapes (a single one is copied as is), and a stray `additionalItems` is last-wins. Formats: different formats are a contradiction (`false`), no numeric lattice.
- `openApiMergeRules(version: "3.0.x" | "3.1.x", customRules?, dialect?)` — 3.0.x schemas follow draft-04 (array `items` is the tuple), 3.1.x schemas follow 2020-12 (`prefixItems` is the tuple) or the draft `dialect` names (`jsonSchemaDialect`); `format` uses the numeric lattice `int32 ⊂ int64`, `float ⊂ double` (D-14). `openApiJsonSchemaMergeRules(version, customRules?, dialect?)` returns the schema rules alone.
- `schemaMergeRulesFor(dialect)` — the schema-level rules allof-merge uses at a schema location of a dialect: `"draft-04"`, `"draft-06"`, `"draft-07"`, `"2019-09"`, `"2020-12"`, a `$schema` URI, `"openapi-3.0"`, `"openapi-3.1"`, `"asyncapi-schema"` or an AsyncAPI `schemaFormat` string (`undefined` for a format that is not JSON Schema). For consumers that merge single schemas; `jsonSchemaDraftOf(uri)` maps a `$schema` URI to its draft.
- `graphapiMergeRules`, and `createGraphapiMergeRules(customRules?)` for GraphApi rules with custom schema rules (draft-06 based, no format lattice).
- `asyncApiMergeRules(version: "2.x" | "3.0", customRules?)` — AsyncAPI document rules (see "AsyncAPI"); `asyncApiSchemaMergeRules(schemaFormat?, customRules?)` the rules of one schema format.

`customRules` of all four factories are schema-level rules: they are added to the rules of every schema location (root, `properties/*`, `items`, `not`, `definitions/*`, OpenAPI `components/schemas/*`, parameter and media type schemas, GraphApi schemas, …) and win over the built-in rule of the same key. Rules objects are memoized per `(version, customRules)` identity and deep-frozen (also the OpenAPI and GraphApi rule sets and lazily derived child rules); the caller's custom rule objects are only referenced, not frozen. A rule is `{ $?: MergeResolver, sibling?: string[], group?: string }`: `$` merges the values of the key, `sibling` lists the keys kept outside of `oneOf`/`anyOf` branches by `mergeCombinarySibling`, and `group` names the keyword group (`type`, `enumConst`, `numericBounds`, `string`, `objectShape`, `arrayShape`, `dependencies`, `conditional`) that merges the key together with its related keywords. A custom `$` without `group` on one of these keys hands the whole group back to the per-key resolvers. The format lattice is chosen by the `format` rule: `"/format": { $: mergeOpenApiFormat, group: "string" }` enables it in JSON Schema rules, `mergeFormat` is the strict resolver.

#### Vendor and unknown keywords (D-19)
A key the rule set has no rule for (`x-go-type`, `foo`, `prefixItems` under draft-07, …) is merged by the `"/?"` rule, which is a silent last-wins by default. The rule of a key is found with json-crawl precedence: exact key (`"/x-go-type"`) > longest matching prefix rule (`"/x-*"`, json-crawl 1.0) > `"/*"` > `"/?"`; built-in keywords are exact keys, so prefixes and `"/*"` only reach unknown keys. A rule set without `"/?"` (a hand-written rule tree) also falls back to last-wins (0.6.8 threw `Merge rule not found`).

```ts
import { merge, jsonSchemaMergeRules, openApiMergeRules, createGraphapiMergeRules, equal, first } from 'allof-merge'

// report differing values, keep the last one
const strictLast = { $: (values, ctx) => { if (new Set(values).size > 1) ctx.mergeError(values); return values[values.length - 1] } }

const rules = jsonSchemaMergeRules("draft-07", {
  "/x-go-type": { $: equal },                   // exact vendor key: different values are a contradiction (false)
  "/x-*": strictLast,                            // every other x- key: last-wins + onMergeError
  "/?": { $: first },                            // every other unknown key: first-wins instead of last-wins
})
merge(schema, { rules, onMergeError })

// the same custom rules for OpenAPI and GraphApi documents (applied at every schema location)
merge(openApiDoc, { rules: openApiMergeRules("3.1.x", { "/x-*": strictLast }) })
merge(graphApiDoc, { rules: createGraphapiMergeRules({ "/x-*": strictLast }) })
```

A resolver gets the values of the key in item order and returns the merged value; returning `undefined` makes the conjunction a contradiction (`false`, reported), `ctx.mergeError(values)` reports without failing. Rules are matched field-wise like json-crawl rules: a prefix or `"/*"` rule is shallow-merged under a matching exact rule, so give them only a `$`.

## Benchmark
```
allof-merge x 657 ops/sec ±2.35% (90 runs sampled)
json-schema-merge-allof x 217 ops/sec ±2.03% (86 runs sampled)
Fastest is allof-merge
```

Check yourself:
```SH
npm run benchmark
```

## Contributing
When contributing, keep in mind that it is an objective of `allof-merge` to have no additional package dependencies.

Please run the unit tests before submitting your PR: `npm test` (the property-based equivalence test alone: `npm run test:fuzz`; more cases locally with `FUZZ_RUNS=5000 npm run test:fuzz` or another `FUZZ_SEED`). Hopefully your PR includes additional unit tests to illustrate your change/modification!

## License

MIT
