# allof-merge — review and redesign options (same public API)

Inputs: `src/` of allof-merge 0.6.8 (incl. the uncommitted `normalize.ts` change), the audit in `docs/ANALYSIS.md` (27 findings AM-01…27, performance table B.1, hotspots B.2), the fork `@netcracker/qubership-apihub-api-unifier` 2.9.3 (`merge.ts`, `allOf.ts`, `cache.ts`, `cycle-jso.ts`, `resolvers/*`), and the consumer usage in `api-smart-diff` (merge called on every schema node with `source: root`). Goal: a design that keeps the public API — `merge(value, options)`, `allOfResolverHook(options)`, `jsonSchemaMergeRules/openApiMergeRules/graphapiMergeRules`, `MergeOptions` (`source`, `rules`, `mergeRefSibling`, `mergeCombinarySibling`, `onMergeError`, `onRefResolveError`), the `MergeRule { $, sibling }` shape and the utility exports — while fixing every finding and improving performance.

## 1. Review of the current implementation

### 1.1 Architecture

One `syncClone` pass with one hook (`allOfResolverHook`). For every node the hook: allocates `mergeError` and `exitHook` closures, destructures `{ allOf, ...sibling }`, and — if the node's rule tree has `/allOf.$` — resolves `$ref` items lazily (`normalizeAllOfItems`), flattens nested `allOf`, merges with `jsonSchemaMergeResolver`, and optionally rewrites `$ref`/`oneOf`/`anyOf` siblings into `allOf`. Impossible `oneOf`/`anyOf` branches are remembered in `nodeToDelete` (a `Map<pointer-string, index>`) and spliced out by the parent's exit hook. Cycles through `$ref` are detected by fingerprinting the item list with `JSON.stringify` and scanning the global `allOfRefs` list.

What is good and must be kept: the single-pass, hook-based design is small (1 044 lines), dependency-free apart from json-crawl, works on fragments (`source`), supports custom rule trees, and the keyword resolvers are mostly correct for the common keywords (bounds, `multipleOf` LCM, `required`, tuple `items`, `not`, `definitions`).

### 1.2 Root causes behind the 27 findings

The findings cluster into five structural causes rather than 27 independent bugs:

1. **No representation of "unsatisfiable"** — `undefined` from a resolver means both "no rule result" and "contradiction"; the key is then dropped (AM-01), a whole node becomes `undefined`/`null` (AM-09, AM-08), and `false` schemas are discarded before they can be seen (AM-05). The README promise "does not validate more or less" is violated exactly here.
2. **Keywords merged in isolation although JSON Schema couples them** — `exclusiveMinimum` without `minimum` (AM-10), `additionalItems` without the other item's `items` (AM-19), `properties` without the *whole* `patternProperties`/`additionalProperties` picture (AM-04), `contains` (AM-12), `dependencies` (AM-17), `integer ⊂ number` (AM-02), pattern conjunction (AM-03), 2020-12 keywords (AM-20).
3. **String-based identity** — `JSON.stringify` for enum/const equality (AM-13), for the cycle fingerprint (AM-07, O(R²), AM-23 is a mutation of exactly this logic), `buildPointer` strings for `nodeToDelete` (the O(depth²) hotspot).
4. **Resolution entangled with merging** — refs are resolved inside the allOf hook, so a broken ref rewrites the node (AM-15), `resolvePointer` through refs loses segments (AM-16), and every usage re-resolves and re-clones the target (O(usages × |target|)).
5. **Rule plumbing** — thunks re-create the ≈50-key rules object per node and per key (hotspot B.2.3), function rules are called with the wrong arity (AM-06), `/not` has no children (AM-18), OpenAPI rule tree is partial (AM-21), `parseRef` ignores `basePath` (AM-22).

### 1.3 The fork, in one paragraph

api-unifier solved causes 1, 3 and 4 with a different architecture: a separate resolve pass inlines every `$ref` (cycles become JS cycles, each node gets origin metadata), `merge` memoizes results by the identity tuple of the allOf items (`cache.ts`), boolean items become synthetic `any`/`nothing` schemas, branch deletion is gone, a cycle-aware clone (`cycle-jso.ts`) guarantees one output instance per input instance. It did not touch cause 2 (AM-02/03/10/12/17/19/20 remain), it removed the public `merge`/rules API and the fragment use-case, it decorates output with symbols, and it brought ≈10× the code and three private-registry dependencies. The ideas worth taking are the identity memo, the "never undefined" contract and boolean-schema unification; the rest is orthogonal to this library's purpose.

## 2. Design principles shared by all options

- **Unsatisfiable is a value.** The intersection engine returns the boolean schema `false` (configurable to `{ not: {} }` for draft-04 consumers) whenever a conjunction is contradictory; it never returns `undefined` and never deletes a key or a branch. `onMergeError` keeps firing for diagnostics. A `oneOf: [false, S]` is a valid, equivalent schema; consumers that want pruning filter `false`. This resolves AM-01, 05, 08, 09, 25 in one place.
- **Identity, not strings.** Equality of enum/const members by structural deep-equal (≈25 lines, zero deps); cycle and memo keys by object identity (`WeakMap`/`Map` on instances), never `JSON.stringify` of subtrees; no pointer strings in the hot path. Resolves AM-07, 13, 23 and the depth²/R² hotspots.
- **Keyword groups.** The per-key resolver table stays (custom rules keep working), but the engine first runs *group resolvers* that see all items of the node and own several keys: numeric bounds (`minimum`+`exclusiveMinimum`, `maximum`+`exclusiveMaximum`, both drafts), object shape (`properties`+`patternProperties`+`additionalProperties`+`propertyNames`), array shape (`items`/`prefixItems`+`additionalItems`/`items(2020)`+`contains`/`minContains`/`maxContains`+`unevaluatedItems`), types (`type` lattice with `integer ⊂ number`), dependencies (`dependencies`/`dependentRequired`/`dependentSchemas`). Resolves AM-02, 03, 04, 10, 12, 17, 19, 20 and keeps the rule table backwards compatible (a custom `/minimum` rule still wins over the group if present).
- **Merged results are memoized and shared.** The merge of a given set of item *instances* is computed once per `merge()` call (and, through `allOfResolverHook`, across calls when the hook is reused); repeated `$ref` usages reuse the merged instance (sharing already exists today — AM-27 — it becomes documented and complete).
- **Rules are values.** `jsonSchemaMergeRules(draft, custom)` returns a frozen, memoized object per `(draft, custom)` identity; function rules are invoked with the json-crawl context and `getNodeRules` is used for lookup (AM-06, hotspot B.2.3).

## 3. Options

### Option A — Harden the single pass

Keep `syncClone` + one hook. Changes: the five principles above applied inside the existing files; `nodeToDelete`/`findNodeToDelete`/exit hooks deleted (branches become `false`); `normalizeAllOfItems` keeps resolving refs lazily but with a `Map<refString, resolvedTarget>` and an identity-keyed in-progress set for cycles (no stringify, no `allOfRefs` scan); results of `jsonSchemaMergeResolver` memoized per item-identity tuple and written with `state.node[key] = cached; return { done: true }` on repeated usages so the clone does not re-walk the target.

- Solves: all correctness findings; depth² (no `buildPointer`, no exit hook), R² (map lookup), usages × |target| (memo + `done`), rule allocation (memoized rules). Remaining cost: json-crawl's own path copy (fixed separately in json-crawl).
- Pros: smallest diff (~300 lines changed), lowest risk, same file layout, fragment/`source` semantics untouched, keeps lazy resolution so untouched `$ref`s outside allOf stay strings.
- Cons: resolution stays entangled with merging (two code paths still know about `$ref`), memo is per `merge()` call unless the caller reuses `allOfResolverHook`, keyword groups bolted onto a key-indexed resolver loop.

### Option B — Two phases inside one `merge()`: resolve index → merge pass

Phase 1 (`createResolutionIndex(source)`): one read-only walk of `source` (or of `value` when `source` is absent) building `Map<normalizedRef, targetNode>` for every `$ref` reachable from `value`, following ref→ref chains with an identity-based cycle set, applying `~0/~1` and percent decoding once, and recording broken/external refs for `onRefResolveError`. Nothing is cloned or inlined; the index is a side table. Phase 2: the clone pass as in Option A, but the hook never parses or resolves refs — it asks the index. `source` fragments work because the index is built from `source`. Memo and "never undefined" as in A.

- Solves: everything A solves, plus AM-15/16/22 by construction (resolution has one implementation, tested on its own), and the index makes "resolve once, merge once per target" natural: the memo key for a `$ref` item is the target instance.
- Pros: clean separation (resolution ↔ intersection), each phase unit-testable, `resolvePointer`/`parseRef` become thin wrappers over the index code (API preserved), identical output contract to today for refs outside allOf (left as strings).
- Cons: one extra read-only traversal of the document (≈ the clone-only cost, +20–40 % wall time on wide documents without any allOf — measurable but linear); a larger refactor than A (~500 lines); for `merge` called on every node (api-smart-diff) the index must be cached per `source` instance (a `WeakMap<source, index>`) or the extra pass is paid per call — provide this cache inside `allOfResolverHook`.

### Option C — Lazy intersection graph (demand-driven evaluator)

Model every schema node as an expression `∧(items…)` evaluated on demand; `merge()` builds the graph (identity-keyed nodes), evaluates the root, and materializes the result. Cycles are placeholders filled on completion (the fork's `cyclicGuardResult` idea), shared sub-expressions evaluate once, nodes with no `allOf` are passed through untouched (no clone at all unless something below them changes — structural sharing with the input).

- Solves: all findings; best asymptotics (O(n) nodes, each merge once, no clone of unchanged subtrees, so "merge on every node" collapses to one evaluation per subtree).
- Pros: fastest; the natural home for a cross-call cache (`createMerger()`); output structurally shares unchanged input subtrees (less memory).
- Cons: the biggest rewrite (≈ new engine, json-crawl used only for the final materialization or not at all); structural sharing with the *input* changes the implicit "output is a copy" expectation (api-smart-diff writes transformed children into parents — it would start mutating the caller's document through the shared nodes unless it clones); custom rule trees need an adapter because today's rules are addressed by crawl path, not by expression; harder to keep `allOfResolverHook` meaningful (it would become a thin compatibility shim).

### Comparison

| | A — hardened single pass | B — resolve index + merge pass | C — lazy intersection graph |
|---|---|---|---|
| AM-01/05/08/09/25 (unsatisfiable) | ✔ | ✔ | ✔ |
| AM-02/03/04/10/12/17/19/20 (keyword groups) | ✔ | ✔ | ✔ |
| AM-06/18/21/22 (rules & plumbing) | ✔ | ✔ | ✔ (rules adapter) |
| AM-07/13/23 (string identity) | ✔ | ✔ | ✔ |
| AM-14 (input mutation) | ✔ | ✔ | ✔ (requires copy-on-write discipline) |
| AM-15/16 (ref handling) | ✔ (patched) | ✔ (by construction) | ✔ |
| AM-24/27 (cyclic, shared output) | unchanged, documented | unchanged, documented | sharing extends to unchanged input |
| Depth: 1 000 nested levels (1.7 s today) | ≈ clone cost (≈50 ms + json-crawl path term) | same + index pass | ≈ O(n), no clone of untouched subtrees |
| 4 000 usages of one `$ref` (349 ms, O(R²)) | O(R), ≈ tens of ms | O(R) | O(R) |
| 1 000 usages × 1 000-property target (6.1 s) | one merge + shared instance: ≈ cost of one target | same | same |
| Wide 5 000 props, no allOf (64 ms vs 19 ms clone) | ≈ 30–40 ms (no closures, no spread per node) | +1 index pass | ≈ input sharing, near zero |
| api-smart-diff merge-on-every-node (3–5×) | 3–5× unless hook reused | 1× with cached index + reused hook | 1× (memo per subtree) |
| Public API | unchanged | unchanged | unchanged signatures; `allOfResolverHook` becomes a shim |
| Output contract changes | `false` for contradictions; no sorting of `enum`/`required`; pattern form | same as A | same as A + structural sharing with input |
| Effort / risk | S–M / low | M / medium | L / high |

### Recommendation

**Option B**, with Option A's resolver and memo work as its first milestone (A is a strict subset of B). Reasoning: B is the smallest design that gives resolution a single, testable implementation (the source of AM-07/15/16/22/23 and of the uncommitted change) while keeping today's output contract for refs outside allOf and the fragment/`source` use-case; its only cost is one linear read-only pass, which disappears for the merge-on-every-node pattern once the index is cached per `source`. Option C's extra gains are concentrated in api-smart-diff's usage pattern, which is better fixed on the consumer side (merge once at the top, then look up pointers) and would force a copy-on-write contract on every consumer.

## 4. Target architecture (Option B)

```
merge(value, options)
  ├─ rules   = memoized(options.rules ?? selectMergeRules(value))      // frozen per (draft, custom)
  ├─ index   = indexCache.get(source) ?? createResolutionIndex(source) // phase 1, WeakMap per source
  └─ syncClone(value, [mergeHook(index, rules, memo, options)])        // phase 2
```

**`createResolutionIndex(source)`** — iterative walk collecting every `{ $ref }` node reachable from `source`; for each distinct normalized ref: parse once (`~0`/`~1`, percent-decoding, `basePath`), resolve the pointer segment by segment, and when an intermediate value is itself a `$ref` node, resolve it and continue with the *remaining* segments (AM-16); detect ref→ref cycles with an identity set and report them once; external refs (`filePath` set) and unresolvable pointers are recorded as `broken` with the reason. API: `resolve(ref): { target } | { broken: reason }`; `resolvePointer`/`parseRef` exported as today, implemented on top of it.

**`mergeHook`** — per node: skip non-objects and nodes whose rules lack `/allOf.$`; `const { allOf, ...sibling } = value` (cached per node instance with a `WeakMap` so the spread happens once even when the same instance is reached through several refs); build the item list: allOf items (ref items replaced by `index.resolve`, broken ones left as `{ $ref }` and reported; when any item stays a `$ref` the node is returned **unchanged** — AM-15), siblings as one item, nested allOf flattened with an identity set guarding against self-inclusion, booleans kept (`true` → `{}`, `false` → `false`); then `result = memo.get(identityTuple(items)) ?? intersect(items)`; on repeated usage write `state.node[key] = result; return { done: true }` so the clone does not descend again; otherwise `return { value: result }` and let the clone descend into the fresh result (nested allOf inside merged children is merged on the way down, exactly as today). `mergeRefSibling`/`mergeCombinarySibling` keep their semantics (opt-in rewrites before intersection), with the sibling whitelist from the rule.

**`intersect(items, rules, ctx)`** — the engine:
1. If any item is `false` → `false`. Drop `true`/`{}` items.
2. Group values by key (`getAllOfItemsMap`).
3. Run **group resolvers** (each consumes the keys it owns from the map and may emit several keys or `false`): `typeGroup` (lattice over `type` arrays; `integer ∧ number = integer`; empty intersection → `false`), `numericBoundsGroup` (per draft: pick the tightest lower/upper bound carrying its exclusiveness; draft-04 boolean flags travel with their bound), `stringGroup` (`minLength`/`maxLength` tightest; `pattern` conjunction as `^(?=[\s\S]*?(?:p1))(?=[\s\S]*?(?:p2))[\s\S]*$` after de-duplication; identical single pattern kept verbatim), `objectShapeGroup` (for every property name present in any item, collect the applicable schemas from each item: own `properties[name]`, matching `patternProperties` schemas, else `additionalProperties` schema, else nothing for `true`/absent, `false` → the property becomes `false`; `patternProperties` kept as the union of patterns, each the allOf of same-pattern schemas; `additionalProperties` = intersection of all items' additional schemas, `false` if any is `false`), `arrayShapeGroup` (tuple/items/additionalItems as today but with the single-`additionalItems` case included (AM-19) and 2020-12 `prefixItems`/`items`; `contains` kept as `allOf` of the item-level `{ contains }` fragments when more than one, since it has no closed intersection form (AM-12); `minContains`/`maxContains` tightest), `dependenciesGroup` (draft-04 `dependencies`, 2019-09 `dependentRequired`/`dependentSchemas`, union/allOf semantics; AM-17/20), `enumConstGroup` (deep-equal intersection; `const` as a one-element enum; empty → `false`).
4. Remaining keys go through the **rule table** exactly as today (`/key.$` resolver, `/?` fallback), so custom rules keep working and override groups when a key has an explicit custom rule.
5. Any resolver returning `undefined` is a contradiction → `false` + `onMergeError`; the engine never returns `undefined`.
6. `enum`/`required` keep first-seen order (no sort); `title`/`description`/`default`/`format`/`examples` keep today's `last`/`mergeObjects` behaviour.

**Rules** — same tree shape and exports; `jsonSchemaMergeRules(draft, custom)` memoized per `(draft, custom)` identity and `Object.freeze`d; draft gains `"2020-12"` (and `"draft-07"`) with the new keywords; `/not` gets child rules; OpenAPI tree adds `callbacks`, `webhooks`, `components.pathItems`, `links`, `encoding/*/headers/*/schema`; function rules receive the crawl context. `MergeRule` gains an optional `group?: string` so a custom rule can opt out of a group (default: groups own their keys unless a custom `$` is present).

**Memo and cross-call reuse** — `allOfResolverHook(options)` already is the reusable unit; it keeps `index` (per `source`), `memo` (per item-identity tuple) and the spread cache for its lifetime, so api-smart-diff can create one hook per document and call `syncClone` per node with amortized cost, or — recommended — call `merge` once on the root and read merged subtrees by pointer.

## 5. Output-contract changes to announce

| Today | Proposed | Why |
|---|---|---|
| Contradiction drops the key / node becomes `undefined` | node becomes `false` (option `unsatisfiable: "false" \| "not-empty"` for `{ not: {} }`) | AM-01/05/08/09; keeps validation equivalence |
| Impossible `oneOf`/`anyOf` branch removed | branch stays as `false` | AM-08; no `null` holes, deterministic |
| `enum`/`required` sorted | insertion order, de-duplicated | AM-26 |
| `(?=p1)(?=p2)` | `^(?=[\s\S]*?(?:p1))(?=[\s\S]*?(?:p2))[\s\S]*$` | AM-03 |
| broken `$ref` in allOf → node rewritten | node unchanged + `onRefResolveError` | AM-15 |
| cyclic `$ref` in allOf → cyclic output | unchanged (documented; a `serialize` helper is out of scope) | AM-24 |
| repeated `$ref` targets → shared output instances | unchanged, now guaranteed and documented | AM-27 |
| `integer ∧ number` → conflict | `integer` | AM-02 |

api-smart-diff impact: it must treat a `false` schema as "unsatisfiable" (today it would see a removed property); its `/type` classifier already handles `type` arrays; order-preserving `required`/`enum` removes spurious reorder diffs.

## 6. Performance targets (vs `docs/ANALYSIS.md` B.1)

| Shape | Today | Target |
|---|---|---|
| Wide 5 000 properties with allOf | 86 ms | ≤ 45 ms (no closures/exit hooks, cached spread, frozen rules) |
| Deep 1 000 levels with allOf | 1 718 ms | ≤ 80 ms (no `buildPointer`; residual is json-crawl's path copy, fixed in json-crawl 0.5.5) |
| 4 000 usages of one `$ref` | 349 ms | ≤ 40 ms (index lookup + memo) |
| 1 000 usages × 1 000-property target | 6 070 ms | ≤ 150 ms (one intersection, shared instance, no re-clone) |
| Ring of 200 cyclic definitions | 84 ms | ≤ 20 ms (identity cycle set) |
| api-smart-diff every-node, depth 5 | 109 ms vs 25 ms single | ≈ single-merge cost with a reused hook |
| Cartesian `oneOf × anyOf` in one allOf | m^k branches | unchanged by design; cap with `onMergeError` above a configurable branch budget (default 1 024) instead of hanging |

## 7. Migration plan

1. **M0 — unblock**: revert the uncommitted `normalize.ts` change (AM-23); land the audit suite (`test/audit`) as the acceptance baseline; add ajv to devDependencies.
2. **M1 — resolver correctness (Option A subset, patch release)**: deep-equal, boolean items, `false` for contradictions (behind the `unsatisfiable` option defaulting to today's behaviour until M3), `integer ⊂ number`, pattern conjunction, fresh wrappers (AM-14), `/not` children, `/items` arity fix, rules memoized/frozen, no sorting. Flip the matching `test.failing` cases.
3. **M2 — identity and memo**: replace the stringify fingerprint and `allOfRefs` with the identity cycle set and the item-tuple memo; delete `nodeToDelete` and exit hooks; `done: true` on repeated usages. Benchmarks from §6 must hit their targets except the depth row.
4. **M3 — resolution index (Option B)**: `createResolutionIndex`, `resolvePointer`/`parseRef` on top of it, broken refs leave the node unchanged, `basePath` honoured; default `unsatisfiable: "false"` (minor version bump, changelog entry from §5).
5. **M4 — keyword groups**: `objectShapeGroup`, `numericBoundsGroup`, `arrayShapeGroup`, `dependenciesGroup`, draft-07/2020-12 keywords, OpenAPI rule-tree gaps; `MergeRule.group`.
6. **M5 — consumers**: api-smart-diff handles `false` schemas and switches to a single top-level merge (or a reused hook); re-run its suite and `docs/ANALYSIS.md` ISSUE-06-related timings.

Each milestone is independently releasable and keeps every existing test green except those whose expectation is changed by §5 (listed per milestone in the changelog).

## 8. Decisions (reviewed 2026-11-14)

1. **Unsatisfiable** is represented as the boolean schema `false` (default); an `unsatisfiable: "false" | "not-empty"` option allows `{ not: {} }` for draft-04 consumers.
2. **Pattern conjunction**: lookahead rewrite `^(?=[\s\S]*?(?:p1))(?=[\s\S]*?(?:p2))[\s\S]*$` after de-duplication; when a pattern contains lookbehinds or anchors the wrapper cannot handle safely, keep `allOf: [{ pattern: p1 }, { pattern: p2 }]`.
3. **`contains`**: multiple `contains` are kept as `allOf` fragments; `minContains`/`maxContains` take the tightest value.
4. **Branch budget**: default 1 024 combinations for `oneOf`/`anyOf` products inside one allOf, configurable via options; above the limit the node is returned unchanged and `onMergeError` is called (no throw, no hang).
5. **Cross-call reuse**: additive export `createMerger(options) → { merge, hook }` holding the resolution index and the memo for its lifetime; `merge()` and `allOfResolverHook()` keep their current signatures and semantics.
6. **Drafts**: add `"draft-07"` and `"2020-12"` to `JsonSchemaVersion`; the default stays `"draft-06"`; `selectMergeRules` is unchanged.
7. **Release**: a single `1.0.0` carrying the whole redesign (§5 output-contract changes, new drafts, `createMerger`), with M0–M5 as internal milestones on one branch.
8. **Execution**: implemented in the worktree `../allof-merge-redesign` (branch `redesign/1.0.0`, based on HEAD so the uncommitted `normalize.ts` change is dropped — M0) by a separate session, with `test/audit` as the acceptance suite; no commits until review.

## 9. Implementation notes (branch `redesign/1.0.0`, 2026-11-14)

### 9.1 What was implemented

All milestones M0–M5 landed on one branch as release `1.0.0` (the `version` field is left for the release commit). File layout:

- `src/resolve.ts` — `createResolutionIndex(source)` with `resolve($ref)` (direct target, cached per normalized ref, reasons `external` / `not-found` / `cycle`) and `resolvePointer(pointer)` (segment-by-segment walk that follows intermediate `$ref` nodes with the remaining segments and detects ref → ref cycles with an identity set). `src/pointer.ts` holds `parseRef` (with `basePath`), `createRef`, `parsePointer`, `buildPointer`, `pathMask`, `isRefNode`; `utils.resolvePointer` is a thin wrapper over the index.
- `src/merge.ts` — `createMerger(options) → { merge, hook }`; `merge()` and `allOfResolverHook()` are one-line wrappers. The hook has no `nodeToDelete`, no `findNodeToDelete`, no `buildPointer` in the hot path; the `{ allOf, ...sibling }` spread and the `{ $ref, ...rest }` split are cached per node instance; items are collected with an identity set (self-inclusion and duplicates skipped, nested allOf flattened, `true`/`{}` dropped, `false` kept); results are memoized per item-identity tuple (a trie of `Map`s) and a repeated tuple writes `state.node[key] = cached; return { done: true }`.
- `src/intersect.ts` — the engine (`intersect`, `findKeyRule`, `UNCHANGED`, and `jsonSchemaMergeResolver` as the synchronous compatibility export). Steps 1–6 of §4 as specified; the branch budget is checked before `mergeArray` runs.
- `src/groups/*` — `typeGroup`, `enumConstGroup`, `numericBoundsGroup`, `stringGroup`, `objectShapeGroup`, `arrayShapeGroup`, `dependenciesGroup`, plus `conditionalGroup` (`if`/`then`/`else`, not in §4, added for draft-07). Built-in rules are tagged with `group`; a group runs only when every present key of the group is tagged with it.
- `src/rules/*` — memoized per `(draft, custom)` identity, frozen, with `"draft-07"` and `"2020-12"`; `/not` has child rules; the OpenAPI tree gained `callbacks`, `webhooks`, `components.pathItems`, `components.callbacks`, parameter/header `content` and `encoding/*/headers/*/schema`; OpenAPI 3.1 schemas use the 2020-12 keywords.
- Tests: the 44 `test.failing` cases of `test/audit` are plain tests now; expectations changed by §5 carry a comment citing the row; `test/audit/b12.redesign.test.ts` (33 cases) covers the additive API. Whole suite: 22 files, 468 passed, 1 pre-existing skip (was 21 files, 434 passed, 1 skip); unchanged after the move to json-crawl 0.6.0. `ajv` is a devDependency.

### 9.2 Deviations from §4/§8 and why

1. **Lazy resolution index instead of an eager walk.** `createResolutionIndex` resolves a `$ref` on first use and caches it; nothing is pre-collected. The cache semantics are those of §4 (one parse and one resolution per distinct ref per `source` instance, index cached per `source` in a `WeakMap`), but the extra read-only pass of the whole document (+20–40 % on wide documents in the §3 estimate) is avoided.
2. **Schema-valued children are merged by the clone pass, not synchronously.** `properties[x]`, `items`, `additionalProperties`, `propertyNames`, `not`, `dependentSchemas[x]`, … become `{ allOf: [...] }` nodes that the hook merges on the way down with the rules of their location. This is why `onMergeError` reports the path of the conflicting child (B2.1.2) and why a `$ref` inside a merged child is now resolved (B6.3.3 changed its expectation; 0.x kept `{ $ref, maxLength }`, which draft-06/07 validators read as the bare `$ref`). `jsonSchemaMergeResolver(args, ctx)` stays exported as a synchronous engine call for custom rules.
3. **Broken `$ref` handling (AM-15).** §4 says "node returned unchanged"; the implementation keeps the node's siblings in place and its `allOf` array, but resolvable items inside that array are resolved and only the broken ones stay `{ $ref }`. This keeps B3.2.5 ("good refs next to a broken one are resolved", a 0.x pass) green while fixing the structure corruption of AM-15.
4. **Contradiction reporting inside combinaries.** A node that is itself a `oneOf`/`anyOf` branch does not report its contradiction (the branch is legitimately impossible, as in 0.x); when every branch of a combinary is unsatisfiable the combinary reports once at its own path. This needs one exit hook per `oneOf`/`anyOf` array (not per node), the only exit hooks besides the memo's.
5. **AM-25 kept as "equivalent impossible combination".** `minimum > maximum`, `minLength > maxLength` and `const ∉ enum` are not turned into `false`: the output is equivalent either way, and keeping the keywords preserves `title`/`description` and the other annotations of the node (the existing test "merges all allOf" relies on it). `type`, `enum`, `const` and boolean contradictions are reported and become `false`.
6. **One keyword table for draft-06, draft-07 and 2020-12.** `selectMergeRules` is unchanged (§8.6) and returns the draft-06 rules for plain JSON Schema documents, so a 2020-12 document merged with the defaults would still lose `prefixItems`/`dependentRequired` constraints if those keywords lived only in the `"2020-12"` table. Merging a keyword when it is present is always safer than last-wins, so the three modern drafts share one superset table; draft-04 keeps its own (boolean exclusive bounds, no `const`/`propertyNames`/`contains`/`$defs`). B6.3.1/B6.3.2 pass with the default rules.
7. **Exit hooks for the memo.** The output instance of a merged node is only known after the clone finished it, so memoized merges register one exit hook that records `state.node[key]`; a tuple met again while its first occurrence is still being cloned (a cycle through fresh wrappers) is written as `{ $ref: "#<pointer of the first occurrence>" }`, which reproduces the 0.x output of `test/merge.cycleRefs.test.ts › cross cycle refs` (a JSON pointer into the merged document) without any string fingerprint.
8. **Containers are rebuilt, members are shared (AM-27 level of 0.x).** A first version returned the single owner's `properties` object by instance; that made `merged.properties` and `merged.$defs.Node.properties` the same output object and api-smart-diff's traversal (`test/jsonSchema/refs-edge-cases.test.ts › B4.5`) looped forever. The groups therefore return a shallow copy of a single owner's `properties`/`patternProperties`/`items`, exactly like `getPropertiesForMerge` did. To keep repeated `$ref` usages cheap the hook recognizes such copies (`containerOrigin`) and, once the original or an earlier copy has been cloned, writes a shallow copy of the finished output and returns `done` instead of re-walking every member.
9. **`links` (AM-21).** Link objects carry no schema (their `parameters` are runtime expressions), so there is nothing to merge; no rule was added.
10. **`MergeContext.path`** was added (optional) so resolvers can see the node path; `MergeRule.group` as in §4.

### 9.3 Performance against §6 (same machine as `docs/ANALYSIS.md` B.1, Node 26.13, best of 3; scripts in the session scratchpad, not in the repo)

| Shape | 0.6.8 | 1.0.0 | Target | Result |
| --- | --- | --- | --- | --- |
| Wide 5 000 properties with allOf | 82.3 ms | 52.8 ms | ≤ 45 ms | miss by ~8 ms; ~55 % of the remaining time is json-crawl itself (`getNodeRules` copies the rules object for every node reached through `/*`, path arrays per node). A dictionary-mode rules object made that copy 15 µs instead of 0.15 µs; the rules are now built with `Object.fromEntries` to stay in V8 fast-properties mode (the single biggest win of this row). |
| Deep 1 000 levels with allOf | 1 679.6 ms | 45.3 ms | ≤ 80 ms | met (linear; clone alone is 31.8 ms) |
| 4 000 usages of one `$ref` | 401.7 ms | 47.6 ms | ≤ 40 ms | miss by ~8 ms, linear (12 µs per usage, all json-crawl per-node cost) |
| 1 000 usages × 1 000-property target | 6 492.5 ms | ≈ 550–610 ms | ≤ 150 ms | miss: each usage still copies its 1 000-key `properties` container twice (fast path + output). Sharing the container reaches the target but breaks api-smart-diff (9.2 item 8). 11× faster than 0.6.8. |
| Ring of 200 cyclic definitions | 64.5 ms | 4.3 ms | ≤ 20 ms | met |
| api-smart-diff every-node, depth 5 (4 778 nodes) | 109.4 ms vs 26.9 ms single | 49.0 ms per node, 19.4 ms with a reused `createMerger`, 8.2 ms single | ≈ single | 2.4× single with a reused merger (index and memo shared; each call still clones its subtree) |
| Cartesian `oneOf × anyOf` | m^k | unchanged, `branchBudget` 1 024 → `onMergeError`, node unchanged | | met |

Not asserted in Jest (machine dependent); `test/audit/b10.robustness.test.ts` guarantees termination and correctness for the same shapes.

### 9.4 Downstream check (api-smart-diff, `bun test`)

479 pass / 0 fail before and after, with the worktree `dist` copied over `node_modules/allof-merge/dist` (restored afterwards from the published 0.6.6 tarball). No diff expectation changed: the api-smart-diff suite does not exercise a property with an impossible schema, so the announced "dropped property → `false` schema" difference does not surface there. The only observable change during the check was the hang of 9.2 item 8, fixed on the allof-merge side. The §7 M5 consumer work (treating `false` schemas as unsatisfiable, switching to one top-level merge or a reused merger) remains to be done in api-smart-diff.

### 9.5 Open items

- The wide and 4 000-refs rows missed their targets by ~15–20 % with json-crawl 0.5.3; the per-node rules copy and path copy live in json-crawl. Against json-crawl 0.6.0 (single path build per node, `/*`-only rules returned by reference; built locally, not yet published) the same sources run the wide 5 000 row in 21 ms instead of 39 ms and the 4 000-refs row in 25 ms instead of 44 ms on the same machine in one session (best of 5, shapes rebuilt for the check, so the absolute numbers are not comparable with the table above), which puts both rows within their targets. allof-merge 1.0.0 requires json-crawl `^0.6.0` (see CHANGELOG).
- The 1 000 × 1 000 row needs either container sharing (unsafe for consumers that mutate results in place) or a cheaper container representation; left as is.
- `unevaluatedProperties`/`unevaluatedItems` are merged like `additionalProperties` (false wins, schemas conjoined), which is sound for the common usage but not for every annotation-dependent construction.
