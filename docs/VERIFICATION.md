# allof-merge 1.0.0 redesign — verification report (2026-11-17)

Scope: the uncommitted redesign on top of 0.6.8 (HEAD 83f34a0), checked against `docs/ANALYSIS.md`, `docs/DESIGN_PROPOSALS.md`, `CHANGELOG.md`, all GitHub issues of udamir/allof-merge and its consumers, a security review, and the test suites of similar tools. Baseline: `npx jest` 22 suites, 468 passed, 1 skipped (legitimate: `merge.jsonschema.test.ts` "multipleOf using allOf or direct assignment", already skipped in 0.6.8, LCM result is equivalent); `tsc --noEmit` clean.

Method: ≈ 9 000 inputs through `merge` — 196 recorded calls from json-schema-merge-allof (mokkabonna) and @stoplight/json-schema-merge-allof, ≈ 870 cases ported from oasdiff `flatten/allof`, hypothesis-jsonschema `merged()`, @x0k/json-schema-merge, json-schema-intersect, qubership api-unifier and Redoc, 262 real-world schemas from datamodel-code-generator, 7 500 random fuzz pairs/triples (draft-07, draft-07 + `mergeCombinarySibling`, 2020-12) — each judged by ajv on generated instances and re-checked with Python `jsonschema`. Probe scripts and recorded data live in `/tmp/amr-verify`, `/tmp/amr-sec`, `/tmp/amr-similar`, `/tmp/amr-similar2` (not part of the repo).

Oracle caveat: ajv 8.20 is wrong for `contains` next to tuple `items` (`{items:[{}],contains:{}}` accepts `[]`) and under `additionalProperties` (key-order dependent). All 45 non-reproducible fuzz mismatches were this. Audit cases mixing `contains` with tuple `items`/`additionalProperties` must be cross-checked with another validator.

## 1. Findings (deduplicated, most severe first)

IDs are new (`VR-nn`); the source reports' ids are listed so the probes can be found.

### Critical / high — denial of service

| ID | Finding | Reproducer → measured | Since | Fix direction |
|---|---|---|---|---|
| VR-01 | `multipleOf` arithmetic hangs or overflows (`findMultiplierForInteger`, `calculateLCM/GCD`, `src/utils.ts:110-127`) | `{allOf:[{multipleOf:"abc"},{multipleOf:2}]}`, `{}` or `5e-324` → infinite loop (uncatchable); `0.5 ∧ 1e308` → RangeError; `1e200 ∧ 3e200` → `NaN`; `1e-300 ∧ 2` → 250; `2 ∧ 1/3` → 6666666666666666; `0 ∧ 2` → 0, `-2 ∧ 3` → -6; LCM > 2^53 silently imprecise | 0.6.8 | accept finite positive numbers only, cap the decimal multiplier (~1e9–1e15) and check the result is finite and exact, otherwise keep `allOf` fragments + `onMergeError` |
| VR-02 | ReDoS: user regexes are executed at merge time (`testPattern`, `src/groups/object.ts`) | `patternProperties:{"^(a+)+$":{}} ∧ properties:{["a"×n+"!"]:{}}` → n=24 1.1 s, n=27 9.3 s, n=30 > 60 s. Pattern conjunction itself adds no backtracking | 0.6.8 | never run user patterns by default; keep object shapes as `allOf` fragments when names must be matched against foreign patterns, or opt-in matching with length caps |
| VR-03 | `$ref` fan-out ("billion laughs"): output tree exponential in input | 25 levels of `{a:allOf[$ref prev,…], b:allOf[$ref prev,…]}`, 3.7 KB input → 9 ms merge, 100 M-node tree, `JSON.stringify` 36 s then `RangeError` | 0.6.8 | output-node / inline budget; keep `{allOf:[{$ref}]}` after N inlinings |
| VR-04 | Deep plain nesting (no allOf) exhausts the heap — json-crawl 0.6 copies the path per node, O(depth²) memory | depth 10 000 → 4.7 s / 2.45 GB, depth 20 000 (≈ 380 KB JSON) → OOM, exit 134 | json-crawl | parent-linked / lazy paths in json-crawl; `maxDepth` guard |
| VR-05 | `branchBudget` is per node and bypassable | nested 32×32 inside 32×32: 68 KB → 34 MB, 6.6 s, no error; `mergeCombinarySibling` with `{anyOf:n, oneOf:n}`: n=2000 → 70 MB, 22.5 s, no check; exported `jsonSchemaMergeResolver` runs with `Infinity` | new + 0.6.8 | one budget per merge call, counting sibling distribution too |
| VR-06 | Stack overflow at ≈ 10 000 levels (catchable `RangeError`) in `collectItems.visit`, `resolve.follow/walk`, `deepEqual`, `mergeValues` | nested `allOf`, `$ref` chains, deep `enum`/`const`/`example` | 0.6.8 | iterative walks or a depth limit reported via `onMergeError` |
| VR-07 | Quadratic keyword merges | `enum` ∩ 20k objects 15.5 s; `required` union 20k objects 28.5 s; 10k allOf items with one property each 4.8 s; 10k patterns × 10k names 19 s | 0.6.8 | `Set` for primitives, canonical hashing for objects, caps |

### High — semantic soundness (merged schema ≠ original)

| ID | Finding | Reproducer (ajv + python-jsonschema confirmed) | Notes |
|---|---|---|---|
| VR-10 | Another item's `additionalProperties` **schema** is not applied to kept `patternProperties` (`src/groups/object.ts:43-64`) — accepts too much | `{patternProperties:{"^x":{type:"string"}}} ∧ {additionalProperties:{minLength:2}}` accepts `{x:"a"}`; `{pp:{"^x":{type:"number"}}} ∧ {properties:{a:{}},additionalProperties:{type:"string"}}` accepts `{xa:1}` | expected `patternProperties["^x"] = {type:"string",minLength:2}`; when the other item has its own patterns, conjunction/difference patterns or `allOf` fragments. The **only** mismatch class in 15 000 random draft-07 schemas |
| VR-11 | A pattern is dropped when another item has `additionalProperties:false` with different patterns (`src/groups/object.ts:45-48`) — rejects too much | `{pp:{"^a":{}},additionalProperties:false} ∧ {pp:{"b$":{}},additionalProperties:false}` → `{additionalProperties:false}`, rejects `{ab:1}` | expected `patternProperties:{"^(?=[\s\S]*?(?:^a))(?=[\s\S]*?(?:b$))[\s\S]*$":{}}`. **Existing tests encode the wrong output**: `test/merge.properties.test.ts` "disallows all except matching patternProperties if both false" #3 and "considers patternProperties before merging additionalProperties" (expected `.+\d{2,}$` schema should be `{minLength:9,maxLength:10,type:["integer","null","string"]}`) |
| VR-12 | `unevaluatedProperties`/`unevaluatedItems` merged like `additionalProperties` (`src/rules/jsonschema.ts:123-124`) — accepts too much | `{properties:{a:{}},unevaluatedProperties:false} ∧ {properties:{b:{}}}` accepts `{b:1}`; `{prefixItems:[{}],unevaluatedItems:false} ∧ {prefixItems:[{},{}]}` accepts `[1,2]` | DESIGN §9.5 calls it "sound for common usage"; it is unsound for the textbook case. Keep items carrying `unevaluated*` as `allOf` fragments |
| VR-13 | OpenAPI 3.0 `nullable: true ∧ (absent)` → `nullable:true` (`src/rules/jsonschema.ts:86` + single-value passthrough `src/intersect.ts:114-116`) | `{type:"string",nullable:true} ∧ {type:"string"}` accepts `null` | AM-11 fixed only for explicit `false ∧ true`. Policy decision: the idiom `allOf:[{$ref:Base}], nullable:true` relies on today's behaviour |
| VR-14 | Type group ignores `nullable` | `{type:"string",nullable:true} ∧ {type:"number",nullable:true}` → `false`, but null satisfies both | expected `{nullable:true, enum:[null]}` (or equivalent) |
| VR-15 | Missing `minContains` not treated as 1 (`src/groups/array.ts:100-103`) | `{contains:{type:"number"},minContains:0} ∧ {contains:{type:"number"}}` → `minContains:0`, accepts `[]` | |
| VR-16 | `format` / numeric format lattice is last-wins | `int32 ∧ int64` → `int64` (accepts 2147483648 under format assertion); `email ∧ date` → `date`, silent | int32 ⊂ int64, float ⊂ double; other conflicts → fragments or `onMergeError` (oasdiff reports them) |

### Medium — security (prototype handling)

| ID | Finding | Reproducer | Since |
|---|---|---|---|
| VR-20 | **New in redesign:** attacker-controlled prototype on output objects — memo-hit write `state.node[nodeKey] = entry.node` (and `state.node[key] = {...output}`) in `src/merge.ts` with key `__proto__` sets the prototype | `JSON.parse('{"definitions":{"A":{"isAdmin":true},"B":{"x-y":1}},"properties":{"x":{"allOf":[{"$ref":"#/definitions/A"},{"$ref":"#/definitions/B"}]},"__proto__":{"allOf":[{"$ref":"#/definitions/A"},{"$ref":"#/definitions/B"}]}}}')` → `out.properties.isAdmin === true` (inherited); reproduced with `dist/index.cjs` | new |
| VR-21 | `__proto__` members silently dropped in `properties`, `patternProperties`, `definitions`/`$defs`, `dependencies`, `example`, enum objects, top-level keyword; TS target `es6` compiles spread to `Object.assign` (calls the setter) | `{properties:{__proto__:{minLength:1}},additionalProperties:false} ∧ {properties:{__proto__:{type:"string"}}}` → `{properties:{},…}`, rejects `{"__proto__":"a"}` | partly 0.6.8 |
| VR-22 | `in` checks see inherited keys: `additionalProperties:false` bypass and silent ref resolution | `{properties:{constructor:{type:"string"}}} ∧ {properties:{a:{}},additionalProperties:false}` keeps `constructor` (accepts `{constructor:"x"}`); `$ref:"#/definitions/constructor"` / `"#/__proto__"` resolve to `Object`/`Object.prototype`, dropped, no `onRefResolveError` (`src/resolve.ts:47`) | 0.6.8 |
| VR-23 | Exported `resolvePointer(doc,"/__proto__")` and `createResolutionIndex(doc).resolve("#/__proto__")` return `Object.prototype` — a consumer writing into the result pollutes globally (same class as api-ref-bundler #472) | shown `({}).pollutedByConsumer === 1` | 0.6.8 |
| VR-24 | Unbounded caches: module-level `regexpCache` (100k patterns → 151 MB, attacker-fillable, also with plain `merge()`); `createMerger` `TupleMemo` holds strong refs (200 documents → 41.5 MB) | | new |
| VR-25 | Output sharing across calls of one `createMerger`: results of different documents that share a subschema object share output instances — mutating one corrupts the other (cross-tenant risk for a server-side cached merger). Within one result documented as AM-27 | `o1.properties.p.type = "X"` changes `o2` | new |
| VR-26 | Rules are only shallowly frozen and process-global; OpenAPI and GraphApi rule sets not frozen at all (CHANGELOG says "frozen") | `jsonSchemaMergeRules()["/minItems"].$ = () => 999` changes every later merge | new |

### Medium — correctness / contract

| ID | Finding | Reproducer |
|---|---|---|
| VR-30 | Synthetic `$ref` written for an in-progress cyclic tuple points into the *output of the current call* (`src/merge.ts:302`); in fragment mode (`source`) it dangles. Hits the api-smart-diff merge-per-node pattern. A whole-document merge emits a valid but undocumented `#/paths/~1x/…` pointer | `merge(doc.components.schemas.Foo,{source:doc})` with `Foo:{allOf:[{properties:{test:{type:"string"}}},{$ref:Baz}]}`, `Baz:{properties:{test:{$ref:Foo}}}` → `$ref:"#/properties/test"`. oasdiff hoists such cycles into `components.schemas.AllOfMerged_A_B` |
| VR-31 | #208 part b: `mergeRefSibling` + `source` turns `friend` into a cyclic JS object (`friend.properties.friend === friend`), `JSON.stringify` throws; the `$ref` is not kept | reporter's comment 3 of #208; no regression test |
| VR-32 | Contradiction replaces the whole node with `false`, so sibling `definitions`/`$defs`/`$id` vanish and outside refs into them dangle (`src/merge.ts:290,317`) — same shape as AM-15 | `definitions.A = {$defs:{B:{type:"integer"}}, allOf:[{type:"string"},{type:"number"}]}` with `x:{$ref:"#/definitions/A/$defs/B"}` |
| VR-33 | `createMerger` memo keyed by item identity only, not by rules — per-call `rules` return stale results | same doc merged with draft-04 rules then with a custom `/minimum` → first result returned; JSON Schema vs GraphApi `nullable` likewise |
| VR-34 | Caches stale if the caller mutates inputs between `merger.merge` calls (index per source, tuple memo) — undocumented | mutate `doc.definitions.a.type` and merge again → old type |
| VR-35 | `mergeRefSibling` rewrites broken and **external** `$ref`s into `allOf` form, against the "broken ref leaves the node" contract | `{$ref:"ext.json#/a", description:"d"}` → `{allOf:[{$ref:"ext.json#/a"},{description:"d"}]}` |
| VR-36 | Plain-name fragments (`#foo` — `$anchor`, or draft-06/07 `$id:"#foo"`) silently resolve to the **document root** (`src/pointer.ts:45-48`); `#/` treated as root instead of key `""` | `allOf:[{$ref:"#foo"},{minLength:1}]` merges the root schema in, no `onRefResolveError` |
| VR-37 | Malformed keyword values crash or corrupt | `required:true/null` → `TypeError` (`uniqueConcat`, `utils.ts:98`); `anyOf:true`, `oneOf:true`, `anyOf:null` → `TypeError` (`findCombinations`/`countCombinations`); `enum:null` overrides a real enum; `not:null` → `not:{anyOf:[null,…]}`. Redocly's fork and Redoc's tests expect tolerance |
| VR-38 | Backward compatibility of custom rules: `"/x-schema":{$:jsonSchemaMergeResolver}` without child rules now leaves an unmerged `allOf`; the exported resolver called directly leaves conflicting children unmerged without `mergeError` (DESIGN §9.2.2 vs CHANGELOG "utility exports keep their behaviour") |
| VR-39 | When a custom `$` hands a group back to the per-key table, the legacy fallbacks reintroduce AM-04 (`/additionalProperties`), AM-19 (`/items`), AM-10 (`/minimum` under draft-04), last-wins for backreference patterns. These fallbacks are the ≈50 %-covered `src/resolvers/items.ts` / `properties.ts` — live only in this mode and untested |

### Low

- VR-40 ref→ref cycles inside `allOf` vanish silently (`definitions:{a:{$ref:"#/definitions/a"}}`), the index's `"cycle"` reason is never reported (`src/merge.ts:170-181`).
- VR-41 `onMergeError` fires for `oneOf`/`anyOf` that were already unsatisfiable in the input (`{oneOf:[false,false]}`); the exit hook is registered on every combinary array.
- VR-42 Invalid input dropped silently: non-object `allOf` items, non-array `allOf` (→ `{}`, removes a constraint), `type: []`, `$ref:""`. Consider `onMergeError`.
- VR-43 Conflicting unknown / `x-*` keywords: silent last-wins (root siblings last), no `onMergeError`.
- VR-44 Not simplified (equivalent, but larger/silent): `minimum > maximum`, `minLength > maxLength`, `minItems > maxItems` kept instead of `false`; `required` + `false` property; `type:null ∧ const:0`; unsatisfiable `oneOf` with every branch `false` not collapsed; duplicate `anyOf` branches / identical oneOf groups (`[A,B]∧[A,B]` → 4 branches) / identical if-then fragments not deduplicated; `contains:true`/`{}`/`false` not collapsed; `if` without `then`/`else` kept; enum not filtered by type.
- VR-45 README wording: `required` "first-seen order" — root siblings come after the allOf items (`{required:[p1,p2],allOf:[{required:[p4]}]}` → `[p4,p1,p2]`).
- VR-46 CHANGELOG claims "group resolvers are exported" — only `keywordGroups` is exported from `src/index.ts`.
- VR-47 Dead code: `singleOwner` (`groups/common.ts:20-29`), `MapArray` (`utils.ts:8-18`), `groupByName` (`groups/index.ts:33`), `intersect.ts:100-106` and the `"allOf" in result` branch (`:144`); `jsonSchemaMergeResolver` is never called by the engine.

### Release blockers (packaging / supply chain)

- VR-50 `package.json` requires `json-crawl ^0.6.0`, which is not on npm (latest 0.5.3); `node_modules/json-crawl` is a hand-copied worktree build without integrity hash; `yarn.lock` still pins 0.5.3, so `--frozen-lockfile` fails and `yarn audit`/`npm audit` cannot run; `dist` bundles inline the unpublished code and the banner still says v0.6.8. Publish json-crawl 0.6.0, regenerate the lockfile, build `dist` in CI, bump the version.
- VR-51 Dependabot: all open alerts are dev-scope (handlebars ×2 critical, rollup path traversal, tar, js-yaml, minimatch, brace-expansion, form-data, serialize-javascript); no runtime alerts, no security advisories. Clean up before release.

## 2. Claims verified OK

AM-01/05/08/09 (contradiction → `false` / `{not:{}}`, branches kept as `false`, one report per all-impossible combinary), AM-02 (type lattice incl. `["number","null"] ∧ ["integer","null"]`, OAS 3.1 `[x,"null"]`), AM-03 (pattern conjunction correct for anchors, alternation, lookbehind, `\b`, `\p{L}`, astral, `\n`; backreferences/named groups → fragments), AM-06, AM-07, AM-10, AM-12, AM-13, AM-14 (deep-frozen input, no input aliasing with all option combinations), AM-15 (except VR-35), AM-16, AM-17, AM-18, AM-19, AM-20, AM-21 (callbacks, webhooks, pathItems, parameter content, encoding headers under 3.0 and 3.1), AM-22, AM-24/27 (as documented), AM-26. Cartesian product of `oneOf`s is sound; `branchBudget` default 1024 works per node; `dependencies`/`dependentRequired`/`dependentSchemas`, `if/then/else`, `not ∧ not`, decimal `multipleOf` (0.07/0.03 → 0.21, 0.5/0.75/1.25 → 7.5), `~0`/`~1`/percent-encoded refs, refs into arrays, ref→ref chains, `$defs`. Rules memoized; custom `$` on grouped key hands the group back. oasdiff: all 24 validation instances match except int32 (VR-16). datamodel-code-generator corpus: 241/262 equivalent, the rest are VR-12, unvalidatable cycles and an ajv `$id` quirk.

Performance (ts-node on `src`, json-crawl 0.6.0, best of 5): wide 5 000 → 24.7 ms (target ≤ 45 ✔), deep 1 000 → 31.4 ms (≤ 80 ✔), 4 000 `$ref` usages → 33.3 ms (≤ 40 ✔), 1 000 × 1 000 → 662 ms (≤ 150 ✘, acknowledged in docs), ring of 200 → 26.5 ms (≤ 20 ✘, documented ring shape could not be reproduced; claimed 4.3 ms). HEAD 0.6.8 cannot be compared against json-crawl 0.6.0 (it does not merge at all with it).

## 3. GitHub issues (udamir/allof-merge, 12 in total)

| # | Title | Redesign status | Regression test |
|---|---|---|---|
| 232 | number vs integer | fixed (all 4 repros) | partial: B1.1.5/B1.1.6 top level only; add nested property and `["number","null"]∧["integer","null"]` cases, reference #232 |
| 222 | `title` promotion duplicates classes | open feature; not implementable via custom rules (single-value keys skip their resolver in `intersect`) | none |
| 208 | `$ref` corrupted | part a fixed; **part b broken** (VR-31) | a: `merge.issue208.test.ts`; b: none |
| 200 | remove refs / unused components | out of scope | — |
| 190 | circular refs in allOf | fixed | `merge.cycleRefs.test.ts`, B3.3.10 |
| 142, 110 | question / empty | n/a | — |
| 137 | `mergeCombinarySibling` drops root `title` | unchanged by design (branch title wins) | no title test |
| 111 | oneOf properties not combined | fixed for local refs; external refs unsupported | none dedicated (closest B5.1.19) |
| 107 | AsyncAPI 2.x rules | not implemented | none |
| 70 | `merge` return type | fixed (`unknown`) | type-level only |
| 67 | infinite loop on Bitbucket spec | fixed (1.4 MB spec in 38 ms) | `merge.cycleRefs.test.ts`, B3.3.8, B10.3.7 |

Non-dependabot PRs (#166, #69, #42) merged. Consumer repos: no issue caused by allof-merge (api-ref-bundler #472 is the same prototype-pollution class as VR-23).

## 4. Similar tools

| Tool | Lang | Merges allOf? | Worth adopting |
|---|---|---|---|
| json-schema-merge-allof (mokkabonna) / @stoplight fork | JS | yes | baseline suite; all cases mapped (§5.1) |
| oasdiff `flatten/allof` | Go | yes, whole-spec | numeric format lattice; report conflicting `default`/`const`/`format`/`contentMediaType`; dedupe identical oneOf groups; hoist merged cycles to `components.schemas.AllOfMerged_A_B`; skip zero/negative `multipleOf` |
| hypothesis-jsonschema `merged()` | Python | yes (canonicalise + intersect) | property test `merged([a,b]) ≡ allOf`; filter enum/const through the other schema; detect `required` + `false` property, `items:false` + `contains`; refuse float `multipleOf` it cannot prove |
| @x0k/json-schema-merge | TS | yes, draft-07, no `$ref` | pattern difference via negative lookahead for pp × ap; prototype-safe keys; Symbol keys; `contains` true/false collapse; keep if/then/else triples together |
| json-schema-intersect (kevinoid) | JS | binary, draft-04/OAS | applies `additionalProperties` to the other item's patterns (VR-10); strict `TypeError` on malformed values |
| qubership-apihub-api-unifier | TS | fork of 0.6 | combiner-lifting corner tests; origin metadata |
| @redocly/allof-merge 0.6.13 | TS | fork of 0.6 | `applyAdditionalPropertiesToSiblings` option; `openApiJsonSchemaMergeRules(version)` schema-only rules; malformed-input tolerance |
| datamodel-code-generator | Python | `--intersect-allof-keywords` | 262 real-world schemas as a corpus |
| kin-openapi, swagger-js, json-schema-to-typescript, quicktype, openapi-generator, openapi-schema-to-json-schema, json-schema-ref-parser, openapi-merge | — | no real intersection | — |

## 5. Coverage of similar tools' test cases

### 5.1 json-schema-merge-allof / stoplight

All `index`, `items`, `properties`, `options`, `custom-resolvers`, `resolveAllOf` cases are already ported into `merge.jsonschema/items/properties.test.ts` under the upstream names, except: stoplight "throws if merging incompatible inferred type" (redesign correctly merges — add as a test), properties "property name same as a reserved word", resolveAllOf `summary` override, meta-schema idempotence (skipped upstream). Two ported cases have wrong expectations (VR-11). Intentional differences: `false` instead of throw, last-wins title (mokka first-wins), no `deep`/`ignoreAdditionalProperties`/`defaultResolver`, pattern and `contains` forms where upstream is wrong (`(?=a)(?=b)` rejects `"ab"`-style strings). mokka issues #44 (1)(2) = VR-11; #6 = VR-16; #7 by design; #42, #36, #26, #22, #23 OK.

### 5.2 Others

oasdiff 169 cases: equivalent except VR-16. hypothesis 41: 36 OK, 1 VR-01, rest simplification gaps (VR-44). @x0k 221: 203 OK, 18 VR-10/VR-11, x0k's own `(?=a)(?=b)` expectations wrong (redesign right), `__proto__` = VR-21. json-schema-intersect 142: 97 equal, VR-10 ×1, VR-37 ×3, malformed values silently dropped. api-unifier 16: VR-11 once, cycles and lifting OK. Redoc 4: VR-37. Fuzz 7 500: 7 real mismatches, all VR-10/11.

## 6. Missing test cases (priority order)

1. VR-10/11 — the reproducers above with `expectSameValidation`; fix the two wrong expectations in `test/merge.properties.test.ts`; add an oracle sweep over every MP case (they compare structure only, which is how the bug passed).
2. VR-01 — non-number, `{}`, subnormal, `1e308`, `1e200 ∧ 3e200`, `1/3`, `0`, negative `multipleOf`; must terminate (time guard).
3. VR-02/03/04/05/06/07 — DoS guards: evil pattern timing, `$ref` fan-out output size, depth 20 000, nested combinary budget and `mergeCombinarySibling` n², 10k-level `allOf`/`$ref` chains, 20k enum/required.
4. VR-20/21/22/23 — `__proto__`/`constructor`/`prototype` in every container (properties, patternProperties, definitions, $defs, dependencies, enum, example, ref pointers); assert own properties survive, outputs have `Object.prototype` as prototype, `Object.prototype` untouched, `resolvePointer` returns `undefined`.
5. VR-12 — `unevaluatedProperties`/`unevaluatedItems` repros.
6. VR-13/14 — OAS 3.0 `nullable` true ∧ absent, and both-nullable type conflict.
7. VR-30/31 — fragment merge of recursive conjunction (TwoRecursiveBranches, Foo/Baz) must not emit dangling refs; #208 part b.
8. VR-37 — `required:true|null`, `anyOf:true|null`, `oneOf:{}`, `enum:null`, `not:null`: no throw, `onMergeError`.
9. VR-15, VR-16 (int32 ∧ int64, float ∧ double, email ∧ uuid), VR-32, VR-33, VR-35, VR-36, VR-40.
10. VR-39 — per-key fallback mode for `/additionalProperties`, `/items`, `/minimum` overrides.
11. #232 nested + nullable; #137 title; #111 dedicated; stoplight inferred type; reserved-word property name; resolveAllOf `summary`; #44 `contains` repro; #42; meta-schema idempotence; x0k `"a\nd"` and if/then/else triple cases.
12. A property-based test in the style of hypothesis-jsonschema (random pairs, compare validation) kept in CI, with a second validator for `contains`.

## 7. Decisions (2026-11-17)

| Topic | Finding | Decision |
|---|---|---|
| D-1 OAS 3.0 `nullable` true ∧ absent | VR-13 | Strict: absent = `false`; `{type:string,nullable:true} ∧ {type:string}` → `{type:string}`. The `allOf:[{$ref}], nullable:true` idiom no longer yields a nullable result — call out in CHANGELOG output-contract section. VR-14 (both nullable, conflicting types) follows: only null remains. |
| D-2 conflicting `format` | VR-16 | Numeric lattice (int32 ⊂ int64 → int32, float ⊂ double → float); any other differing formats kept as `allOf:[{format:a},{format:b}]` + `onMergeError`. |
| D-3 user regex execution | VR-02 | Keep matching, but skip it (fall back to exact `allOf` fragments for that object shape) when pattern/name exceed a length cap or the pattern has nested quantifiers; option to disable matching entirely. |
| D-4 cyclic merged conjunction | VR-30, VR-31 | Revised 2026-11-17: at re-entry emit `{$ref}` to the **source location** of the node where the in-progress tuple first appeared (e.g. `#/components/schemas/Foo`, the unmerged original, semantically equal to the merged result). Always valid against `source`, serializable, compatible with api-smart-diff's `$ref`-path cycle guard (json-crawl `syncCrawl` has no object-identity cycle detection, so a cyclic JS object would hang it). If that node is not reachable from `source` (value outside source), keep the original `allOf` at the re-entry node. Applies to #208 part b too. |
| D-4b plain allOf cycles | AM-24 | Same rule as D-4: every cycle re-entry emits `{$ref}` to the source location; merged output is never a cyclic JS object and is always serializable. Changes the documented AM-24 contract — update README, CHANGELOG output-contract section and the AM-24 tests. |
| D-5 pp × additionalProperties | VR-10, VR-11 | Handle simple cases directly (other item has an `additionalProperties` schema and no patterns → conjoin into each pattern's schema; identical patterns); everything else keeps the object shapes as `allOf` fragments. No synthesized lookahead/difference patterns. Fix the two wrong expectations in `test/merge.properties.test.ts`. |
| D-6 malformed keyword values | VR-37 | Ignore the malformed value, merge the valid parts, report via `onMergeError`; never throw. |
| D-7 resource limits | VR-03..VR-07 | Safe configurable defaults: per-call branch budget (including `mergeCombinarySibling`), max inlinings per `$ref` target (≈1000) before keeping `{$ref}`, `maxDepth` (≈2000); exceeded → node unchanged + `onMergeError`. |
| D-8 `unevaluated*` | VR-12 | Items carrying `unevaluatedProperties`/`unevaluatedItems` stay separate `allOf` fragments. |
| D-9 `mergeRefSibling` + broken/external `$ref` | VR-35 | Leave the node as is; `onRefResolveError` for broken local refs only. |
| D-10 contradiction with container siblings | VR-32 | `{allOf:[false], definitions/$defs/$id…}`; plain `false` when there are no container siblings. |
| D-11 output sharing | VR-25 | Keep sharing, document it, add `freezeOutput: true` (deep-freeze results). |
| D-12 features #222, #107, simplifications, property-based CI test | — | Pending — user asked for a design per feature with examples and pros/cons: `docs/FEATURE_DESIGN.md`. |
| D-13 OAS 3.0 nullable reading | VR-13 | Confirmed (second round): OAS 3.0.3 wording — a typed item without `nullable:true` forbids null, an untyped item does not restrict null. |
| D-14 format lattice scope | VR-16 | int32 ⊂ int64 / float ⊂ double narrowing only under the OpenAPI rule sets; JSON Schema and GraphApi treat differing formats (incl. int32 vs int64) as conflicts → `allOf` fragments + `onMergeError`. |
| D-15 limit defaults | VR-03 | Confirmed: `maxRefExpansion` 10 000 + `expansionBudget` 2 000 000 nodes per call. |
| D-16 plain `$ref` through a merged-away allOf | replay | Confirmed: inline the target (the member's value, not the stricter merged property). |
| D-17 cycle re-entry through an allOf member | remaining issue 2 | When a cycle re-entry pointer would run through an allOf that the merge removes, keep that allOf node unmerged in the output so the pointer stays valid. |
| D-18 mixed tuple keywords | remaining issue 1 | Per draft (strict): draft-04/06/07 rules — array `items` is the tuple and `prefixItems` is an unknown keyword; 2020-12 rules — `prefixItems` is the tuple and array `items` is kept as an `allOf` fragment + `onMergeError`. |
| D-19 vendor / unknown keyword conflicts | VR-43 | Default stays last-wins; it must be possible to define rules for vendor fields (exact keys and `x-` prefixes via json-crawl `"/^"` maps) and to override the default last-wins for unknown keys. |
| D-20 `$ref` into a member a contradiction drops | §9 open finding (a) | A `$ref` pointing into a node that becomes unsatisfiable (`false`, or `{ allOf: [false], containers }`) whose target key was dropped is replaced by a copy of the original target, merged as a normal schema in its own right (its own `allOf` merged); the node stays `false`. `LegacyId = { allOf: [string, number], properties: { code: { type: string, maxLength: 8 } } }`, `Order.properties.code = { $ref: LegacyId/properties/code }` → `LegacyId: false`, `Order.properties.code: { type: string, maxLength: 8 }`. |
| D-21 `$ref` to a sibling member of a merged node | §9 open finding (b) | A `$ref` whose pointer runs through a node whose own `allOf` is merged (`A = { properties: { x: { type: string } }, allOf: [{ properties: { x: { minLength: 3 } } }] }`, `p: { $ref: A/properties/x }`) would resolve to the merged, stricter value: the ORIGINAL value is inlined at the ref site (`p: { type: string }`), `A` is fully merged. Applies whenever the pointer runs through such a node, whether or not that member changed. The inlined copy is merged normally, follows the cycle rules D-4/D-4b and the limits. |

Not policy questions, fixed as obvious: VR-01 (multipleOf guards), VR-06 (iterative/depth-limited recursion), VR-15, VR-20..VR-24 and VR-26 (own-property-safe writes and lookups, ES2018 target, bounded caches, deep-frozen rules), VR-33/34 (memo keyed by rules; document input immutability), VR-36 (anchors → resolve or report), VR-39..VR-47, VR-50.

| D-22 links into merged schemas stay links | user, 2026-11-17 | Principle: every valid `$ref` stays valid after the merge and is updated rather than replaced. A `$ref` whose pointer runs through a schema the merge rewrites is rewritten to the matching location in the merged output when the merged value there means the same as the original target (structurally equal after merging); when merging made it stricter, the `$ref` is replaced by a copy of the original target (siblings kept, per the draft's `$ref`-sibling reading). Applies to `$ref`s with siblings too (no longer keeps the pointed-into schema unmerged for that reason). |
| D-23 existing copies become links | user, 2026-11-17 | The cases that were copied so far (plain `$ref` into a merged schema's property or into an allOf member, a `$ref` into a schema that became `false` is still copied because nothing equal survives) use the D-22 rule: rewritten link when the meaning is unchanged, copy only otherwise. |

| D-24 `$ref` siblings under draft-04/06/07 and OpenAPI 3.0 | fuzz KI-1, user 2026-11-17 | Apply always (author intent), in every draft: siblings of `$ref` are conjoined with the target, also where draft-04/06/07 / OAS 3.0 validators would ignore them. Documented as an intentional deviation; copies made by the link rules keep constraint siblings too (no drop + report). |
| D-25 fragment-mode links, link to the target's own place | link agent, self-decided | Fragment mode leaves `$ref`s as they are (they resolve against the unchanged `source` with the same meaning); a pointer through a `$ref` member links to the target's own location (e.g. `#/components/schemas/Base/properties/id`). Documented. |
| D-26 annotations of combined `oneOf`/`anyOf` branches under `refAnnotations` | user, 2026-11-17 ("keep title according to rules") | A branch of a `oneOf`/`anyOf` product (`allOf: [{ oneOf: [{ $ref: Cat }] }, { oneOf: [{ $ref: Indoor }] }]`) keeps the branch-level annotations of its `$ref` components, as already decided for a single `$ref` branch (Q1-2); when several components carry the same annotation, the active merge rule of that keyword resolves it (default last-wins → `Indoor`; a custom `/title` rule such as first-wins or concatenation is honoured). The same applies to product branches that `mergeCombinarySibling` distributes. Node-level inherited annotations (a `$ref` next to the groups, a `$ref` inside a component's own `allOf`) are still omitted. Before: such branches lost every inherited annotation under `"omit"`. |
| D-27 links into `oneOf`/`anyOf` branches whose index shifts | link agent, self-decided per D-22 ("links stay valid and are updated") | A `$ref` into a branch whose position moved because `dropFalseBranches` removed impossible branches or `dedupeAnyOf` removed duplicates is rewritten to the branch's new position when the value there is equal (the D-22 equality check), instead of being copied: `X.oneOf = [<impossible>, { type: integer }, { type: boolean }]`, `{ $ref: X/oneOf/2 }` → `{ $ref: X/oneOf/1 }`; below a branch and through nested shifted lists too; a pointer to a removed `anyOf` duplicate links the equal branch kept; a pointer to a removed impossible branch stays a copy (`false`). `dedupeFragments` shifts nothing an input pointer can address (an input `allOf/<i>` step is matched by removing it). |

## 8. Feature analysis (pending D-12)

### 8.1 #222 — control over annotation promotion (`title` etc.)

Today a `$ref` target's `title` is copied into the merged schema (`Derived` gets `title: "Base"`), and code generators that name classes by `title` emit duplicates. A custom rule cannot prevent it because single-owner keys skip their resolver in `intersect`.

- Pros: small (S) change — an option such as `annotations: "merge" | "root"` (`root` = only the node's own annotations survive) plus calling resolvers for single-owner keys when a custom rule exists; additive, default unchanged; serves codegen consumers, the only open user-reported bug-like issue.
- Cons: annotation policy is consumer-specific (docs viewers want the promoted title, codegen does not) — defining the set (`title` only? `description`, `examples`, `x-*`?) is a design decision; calling resolvers for single-owner keys costs a little on the hot path; interacts with `mergeRefSibling` (sibling title already overrides).
- Recommendation: include in 1.0.0 as an opt-in option limited to `title`/`description`/`$comment`, with rules-level control as the general mechanism.

### 8.2 #107 — AsyncAPI 2.x rule set

- Pros: completes the spec set of api-smart-diff (which already supports AsyncAPI); additive (no contract change), can be auto-detected like OpenAPI.
- Cons: AsyncAPI 3.0 (2023) is current — doing 2.x alone targets a legacy version; payloads may use non-JSON-Schema `schemaFormat` (Avro, RAML, Protobuf) that must be skipped; medium effort plus a rule tree to maintain; api-smart-diff already merges schema nodes with JSON Schema rules, so the practical gain is whole-document merges only.
- Recommendation: defer to 1.1.0 and ship 2.x and 3.0 together; nothing about it needs a major version.

### 8.3 Simplifications (collapse to `false`, dedupe, `contains` collapse, enum filtering)

- Pros: smaller, clearer output; explicit `false` lets consumers detect impossible schemas; deduplicating identical `oneOf`/`anyOf` groups also shrinks the cartesian product (helps D-7); output form is part of the contract, so changing it after 1.0.0 would create spurious diffs for api-smart-diff users between library versions — if ever, now.
- Cons: each rule must be proven equivalent, and some are subtle: `minimum:15 ∧ maximum:10` is **not** unsatisfiable unless `type` excludes everything but numbers (strings still validate), same for `minLength > maxLength`, `minItems > maxItems`; more code on the hot path; risk of new soundness bugs right before release.
- Recommendation: include the cheap provably-safe ones (dedupe identical branches/fragments, `contains:true|{}` → drop, `contains:false` → `false` when type is array-only, filter `enum`/`const` by `type`, bound contradictions → `false` only when `type` restricts to the matching kind, otherwise just `onMergeError`); skip `required` + `false`-property and if/then/else pruning.

### 8.4 Property-based equivalence test in CI

- Pros: the fuzzer is what found the only unsound class (VR-10/11) that 468 tests missed; cheap (seconds with a fixed seed); guards every future keyword change.
- Cons: needs a second JS validator as devDependency (e.g. `@hyperjump/json-schema` or `@cfworker/json-schema`) because ajv 8.20 is wrong for `contains`; generator code to maintain; random seeds can be flaky — use a fixed seed in CI and a larger random run on demand/nightly.
- Recommendation: include (devDependency only, no runtime impact).

## 9. Fix status (2026-11-17)

All findings were fixed by three agents (engine, keyword groups, json-crawl) and integrated; `npx tsc --noEmit` clean, `npx jest` 25 suites, 592 passed, 1 pre-existing skip (coverage 92 % statements), `npm run build` green (ES2018 target, banner v1.0.0). Test ids refer to `docs/TEST_PLAN.md` (B13 engine, B14 keywords, B15 integration). "Not in scope" items wait for the user (D-12). Update after the second-round decisions D-14, D-17, D-18, D-19: 26 suites, 635 passed, 1 pre-existing skip (coverage 93 % statements), B16 block in `test/audit/b16.decisions.test.ts`, every whole-document merge of the suite checked for dangling `$ref`s (`test/setup/refIntegrity.ts`), `tsc --noEmit` clean, build green. Update after D-20 and D-21: 27 suites, 662 passed, 1 pre-existing skip (coverage 93 % statements), B17 block in `test/audit/b17.ref-targets.test.ts`, the suite-wide check also fails any whole-document merge that leaves a `$ref` running through a node whose own `allOf` was merged, `tsc --noEmit` clean, `npm run build` green without circular-dependency warnings. Update after D-22 and D-23: B18 block in `test/audit/b18.ref-rewrite.test.ts` (37 tests), 14 earlier expectations changed (listed in `docs/TEST_PLAN.md`), the suite-wide check now requires every output `$ref` to resolve and fails a copy where an equal merged value exists, `tsc --noEmit` clean, `npm run build` green; the identity memo of a merge call is keyed by rules (shared instances under different rules, found by the AsyncAPI work). Update after D-24, D-25 and the D-12 features (AsyncAPI, `refAnnotations`, simplifications, property-based test): 39 suites, 938 passed, 1 pre-existing skip, details and measurements in "After D-24, D-25 and the D-12 features" below. Update after D-26 and D-27: see "After D-26 and D-27" below.

| ID | Status | How | Tests |
|---|---|---|---|
| VR-01 | fixed | finite positive `multipleOf` only, decimal multiplier capped at 1e15, LCM checked finite and ≤ 2^53, otherwise `allOf` fragments + `onMergeError` | B14.6.1–4 |
| VR-02 | fixed (D-3) | user patterns run only within `matchPatterns` limits (256/256), never with nested quantifiers, ≤ 100 000 tests per node; otherwise object shapes as fragments; `matchPatterns: false` | B14.2.1–5, B15.2.1 |
| VR-03 | fixed (D-7) | `maxRefExpansion` per target (default 10 000) plus `expansionBudget` (default 2 000 000 inlined schema nodes per call, the size of every inlined target counts); see "Limits" below | B13.6.4–5, B15.5.1–3 |
| VR-04 | fixed (needs json-crawl release) | json-crawl lazy parent-linked paths (`../json-crawl-fix`, copied into `node_modules`), `maxDepth` (default 2 000) | B13.6.6–7 |
| VR-05 | fixed | one branch budget per `merge()` call, counting the `mergeCombinarySibling` distribution and the exported `jsonSchemaMergeResolver` | B13.6.1–3 |
| VR-06 | fixed | iterative `collectItems`, ref resolution, `deepEqual`, `mergeValues`, `canonicalKey` | B13.6.8, B14.8.1–3 |
| VR-07 | fixed | structural hash sets for `enum`/`required`/`dependencies`, per-name visiting in the object group, pattern-test cap | B14.9.1–3, B14.2.5 |
| VR-10 | fixed (D-5) | another item's `additionalProperties` schema is conjoined into kept patterns when it has no own patterns; other interactions → fragments | B14.1.1–3, B14.1.6–7 |
| VR-11 | fixed (D-5) | patterns of closed items kept as fragments, identical patterns merged; the two wrong expectations in `test/merge.properties.test.ts` corrected | B14.1.4–5, `merge.properties.test.ts` |
| VR-12 | fixed (D-8) | items with own `unevaluated*` stay fragments (`$ref` items as `$ref`) | B13.10.1–4 |
| VR-13 | fixed (D-1, OAS 3.0.3 reading, **confirm**) | typed item without `nullable: true` forbids null; untyped items do not restrict null | B14.3.1–3, B7.3.1 changed |
| VR-14 | fixed (D-1) | both nullable with conflicting types → `{ type: T, nullable: true, enum: [null] }` | B14.3.4–6 |
| VR-15 | fixed | missing `minContains` counts as 1 | B14.5.1 |
| VR-16 | fixed (D-2, D-14) | `int32 ⊂ int64`, `float ⊂ double` only under the OpenAPI rule sets (`/format` rule `mergeOpenApiFormat`); JSON Schema and GraphApi: every pair of differing formats → fragments + `onMergeError` (strict `mergeFormat`) | B14.4.1–2 (B14.4.1 changed by D-14), B1.10.4 changed, B16.1.1–5 |
| VR-20 | fixed | memo-hit and output writes through `safeSet` | B13.2.1 |
| VR-21 | fixed | own-property safe helpers everywhere (incl. `mergeCombinarySibling`, `getAllOfItemsMap`, group results), ES2018 target | B13.2.2–3, B14.10.2–3, B15.4.1 |
| VR-22 | fixed | own-property lookups; refs to inherited members are broken refs | B13.2.4, B14.10.1 |
| VR-23 | fixed | `resolvePointer` / resolution index never return inherited members | B13.2.5 |
| VR-24 | fixed | compiled-pattern LRU (1 000), weakly keyed merger memo | B14.2.4 |
| VR-25 | fixed (D-11) | sharing kept and documented, `freezeOutput: true` | B13.7.2–3 |
| VR-26 | fixed | all rule sets deep-frozen (`freezeRules`), incl. lazily derived rules | B14.11.1–2 |
| VR-30 | fixed (D-4) | re-entry → `{ $ref: "#<source pointer>" }` of the node where the tuple started; outside source the `allOf` is kept | B13.4.1, B13.4.6 |
| VR-31 | fixed (D-4) | #208 part b: refs into source, serializable | B13.4.2 |
| VR-32 | fixed (D-10) | `{ allOf: [false], definitions/$defs/… }` | B13.5.1–3 |
| VR-33 | fixed | memo per rules object | B13.7.1 |
| VR-34 | documented | README: inputs must not be mutated while a merger is in use | — |
| VR-35 | fixed (D-9) | `mergeRefSibling` leaves broken/external `$ref` nodes as they are | B13.3.6–7 |
| VR-36 | fixed | `$anchor`, `$dynamicAnchor`, `$id: "#x"` resolve; unknown anchors are broken; `#/` is member `""` | B13.3.1–3 |
| VR-37 | fixed (D-6) | malformed values ignored + `onMergeError`, never throw | B13.8.2–4, B14.7 |
| VR-38 | fixed | custom `$: jsonSchemaMergeResolver` without child rules and direct calls merge children eagerly | B13.9.2–3 |
| VR-39 | fixed | per-key fallbacks consult all items (with the call's `matchPatterns`); draft-04 exclusive flag travels with the bound value the custom rule selects (decision 2026-11-17: the flag of the item(s) with that value, exclusive if any is) | B14.12.1–5, B15.1.1–4, B12.5.1 |
| VR-40 | fixed | ref -> ref cycles reported through `onRefResolveError` | B13.3.4–5 |
| VR-41 | fixed | input-unsatisfiable combinaries not reported | B13.8.1 |
| VR-42 | fixed | non-array `allOf`, non-object items, `type: []` reported; empty / non-string `$ref` is a broken ref (node kept, `onRefResolveError`) | B13.8.2–3, B14.7, B15.6.1 |
| VR-43 | fixed (D-19) | default stays a silent last-wins; exact vendor rules and `"/^"` prefix maps (`{ "/^": { "x-": rule } }`) apply at every schema depth with json-crawl precedence exact > longest prefix > `/*` > `"/?"`; a custom `"/?"` overrides the default for every unknown key; `openApiMergeRules` / `openApiJsonSchemaMergeRules` take `customRules`, `createGraphapiMergeRules(customRules)` added; rule sets without `"/?"` fall back to last-wins (0.6.8 threw `Merge rule not found`) | B16.4.1–11, `merge.jsonschema.test.ts` changed |
| VR-44 | fixed (D-12, FEATURE_DESIGN Q3-1/Q3-2) | four safe simplifications on by default (`dedupeAnyOf`, `dedupeFragments`, `dedupeCombinaryGroups`, `dropFalseBranches`), opt-in `simplify` (S4b, S4c, S5, S6a, S6b, S7 typed, S9) | B20 |
| VR-45 | fixed | README wording: `allOf` items first, then the node's own keywords | — |
| VR-46 | fixed | group objects exported; CHANGELOG export list rewritten | B13.9.1, B14.14.1 |
| VR-47 | fixed | `singleOwner`, `groupByName` and dead branches removed; `MapArray` kept as a commented compatibility export | — |
| VR-50 | partially | `package.json` version 1.0.0, banner v1.0.0, ES2018 build; **blocked**: json-crawl 0.6.0 (with lazy paths) must be published and `yarn.lock` regenerated | — |
| VR-51 | open (release task) | dev-scope Dependabot alerts not cleaned up yet | — |
| D-12 | fixed (FEATURE_DESIGN decisions) | #107 AsyncAPI 2.x / 3.x with auto-detection and the `$ref`-to-Multi-Format-Schema hook (unwrap AsyncAPI / JSON Schema formats, keep + report others); #222 `refAnnotations: "merge" \| "omit" \| string[]` (default `"merge"`, `$ref` branches distributed by `mergeCombinarySibling` keep their annotations); simplifications (see VR-44); property-based test `test/fuzz` (`npm run test:fuzz`) with the options randomized | `test/asyncapi/*`, B19, B20, F4 |
| D-24 | fixed | `$ref` siblings apply in every draft: the link rules' copies conjoin every sibling (the draft-04/06/07 / OAS 3.0 / GraphApi drop + `refSiblingDropped` report removed); README and CHANGELOG document the deviation (`allOf: [{ $ref: Name, maxLength: 3 }, { minLength: 1 }]` → `{ type: string, minLength: 1, maxLength: 3 }`); the fuzz oracle reads draft-07 `$ref` siblings the same way (`withRefSiblingsApplied`: the `$ref` moves to the end of the node's `allOf`, so every pointer into the node stays valid), the draft-07 generator produces `$ref`s with siblings again, KI-1a/b/c are documented tests and corpus cases | B17.2.10, B18.2.2, B18.2.5 changed; `test/fuzz/ref-siblings.test.ts` |
| D-25 | documented | fragment mode leaves `$ref`s as they are; a pointer through a `$ref` member links to the target's own place | README, CHANGELOG; B18.1.6, B18.4.3 |
| D-26 | fixed | `mergeArray` marks the product branches it creates (`productBranches`, a WeakSet in `src/resolvers/basic.ts`); `collectItems` treats every component of such a branch (also when it is the branch a `mergeCombinarySibling` distribution holds) as a reference resolution, so a `$ref` component's target keeps its annotations and `intersect` combines them with the keyword's rule; `$ref`s inside a component's own `allOf` stay inherited | B19.4.5 changed, B19.8.1–7 |
| D-27 | fixed | `simplifyMerged` records, per output node and combinary key, where every branch went (new index, the equal kept branch for an `anyOf` duplicate, none for a removed branch; `CallState.shifts`); `relink` tries every candidate first with the indexes remapped along its path in the output (nested lists too), then as written, both with the D-22 equality check | B20.4.6 changed, B18.8.1–7 |
| D-14 | fixed | see VR-16 | B16.1.1–5 |
| D-17 | fixed | whole-document `merge`/`merger.merge`: after the clone pass, every output `$ref` through an `allOf` is checked; an `allOf` node the merge removed on such a pointer path is kept unmerged (members still merged) and the document is merged again until no pointer runs through a removed `allOf` (each round keeps at least one more node; memo and container cache are reset for the round and after the call). A bare `$ref` into kept `allOf`s is no longer inlined (D-16 only where needed). Fragment mode unchanged (pointers resolve against `source`); the raw hook does a single pass. Suite-wide check: `test/setup/refIntegrity.ts` fails any test whose whole-document merge leaves a `$ref` that resolved in the input but not in the output | B16.2.1–10, all suites |
| D-18 | fixed | schema rules carry `tuple: "items"` (draft-04/06/07, OpenAPI 3.0) or `"prefixItems"` (2020-12, OpenAPI 3.1); draft-04/06/07 have no `/prefixItems` rule (unknown, last-wins), 2020-12 keeps an array `items` that must be combined as `allOf` fragment `{ items, additionalItems? }` + `onMergeError`, a single one is copied, a stray `additionalItems` is last-wins; per-key fallbacks follow the same reading; a key without a rule in the rule set no longer takes its keyword group away from the other keys | B16.3.1–9, B6.3.1 changed |
| D-19 | fixed | see VR-43 | B16.4.1–11 |
| D-20 | fixed | a bare `$ref` whose pointer runs through a node the merge rewrites is inlined with the ORIGINAL target (resolved in the input, merged in its own right); for a contradiction this is the member D-10 drops, the node stays `false` / `{ allOf: [false], containers }`; refs into kept container members stay `$ref` | B17.1.1–5 |
| D-22 | fixed | whole-document merge: a `$ref` (bare or with siblings, also an allOf fragment `{ $ref }`) whose pointer runs through a rewritten node is copied during the clone pass and, after it (`relink`, at the end of the root), turned back into a link to the first candidate whose merged value is structurally equal to the copy: the pointer, the pointer without `allOf/<i>` steps, the target's own place without them, the stripped pointer through intermediate `$ref`s. Copies keep siblings per draft (2020-12 / OAS 3.1: conjoined; older: annotation + container siblings kept, constraint siblings dropped + `refSiblingDropped`). Cycle re-entries whose source pointer runs through a rewritten node point to the output location of the re-entered frame. Fragment mode leaves `$ref`s as they are. D-17 remains a fallback for refs that are neither linked nor copied (limits, non-schema locations, link siblings) | B18.1–7, changed: B13.4.6, B15.7.1, B16.2.1/3/4/7/8, B17.2.2/8/9/10, B17.3.1/3 |
| D-23 | fixed | the former D-16 / D-21 copies follow D-22 (link when equal, copy otherwise); a `$ref` into a schema that became `false` stays a copy (nothing equal survives) | B15.7.1, B17.2.2, B18.1, B18.2.6 |
| — | fixed | identity memo (`done`) and container-output cache keyed by (input node, rules): one instance under different rules (OpenAPI `info.x-…` and `components/schemas`, Avro vs AsyncAPI payload) is cloned per rule set | B18.6.1–2 |
| D-21 | fixed | same mechanism for a sibling member of a merged node (`#/definitions/A/properties/x`, also below it, also through an intermediate `$ref`); decided from the input before the node is visited, so it applies whenever the node has its own `allOf`, also when the merge leaves that member unchanged (or the node ends up unmerged because of a limit: inlining the original is equivalent either way). Also counted as "rewritten": a `$ref` with siblings under `mergeRefSibling` and a `oneOf`/`anyOf` with distributable siblings under `mergeCombinarySibling`. Members `definitions`, `$defs`, `components` are never "run through" (kept next to a merged node and next to a contradiction). Applies in whole-document and fragment mode and in the raw hook (see "Order of the `$ref` rules") | B17.2.1–15, B17.3.1–4 |

Additional changes during integration: a bare `$ref` whose pointer passes through an `allOf` member is inlined instead of dangling once that `allOf` is merged (replay finding, also in 0.6.8; B15.7.1); a frame that writes an already finished (shared) output no longer replaces that output's inlining counts — before, every reuse of a shared output counted the whole `allOf` → `$ref` chain again, so a 150-step chain already hit `maxRefExpansion` (B15.7.2); malformed boolean keywords, non-schema tuple values and invalid patterns are reported (B15.7.3); identity keywords (`$id`, `id` when a string, `$anchor`, `$dynamicAnchor`, `$schema`, `$vocabulary`) of `$ref`-inlined items are no longer copied into the merged node (no duplicate ids/anchors; the node's own survive; B15.3.1–5). Timing assertions of B14 got generous margins (≥ 1 s for cases that hung or took ≥ 15 s before the fix).

### Limits: choice of the defaults

Measured with the fixed code (per-target maximum = smallest `maxRefExpansion` without a report; total = smallest `expansionBudget` without a report):

| Document | Size | allOf | max inlinings of one target | inlined nodes in total |
|---|---|---|---|---|
| GitHub REST (api-smart-diff bench fixture) | 14.3 MB | 87 | 25 | 1 824 |
| GitHub REST 3.1 (yaml) | 9.9 MB | 77 | 23 | 2 392 |
| Bitbucket (#67) | 1.4 MB | 119 | 105 | 1 068 |
| Bitbucket (allof-merge temp) | 1.3 MB | 115 | 111 | 959 |
| Asana | 3.2 MB | 169 | 41 | 2 447 |
| Kubernetes apps/v1 | 0.9 MB | 180 | 51 | 4 777 |
| Stripe, TMF order management / product catalog, cbridge | 1.1–8.1 MB | 0–2 | ≤ 2 | ≤ 20 |

A per-target count is a poor proxy for the output size: with the D-7 default of 1 000 a 28 KB document (a 1 000-property target behind five levels of 10-fold fan-out) still produced 25 MB of output, while a legitimate document with 4 000 usages of one small target kept `$ref`s. Decision (minor policy, integration agent): keep the per-target limit but raise it to 10 000 (90× the real-world maximum), and add `expansionBudget`, a total budget of inlined schema nodes per call (the node count of every inlined target), default 2 000 000 (400× the real-world maximum; the synthetic "1 000 usages of a 1 000-property target" benchmark needs ≈ 1 000 000). Results: 25-level billion laughs (3.7 KB) → 2.7 MB in 12 ms; the fat-target attack → 48 MB (bounded by the budget) in 0.4 s incl. `JSON.stringify`; 4 000 and 50 000 usages of one small target merge fully up to 10 000 usages per target. **Confirm** the two defaults.

### Measurements after the fixes (ts-node on `src`, Node 26.13, best of 5 / 3)

| Shape | Time | Note |
|---|---|---|
| wide: 5 000 properties with a 2-item allOf | 26.7 ms | target ≤ 45 ms |
| deep: 1 000 nested allOf levels | 27.8 ms | target ≤ 80 ms |
| deep: 20 000-level plain chain | 99 ms | RSS 322 MB (was OOM) |
| deep: 20 000 nested allOf levels | 300 ms | merged down to `maxDepth` 2 000, reported once |
| 4 000 usages of one `$ref` | 41.9 ms | target ≤ 40 ms, no limit report |
| 1 000 usages × 1 000-property target | 297 ms | target ≤ 150 ms (missed, was 662 ms) |
| ring of 200 definitions | 78 ms | serializable (cycle `$ref`s); target ≤ 20 ms missed by design: every definition now carries all 200 properties (output 1 MB, quadratic in the ring length: 50 → 9 ms, 400 → 299 ms), where the earlier 4.3 ms shared one cyclic object |
| billion laughs, 25 levels | 12 ms | 2.7 MB output |
| fat target, 10^5 fan-out | 379 ms incl. stringify | 48 MB output, budget report |
| evil regex `^(a+)+$` × `a`·30 + `!` | < 0.1 ms | not executed (nested quantifier) |
| evil regex `^(a|aa)*$` × `a`·40 + `!` | < 0.1 ms | not executed |

### Replay of the probe corpora

All earlier corpora were replayed against the fixed `src` (scratch harness `/tmp/amr-replay`; ajv on ~1 000–3 000 generated instances per case, every ajv difference re-checked with python `jsonschema`), ≈ 75 000 merged inputs in total, before the integration fixes above; the two findings it raised (the dangling `$ref`, the chain counting) are fixed since.

| Corpus | Inputs | Equivalent | Intentional (D-ids) | Real mismatches | Throws / hangs |
|---|---|---|---|---|---|
| `/tmp/amr-similar` (mokka + stoplight recorded calls, extra probes) | 233 | 218 (+15 originals ajv cannot compile; python agrees where decidable) | D-6 ×3, D-2 ×2, D-3/D-5 fragments ×6 | 0 (all 14 earlier mismatches now equivalent) | 0 |
| hypothesis / x0k / qubership | 41 / 221 / 16 | 41 / 221 / 11 (+3 output-only, 2 infinitely recursive originals) | — | 0 | 0 (1 throw before) |
| json-schema-intersect | 142 | 110 (+20 D-6, 12 draft-04 bounds equivalent under python Draft4) | D-6 | 0 | 0 |
| datamodel-code-generator | 262 | 245 (+4 recursive ok in python, 11 uncheckable: external refs, `\A`, 2020 array `items`) | — | 1 → fixed (dangling `$ref` into a merged `allOf`, B15.7.1) | 0 |
| oasdiff | 169 | 152 (+16 python-checked) | 49 oasdiff shape assertions differ in form only (last-wins title, kept bounds, no `oneOf` pruning, no `AllOfMerged_*` hoisting) | 0 | 0 |
| probes, probe2–5 (output only) | 51 | reviewed | — | — | 0 (7 throws before) |
| fuzz replay (old corpora) | 7 500 | all (33 ajv-only `contains` diffs, 2 ajv crashes; python ok) | — | 0 | 0 |
| fresh fuzz (draft-07 ×2, draft-07 + `mergeCombinarySibling`, 2020-12 ×2) | 15 000 | all (70 ajv-only `contains` diffs, 16 ajv crashes on 2020; python ok) | ~870 contradictions, D-2 ×8, D-6 ~40, D-8 ×4, D-10 ×6, ~47 object-shape fragments, 6 `multipleOf` fragments | 0 | 0 (≤ 5 ms per merge) |
| `/tmp/amr-verify` probes + fuzz.ts (5 × 4 000) + fuzz2.ts (3 × 15 000) | ≈ 65 000 | 100 checked comparisons ok; fuzzers 0 mismatches | — | 0 (p2 `0.1 ∧ 0.3 → 0.3` is exact; ajv and python use float division) | p13 throws `Merge rule not found` for custom rules without a `/?` fallback (same in 0.6.8) |
| `/tmp/amr-sec` DoS and prototype probes | all | — | — | — | 0 hangs: ReDoS 4.7 ms, `multipleOf` edge values < 5 ms, nested 32×32 branches 34 ms, billion laughs 13 ms, 100 000 nested allOf 138 ms, 20 000 nested properties 316 ms, 10k × 10k patterns 977 ms; no prototype pollution, own `__proto__`/`constructor` keys survive, rules deep-frozen |

Remaining after the replay (not fixed, listed for the user):

- Mixed-draft input: `{prefixItems:[{type:number}]} ∧ {items:[{}, {type:string}]}` → `{prefixItems:[number, string]}`. The shared draft-06/07/2020-12 table reads a tuple `items` as positions; under a draft-07 validator `prefixItems` is unknown, so the merged schema accepts `[1, 2]` while the original does not; under 2020-12 the original's array `items` is invalid. Ambiguous input, intentional consequence of the shared keyword table. **Resolved by D-18** (per-draft tuple keywords, B16.3).
- A cycle that starts inside an `allOf` item is written as a `$ref` to its source location, which passes through that `allOf` (`#/definitions/A/allOf/0/properties/self`): valid against `source` (D-4) but not inside a whole-document result. **Resolved by D-17** (the `allOf` is kept, B16.2).
- `allOf` → `$ref` chains are quadratic in the chain length (each definition re-walks its chain): 1 000 steps 0.3 s merged fully; from ≈ 1 150 steps the `expansionBudget` stops inlining (bounded, equivalent output, 4 000 steps ≈ 1 s). Real documents have chains of a few steps.
- VR-43 (conflicting unknown / `x-*` keywords, silent last-wins) unchanged by choice. **D-19**: default unchanged, vendor / prefix / unknown-key rules configurable (B16.4).
- A custom rule set without a `/?` fallback throws `Merge rule not found` for unknown keys (same in 0.6.8; a programming error, not input). **Fixed by D-19**: last-wins.
- Found while implementing D-17: (a) a contradiction drops the node's `properties` etc. (D-10 keeps only container siblings), so an input `$ref` to `#/definitions/A/properties/x` of a contradictory `A` dangles in a whole-document result (the suite-wide check would flag it; no fixture has it); (b) a `$ref` to a sibling member of a merged node (`#/definitions/A/properties/x` where `A` has its own `properties.x` and an `allOf` item adds `x: { minLength: 3 }`) resolves in the output to the merged, stricter `x` — the source meant `A`'s own `x` only (same family as D-16, which inlines the member's value for pointers through `allOf`). Both needed a policy decision. **Resolved by D-20 and D-21** (B17).
- `createMerger` retains ≈ 9 MB after 1 000 documents while they are reachable (weak maps; nothing is held after the documents are released).
- The replay measured 1 000 × 1 000 at 353 ms against 19 ms for the 0.6.8 copy in `/tmp/amr-verify/head`; 0.6.8 shared one output instance (and produced cyclic objects), the redesign rebuilds the container per usage (see B.3 in `docs/ANALYSIS.md`).

### Order of the `$ref` rules (D-16, D-17, D-20 … D-23)

A node is "rewritten" when the merge changes its shape so that its members no longer mean what they meant in the input: it has its own `allOf` (merged), it is a `$ref` with siblings under `mergeRefSibling`, or a `oneOf`/`anyOf` with distributable siblings under `mergeCombinarySibling`. A pointer "runs through" a rewritten node when a proper prefix of it resolves (in the input, intermediate `$ref`s followed) to that node and the next segment is not `definitions`, `$defs` or `components`; the target itself may be rewritten (a `$ref` to a merged node is equivalent and stays). Principle (D-22): every valid link stays valid and keeps its meaning, as a link wherever possible. The rules apply in this order:

1. Cycle re-entries (D-4, D-4b) are written as `$ref`s to the source location of the node where the cycle started. When that pointer runs through a rewritten node, a whole-document merge writes a `$ref` to the output location of the re-entered node instead (the merged value written there means what the input node means, so the pointer is valid and keeps its meaning by construction). Outside `source` the conjunction keeps its `allOf` (D-4).
2. Whole-document merge, during the clone pass: a `$ref` at a schema location (bare or with siblings, without `mergeRefSibling`; also a `{ $ref }` fragment left inside `allOf`) whose pointer runs through a rewritten node is replaced by a copy of the ORIGINAL target (resolved in the input, merged in its own right; limits and cycle rules apply; a target with its own `unevaluated*` is copied whole). Siblings are conjoined with the copy in every draft (D-24; an earlier draft of this rule dropped the constraint siblings under draft-04/06/07 / OpenAPI 3.0 / GraphApi rules and reported them with `refSiblingDropped`). With `mergeRefSibling` a `$ref` with siblings is merged with the original target as before. Exception: every rewritten node on the way is kept unmerged by rule 4.
3. Whole-document merge, after the clone pass (`relink`, run when the root is finished, so also by the raw hook): each copy becomes a link again when the merged output holds the same value at one of the candidates, in this order: the pointer itself; the pointer with every `allOf/<i>` step removed (when reached without intermediate `$ref`s); the target's own place in the input with `allOf/<i>` steps removed; the stripped pointer through intermediate `$ref`s. "The same" is structural deep equality (key order ignored, `$ref` strings compared literally, `true` equals `{}`) between the output value at the candidate and the original target merged on its own in the same call — for a bare `$ref` the copy itself, for a `$ref` with siblings the target merged without them. The link keeps the `$ref`'s siblings as they are (merged in their own right). A candidate inside the copy itself is never used. All decisions are taken on the output as the pass left it; afterwards every pointer below a copy that became a link is moved below the link's target (except into the link's own siblings), and a link that does not resolve in the final output is turned back into its copy. A `$ref` into a schema that became `false` (D-20) stays a copy (nothing equal survives); a pointer into a member pushed into `oneOf` branches stays a copy (no matching location).
4. Whole-document merge only, fallback (D-17): after the clone pass, every `$ref` left in the output that rules 1–3 did not handle and whose pointer runs through a node the pass actually rewrote keeps that node unmerged (its members are still merged) and the document is merged again, until no such `$ref` is left. Since D-22 this triggers only for `$ref`s kept by `maxRefExpansion` / `expansionBudget` / `maxDepth`, `$ref`s outside schema locations, and `$ref`s inside the siblings of a link (merged in fragment mode). The raw hook does not apply it.

Fragment mode (`merge(node, { source: doc })`): pointers resolve against the unmodified `source`, so every `$ref` keeps its meaning there; rules 2–4 do not apply (no copy, no rewrite — decision, minor policy, replacing the earlier "inline anyway": a link that is valid and means the same stays a link), cycle pointers always point into `source`. A fragment written back into a merged document must therefore be merged again with that document as source. Pointers the merge writes keep `$ & + , ; = : @` literal (`#/$defs/A`).

The suite-wide check (`test/setup/refIntegrity.ts`) enforces the result structurally for every whole-document merge of the test suite: every output `$ref` resolves in the output (refs already broken in the input excepted, `danglingRefs`), and a bare input `$ref` through a node with its own `allOf` is a copy only where neither its pointer nor its matching location holds an equal merged value (`copiesWithEqualLink`). `expectRefMeaningPreserved` (ajv) is the semantic version used by the B17 and B18 tests: every `$ref` site of the input that still exists in the output and every output `$ref` must accept the same instances in both documents. ajv 8 applies `$ref` siblings in every draft, which is the reading of D-24, so the draft-04/06/07 cases with constraint siblings are judged against the input as written.

### After D-24, D-25 and the D-12 features (2026-11-17)

`npx tsc --noEmit` clean; `npx jest` alone: 39 suites, 938 passed, 1 pre-existing skip (coverage 93.9 % statements, 85.3 % branches); `FUZZ_RUNS=5000 npx jest test/fuzz` (2 × 5 000 random cases with randomized options, the corpus incl. the former KI-1 cases): 13 passed in 27 s, ajv second opinion 5 sampled disagreements, all allowlisted (`contains` + tuple defect); three more seeds × 5 000 per profile green. `npm run build` green, no circular-dependency warnings; smoke test of `dist/index.cjs` and `dist/index.mjs` (OpenAPI 3.1 merge, AsyncAPI 3.0 unwrap + kept Avro wrapper with one report, `refAnnotations: "omit"`, `simplify: true`) passed.

Changes: AsyncAPI engine hook (`selectMergeRules` → `asyncApiMergeRules(detectAsyncApiVersion(doc))`; `collectItems` unwraps a `$ref` target that is a 3.x Multi Format Schema Object, keeps any other format as a `{ $ref }` part reported through `onMergeError`, the same wrapper twice once; messages in `ErrorMessage.schemaFormatNotMergeable` / `schemaFormatWithoutSchema`); D-24; `refAnnotations` (inherited items stripped through a cached copy like the identity keywords; reference resolutions — a D-22 copy's target, a `$ref` branch made by `mergeCombinarySibling` — keep their annotations); simplifications (`dedupeCombinaryGroups` and `dedupeFragments` in `intersect` / the fragment lists, `dropFalseBranches` / `dedupeAnyOf` / `simplify` when a merged node's subtree is finished; `dropFalseBranches` / `dedupeAnyOf` also on not-merged nodes with `oneOf`/`anyOf`, which therefore count as rewritable for the link rules: a pointer into a shifted branch is copied — since D-27 it links the branch's new index); schema rule sets carry a `draft` marker; `test:fuzz` script.

Measurements (same script and machine as above, ts-node on `src`, Node 26.13, best of 5 / 3; three runs, range):

| Shape | Before (above) | Now | Change |
|---|---|---|---|
| wide: 5 000 properties with a 2-item allOf | 26.7 ms | 27.2 – 29.6 ms | +2 … +11 % |
| deep: 1 000 nested allOf levels | 27.8 ms | 29.4 – 35.2 ms | +6 … +27 % (noisy: the A/B run below gives 31 ms both with and without the new options) |
| deep: 20 000-level plain chain | 99 ms | 104.7 – 117.5 ms | +6 … +19 % |
| deep: 20 000 nested allOf levels | 300 ms | 341 – 357 ms | +14 … +19 % |
| 4 000 usages of one `$ref` | 41.9 ms | 43.1 ms | +3 % |
| 1 000 usages × 1 000-property target | 297 ms | 283.8 ms | −4 % |
| ring of 200 definitions | 78 ms | 80.0 ms | +3 % |
| billion laughs, 25 levels | 12 ms | 13.2 ms | +10 % |
| fat target, 10^5 fan-out | 379 ms | 370.9 ms | −2 % |
| evil regex `^(a+)+$` / `^(a|aa)*$` | < 0.1 ms | ≤ 0.1 ms | — |

No shape is consistently above +20 %. The deep shapes vary most between runs; an A/B run in one process (all four safe options on vs off, best of 7) gave chain 109 / 99 ms and 105 / 105 ms, deep 1 000 31.1 / 31.1 ms and 31.7 / 31.7 ms, so the options themselves cost nothing measurable there and the spread is machine noise.

### After D-26 and D-27 (2026-11-17)

D-26: product branches made by `mergeArray` are marked; their components are read as reference resolutions, so `$ref` components keep their annotations under `refAnnotations` and the keyword's merge rule combines them (B19.4.5 changed from "annotations dropped" to `title: "B"`, new B19.8.1–7: default rule, custom first-wins / concatenation `/title`, description, mixed `$ref` + inline components, node-level `$ref`s still dropped, `mergeCombinarySibling` distribution, `anyOf` + ajv equivalence). D-27: branch moves recorded by `simplifyMerged`, remapped candidates in `relink` (B20.4.6 changed from copies to links `X/oneOf/1` and `X/oneOf/0`, new B18.8.1–7: several removed branches, a pointer below a branch and a `$ref` with siblings, `anyOf` duplicates, nested lists, a merged / distributed node, options off, idempotence). `expectRefMeaningPreserved` reads an output pointer in the input as well, which a shifted index does not allow, so B18.8 checks the meaning per `$ref` site (ajv, input site vs output site) next to `expectRefsResolve` and `copiesWithEqualLink`. Results: `npx tsc --noEmit` clean; `npx jest` alone: 39 suites, 952 passed, 1 pre-existing skip (coverage 93.95 % statements, 85.45 % branches); `npm run test:fuzz` and `FUZZ_RUNS=3000 npm run test:fuzz`: 13 passed each (9 s / 18 s); `npm run build` green, no circular-dependency warnings; `dist/index.cjs` smoke test of both cases passed; `node_modules/json-crawl` unchanged.

### Build: circular dependencies

`npm run build` warned about three module cycles, all new in the redesign (0.6.8 had a different one, `resolvers/jsonschema ↔ resolvers/properties`, which the redesign had already removed): `resolvers/basic ↔ groups/string` (the format resolvers used `mergeFormats` from the string group, which imports `conjunctPatterns`/`mergeOpenApiFormat` from `resolvers/basic`), `rules/jsonschema → resolvers → intersect → rules/jsonschema` and `merge → rules → rules/jsonschema → resolvers → intersect → merge` (the exported `jsonSchemaMergeResolver`, the `$` of the schema rules, runs a merger with the default rules). They were harmless (every cross-module use is inside a function body and the package entry evaluates the modules in a working order), but a deep import entering at `resolvers` would have read the rule tables before the resolvers were initialized. Removed: `mergeFormats` moved to the leaf `src/groups/format.ts` (re-exported from the string group, public exports unchanged); `jsonSchemaMergeResolver` and `isAllOfMergeRule` moved to `src/resolvers/conjunction.ts`, which reaches `createMerger` and the default rules through the leaf `src/engine.ts` (registered by `merge.ts` and `rules/jsonschema.ts` when they are evaluated; a call before that throws a clear error, impossible through the package entry). `intersect.ts` no longer imports `merge.ts` or the rules. The build now reports no circular dependencies.
