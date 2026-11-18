# Changelog

## 1.0.0

A new merge engine. Merged schemas now accept exactly the values the input accepts in far more cases (99 % of the benchmark's test cases, 0.6.8: 79 %), whole documents merge 4–12× faster, and problems are reported as issues instead of being dropped silently. `merge`, `allOfResolverHook`, the rule factories, `onMergeError` and `onRefResolveError` keep their signatures.

### Breaking changes

**Package**

- Node.js 22 or later.
- ESM and CommonJS builds only (`dist/index.js`, `dist/index.cjs`); the browser bundle `allof-merge.min.js` (global `AllofMerge`) is no longer published. In browsers, use a bundler or an ESM CDN.
- `json-crawl` 1.x is a regular dependency instead of being inlined. If you call `syncClone` with `allOfResolverHook` yourself, pass `{ circular: false }`. Custom prefix rules are written `"/x-*"` (0.6: `"/^"`).
- Removed unused helpers: `MapArray`, `isEqual` (use `deepEqual`), `getPropertiesForMerge`, `getPatternPropertiesForMerge`, the types `AllOfRef` and `NormalizeResponse`, and the ignored third parameter of `resolvePointer`.

**Output**

- A contradiction becomes the schema `false` instead of a dropped keyword, `undefined` or `null`: `{ allOf: [{ type: "string" }, { type: "number" }] }` → `false`. A property with an impossible schema stays in `properties` as `false`. Use `unsatisfiable: "not-empty"` to get `{ not: {} }`.
- Impossible `oneOf` / `anyOf` branches are removed; when every branch is impossible the schema is `false` (`dropFalseBranches: false` keeps them as `false`).
- Different `format`s are a contradiction (0.6: the last one won). The OpenAPI rules still narrow `int32 ∧ int64` → `int32` and `float ∧ double` → `float`.
- `enum` and `required` keep the order of first appearance without duplicates (0.6: sorted).
- Several `pattern`s are combined into one expression that accepts the right strings (0.6: `(?=p1)(?=p2)`, which rejected valid strings).
- Parts that have no exact merged form are kept in `allOf` instead of being merged incorrectly: different `contains`, several `if` / `then` / `else`, patterns with backreferences, `multipleOf` without an exact least common multiple, items with their own `unevaluatedProperties` / `unevaluatedItems`, some `patternProperties` / `additionalProperties` combinations.
- The output is never a cyclic object: a `$ref` cycle is written as a `$ref` to the place where it starts, so the result is always JSON-serializable.
- `$ref`s keep working after a whole-document merge: a `$ref` that pointed into a merged `allOf` is rewritten to the matching place in the merged schema, or replaced by a copy of its target.
- Siblings of `$ref` (`{ $ref: Name, maxLength: 3 }`) apply in every draft, also draft-04 to 07 and OpenAPI 3.0.
- The rules follow the document: `$schema` selects the JSON Schema draft (2019-09 and 2020-12 use the 2020-12 rules, draft-06 when absent), OpenAPI 3.1 `jsonSchemaDialect` is honored, and OpenAPI versions are matched exactly (`"13.0"` is not OpenAPI 3). Tuples are read per draft: `items` arrays up to draft-07, `prefixItems` in 2020-12.
- OpenAPI 3.0 `nullable` follows the 3.0.3 wording: an item with a `type` and without `nullable: true` forbids `null`, so `{ type: "string", nullable: true } ∧ { type: "string" }` is not nullable.
- `integer ∧ number` is `integer`, also nested and in type lists (#232).
- Malformed values (`required: true`, `enum: null`, `anyOf: {}`, …) are dropped and reported; the merge never throws on them.
- An unknown keyword without a rule keeps the last value (0.6: threw `Merge rule not found`).
- `$id`, `$anchor` and other identity keywords of schemas inlined through `$ref` are not copied into the merged schema.
- A broken `$ref` inside `allOf` leaves the rest of the node in place.
- Uses of the same `$ref` target share one output object. Use `freezeOutput: true` if code downstream might mutate the result.

### Added

- Issues: `onIssue` and `issueLevel` options, `mergeWithIssues(value, options)` → `{ result, issues }`, the `MERGE_ISSUES` table. Each issue has a stable `code`, a `severity`, the output `path` and the input `sourcePointer`.
- AsyncAPI 2.x and 3.x documents (#107): payloads and headers merged per `schemaFormat`, Multi Format Schema Objects, schema fields of protocol bindings; `asyncApiMergeRules`, `asyncApiSchemaMergeRules`.
- JSON Schema draft-07 and 2020-12 rules (`prefixItems`, `dependentRequired`, `dependentSchemas`, `unevaluated*`, `minContains` / `maxContains`, `if` / `then` / `else`, `$anchor`), `schemaMergeRulesFor(dialect)` and `jsonSchemaDraftOf(uri)`.
- `createMerger(options)`: a reusable merger with `merge`, `hook` and `needsMerge`, for merging many parts of one document.
- `refAnnotations` option (#222): keep the `title` / `description` of a `$ref` target out of the schemas that extend it.
- Simplification options: `dedupeAnyOf`, `dedupeFragments`, `dedupeCombinaryGroups`, `dropFalseBranches` (on by default), and the opt-in `simplify` (enum filtered by type, typed contradictions, redundant bounds, `contains` → `minItems`).
- Limits for hostile input: `branchBudget`, `maxRefExpansion`, `expansionBudget`, `maxDepth`, `matchPatterns`.
- Custom rules for every rule set (`openApiMergeRules`, `openApiJsonSchemaMergeRules`, `createGraphapiMergeRules`, `asyncApiMergeRules`), prefix rules for vendor keywords (`"/x-*"`) and the `"/?"` rule for unknown keywords.
- `freezeOutput` option; `mergeOpenApiFormat` and other resolvers, keyword groups and `intersect` exported for custom rules.

### Fixed

- `properties`, `patternProperties` and `additionalProperties` are merged together, so properties allowed by another item's patterns are no longer lost.
- `items`, `additionalItems` and `prefixItems` are merged together; conflicting tuple positions become `false` instead of `null`.
- draft-04 / OpenAPI 3.0 boolean `exclusiveMinimum` / `exclusiveMaximum` stay with their bound.
- `enum` and `const` values are compared by structure; `dependencies` is merged under draft-04; `allOf` inside `not` is merged.
- Merging `items` under OpenAPI 3.0 rules, and cyclic input with `$ref`s, no longer throw.
- The input is never modified.
- `resolvePointer` follows `$ref`s along the pointer; `$ref`s to `$anchor` names resolve; `$ref` → `$ref` loops are reported.
- OpenAPI rules cover `callbacks`, `webhooks`, `components.pathItems`, parameter and header `content`, and `encoding` headers.
- The same object used at several places of a document (for example a YAML alias) is merged correctly at each place.
- Keys such as `__proto__` and `constructor` are ordinary property names and cannot change prototypes.
- No catastrophic slowdowns: patterns are never run when they risk ReDoS, `$ref` fan-out ("billion laughs") is bounded, documents 20 000 levels deep do not overflow the stack, and large `enum` / `required` / `properties` merge in linear time.

### Performance

- Whole documents merge 4–12× faster than 0.6.8 (GitHub REST API, 12 MB: 1.46 s → 0.12 s), in linear time in document depth and in the number of `$ref` usages.
