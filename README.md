# allof-merge

<img alt="npm" src="https://img.shields.io/npm/v/allof-merge"> <img alt="npm downloads" src="https://img.shields.io/npm/dm/allof-merge?label=npm"> ![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/udamir/allof-merge/ci.yml) <img alt="npm type definitions" src="https://img.shields.io/npm/types/allof-merge"> <img alt="License" src="https://img.shields.io/github/license/udamir/allof-merge">

Merge `allOf` in JSON Schema, OpenAPI, AsyncAPI and GraphApi documents into equivalent, easier to read schemas without `allOf`.

```ts
import { merge } from "allof-merge"

merge({
  type: ["object", "null"],
  additionalProperties: { type: "string", minLength: 5 },
  allOf: [{ type: ["array", "object"], additionalProperties: { type: "string", minLength: 10, maxLength: 20 } }],
})
// { type: "object", additionalProperties: { type: "string", minLength: 10, maxLength: 20 } }
```

## Features

- **Exact**: the merged schema accepts exactly the values the original accepts. Parts that have no exact single-keyword form stay in `allOf`, and contradictions become `false`.
- **Whole documents**: OpenAPI 3.0 / 3.1, AsyncAPI 2.x / 3.x, GraphApi and JSON Schema (draft-04, 06, 07, 2019-09, 2020-12). The rules are picked from the document automatically.
- **`$ref` aware**: local and circular `$ref`s are resolved, and every `$ref` that resolves in the input still resolves in the output.
- **Keyword aware**: `type` (`integer` ⊂ `number`), numeric bounds, `pattern`, `enum` / `const`, `format`, `properties` × `patternProperties` × `additionalProperties`, tuples, `contains`, `dependencies`, `if` / `then` / `else` and more.
- **Reports issues** (contradictions, broken `$ref`s, malformed values, parts kept unmerged) instead of silently dropping them. It never throws on bad input.
- **Safe on hostile input**: bounded `$ref` expansion, `oneOf` products and depth, no ReDoS, no prototype pollution.
- **Fast**: linear in document size, depth and number of `$ref` usages. The 12 MB GitHub REST API description merges in about 0.1 s.
- **Customizable** merge rules, including vendor keywords (`x-*`).
- TypeScript types included; one small dependency ([json-crawl](https://github.com/udamir/json-crawl)); works in Node.js and browsers.

## Installation

```sh
npm install allof-merge
# or
pnpm add allof-merge
```

Node.js 22 or later. The package ships ESM and CommonJS builds. In browsers, use it through a bundler or an ESM CDN (`import { merge } from "https://esm.sh/allof-merge"`).

`$ref`s to other files are not resolved: bundle the document first, for example with [api-ref-bundler](https://github.com/udamir/api-ref-bundler).

## Usage

### Merge a whole document

```ts
import { merge } from "allof-merge"

const doc = {
  openapi: "3.0.3",
  components: {
    schemas: {
      Base: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      Pet: { allOf: [{ $ref: "#/components/schemas/Base" }, { required: ["name"], properties: { name: { type: "string" } } }] },
    },
  },
}

merge(doc).components.schemas.Pet
// { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] }
```

The input is never modified. The merge rules are chosen from the document:

| Document | Rules |
|---|---|
| `openapi: "3.0.x"` | OpenAPI 3.0 |
| `openapi: "3.1.x"` (or later 3.x) | OpenAPI 3.1, schemas per `jsonSchemaDialect` (2020-12 by default) |
| `asyncapi: "2.x"` / `"3.x"` | AsyncAPI, payloads and headers per `schemaFormat` |
| `graphapi` | GraphApi |
| anything else | JSON Schema of the draft named by `$schema` (draft-06 when absent) |

Pass `rules` to choose them yourself, for example `merge(schema, { rules: jsonSchemaMergeRules("2020-12") })`.

### Check what happened

```ts
import { mergeWithIssues } from "allof-merge"

const { result, issues } = mergeWithIssues({ allOf: [{ type: "string" }, { type: "number" }] })
// result: false
// issues: [{ code: "unsatisfiable", severity: "error", reason: "type", path: [], message: "…" }]
```

Or pass `onIssue: (issue) => …` to `merge`. See [Issues](#issues).

### Merge many parts of one document

`createMerger` keeps the `$ref` index and the merged results between calls, so merging many nodes of one document costs about as much as merging the whole document once:

```ts
import { createMerger } from "allof-merge"

const merger = createMerger({ source: doc })
const pet = merger.merge(doc.components.schemas.Pet)
merger.needsMerge(doc.components.schemas.Base) // false: nothing to merge, the call can be skipped
```

Results of one merger share objects (the same `$ref` target is merged once). Do not mutate them, or pass `freezeOutput: true`. Do not change the input documents while a merger is in use.

`merger.hook` (also `allOfResolverHook(options)`) is the same merge as a [json-crawl](https://github.com/udamir/json-crawl) clone hook, for combining it with your own hooks: `syncClone(doc, [merger.hook, myHook], { rules: jsonSchemaMergeRules(), circular: false })`. The hook merges only where the `rules` passed to `syncClone` mark a schema location, and `circular: false` is required.

## Options

```ts
merge(value, options?: MergeOptions)
```

| Option | Default | Description |
|---|---|---|
| `rules` | auto | Merge rules, see [Rules](#rules) |
| `source` | `value` | The whole document when `value` is a part of it (for `$ref` resolution) |
| `mergeRefSibling` | `false` | Merge `$ref` with its sibling keywords: `{ $ref: Name, maxLength: 3 }` → `{ type: "string", maxLength: 3 }` |
| `mergeCombinarySibling` | `false` | Distribute sibling keywords into `oneOf` / `anyOf` branches |
| `onIssue` | | Called for every [issue](#issues) at or above `issueLevel` |
| `issueLevel` | `"warning"` | `"error"` delivers errors only |
| `onMergeError`, `onRefResolveError` | | Callbacks of 0.x, still called for merge conflicts and broken `$ref`s |
| `unsatisfiable` | `"false"` | How a contradiction is written: `false` or `{ not: {} }` (`"not-empty"`, for draft-04 consumers) |
| `refAnnotations` | `"merge"` | `"omit"` drops `title`, `description` and `$comment` that a schema gets only through a `$ref`; or a list of keys (`["title", "x-*"]`) |
| `dropFalseBranches` | `true` | Remove impossible `oneOf` / `anyOf` branches |
| `dedupeAnyOf` | `true` | Keep identical `anyOf` branches once (never `oneOf`) |
| `dedupeFragments` | `true` | Keep identical parts left in `allOf` once |
| `dedupeCombinaryGroups` | `true` | Combine identical `oneOf` / `anyOf` groups of different items once |
| `simplify` | `false` | Extra exact simplifications, see [Simplifications](#simplifications) |
| `freezeOutput` | `false` | Deep-freeze the result |
| `branchBudget` | `1024` | Max `oneOf` / `anyOf` combinations per call; above it the node is kept |
| `maxRefExpansion` | `10000` | Max inlinings of one `$ref` target per call |
| `expansionBudget` | `2000000` | Max schema nodes copied in by `$ref` inlining per call |
| `maxDepth` | `2000` | Deeper nodes are copied without merging |
| `matchPatterns` | `true` | Match property names against `patternProperties` of other items (names and patterns up to 256 characters); `false` disables it |

The limits only protect against hostile input: real-world specifications stay far below them. A node that hits a limit is left unmerged (still equivalent) and reported.

## What the output looks like

- **Contradictions** become `false`: `{ allOf: [{ type: "string" }, { type: "number" }] }` → `false`. A property with an impossible schema stays in `properties` as `false`.
- **Impossible `oneOf` / `anyOf` branches** are removed. If every branch is impossible, the schema is `false`.
- **`enum` and `required`** keep the order of first appearance, without duplicates.
- **Several `pattern`s** are combined into one regular expression. Patterns with backreferences or named groups stay in `allOf`.
- **Different `format`s** are a contradiction (`false`). The OpenAPI rules narrow `int32 ∧ int64` → `int32` and `float ∧ double` → `float`.
- **Kept in `allOf`** because they have no exact merged form: different `contains`, several `if` / `then` / `else`, `multipleOf` values without an exact least common multiple, items with their own `unevaluatedProperties` / `unevaluatedItems`, and some combinations of `patternProperties` with `additionalProperties`. Each is reported as a `*-kept` warning.
- **`$ref`s keep working**: a `$ref` that pointed into a merged `allOf` is rewritten to the matching place of the merged schema, or replaced by a copy of its target when that place now means something stricter.
- **Cycles**: the output is never a cyclic object. A cycle is written as a `$ref` to the place where it starts, so the output is always JSON-serializable.
- **`$ref` siblings** apply in every draft: `{ $ref: Name, maxLength: 3 }` means "`Name` and at most 3 characters", also under draft-04 to 07 and OpenAPI 3.0, whose validators ignore siblings of `$ref`.
- **OpenAPI 3.0 `nullable`** follows the 3.0.3 wording: an item with a `type` and without `nullable: true` forbids `null`.
- **Unknown and vendor keywords**: the last value wins, unless a rule says otherwise.
- **Malformed values** (`required: true`, `enum: null`, …) are dropped and reported.
- Uses of the same `$ref` target share one output object; use `freezeOutput: true` if code downstream might mutate it.

### Simplifications

The four `dedupe*` / `dropFalseBranches` options above are always equivalences and on by default. `simplify: true` (or an object choosing rules) adds rules that change the form of merged schemas more visibly. Each is exact under the draft of the rule set:

| Rule | `allOf` items | Result |
|---|---|---|
| `enumByType` | `{ type: "string" }`, `{ enum: ["a", 1] }` | `{ type: "string", enum: ["a"] }` |
| `contradictions` | `{ type: "number", minimum: 15 }`, `{ maximum: 10 }` | `false` |
| `contradictions` | `{ type: ["number", "string"], minimum: 15 }`, `{ maximum: 10 }` | `{ type: "string" }` |
| `redundantBounds` | `{ minimum: 5 }`, `{ exclusiveMinimum: 3 }` | `{ minimum: 5 }` |
| `containsToMinItems` | `{ type: "array", contains: true }`, `{ minItems: 0 }` | `{ type: "array", minItems: 1 }` (draft-06 / 07) |

Keep `simplify` off if you compare merged schemas with unmerged ones.

### Annotations from `$ref`

By default, `{ allOf: [{ $ref: Base }, …] }` inherits everything from `Base`, including its `title`. With `refAnnotations: "omit"`, a schema keeps only its own `title`, `description` and `$comment`, which helps code generators that name types by `title`:

```ts
// Base:    { title: "Base", type: "object", properties: { id: { type: "string" } } }
// Derived: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { name: { type: "string" } } }] }

merge(doc).components.schemas.Derived
// { type: "object", properties: { id: …, name: … }, title: "Base" }
merge(doc, { refAnnotations: "omit" }).components.schemas.Derived
// { type: "object", properties: { id: …, name: … } }
```

## Rules

| Factory | For |
|---|---|
| `jsonSchemaMergeRules(draft?, customRules?)` | JSON Schema `"draft-04"`, `"draft-06"` (default), `"draft-07"`, `"2020-12"` |
| `openApiMergeRules(version, customRules?, dialect?)` | OpenAPI documents, `"3.0.x"` or `"3.1.x"` |
| `openApiJsonSchemaMergeRules(version, customRules?, dialect?)` | A single OpenAPI schema |
| `asyncApiMergeRules(version, customRules?)` | AsyncAPI documents, `"2.x"` or `"3.0"` |
| `asyncApiSchemaMergeRules(schemaFormat?, customRules?)` | A single AsyncAPI payload of a `schemaFormat` |
| `createGraphapiMergeRules(customRules?)`, `graphapiMergeRules` | GraphApi documents |
| `schemaMergeRulesFor(dialect)` | A single schema of a dialect (`"2020-12"`, `"openapi-3.1"`, a `$schema` URI, …) |

`customRules` apply at every schema location of the document and win over the built-in rule of the same keyword. A rule is `{ $: (values, ctx) => merged }`. Return `undefined` to mark a contradiction, or call `ctx.mergeError(values)` to report a conflict and still return a value:

```ts
import { merge, jsonSchemaMergeRules, openApiMergeRules, equal, first } from "allof-merge"

const rules = jsonSchemaMergeRules("draft-07", {
  "/x-go-type": { $: equal },   // different values are a contradiction
  "/x-*": { $: first },          // every other x- keyword: first value wins
  "/?": { $: first },            // any other unknown keyword
})
merge(schema, { rules })

merge(openApiDoc, { rules: openApiMergeRules("3.1.x", { "/x-*": { $: first } }) })
```

Rule lookup order: exact keyword (`"/x-go-type"`), longest prefix (`"/x-*"`), `"/*"`, then `"/?"` (last value wins by default). Built-in resolvers such as `first`, `last`, `equal`, `mergeArray` and `mergeFormat` are exported.

## Issues

Every issue has a stable `code`, a `severity` (`"error"` or `"warning"`), a `message`, the output `path`, and when available `sourcePointer` (the location in the input, e.g. `#/components/schemas/Pet`), `keyword`, `values`, `ref` and `reason`. `MERGE_ISSUES` lists every code with its severity and description.

| Code | Severity | When |
|---|---|---|
| `unsatisfiable` | error | No value satisfies the conjunction; the schema is `false`. `reason`: `type`, `enum`, `const`, `bounds`, `format`, `false-item`, `simplify` |
| `unsatisfiable-combinator` | error | Every `oneOf` / `anyOf` branch became impossible |
| `malformed-value`, `malformed-allof`, `malformed-allof-item` | error | A value of the wrong type is ignored |
| `broken-ref`, `ref-cycle` | error | A `$ref` that does not resolve, or a `$ref` chain that loops |
| `cyclic-value` | error | A cyclic JavaScript value outside `source`, replaced by `{}` |
| `pattern-invalid` | error | An invalid regular expression, kept as is |
| `external-ref` | warning | A `$ref` to another file, kept as is |
| `pattern-kept`, `contains-kept`, `conditional-kept`, `unevaluated-kept`, `object-shape-kept`, `multipleof-kept`, `tuple-kept`, `schema-format-kept` | warning | A part without an exact merged form is kept in `allOf` |
| `branch-removed`, `branch-kept-for-link` | warning | An impossible `oneOf` / `anyOf` branch was removed (or kept because a `$ref` points into the list) |
| `kept-for-link`, `link-copied` | warning | A node kept unmerged, or a `$ref` replaced by a copy, so that `$ref`s keep their meaning |
| `branch-budget`, `ref-expansion-limit`, `expansion-budget`, `max-depth` | warning | A limit was reached; the node is kept unmerged |
| `nullable-overridden` | warning | OpenAPI 3.0: `nullable: true` has no effect because another item forbids `null` |
| `merge-conflict` | warning | A custom rule reported a conflict |

Outcomes a rule defines on purpose (the last annotation wins, the OpenAPI format narrowing, removed duplicates, rewritten `$ref`s) are not issues.

## AsyncAPI

AsyncAPI documents are detected by their `asyncapi` version. Message payloads and headers are merged with the rules of their `schemaFormat`: AsyncAPI schema, JSON Schema drafts and OpenAPI schemas are merged, while Avro, Protobuf, RAML and other formats are left untouched. AsyncAPI 3 Multi Format Schema Objects and the schema fields of the `ws`, `http`, `kafka`, `mqtt` and `anypointmq` bindings are supported.

## Benchmark

Compared with allof-merge 0.6.8 and the other popular `allOf` mergers on npm (full tables and method in [benchmark/RESULTS.md](benchmark/RESULTS.md)). The test cases come from the test suites and issue trackers of these libraries and from fuzzing; a result is equivalent when a validator gives it the same verdict as the input on generated instances.

| | allof-merge 1.0 | allof-merge 0.6.8 | @redocly/allof-merge | json-schema-merge-allof | @x0k/json-schema-merge | @fastify/merge-json-schemas |
|---|---:|---:|---:|---:|---:|---:|
| Equivalent result, 968 test cases without `$ref` | 99.2 % | 78.9 % | 80.9 % | 72.7 % | 90.8 % | 68.7 % |
| Equivalent result, 218 test cases with `$ref` | 100 % | 82.6 % | 85.8 % | 94.0 % | 93.6 % | 86.2 % |
| GitHub REST API (12 MB OpenAPI), ms | 100 | 1 462 | 559 | n/a | n/a | n/a |
| 586 small real-world schemas, ms | 9.0 | 79 | 83 | 37 | 8.6 | 39 |

Libraries without `$ref` resolution cannot merge OpenAPI documents (n/a). @fastify/merge-json-schemas and @x0k/json-schema-merge are faster on large synthetic schemas without `$ref`, but they throw on 23 % and 5 % of the cases.

## Migrating from 0.x

`merge`, `allOfResolverHook`, the rule factories, `onMergeError` and `onRefResolveError` keep their signatures. The output changed where 0.x was wrong (contradictions are `false`, impossible branches are removed, `enum` / `required` keep their order, and more), Node.js 22 is required, the browser bundle is gone and a few unused helpers were removed. See the breaking changes in the [changelog](CHANGELOG.md).

## Contributing

The project uses [pnpm](https://pnpm.io) and [Vite+](https://viteplus.dev):

```sh
pnpm install
pnpm test          # all tests
pnpm test:fuzz     # property-based equivalence tests (FUZZ_RUNS=5000 for more cases)
pnpm check         # type check (TypeScript 7) and lint
pnpm build         # dist/
```

The benchmark is a separate project with its own dependencies: `cd benchmark && pnpm install && pnpm start` (it builds the package first).

Please add tests for your change. The package should stay free of additional runtime dependencies.

## License

MIT
