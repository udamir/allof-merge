# allof-merge — Test Plan (audit suite, updated for 1.0.0)

This plan is derived from the features declared in `README.md` ("merged schema does not validate more or less than the original schema", "removes almost all logical impossibilities", correct merging of `properties`/`additionalProperties`/`patternProperties` and `items`/`additionalItems`, custom rules, circular JavaScript references, internal and circular `$ref`, optional sibling merging for `$ref` and combinaries, OpenAPI 3.x and GraphApi rule sets, "fastest implementation") and from the public API exported by `src/index.ts` (`merge`, `allOfResolverHook`, `jsonSchemaMergeRules`, `openApiMergeRules`, `graphapiMergeRules`, `isRefNode`, `isAnyOfNode`, `isOneOfNode`, `parseRef`, `createRef`, `resolvePointer`, `mergeValues`, `pathMask`, and the options `source`, `rules`, `mergeRefSibling`, `mergeCombinarySibling`, `onMergeError`, `onRefResolveError`).

## Conventions

Every case has an id `B<block>.<group>.<n>` that is repeated verbatim in the test name, so `npx jest -t "B1.7.5"` runs exactly one case. Tests live in `test/audit/*.test.ts` (one file per block) with shared helpers in `test/audit/helpers.ts`; existing tests and `src/` were not changed.

Expected results come from JSON Schema semantics, never from the current output. Wherever possible the test uses `ajv` (draft-07, `strict: false`; draft 2020-12 via `ajv/dist/2020`) as an oracle: `expectSameValidation(original, merged, instances)` asserts that the merged schema accepts and rejects exactly the same instances as the original. Draft-04 boolean `exclusiveMinimum`/`exclusiveMaximum` is not supported by ajv 8, so those expectations are reasoned explicitly in the test. `ajv` is available as a transitive devDependency (via `schema-utils`); it should be added to `devDependencies` if the audit tests are kept.

A case whose correct expectation was not met by 0.6.8 was written as `test.failing(...)` with a comment `// ISSUE-AM-NN: <reason>`; the issue ids are described in `docs/ANALYSIS.md`. With the 1.0.0 redesign every one of those cases passes and has been promoted to a plain `test` (the comment now reads `// AM-NN (fixed): <reason>`). Expectations that the announced output-contract changes of `docs/DESIGN_PROPOSALS.md` §5 invalidated (impossible `oneOf`/`anyOf` branches kept as `false`, insertion order of `enum`/`required`, the pattern conjunction form, `contains` fragments) were adjusted with a comment citing the §5 row or the finding. Behaviour that is a deliberate design choice (for example writing a cycle re-entry as a `$ref` to its source location) is covered by a normal test that documents the behaviour. The verification fixes (`docs/VERIFICATION.md`) changed a few expectations of B1–B12 and of the original suites; each changed case cites the VR finding or D decision in a comment, and blocks B13–B15 cover the fixes themselves.

Status column: `pass` — the implementation meets the expectation; `pass (AM-NN fixed)` — a former `test.failing` defect case that passes since 1.0.0; `doc` — a normal test that documents a deliberate (possibly debatable) behaviour; `§5` — the expectation was changed by an announced output-contract change.

Run everything with `npm test` (or `npx jest test/audit --coverage=false` for the audit suite alone).

## B1 — Keyword-by-keyword merge semantics (`test/audit/b1.keywords.test.ts`)

### B1.1 type

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.1.1 | `string ∧ string` | `type: string` | pass |
| B1.1.2 | `[string, number, null] ∧ [number, null]` | `[number, null]`, same validation | pass |
| B1.1.3 | `[string, number] ∧ string` | `string` | pass |
| B1.1.4 | `[string] ∧ [string, number]` | scalar `string` | pass |
| B1.1.5 | `integer ∧ number` | `integer`, no merge error | pass (AM-02 fixed) |
| B1.1.6 | `[integer, boolean] ∧ [number, string]` | `integer` | pass (AM-02 fixed) |

### B1.2 enum and const

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.2.1 | enum intersection of primitives | members `{1, 2, 10}` in any order, same validation | pass |
| B1.2.2 | enum intersection with equal object members | `[{a:1}]` | pass |
| B1.2.3 | enum object members with different key order | treated as equal (structural comparison) | pass (AM-13 fixed) |
| B1.2.4 | single enum | kept verbatim | pass |
| B1.2.5 | equal const values (primitive and object) | kept | pass |
| B1.2.6 | const objects with different key order | treated as equal | pass (AM-13 fixed) |
| B1.2.7 | `const: 1 ∧ enum: [1, 2]` | equivalent schema (both kept) | pass |

### B1.3 numeric bounds

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.3.1 | `minimum`/`maximum` | max of minimums, min of maximums | pass |
| B1.3.2 | numeric `exclusiveMinimum`/`exclusiveMaximum` (draft-06+) | tightest values | pass |
| B1.3.3 | `minimum: 5 ∧ exclusiveMinimum: 5` | both kept, equivalent | pass |
| B1.3.4 | draft-04 boolean exclusive flag with equal bounds | OR of the flags | pass |
| B1.3.5 | draft-04 `{minimum:1, exclusiveMinimum:true} ∧ {minimum:5}` | `minimum: 5`, flag not `true` (5 is valid for both inputs) | pass (AM-10 fixed) |
| B1.3.6 | draft-04 `{maximum:10, exclusiveMaximum:true} ∧ {maximum:5}` | `maximum: 5`, flag not `true` | pass (AM-10 fixed) |

### B1.4 multipleOf

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.4.1 | `4 ∧ 6` | LCM `12`, same validation | pass |
| B1.4.2 | `7 ∧ 11 ∧ 13` | `1001` | pass |
| B1.4.3 | decimals `0.5 ∧ 0.2`, `0.1 ∧ 0.3`, `2.5 ∧ 1.5` | `1`, `0.3`, `7.5` | pass |

### B1.5 strings

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.5.1 | `minLength`/`maxLength` | tightest values | pass |
| B1.5.2 | single `pattern` | kept verbatim | pass |
| B1.5.3 | two patterns both anchored with `^` | single string pattern, same validation | pass |
| B1.5.4 | prefix pattern `^a` ∧ suffix pattern `b$` | `"ab"` accepted, `"a"`, `"b"`, `"ba"` rejected | pass (AM-03 fixed) |
| B1.5.5 | two unanchored patterns `a` ∧ `b` | `"ab"` and `"ba"` accepted | pass (AM-03 fixed) |
| B1.5.6 | three patterns anchored with `^` | single string pattern, correct acceptance | pass |

### B1.6 required

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.6.1 | union of two lists | `{a, b, c}` without duplicates | pass |
| B1.6.2 | single list | kept verbatim (order preserved) | pass |

### B1.7 properties × additionalProperties × patternProperties

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.7.1 | same property in two items | merged property schema, other properties kept | pass |
| B1.7.2 | property vs `additionalProperties: false` of another item | property removed, `additionalProperties: false` kept, same validation | pass |
| B1.7.3 | property vs `additionalProperties: <schema>` of another item | schema merged into the property, `additionalProperties` kept | pass |
| B1.7.4 | property matching a `patternProperties` pattern of another item | property kept, pattern kept | pass |
| B1.7.5 | property matching no pattern, `additionalProperties` absent | property kept (additionalProperties defaults to true) | pass (AM-04 fixed) |
| B1.7.6 | property matching one of several patterns | property kept | pass (AM-04 fixed) |
| B1.7.7 | item 1 has only non-matching `patternProperties`, item 2 lists property `b` | `b` kept (same validation) | pass (AM-04 fixed) |
| B1.7.8 | pattern vs `additionalProperties: false` of another item | pattern removed | pass |
| B1.7.9 | same pattern in two items plus a distinct pattern | same pattern merged, distinct one kept | pass |
| B1.7.10 | two `additionalProperties` schemas | merged schema | pass |
| B1.7.11 | `additionalProperties: true` ∧ schema / true | schema / true | pass |
| B1.7.12 | `additionalProperties: false` ∧ true / schema | `false` | pass |
| B1.7.13 | boolean property schemas | `false` wins, `true` absorbed | pass |
| B1.7.14 | `minProperties`/`maxProperties` | tightest values | pass |

### B1.8 items, additionalItems, array keywords

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.8.1 | two `items` schemas | merged schema | pass |
| B1.8.2 | tuple ∧ schema | schema merged into each position and into the tail (`additionalItems`) | pass (AM-19, expectation extended) |
| B1.8.3 | tuple ∧ tuple | position-wise merge, longer tuple wins | pass |
| B1.8.4 | tuple with `additionalItems: false` ∧ longer tuple | tuple truncated, `additionalItems: false` | pass |
| B1.8.5 | two tuples with `additionalItems` schemas | `additionalItems` merged | pass |
| B1.8.6 | one tuple + `additionalItems` ∧ `items: <schema>` | `items` schema merged into the single `additionalItems` | pass (AM-19 fixed) |
| B1.8.6b | two `additionalItems` ∧ `items: <schema>` | `items` schema merged into `additionalItems` | pass |
| B1.8.7 | `uniqueItems` | OR | pass |
| B1.8.8 | `minItems`/`maxItems` | tightest values | pass |
| B1.8.9 | `contains: A ∧ contains: B` | both constraints kept (`["a", 1]` stays valid), no merge error | pass (AM-12 fixed) |

### B1.9 dependencies, propertyNames, not

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.9.1 | array dependencies | union per property | pass |
| B1.9.2 | array ∧ schema dependency | schema with merged `required` | pass |
| B1.9.3 | two `propertyNames` schemas | merged schema | pass |
| B1.9.4 | two `not` schemas | `not: { anyOf: [...] }` | pass |

### B1.10 annotations and OpenAPI-specific keywords

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B1.10.1 | `nullable: true ∧ false` | `false` | pass |
| B1.10.2 | `nullable: false ∧ true` | `false` (null is forbidden by one item) | pass (AM-11 fixed) |
| B1.10.3 | `readOnly`, `writeOnly`, `deprecated` | OR | pass |
| B1.10.4 | `title`, `description`, `format`, `default`, `externalDocs` | last wins | pass |
| B1.10.5 | `examples` arrays, `example` objects / scalars | concatenated, deep merged, last | pass |
| B1.10.6 | unknown keyword, `x-*` | last wins | pass |
| B1.10.7 | `definitions`, `$defs` | objects merged, members merged too | pass |
| B1.10.8 | `xml` | deep merged | pass |
| B1.10.9 | `$id`, `$schema` | last wins / single kept | pass |
| B1.10.10 | OpenAPI `discriminator` | deep merged | pass |
| B1.10.11 | unrelated keywords from both items | all kept, input unchanged | pass |

## B2 — Conflicting and impossible merges, `onMergeError` (`test/audit/b2.conflicts.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B2.1.1 | `string ∧ number` | `onMergeError(message, [], ["string", "number"])` | pass |
| B2.1.2 | nested conflict | path of the conflicting node reported | pass |
| B2.1.3 | disjoint enums | reported with both lists | pass |
| B2.1.4 | different const | reported | pass |
| B2.1.5 | no hook given | no throw | pass |
| B2.1.6 | compatible merge | no report | pass |
| B2.2.1 | `string ∧ number` with other keywords | result is a schema that rejects everything | pass (AM-01 fixed) |
| B2.2.2 | `string ∧ number` alone at root | result is still a schema (not `undefined`) | pass (AM-01 fixed) |
| B2.2.3 | impossible property schema | property kept and rejects every value | pass (AM-01 fixed) |
| B2.2.4 | disjoint enums | result is a valid schema that rejects everything (`enum: []` is invalid) | pass (AM-01/AM-09 fixed) |
| B2.2.5 | different const | result rejects everything | pass (AM-01 fixed) |
| B2.2.6 | `const ∉ enum` | equivalent (impossible) combination | pass |
| B2.2.7 | `minimum > maximum` | equivalent (impossible) combination | pass |
| B2.2.8 | `allOf: [{type: string}, false]` | rejects everything | pass (AM-05 fixed) |
| B2.2.9 | `false` inside a property's allOf | property rejects every value | pass (AM-05 fixed) |
| B2.3.1 | one impossible `oneOf` branch | branch removed (`dropFalseBranches`), no `onMergeError`; kept as `false` with `dropFalseBranches: false` | changed (Q3-1) |
| B2.3.2 | `anyOf` branch with impossible nested property | branch kept, property is `false`, same validation | §5 rows 1/2 |
| B2.3.3 | branch conflicting with combinary sibling | only that branch is removed (`false` with `dropFalseBranches: false`) | changed (Q3-1) |
| B2.3.4 | three branches `[bad, bad, ok]` | `oneOf: [ok]`; `[false, false, ok]` with `dropFalseBranches: false` | changed (Q3-1; AM-08 fixed) |
| B2.3.5 | three branches `[bad, ok, bad]` | `oneOf: [ok]`; `[false, ok, false]` with `dropFalseBranches: false` | changed (Q3-1; AM-08 fixed) |
| B2.3.6 | all branches impossible | no `null` entries, rejects everything | pass (AM-08 fixed) |
| B2.3.6b | all branches impossible | `onMergeError` reported once at the combinary's path | pass |
| B2.3.7 | nested `oneOf` branch impossible | nested branch removed (`false` with `dropFalseBranches: false`), outer `oneOf` untouched | changed (Q3-1) |
| B2.3.8 | conflicting tuple position | no `null` in `items` | pass (AM-09 fixed) |

## B3 — `$ref` handling (`test/audit/b3.refs.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B3.1.1 | simple internal ref in allOf | resolved and merged, `definitions` kept | pass |
| B3.1.2 | `~1` / `~0` escapes | resolved | pass |
| B3.1.3 | percent-encoded segment | resolved | pass |
| B3.1.4 | ref → ref | fully resolved, no `$ref` left | pass |
| B3.1.5 | ref → ref with sibling at the intermediate target | sibling merged | pass |
| B3.1.6 | ref to a target that itself has allOf | both merged | pass |
| B3.1.7 | pointer through `/allOf/0/...` of the source | resolved | pass |
| B3.1.8 | pointer that only exists after merging | reported as unresolvable | doc |
| B3.1.9 | ref into an array index | resolved | pass |
| B3.1.10 | `$ref` outside allOf | untouched | pass |
| B3.1.11 | `source` option (fragment) | resolved against the source | pass |
| B3.1.12 | `source` with OpenAPI components | resolved | pass |
| B3.2.1 | broken ref | `onRefResolveError("Cannot resolve $ref", path, ref)`, allOf kept | pass |
| B3.2.2 | nested broken ref | path reported | pass |
| B3.2.3 | broken ref with `source` | reported | pass |
| B3.2.4 | broken ref with root siblings (`definitions`) | siblings stay at the root | pass (AM-15 fixed) |
| B3.2.5 | broken + good refs | good ones resolved | pass |
| B3.2.6 | external ref in allOf | untouched and reported | pass |
| B3.2.7 | external ref outside allOf | untouched, not reported | pass |
| B3.2.8 | broken ref without hook | no throw | pass |
| B3.3.1 | `$ref` to the allOf node itself | skipped | pass |
| B3.3.2 | `$ref: "#"` in allOf | cyclic result (self reference) | doc |
| B3.3.3 | self-recursive definition used in its own allOf | cyclic result | doc |
| B3.3.4 | indirect cycle A → B → A | all constraints kept in both | pass |
| B3.3.5 | cycle A → B → C → A | all constraints kept | pass |
| B3.3.6 | recursive `$ref` outside allOf | kept as string | pass |
| B3.3.7 | recursive definition used from outside | merged, inner `$ref` kept | pass |
| B3.3.8 | cyclic JavaScript references without `$ref` | merged, cyclic result | pass |
| B3.3.9 | cyclic JavaScript references mixed with `$ref` items | no throw | pass (AM-07 fixed) |
| B3.3.10 | cross cycle between two properties | resolved | pass |

## B4 — Sibling merging options (`test/audit/b4.sibling.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B4.1.1 | `mergeRefSibling: true` | `$ref` merged with siblings | pass |
| B4.1.2 | default | untouched | pass |
| B4.1.3 | bare `$ref` with option | untouched | pass |
| B4.1.4 | broken ref with siblings | `allOf: [{$ref}, siblings]` and report | pass |
| B4.1.5 | `$ref` siblings inside allOf items | merged regardless of the option | doc |
| B4.1.6 | ref target with its own allOf | merged | pass |
| B4.1.7 | OpenAPI component ref with siblings | merged | pass |
| B4.2.1 | `mergeCombinarySibling` on oneOf | siblings pushed into each branch, same validation | pass |
| B4.2.2 | on anyOf | same | pass |
| B4.2.3 | `definitions`, `$defs`, `$id`, `$schema` | stay outside the branches | pass |
| B4.2.4 | OpenAPI `discriminator` | stays outside | pass |
| B4.2.5 | applied to the result of an allOf merge | same validation | pass |
| B4.2.6 | branch conflicting with sibling | removed; kept as `false` with `dropFalseBranches: false`; same validation | changed (Q3-1) |
| B4.2.7 | default | untouched | pass |
| B4.2.8 | nested schema | applied | pass |
| B4.2.9 | combinary without siblings | untouched | pass |
| B4.2.10 | oneOf × anyOf from different allOf items | cartesian product, same validation | pass |
| B4.2.11 | both options on a GraphApi-like document | merged | pass |

## B5 — Nested allOf (`test/audit/b5.nested.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B5.1.1–13 | allOf under `properties`, `patternProperties`, `additionalProperties`, `items` (schema and tuple), `additionalItems`, `contains`, `propertyNames`, `definitions`, `$defs`, `dependencies`, `oneOf`, `anyOf` | merged, no `allOf` left | pass |
| B5.1.14 | allOf under `not` | merged | pass (AM-18 fixed) |
| B5.1.15 | allOf inside allOf items (flattening) | merged flat | pass |
| B5.1.16 | allOf item with both allOf and siblings | merged | pass |
| B5.1.17 | allOf next to other keywords | siblings merged in | pass |
| B5.1.18 | allOf produced by merging nested properties | merged recursively | pass |
| B5.1.19 | allOf in oneOf branches combined with outer allOf | merged | pass |
| B5.1.20 | deep mixed structure | merged, same validation | pass |
| B5.2.1 | allOf under an unknown key of a JSON Schema document | untouched | doc |
| B5.2.2 | allOf in a non-schema OpenAPI location | untouched | doc |

## B6 — Draft rule sets and custom rules (`test/audit/b6.drafts.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B6.1.1 | default rules are draft-06, `const` merged | `const` kept | pass |
| B6.1.2 | numeric exclusive bounds | tightest | pass |
| B6.1.3 | `$defs` and `definitions` | merged | pass |
| B6.1.4 | `propertyNames`, `dependencies` | merged | pass |
| B6.2.1 | draft-04 boolean exclusive flags with equal bounds | OR | pass |
| B6.2.2 | draft-04 `const` | not a keyword, last wins | doc |
| B6.2.3 | draft-04 `$defs` | last wins, `definitions` merged | doc |
| B6.2.4 | draft-04 `dependencies` | merged (it is a draft-04 keyword) | pass (AM-17 fixed) |
| B6.2.5 | draft-04 common keywords | merged | pass |
| B6.3.1 | 2020-12 `prefixItems` | merged position-wise | pass (AM-20 fixed) |
| B6.3.2 | 2020-12 `dependentRequired` | union | pass (AM-20 fixed) |
| B6.3.3 | 2020-12 `$defs` + `items` schema | merged, the `$ref` inside the merged `items` is resolved | pass (expectation updated, §4) |
| B6.4.1 | custom rule for `x-tags` | applied | pass |
| B6.4.2 | custom rule overriding `type` | applied | pass |
| B6.4.3 | custom rules propagate into nested schemas | applied | pass |
| B6.4.4 | rules without `/allOf` | document untouched | pass |
| B6.4.5 | explicit `rules` bypass auto-detection | OpenAPI document untouched with JSON Schema rules | pass |

## B7 — OpenAPI 3.x rules (`test/audit/b7.openapi.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B7.1.1 | auto-detect 3.0 | component schemas merged | pass |
| B7.1.2 | auto-detect 3.1 | merged | pass |
| B7.1.3 | `openApiMergeRules()` default | 3.0.x (boolean exclusive flag) | pass |
| B7.1.4 | no `openapi` key | `components` is not a schema location | pass |
| B7.2.1 | path parameters, operation parameters, requestBody content, response headers and content, `components.schemas/parameters/headers/responses/requestBodies` | all merged | pass |
| B7.2.2 | `$ref` to `components.schemas` | resolved | pass |
| B7.2.3 | `$ref` from a parameter schema | resolved | pass |
| B7.2.4 | `callbacks`, `webhooks` | merged | pass (AM-21 fixed) |
| B7.2.6 | `encoding/*/headers/*/schema` | merged | pass (AM-21 fixed) |
| B7.2.5 | non-schema allOf (`info`, `x-root`) | untouched | pass |
| B7.3.1 | 3.0 `nullable: true ∧ false` | `false` | pass |
| B7.3.2 | 3.0 `nullable: false ∧ true` | `false` | pass (AM-11 fixed) |
| B7.3.3 | 3.0 boolean exclusive flag, equal bounds | OR | pass |
| B7.3.4 | 3.0 boolean exclusive flag, larger inclusive bound wins | flag dropped | pass (AM-10 fixed) |
| B7.3.5 | `discriminator` | merged | pass |
| B7.3.6 | `x-*` | last wins | pass |
| B7.3.7 | `readOnly`/`deprecated`/`example` | OR / OR / merged | pass |
| B7.3.8 | 3.0: two `items` schemas | merged (currently throws) | pass (AM-06 fixed) |
| B7.3.9 | 3.0: single `items` with nested allOf | merged | pass |
| B7.3.10 | 3.0: `enum`, `required` | intersected, united | pass |
| B7.4.1 | 3.1 numeric exclusive bounds | tightest | pass |
| B7.4.2 | 3.1 `const` | merged | pass |
| B7.4.3 | 3.1 type arrays with `null` | intersected | pass |
| B7.4.4 | 3.1 two `items` schemas | merged | pass |
| B7.5.1 | conflict path in a document | full path reported | pass |
| B7.5.2 | broken component ref | full path and ref reported | pass |

## B8 — GraphApi rules (`test/audit/b8.graphapi.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B8.1.1 | auto-detect `graphapi` key | component objects merged | pass |
| B8.1.2 | `graphapiMergeRules` as explicit rules | merged | pass |
| B8.1.3 | `queries`, `mutations`, `subscriptions` and their `args` | merged | pass |
| B8.1.4 | directive `args` | merged | pass |
| B8.1.5 | `$ref` to components | resolved | pass |
| B8.2.1 | `nullable` | OR | pass |
| B8.2.2 | `specifiedByURL` | last wins | pass |
| B8.2.3 | enum `values` with nested description/deprecated | merged objects | pass |
| B8.2.4 | `interfaces`, `directives` maps | merged | pass |
| B8.2.5 | standard JSON Schema keywords | JSON Schema resolvers used | pass |

## B9 — Output properties (`test/audit/b9.output.test.ts`)

16 representative inputs (basic, properties, patternProperties, tuple items, `$ref`, `$ref` siblings, oneOf pruning, combinary sibling, combinary product, dependencies, not, enum/required, pattern, nested allOf, OpenAPI) are run through each check.

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B9.1.* | deep-frozen input, and input compared before/after | not mutated | pass |
| B9.1.17 | several `additionalItems` meeting an `items` schema | not mutated | pass (AM-14 fixed) |
| B9.2.* | output vs input object identity | no shared object references | pass |
| B9.2.17 | resolved `$ref` target used twice | copied, not aliased with the input; copied sub-schemas are shared between usages (json-crawl clone semantics) | doc |
| B9.2.18 | same input object referenced twice | same output object | doc |
| B9.2.19 | nothing to merge | new root object | pass |
| B9.3.* | `merge(merge(x)) ≡ merge(x)` | idempotent | pass |
| B9.3.17 | merging a merged document | no-op | pass |
| B9.4.* | `JSON.stringify(output)` | serializable | pass |
| B9.4.17 | no `undefined` values in a successful merge | round-trips through JSON | pass |
| B9.4.18 | cyclic `$ref` inside allOf | cyclic object (not serializable) by design | doc |
| B9.4.19 | recursive `$ref` outside allOf | serializable | pass |

## B10 — Robustness (`test/audit/b10.robustness.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B10.1.1–5 | number, string, true, false, null | returned unchanged | pass |
| B10.1.6 | `undefined` | `undefined` | pass |
| B10.1.7 | root array | untouched (root is not a schema) | doc |
| B10.1.8 | `{}` | `{}` | pass |
| B10.2.1 | empty allOf | removed | pass |
| B10.2.2 | single-item allOf | unwrapped | pass |
| B10.2.3 | non-object allOf items | ignored | doc |
| B10.2.4 | `allOf` that is not an array | dropped | doc |
| B10.2.5 | `allOf: [true, true]`, `[{...}, true]` | `{}`, the schema | pass |
| B10.2.6 | `allOf: [{}, {}]` | `{}` | pass (AM-09 fixed) |
| B10.2.7 | property with `allOf: [{}, {}]` | property kept as `{}` | pass (AM-09 fixed) |
| B10.2.8 | tuple positions merging to `{}` | `{}` (not `null`) | pass (AM-09 fixed) |
| B10.2.9 | `allOf: [false]` | rejects everything | pass (AM-05 fixed) |
| B10.2.10 | duplicated items | single item | pass |
| B10.2.11 | same JS object twice in one allOf | the item | pass |
| B10.3.1 | 5 000 properties with allOf | all merged | pass |
| B10.3.2 | 1 000 nested levels with allOf on every level | all merged | pass |
| B10.3.3 | 1 000 levels of allOf inside allOf | flattened | pass |
| B10.3.4 | 200-item allOf chain | merged | pass |
| B10.3.5 | 1 000 usages of one `$ref` | merged | pass |
| B10.3.6 | ring of 100 definitions through allOf `$ref` | merged, terminates | pass |
| B10.3.7 | ring of 50 cyclic JS nodes | merged, terminates | pass |
| B10.3.8 | `merge` called on every node with `source` (api-smart-diff usage) | identical to a single merge | pass |
| B10.3.9 | output of a large merge | accepted by a validator | pass |
| B10.3.10 | 100 broken refs | all reported | pass |

## B11 — Public API (`test/audit/b11.api.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B11.1.1 | documented exports | present | pass |
| B11.1.2 | `allOfResolverHook` with `syncClone` | merges | pass |
| B11.1.3 | hook without rules | no-op | pass |
| B11.2.1 | `isRefNode` | truthy only for non-empty string `$ref` | pass |
| B11.2.2 | `isAnyOfNode` / `isOneOfNode` | truthy only for arrays | pass |
| B11.3.1 | `parseRef` with escapes | pointer, normalized, jsonPath | pass |
| B11.3.2 | `parseRef("#")`, `"#/"` | empty pointer | pass |
| B11.3.3 | external refs | filePath split | pass |
| B11.3.3b | `basePath` for a local ref | applied | pass (AM-22 fixed) |
| B11.3.4 | percent-encoding | decoded | pass |
| B11.3.5 | `createRef` | normalized refs | pass |
| B11.3.6 | `parseRef` ∘ `createRef` round-trip | identity | pass |
| B11.4.1 | `resolvePointer` plain pointers, indices, escapes | resolved | pass |
| B11.4.2 | missing paths, out-of-range, non-object data | `undefined` | pass |
| B11.4.3 | through an intermediate `$ref` | remaining segments applied | pass (AM-16 fixed) |
| B11.4.4 | through a self-referencing `$ref` | `undefined` | pass (AM-16 fixed) |
| B11.5.1 | `mergeValues` | deep merge / concat / patch wins | pass |
| B11.5.2 | `mergeValues` arguments | not mutated | pass |
| B11.5.3 | `pathMask` | four regexps that round-trip escaping | pass |
| B11.6.1–3 | `merge` without options, with `{}`, default `source` | works | pass |

## B12 — Additive API of the redesign (`test/audit/b12.redesign.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B12.1.1–4 | `unsatisfiable` option | `false` by default, `{ not: {} }` with `"not-empty"`; a combinary whose every branch is unsatisfiable is reported once, a surviving branch silences the others | pass |
| B12.2.1–4 | `branchBudget` | products within the budget are merged; above it the node is unchanged and `onMergeError` carries the budget message | pass |
| B12.3.1–6 | `createMerger` | same results as `merge`, `hook` usable with `syncClone`, merged instances shared across calls, per-call `source`/`rules`, memo survives a throwing hook | pass |
| B12.4.1–8 | `"draft-07"` / `"2020-12"` | memoized frozen rules, `prefixItems`+`items`, `dependentRequired`/`dependentSchemas`, `unevaluated*`, `minContains`/`maxContains`, `if`/`then`/`else` fragments, OpenAPI 3.1 uses 2020-12 | pass |
| B12.5.1–7 | keyword groups and custom rules | custom `$` disables the group, `group` tag keeps it, pattern fallback to allOf fragments, first-seen order, type lattice order, `false` tail truncation, no input mutation | pass |
| B12.6.1–4 | `createResolutionIndex` | direct targets, reasons for broken/external/cyclic refs, walk through intermediate refs, cached results | pass |

## B13 — Engine fixes of the verification (`test/audit/b13.engine-fixes.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B13.1.1–3 | own-property safe helpers (`src/safe.ts`) | `safeSet` writes `__proto__` as own data, `hasOwn`/`getOwn` ignore inherited members, `safeClone`/`safeAssign` copy `__proto__` | pass |
| B13.2.1–5 | prototype safety of the engine (VR-20 … VR-23) | memoized conjunction under `__proto__` sets no prototype, `__proto__`/`constructor`/`prototype` members survive, refs to inherited members are broken refs, `resolvePointer`/index never return `Object.prototype` | pass |
| B13.3.1–7 | references (VR-36, VR-40, D-9) | unknown plain-name fragment is broken (never the root), `$anchor`/`$id: "#x"` resolve, `#/` is member `""`, ref -> ref cycles reported, `mergeRefSibling` leaves broken/external refs with siblings unchanged | pass |
| B13.4.1–6 | cycle re-entries (D-4, D-4b, VR-30, VR-31) | fragment merges emit only refs that resolve against `source`, #208 part b serializable, whole-document cycles and cyclic JS input serializable, cyclic value outside source → `{}` + report, cycle outputs not shared into another document | pass |
| B13.5.1–3 | contradictions keep container siblings (D-10, VR-32) | `{ allOf: [false], $defs }`, `definitions`/`$id`/`$schema` kept, plain `false` otherwise | pass |
| B13.6.1–8 | resource limits (D-7, VR-03 … VR-06) | per-call branch budget incl. sibling distribution and the exported resolver, `$ref` fan-out bounded, `maxRefExpansion` keeps `$ref` items, `maxDepth`, 20 000-level plain chain linear, 20 000 nested allOf / `$ref` chain without stack overflow | pass |
| B13.7.1–3 | merger memo and sharing (VR-33, VR-24, D-11) | memo keyed by rules, shared conjunctions across documents, `freezeOutput` | pass |
| B13.8.1–4 | reporting (VR-41, VR-37, D-6) | input-unsatisfiable combinary not reported, malformed `allOf` / items / `anyOf` / `oneOf` ignored and reported, never throw | pass |
| B13.9.1–3 | API (VR-46, VR-47, VR-38) | group objects exported, custom `$: jsonSchemaMergeResolver` and direct calls fully merge children | pass |
| B13.10.1–4 | `unevaluated*` (D-8, VR-12) | items with own `unevaluated*` stay fragments (a `$ref` item as `$ref`), the node's own is merged | pass |
| B13.11.1 | `GroupContext` plumbing | groups receive the resolved settings (incl. `expansionBudget` and the simplification settings) and a `report` bound to the node path | pass (changed: settings fields) |

## B14 — Keyword fixes of the verification (`test/audit/b14.keyword-fixes.test.ts`, oracle helpers in `test/audit/b14.oracle.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B14.1.1–7 | `patternProperties × additionalProperties` (D-5, VR-10, VR-11) | another item's `additionalProperties` schema conjoined into kept patterns, identical patterns merged, other interactions kept as fragments (oracle-checked) | pass |
| B14.2.1–5 | bounded pattern matching (D-3, VR-02, VR-24) | evil pattern finishes quickly, nested-quantifier heuristic, `matchPatterns: false` and length caps, per-node test budget, bounded LRU cache | pass |
| B14.3.1–7 | OpenAPI 3.0 `nullable` (D-1, VR-13, VR-14) | OAS 3.0.3 reading: typed item without `nullable: true` forbids null, untyped items do not restrict it, only-null result, JSON Schema / GraphApi semantics unchanged | pass |
| B14.4.1–2 | `format` (D-2, VR-16) | numeric lattice, other differing formats as fragments + report | pass |
| B14.5.1 | missing `minContains` (VR-15) | counts as 1 | pass |
| B14.6.1–4 | `multipleOf` (VR-01) | malformed values reported and terminating, inexact LCM kept as fragments, exact decimal/integer LCM, utils never loop or throw | pass |
| B14.7 (14 cases) | malformed keyword values (D-6, VR-37) | ignored, valid parts merged, reported | pass |
| B14.8.1–3 | deep values (VR-06) | `deepEqual`/`mergeValues` on 10 000 levels, deep `enum`/`const`/`example`, cycle-safe `deepEqual` | pass |
| B14.9.1–3 | linear merges (VR-07) | 20k enum objects, 20k required names, 10k single-property items | pass |
| B14.10.1–3 | own-property safety of the keyword groups (VR-21, VR-22) | `constructor` does not bypass `additionalProperties: false`, `__proto__` members survive everywhere | pass |
| B14.11.1–2 | frozen rule sets (VR-26) | built-in and lazily derived rules are frozen | pass |
| B14.12.1–5 | per-key fallbacks when a custom rule hands a group back (VR-39) | object shape, array shape, draft-04 exclusive flag travels with the bound the custom rule selects, pattern / contains / if fragments | pass |
| B14.13.1–2 | #232 | nested `number ∧ integer`, `["number","null"] ∧ ["integer","null"]` | pass |
| B14.14.1 | exports | new resolvers exported, groups own the new keys | pass |

## B15 — Integration of the verification fixes (`test/audit/b15.integration.test.ts`)

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B15.1.1–4 | draft-04 exclusive flags under a custom `/minimum` / `/maximum` (VR-39, AM-10) | the flag of the item(s) carrying the selected bound value (exclusive if any of them is); default group mode unchanged | pass |
| B15.2.1 | per-key object-shape fallbacks | use the call's `matchPatterns` (`false` → fragments, same as group mode) | pass |
| B15.3.1–5 | identity keywords of `$ref`-inlined items | `$id`/`id`/`$anchor`/`$dynamicAnchor`/`$schema`/`$vocabulary` not copied (single and merged targets, nested allOf items, `$ref: "#"`), the node's own survive, non-string `id` is a normal key, recursive targets still yield cycle `$ref`s | pass |
| B15.4.1 | `mergeCombinarySibling` (VR-21) | `__proto__` siblings copied as own data, no pollution | pass |
| B15.5.1–3 | `expansionBudget` (D-7, VR-03) | a fat target fanned out below `maxRefExpansion` is bounded and reported once, a small budget keeps the `$ref` of the exceeding node (equivalent), 4 000 usages of one target merge fully with the defaults | pass |
| B15.6.1 | empty / non-string `$ref` in `allOf` (VR-42) | a broken ref: node kept, `onRefResolveError` | pass |
| B15.7.1–3 | probe-corpus replay findings | a bare `$ref` into a merged-away `allOf` does not dangle: it links the matching merged location (D-23; was: inlined; other refs untouched), a 1 000-step `allOf` → `$ref` chain merges fully (shared outputs keep their own inlining counts), malformed `uniqueItems` / `items: null` / invalid patterns reported | pass |

## B16 — User decisions D-14, D-17, D-18, D-19 (`test/audit/b16.decisions.test.ts`)

A suite-wide check backs D-17: `test/setup/refIntegrity.ts` (jest `setupFilesAfterEnv`) wraps `merge` and `createMerger().merge` for every test file and throws when a whole-document merge (no `source`, or `source` is the merged value) returns a `$ref` that resolved in the input but not in the output (helper `danglingRefs` / `expectRefsResolve` in `test/helpers/refIntegrity.ts`); `ALLOF_MERGE_REF_CHECK=0` disables it. Every fixture of the suite and both `test/resources` documents pass it.

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B16.1.1 | JSON Schema draft-04/06/07/2020-12, `int32 ∧ int64`, `float ∧ double` (D-14) | `allOf` fragments + one `onMergeError` | pass |
| B16.1.2 | GraphApi rule set, `int32 ∧ int64` | fragments + `onMergeError` | pass |
| B16.1.3 | OpenAPI 3.0.3 / 3.1.0 documents, root and nested property | lattice narrows (`int32`, `float`); `date ∧ date-time` stays a conflict | pass |
| B16.1.4 | `openApiJsonSchemaMergeRules` 3.0/3.1 vs `jsonSchemaMergeRules("2020-12")` | lattice only under the OpenAPI schema rules | pass |
| B16.1.5 | custom `/format` rule with `mergeOpenApiFormat` (group and per-key) / `mergeFormat` | lattice opt-in, strict resolver keeps fragments | pass |
| B16.2.1 | `Node = { allOf: [{ properties: { child: { $ref: "#/definitions/Node/allOf/0" }, … } }, { required }] }` (D-17, changed by D-22) | `Node` merged, `child` a copy of `allOf/0` whose inner `child` is `{ $ref: "#/definitions/Node/properties/child" }` (was: `allOf` kept), no dangling ref, no reports | pass |
| B16.2.2 | same document behind `properties.root` | ajv draft-07 oracle: same validation | pass |
| B16.2.3 | other definitions next to it | every `allOf` merged (D-22; was: the one on the pointer path kept) | pass |
| B16.2.4 | memo re-entry (D-4) whose source pointer runs through an `allOf` member, referenced through a second definition | `A` merged, the re-entry points to `#/definitions/A/properties/next` (D-22; was: `A` kept its `allOf`), `Ref` merged, every output `$ref` resolves in the output, ajv oracle | pass |
| B16.2.5 | fragment merge with `source` | every emitted pointer resolves against `source` | pass |
| B16.2.6 | bare `$ref` into a merged `allOf` without a cycle (D-16) | still inlined, the node merged | pass |
| B16.2.7 | merger reused after a cyclic call | the first output is merged (D-22), the next document is merged normally | pass |
| B16.2.8 | cycle through an `allOf` in OpenAPI `components/schemas` | merged, the re-entry points to `#/components/schemas/Node/properties/child`, `User` shares it (D-22; was: kept), refs resolve | pass |
| B16.2.9 | `openapi30x.json`, `openapi31x.json` (also with `mergeRefSibling` + `mergeCombinarySibling`) | every output `$ref` resolves in the output | pass |
| B16.2.10 | helper self-check | dangling ref found; refs broken in the input and external refs ignored | pass |
| B16.3.1 | `{ prefixItems: [string] } ∧ { items: [{ minLength: 1 }, number] }` under draft-04/06/07 (D-18) | `prefixItems` and `items` side by side, no report | pass |
| B16.3.2 | same under 2020-12 | `{ prefixItems: [string], allOf: [{ items: [...] }] }` + one `onMergeError` | pass |
| B16.3.3 | draft-07: two tuples with `additionalItems` and `prefixItems` | positional merge of `items`, `prefixItems` last-wins; ajv draft-07 oracle | pass |
| B16.3.4 | 2020-12: `prefixItems` + `items` tails | positional merge; ajv 2020 oracle | pass |
| B16.3.5 | 2020-12: two legacy tuples (one with `additionalItems`) + different `contains` | legacy and `contains` fragments both kept, one report for the tuples | pass |
| B16.3.6 | 2020-12: single array `items`; stray `additionalItems` | copied as is without report; last-wins | pass |
| B16.3.7 | OpenAPI 3.0 vs 3.1 documents | 3.0 reads `items` as the tuple, 3.1 `prefixItems` (legacy fragment + report) | pass |
| B16.3.8 | custom `/items` rule (per-key fallbacks) under draft-07 and 2020-12 | same per-draft reading, legacy fragments once | pass |
| B16.3.9 | default rules (draft-06), mixed input of the replay | not read as one tuple any more; ajv draft-07 oracle | pass |
| B16.4.1 | default vendor / unknown keys (D-19) | silent last-wins at every depth | pass |
| B16.4.2 | exact `"/x-go-type"` rule | applies at the root, `properties/*`, `items`, `additionalProperties`, `not`, `definitions/*` | pass |
| B16.4.3 | `"/x-go-type": { $: equal }` | a conflict is a contradiction (`false` + report), equal values merge | pass |
| B16.4.4 | `"/^": { "x-": rule }` | applies at the root, `properties/*`, `items`, `patternProperties/*`; non-`x-` keys stay last-wins | pass |
| B16.4.5 | precedence exact > longest prefix > `/*`; built-in keywords are exact keys | as listed; `/*` reaches unknown keys only | pass |
| B16.4.6 | custom `"/?"` rule | overrides last-wins for every unknown key (root and nested); prefix rules and built-ins still win | pass |
| B16.4.7 | rule sets without `"/?"` (copied rules, hand-written tree) | last-wins instead of `Merge rule not found` | pass |
| B16.4.8 | `openApiMergeRules(3.0.x / 3.1.x, customRules)`, `openApiJsonSchemaMergeRules(version, customRules)` | vendor rules in components, parameter and response schemas; memoized; OpenAPI semantics kept | pass |
| B16.4.9 | `createGraphapiMergeRules(customRules)` | vendor rules in GraphApi schemas; memoized; `createGraphapiMergeRules()` is `graphapiMergeRules`; nullable OR kept | pass |
| B16.4.10 | caller-owned custom rules | not frozen by any factory | pass |
| B16.4.11 | vendor rules vs validation | ajv oracle: same validation | pass |

Changed expectations of earlier blocks: B14.4.1 (`int32 ∧ int64` under the JSON Schema rules is now a conflict, D-14), B6.3.1 (`prefixItems` merged with the 2020-12 rules, D-18), `merge.jsonschema.test.ts` › "should merge unknown keys last-wins if no merge rule is defined" (was "should throw error if merge rule not defined", D-19).

## B17 — User decisions D-20, D-21: `$ref` targets inside rewritten nodes (`test/audit/b17.ref-targets.test.ts`)

Every case checks the whole-document contract with three helpers of `test/helpers/refIntegrity.ts`: `expectRefsResolve` (no dangling `$ref`, D-17), `expectRefsKeepMeaning` (no output `$ref` runs through an input node with its own `allOf` whose output counterpart was merged; structural, also run suite-wide by `test/setup/refIntegrity.ts`) and `expectRefMeaningPreserved` (ajv oracle: every `$ref` site of the input that still exists in the output and every output `$ref` accept the same instances in the input and the output document). Most cases also compare the whole documents with `expectSameValidation`. No expectation of an earlier block changed.

| Id | Case | Expected | Status |
| --- | --- | --- | --- |
| B17.1.1 | OpenAPI `LegacyId = { allOf: [string, number], properties: { code } }`, `Order.properties.code = { $ref: LegacyId/properties/code }` (D-20) | `LegacyId: false`, `code` inlined as `{ type: string, maxLength: 8 }`, one `onMergeError`, ajv oracle | pass |
| B17.1.2 | the dropped target has its own `allOf` | inlined target merged in its own right | pass |
| B17.1.3 | contradiction with a `definitions` sibling, refs into `properties` and into `definitions` | `{ allOf: [false], definitions }`; the `properties` ref inlined, the `definitions` ref stays `$ref`; ajv oracle | pass |
| B17.1.4 | `unsatisfiable: "not-empty"` | `{ not: {} }`, ref inlined | pass |
| B17.1.5 | contradiction from a `$ref` item, pointer below the dropped member (`…/list/items`) | `false`, items schema inlined; ajv oracle | pass |
| B17.2.1 | `A = { properties: { x: string }, allOf: [{ properties: { x: { minLength: 3 } } }] }`, `p: { $ref: A/properties/x }` (D-21) | `p: { type: string }`, `A` merged, `{ $ref: A }` stays; ajv oracle | pass |
| B17.2.2 | the referenced member is not changed by the merge | the link stays (D-23; was: inlined) | pass |
| B17.2.3 | OpenAPI `$ref: '#/components/schemas/Pet/properties/id'`, `Pet` has `allOf: [{ $ref: Base }]` | original `id` inlined, `Pet` merged, `$ref: Pet` stays | pass |
| B17.2.4 | the inlined value has its own `allOf` | merged | pass |
| B17.2.5 | pointer below the member (`…/list/items`), pointer through an intermediate `$ref` (`B = { $ref: A }`, `#/definitions/B/properties/list`) | both inlined with the original values, `B` stays `$ref` (ajv cannot resolve the intermediate-`$ref` pointer: structural checks for that one) | pass |
| B17.2.6 | refs into `definitions` of a merged node and of a merged root | untouched `$ref`s | pass |
| B17.2.7 | `$ref` inside `A` to its own sibling member, no cycle | inlined, `A` merged | pass |
| B17.2.8 | pointer into a merged node from inside that same node (`x.properties.next → A/properties/x`) | `A` merged, `next` and `n` are copies of the original `x` re-entering `#/definitions/A/properties/x/properties/next` (D-22; was: `A` kept unmerged), output `$ref`s resolve, < 1 s, ajv oracle | pass |
| B17.2.9 | fragment mode (`source` given), plain and cyclic | plain: the `$ref` stays (it resolves against `source`, D-22; was: inlined); cyclic: pointers resolve against `source`, ajv oracle against `source` | pass |
| B17.2.10 | `$ref` with siblings through a merged node; with `mergeRefSibling` | a copy conjoined with the `maxLength` sibling in every draft (D-24; was: the sibling dropped and reported under draft-06 rules, before that the node kept unmerged), `A` merged, no report; with `mergeRefSibling` original target ∧ siblings; ajv 2020 oracle | changed (D-24) |
| B17.2.11 | `maxRefExpansion: 1` / `expansionBudget: 1` with two refs | reported, the kept ref keeps `A` unmerged, refs keep their meaning | pass |
| B17.2.12 | `mergeCombinarySibling` pushes the member into `oneOf` branches | ref inlined; without the option the ref stays | pass |
| B17.2.13 | `mergeRefSibling`: pointer through a merged `$ref`-with-siblings node | original member inlined | pass |
| B17.2.14 | raw hook with `syncClone` | inlined (single pass) | pass |
| B17.2.15 | 2020-12 `$defs` document | inlined; ajv 2020 oracle | pass |
| B17.3.1 | one document with D-16, D-17, D-20 and D-21 cases | each ref follows its rule (the cyclic `Node` merged since D-22); ajv oracle | pass |
| B17.3.2 | merge of the output | idempotent | pass |
| B17.3.3 | merger reused after a cyclic call | the first output is merged (D-22), next document merged normally | pass |
| B17.3.4 | `openapi30x.json`, `openapi31x.json` (also with both sibling options) | refs resolve, copies only where no equal merged value exists (`expectRefsKeepMeaning`, D-22) | pass |
| B17.4.1 | `refsThroughMergedNodes` self-check (diagnostic since D-22) | flags the pointer into the merged node, accepts container and target pointers | pass |
| B17.4.2 | `expectRefMeaningPreserved` self-check | fails for a stricter target, lists the checked locations | pass |

## B18 — User decisions D-22, D-23: links into merged schemas stay links (`test/audit/b18.ref-rewrite.test.ts`)

Every case checks the whole-document contract: every output `$ref` resolves, a `$ref` is a copy only where the merged output holds no equal value (`expectRefsKeepMeaning`), and — where ajv can resolve the input pointers — `expectRefMeaningPreserved` (every `$ref` site and every output `$ref` accepts the same instances in input and output). B18.8 (D-27) rewrites pointers to shifted branch indexes, which do not mean the same in the input, so it checks the meaning per `$ref` site instead (ajv, input site vs output site).

| Id | Case | Expected | Status |
|---|---|---|---|
| B18.1.1 | OpenAPI 3.0 and 3.1: `Order.petId = { $ref: Pet/allOf/1/properties/id, description }`, `Pet = { allOf: [{ $ref: Base }, { properties: { id, … } }] }` | `{ $ref: "#/components/schemas/Pet/properties/id", description }`, `Pet` merged, no reports, ajv oracle per draft | pass |
| B18.1.2 | OpenAPI 3.0 and 3.1: bare nested pointer `Pet/allOf/1/properties/tags/items` | `{ $ref: Pet/properties/tags/items }` | pass |
| B18.1.3 | pointer that already is the matching location (sibling member of a merged node, unchanged) | kept as it is | pass |
| B18.1.4 | refs into `allOf` members of `allOf` members (`A/allOf/0/allOf/1/properties/x`, `A/allOf/0/allOf/1`) | `{ $ref: A/properties/x }`; the member itself (not equal to merged `A`) a copy | pass |
| B18.1.5 | pointer through an intermediate `$ref` (`B = { $ref: A }`, `B/allOf/0/properties/x`, `B/properties/x`) | `#/definitions/A/properties/x` (ajv-resolvable target place); the input form `B/properties/x` stays | pass |
| B18.1.6 | pointer through a `$ref` member (`Pet/allOf/0/properties/id`, `allOf/0: { $ref: Base }`) | `{ $ref: Base/properties/id }` | pass |
| B18.1.7 | one equal and one stricter member in one document | link and copy | pass |
| B18.2.1 | OpenAPI 3.0 and 3.1: stricter merged location (`Pet.allOf = [{ id: integer }, { id: { minimum: 1 } }]`) | copy `{ type: integer }` | pass |
| B18.2.2 | OpenAPI 3.0: stricter target, siblings `description`, `x-internal`, `maximum` | copy ∧ every sibling `{ type: integer, maximum: 100, description, x-internal }`, no report (D-24; was: `maximum` dropped + `refSiblingDropped`); ajv oracle on the input as written | changed (D-24) |
| B18.2.3 | OpenAPI 3.1: same with `maximum` | copy ∧ siblings `{ type: integer, maximum: 100, description }`, ajv 2020 oracle | pass |
| B18.2.4 | OpenAPI 3.1: equal target with a constraint sibling | link with the sibling kept, ajv 2020 oracle | pass |
| B18.2.5 | `$defs` document with `{ $ref, maxLength }`: 2020-12 rules vs default draft-06 rules | both `{ type: string, maxLength: 5 }`, no report (D-24; was: draft-06 `{ type: string }` + one report); ajv oracle | changed (D-24) |
| B18.2.6 | refs into a schema that became `false` (with a description sibling, and into its `allOf` member) | copies (D-20) | pass |
| B18.2.7 | members `false` and `true` | links (`true` equals the merged `{}`) | pass |
| B18.3.1 | `Node` member referring to itself through its `allOf` location | `Node` merged, the copy re-enters itself, ajv oracle on nested instances | pass |
| B18.3.2 | cycle whose source pointer does not run through a rewritten node | source pointer kept (`#/definitions/List`) | pass |
| B18.3.3 | cyclic member under `items` | merged, refs resolve, no copy with an equal link, ajv oracle | pass |
| B18.3.4 | mutually recursive members of two definitions | terminates < 2 s, both merged, ajv oracle | pass |
| B18.4.1 | `mergeRefSibling` / `mergeCombinarySibling` off and on | links / copies per case (oneOf distribution → copy; merged `$ref`-with-siblings node → link) | pass |
| B18.4.2 | `createMerger` reuse: same document twice, another document, the same input instances twice | equal outputs, every ref resolves in its own output | pass |
| B18.4.3 | fragment mode | `$ref`s left as they are, resolve against `source` | pass |
| B18.4.4 | raw hook with `syncClone` | links rewritten at the root's end | pass |
| B18.4.5 | `freezeOutput: true` | relinked output frozen | pass |
| B18.4.6 | merge of the output (both option sets, a cyclic OpenAPI document) | idempotent | pass |
| B18.4.7 | `maxRefExpansion: 1` | the kept `$ref` keeps its node unmerged (D-17 fallback) | pass |
| B18.5.1 | `openapi30x.json`, `openapi31x.json` extended with refs into `Dog`/`Cat` members | `Dog/properties/breed` link with description, `Pet/properties/pet_type` link, a copy of `Cat/allOf/1`; contract, ajv oracle, idempotent with both option sets | pass |
| B18.6.1 | one object under `info.x-example` and `components/schemas` (both orders) | merged only under `components/schemas` (identity memo per rules) | pass |
| B18.6.2 | the same instance twice under the same rules | still one shared output instance | pass |
| B18.7.1 | 2020-12: pointer to an `allOf` member that is a `$ref` to a target with `unevaluatedProperties` | link to the target's own place `#/$defs/U`, ajv 2020 oracle | pass |
| B18.7.2 | such a target as a sibling member of a merged node | copied whole, ajv 2020 oracle | pass |
| B18.7.3 | memo re-entry (D-4) whose source pointer runs through a merged node | points to the output location `#/definitions/A/properties/next`, ajv oracle | pass |
| B18.7.4 | pointer below a copy that became a link (`#/properties/p/properties/x`) | moved below the link's target (`#/definitions/A/properties/x`) | pass |
| B18.7.5 | root `{ $ref: A/allOf/0, definitions }` | stays a copy (its target lies inside it), ajv oracle | pass |
| B18.8.1 | D-27: `X.oneOf = [<impossible>, integer, boolean, <impossible>, null]`, pointers to indexes 2, 1, 4, 0 | links `X/oneOf/1`, `X/oneOf/0`, `X/oneOf/2`; the removed branch a copy `false` (its own report only); per-site ajv check | pass |
| B18.8.2 | pointer below a shifted `anyOf` branch, `$ref` with a `description` sibling | `X/anyOf/0/properties/a`; `{ $ref: X/anyOf/0, description }` | pass |
| B18.8.3 | `dedupeAnyOf`: pointer to a removed duplicate, below a shifted branch, before the first removed one | links the equal kept branch `anyOf/0`; `anyOf/2/properties/a`; `anyOf/1` unchanged | pass |
| B18.8.4 | nested shifted lists `X/oneOf/1/oneOf/2` | `X/oneOf/0/oneOf/1` | pass |
| B18.8.5 | `X = { allOf: [object], oneOf: [string, …] }` without / with `mergeCombinarySibling` | nothing shifts (link kept); distributed branches are not equal to the input branch: a copy | pass |
| B18.8.6 | `dropFalseBranches: false`, `dedupeAnyOf: false` | nothing shifts, the pointer stays | pass |
| B18.8.7 | merge of the relinked output | idempotent | pass |

## B19 — `refAnnotations` (#222) (`test/audit/b19.ref-annotations.test.ts`)

The #222 document of `docs/FEATURE_DESIGN.md` §1.1 (`Base` with `title`, `description`, `$comment`, `x-go-name`, `examples`, `deprecated`; `Derived`, `Titled`, `Alias`, `Two`, `RefSib`, `RefSibT`, `Prop.owner`, `OneOfT`, `Inline`), merged with `mergeRefSibling` and `mergeCombinarySibling`. Test plan ids F1.x of the design in brackets.

| Id | Case | Expected | Status |
|---|---|---|---|
| B19.1.1 | default / `"merge"` (F1.1) | output as before: every inherited annotation promoted, own values win | pass |
| B19.2.1 | `"omit"`: `Derived`, `Alias`, `Two` (F1.2) | no `title`/`description`/`$comment`; `x-go-name`, `examples`, `deprecated` still promoted | pass |
| B19.2.2 | own `title` / `description` next to `allOf` (F1.3) | kept | pass |
| B19.2.3 | sibling of the `$ref` allOf item (F1.4) | kept | pass |
| B19.2.4 | inline `allOf` members (F1.5) | last wins as before | pass |
| B19.2.5 | nested property annotations of the target (F1.8) | kept | pass |
| B19.2.6 | `mergeRefSibling` `{ $ref, description }` (F1.9) | target title dropped, own description kept | pass |
| B19.2.7 | the referenced schemas | unchanged | pass |
| B19.3.1 | `["title", "x-*"]` (F1.6) | `title` and `x-go-name` dropped, `description` kept | pass |
| B19.3.2 | `"omit"` vs the explicit default list, `[]` vs `"merge"` | equal | pass |
| B19.3.3 | exact and prefix entries for other keys (`examples`, `deprecated`, `$comm*`) | those dropped | pass |
| B19.3.4 | key on the node and through the ref | the node's value | pass |
| B19.4.1 | nested target `A = allOf [$ref B, { title: A }]` (F1.7) | both titles dropped at the use site; `A` itself keeps its own | pass |
| B19.4.2 | `mergeCombinarySibling` `$ref` branches (F1.10, decision Q1-2) | branches keep `title: Base` / `title: Other`; same as `"merge"` | pass |
| B19.4.3 | `$ref` branches inside a merged node with a node-level `$ref` | branch annotations kept, node-level ones dropped | pass |
| B19.4.4 | without `mergeCombinarySibling` | `$ref` branches stay `$ref`s | pass |
| B19.4.5 | `oneOf` product of two `$ref` groups | the branch keeps its components' annotations, the `title` rule decides (`B`, last wins; D-26; was: dropped) | changed (D-26) |
| B19.5.1 | bare `$ref` into a stricter `allOf` member, copied (F1.11) | the copy keeps the target's annotations | pass |
| B19.5.2 | copied target with its own `$ref` members | the target's own annotations kept, its inherited ones dropped (as the target merged in its own right) | pass |
| B19.5.3 | `$ref` into an equal merged member | stays a link | pass |
| B19.6.1 | one document, two mergers (`"merge"` / `"omit"`), one merger twice (F1.12) | each result follows its option, no shared instances | pass |
| B19.6.2 | `createMerger` reuse with `freezeOutput` (F1.13) | cached stripped copies not mutated, equal results | pass |
| B19.6.3 | cycle through `allOf` and `$ref` (F1.14) | serializable, refs resolve, same output as `"merge"` without titles | pass |
| B19.6.4 | identity keywords and annotations of the target | both stripped, the node's own `$comment` kept | pass |
| B19.7.1 | OpenAPI 3.0 / 3.1 rules (F1.15) | same behaviour | pass |
| B19.7.2 | JSON Schema draft-07 / 2020-12 rules | same behaviour | pass |
| B19.7.3 | GraphApi rules | inherited `description` dropped, own kept | pass |
| B19.7.4 | ajv 2020 equivalence of every `"omit"` schema of the #222 document (F1.16) | equivalent | pass |
| B19.8.1 | D-26: `allOf: [{ oneOf: [Cat, Dog] }, { oneOf: [Indoor, Outdoor] }]` (`$ref`s), `"omit"`, default rules | titles `Indoor, Outdoor, Indoor, Outdoor` (last wins), output equal to `"merge"` | pass |
| B19.8.2 | same, `description` | `a cat, outside, a dog, outside` (last component that has one) | pass |
| B19.8.3 | custom `/title` rule first-wins and concatenation; key list `["description"]` | `Cat, Cat, Dog, Dog`; `Cat & Indoor, …`; the list keeps descriptions | pass |
| B19.8.4 | a `$ref` component and inline components | `Inline` from the inline component, `Cat` where the inline one has no title | pass |
| B19.8.5 | node-level `$ref: Base` next to the groups; a component whose own `allOf` holds the `$ref` | `Base` annotations dropped; the nested `$ref`'s annotations dropped | pass |
| B19.8.6 | `mergeCombinarySibling` distributing `properties` into product branches, with and without a node-level `$ref` | titles kept per D-26, equal to `"merge"`; the node-level `Base` title dropped | pass |
| B19.8.7 | `anyOf` products | titles kept, ajv 2020 equivalence, refs resolve | pass |

## B20 — Simplifications (`test/audit/b20.simplify.test.ts`)

Every case is checked with the cfworker oracle of `test/fuzz` (`checkCase`: no throw, serializable, same verdict as the input on generated instances, idempotent) under the draft-07 or 2020-12 profile. Test plan ids F3.x of `docs/FEATURE_DESIGN.md` §3.6 in brackets.

| Id | Case | Expected | Status |
|---|---|---|---|
| B20.1.1 | input `anyOf` with duplicates (F3.1) | kept once, first-seen order | pass |
| B20.1.2 | `anyOf` product with equal merged branches | kept once; `dedupeAnyOf: false` keeps both | pass |
| B20.1.3 | `oneOf: [S, N, S]`, `oneOf` product with equal branches (F3.2) | unchanged (S1' guard) | pass |
| B20.1.4 | `dedupeAnyOf: false` | duplicates kept | pass |
| B20.2.1 | `contains` fragments `[N, S, N]` (F3.3) | `[N, S]`; `dedupeFragments: false` keeps three | pass |
| B20.2.2 | equal `if`/`then` fragments, equal `format` fragments | kept once | pass |
| B20.2.3 | equal `{ $ref }` fragments (targets with `unevaluatedProperties`) | kept once | pass |
| B20.3.1 | three equal `oneOf [S, N, B]` groups (F3.4) | `oneOf: [S, N, B]`; off: 3 after dropping, 27 with `dropFalseBranches: false` | pass |
| B20.3.2 | six copies of a 4-branch group (F3.4) | 4 branches, no budget report; off: budget report (4096 > 1024) | pass |
| B20.3.3 | groups equal up to order (F3.5, Q3-3) | different groups: product computed, impossible branches dropped | pass |
| B20.3.4 | 5 distinct groups of 4 plus 1 duplicate (F3.6) | counts 1024 (no report); off: 4096 reported | pass |
| B20.3.5 | equal groups under `oneOf` and `anyOf` | not mixed | pass |
| B20.4.1 | written and merged impossible branches | removed | pass |
| B20.4.2 | every branch impossible, with `$defs` (F3.13) | `{ allOf: [false], $defs }`, reported once; plain `false` without containers | pass |
| B20.4.3 | input combinary already all-false | `false`, not reported (VR-41) | pass |
| B20.4.4 | `unsatisfiable: "not-empty"` | `{ not: {} }` branches removed | pass |
| B20.4.5 | `dropFalseBranches: false` | branches kept as `false` | pass |
| B20.4.6 | `$ref`s into branches whose index shifts | links to the new indexes (`X/oneOf/1`, `X/oneOf/0`; D-27; was: copies); a pointer before the removed branch stays a link | changed (D-27) |
| B20.5.1 | `enumByType`: string, integer (`1.5`, `2`), `[number, null]` (F3.9) | filtered | pass |
| B20.5.2 | empty result, `const` of another kind | `false`; matching `const` kept | pass |
| B20.5.3 | untyped `enum` | unchanged | pass |
| B20.5.4 | OpenAPI 3.0 `nullable: true` and typed without `nullable` | `null` kept / filtered (D-13) | pass |
| B20.5.5 | GraphApi rules | excluded | pass |
| B20.6.1 | number-only empty interval (F3.10) | `false`, reported | pass |
| B20.6.2 | integer interval without an integer; with one; number with a real | `false` / unchanged / unchanged | pass |
| B20.6.3 | string lengths, array counts, object counts, `required.length > maxProperties` | `false` | pass |
| B20.6.4 | `minContains > maxContains` with `contains` | 2020-12: `false`; draft-07: unchanged; a min/maxContains without `contains` is dropped by the merge | pass |
| B20.6.5 | multi-type (S6b) | the kind and its bounds leave `type`; every kind impossible → `false` | pass |
| B20.6.6 | untyped bounds (S6c, Q3-4) | unchanged, no report | pass |
| B20.6.7 | design example `{ type: [number, string], minimum: 15 } ∧ { maximum: 10, enum: [a, 12, 20] }` | `{ type: string, enum: [a] }`; without `simplify` unchanged form | pass |
| B20.6.8 | OpenAPI 3.0 draft-04 boolean exclusive bounds, nullable node | `false` / unchanged / nullable keeps its bounds | pass |
| B20.7.1 | S7 typed / untyped (F3.11) | `false` / unchanged | pass |
| B20.7.2 | required name rejected by `additionalProperties: false` | `false`; with `patternProperties` not applied | pass |
| B20.7.3 | S4b draft-07 vs 2020-12 (F3.7) | `minItems: 1`; unchanged under 2020-12 | pass |
| B20.7.4 | S4c with and without `minContains: 0`, with and without `type` (F3.8) | `false` only for the guarded case | pass |
| B20.8.1 | S9 inclusive/exclusive combinations on each side (F3.12) | the tighter bound kept, draft-07 and 2020-12 | pass |
| B20.8.2 | design example; draft-04 | `{ minimum: 5, exclusiveMaximum: 10 }`; draft-04 untouched | pass |
| B20.9.1 | `simplify` selections | only the selected rules run; `{}` is off | pass |
| B20.9.2 | counterexamples of §3.3 (F3.15): `oneOf` twins, `contains: true` + `unevaluatedItems`, `if` alone, untyped bounds | not applied | pass |
| B20.9.3 | written (unmerged) schemas | not rewritten by `simplify` | pass |
| B20.9.4 | contradiction inside a `oneOf` branch | branch dropped, not reported | pass |
| B20.9.5 | one merger per option set | the memo never mixes results | pass |
| B20.9.6 | all four safe options off | the former 27-branch form | pass |

## AsyncAPI (`test/asyncapi/*.test.ts`, FEATURE_DESIGN §2.8)

| File | Tests | Covers |
|---|---|---|
| `schema-format.test.ts` | 45 | `schemaFormat` → dialect (F2.1), `asyncApiSchemaMergeRules`, `unwrapSchemaFormat` |
| `rules.test.ts` | 22 | rule-set shape, memoization per `(version, customRules)`, freezing, custom schema rules, `discriminator` sibling |
| `asyncapi2.test.ts` | 26 | 2.x locations (components, channels, messages, traits, parameters, bindings), payload per message `schemaFormat`, `message.oneOf` untouched, streetlights fixtures |
| `asyncapi3.test.ts` | 25 | 3.x locations, Multi Format Schema Objects per format, bindings of the five protocols, streetlights fixtures, idempotence |
| `detection.test.ts` | 13 | auto-detection 2.x / 3.x (F2.11), not for 1.x, inherited members or non-strings; `merge(doc)` equals explicit rules |
| `ref-unwrap.test.ts` | 18 | a `$ref` inside `allOf` to a 3.x wrapper (F2.10, Q2-4): unwrapped for AsyncAPI / JSON Schema formats (also through `$ref` chains, in payloads and headers, auto-detected), kept + `onMergeError` for OpenAPI, Avro, Protobuf, RAML, unknown, non-string formats and wrappers without `schema`; the same kept wrapper twice is one part and one report; a `$ref` into a wrapper's inner schema follows the link rules; one merger twice; no unwrapping outside 3.x |

## F4 — property-based equivalence test (`test/fuzz/*`, FEATURE_DESIGN §4)

| Id | Case | Expected | Status |
|---|---|---|---|
| F4.1 | ajv `contains` + tuple `items` defect | allowlisted, cfworker right | pass |
| F4.2 | injected bug (`maxLength` merged with max) | found and minimized to a small case with a replay line | pass |
| F4.3 | draft-07 and 2020-12: 1 000 random `allOf` pairs/triples each (fixed seeds 7 / 2020; `FUZZ_RUNS`, `FUZZ_SEED`, `FUZZ_PATH`), options randomized: `mergeCombinarySibling`, `mergeRefSibling`, `refAnnotations` (`"merge"`, `"omit"`, `["title", "x-*"]`), the four safe simplifications (mostly on), `simplify` (off, all rules, a random selection); draft-07 generates `$ref`s with siblings again (D-24) | merged ≡ original (cfworker; draft-07 `$ref` siblings read as applying, `withRefSiblingsApplied`), serializable, idempotent; < 2 % discarded | pass |
| F4.4 | same seed | same cases | pass |
| F4.5 | corpus replay: `real-world.json` (749), `probes.json` (199, incl. the three former KI-1 cases), `fuzz-history.json` (350) | every case equivalent | pass |
| F4.6 | generated cases | mostly merged away, the oracle is not vacuous | pass |
| KI-1a/b/c | `test/fuzz/ref-siblings.test.ts` (former `known-issues.test.ts`): `$ref` allOf member with `maxLength`, root `$ref` next to `allOf`, `mergeRefSibling` with `required` | the siblings apply (D-24): documented outputs, a plain draft-07 validator differs, the D-24 oracle agrees; plus a self-test of the oracle rewrite | pass (was `it.failing`) |

`npm run test:fuzz` runs the block; a local run with `FUZZ_RUNS=5000` (2 × 5 000 random cases + corpus) passed in 27 s.

## Performance (measured, not asserted)

Timings are collected by scratch scripts (reported in `docs/ANALYSIS.md`, section "Performance") rather than asserted in Jest, because wall-clock thresholds are machine dependent. B10.3.* guarantees termination and correctness for the same shapes (wide, deep, long chains, many refs, cyclic graphs, merge-on-every-node).

## Coverage of the uncommitted working-tree change (0.6.8)

The 0.6.8 main worktree carried an uncommitted modification of `src/normalize.ts` (it set `_allOfRef.pointer = refPointer` on the first `$ref`) that made `test/merge.cycleRefs.test.ts › should support cross cycle refs in allOf` loop forever (AM-23). The redesign branch is based on HEAD, `src/normalize.ts` no longer exists (the resolution index replaced it), and the whole cycleRefs suite is green.

## Totals

Before the redesign: 334 audit tests in 11 files, of which 44 were `test.failing` known-defect tests covering 22 issue ids (AM-01 … AM-22); whole suite 21 files, 434 passed, 1 skipped.

After the redesign (1.0.0): 368 audit tests in 12 files (334 original, now all plain tests, plus B2.3.6b and the 33 B12 cases), no `test.failing` left; whole suite 22 files, 468 passed, 1 pre-existing skip, with json-crawl 0.5.3 and with json-crawl 0.6.0 (the dependency 1.0.0 ships with).

After the verification fixes (`docs/VERIFICATION.md` §9): 492 audit tests in 15 files (B1–B12: 368, a few expectations changed with a VR/D comment; B13: 47, B14: 59, B15: 18); whole suite 25 files, 592 passed, 1 pre-existing skip, `tsc --noEmit` clean, with the lazy-path json-crawl 0.6.0 build.

After the user decisions D-14, D-17, D-18, D-19 (`docs/VERIFICATION.md` §7): 535 audit tests in 16 files (B16: 43; B6.3.1 and B14.4.1 changed); whole suite 26 files, 635 passed, 1 pre-existing skip, every whole-document merge of the suite checked for dangling `$ref`s, `tsc --noEmit` clean, `npm run build` green.

After the user decisions D-20, D-21 (`docs/VERIFICATION.md` §7): 562 audit tests in 17 files (B17: 27, no earlier expectation changed); whole suite 27 files, 662 passed, 1 pre-existing skip, every whole-document merge of the suite checked for dangling `$ref`s and for `$ref`s through merged nodes, `tsc --noEmit` clean, `npm run build` green without circular-dependency warnings.

After the user decisions D-22, D-23 (`docs/VERIFICATION.md` §7): B18 block (37 tests); changed expectations B13.4.6, B15.7.1, B16.2.1/3/4/7/8, B17.2.2/8/9/10, B17.3.1/3; the suite-wide check (`test/setup/refIntegrity.ts`) now requires every output `$ref` to resolve (refs broken in the input excepted) and fails a copy where the merged output holds an equal value (`copiesWithEqualLink`); `refsThroughMergedNodes` is a diagnostic only. The identity memo of a merge call is keyed by rules (B18.6).

After D-24, D-25 and the D-12 features (AsyncAPI engine hook, `refAnnotations`, simplifications, `test:fuzz`): 676 audit tests in 20 files (B19: 29, B20: 48), 149 AsyncAPI tests in 6 files, 13 fuzz tests in 3 files; whole suite 39 files, 938 passed, 1 pre-existing skip (coverage 93.9 % statements), `tsc --noEmit` clean, `npm run build` green without circular-dependency warnings. Changed expectations: D-24 B17.2.10, B18.2.2, B18.2.5 (copies keep constraint siblings, no `refSiblingDropped`); `dropFalseBranches` B2.3.1, B2.3.3, B2.3.4, B2.3.5, B2.3.7, B4.2.6, B12.1.3, `merge.jsonschema.test.ts` "merges nested allOf if inside multiple oneOf" (each also asserts the former form with `dropFalseBranches: false`); `dedupeAnyOf` `merge.jsonschema.test.ts` "merges anyOf by finding valid combinations" and "extracts common logic"; B13.11.1 (settings fields). The fuzz known issue KI-1 is a documented test now.

After D-26 and D-27 (`docs/VERIFICATION.md` §7): B19: 36 (B19.8.1–7 new), B18: 44 (B18.8.1–7 new); changed expectations B19.4.5 (product branch keeps `title: "B"`, D-26) and B20.4.6 (links to the shifted indexes instead of copies, D-27); whole suite 39 files, 952 passed, 1 pre-existing skip (coverage 93.95 % statements), fuzz 13 passed (default runs and `FUZZ_RUNS=3000`), `tsc --noEmit` clean, `npm run build` green.
