# allof-merge 1.x — plain-schema performance design (2026-11-18)

Design only: no source file was changed for it. Requested after the benchmark (`benchmark/RESULTS.md`): on JSON Schemas without `$ref`, @fastify/merge-json-schemas and @x0k/json-schema-merge are faster than allof-merge 1.0.0. Every number below comes from esbuild bundles of `src` at commit d7cfe6f (json-crawl 1.0.0 `a8bab8a`), Node 26.13, Intel i9-9880H, min of 20 runs unless noted. Probe and prototype scripts are in the session scratchpad (`prof/cmp.mjs`, `prof/floor.mjs`, `prof/runcount.mjs`, `prof/analyze.cjs`, prototypes `exp/src`); they are not part of the repository.

## 1. Goal and gates

Make the merge of plain schemas (no `$ref`, many `allOf`) about 2× faster without changing any output, issue or option, and without slowing down the document workloads the 1.0.0 fast path already handles.

| Workload | 1.0.0 today | Gate | For reference |
|---|---:|---:|---|
| wide-2000 (2 000 × `allOf` of two object fragments) | 37.7 ms | ≤ 18 ms | @x0k 16.1 ms, @fastify 5.5 ms |
| combinators-100 (100 × `allOf` of three `oneOf`/`anyOf` groups) | 9.1 ms | ≤ 5 ms | @x0k 4.2 ms, @fastify 1.1 ms |
| corpus-586 (586 small real-world schemas, one `merge()` each) | 21.6 ms | ≤ 11 ms | @x0k 8.9 ms, @stoplight 29 ms |
| data.json (56 `allOf`, 6.5 KB) | 1.12 ms | ≤ 0.6 ms | 0.6.8 1.6 ms |
| deep-200, js-allof-200, gql-github, oas-github | 3.7 / 4.2 / 17.1 / 117 ms | no regression | |

Matching @fastify/merge-json-schemas is not a goal: it does not resolve `$ref`, has no document rule sets, records no issues, and throws on 23 % of the corpus (allof-merge: 0 %).

Hard constraints: identical output (deep-equal JSON and the same instance-sharing pattern, B9.2.17 / B22.1.4), identical issues and legacy callbacks, the full test suite and fuzz suite green, the D-11 / D-17 / D-22 / D-27 contracts unchanged.

## 2. Where the time goes

### 2.1 Floors (wide-2000)

| Operation | Time |
|---|---:|
| `structuredClone` of the merged-shape document (the output) | 7.2 ms |
| json-crawl `syncClone` of the output shape, no hook, no rules | 2.9 ms |
| json-crawl `syncClone` of the output shape, no-op hook, the draft-07 rules | 5.8 ms |
| json-crawl `syncClone` of the input, no-op hook, the draft-07 rules | 10.0 ms |
| `merge(input)` | 35.9 ms |
| `merge(mergedShape)` (everything clean: the fast path copies it) | 5.6 ms |

So with the current architecture 10 ms is spent before any merging happens (traversal of the input through json-crawl with hooks and rule resolution), and the merge work on top costs 26 ms for 4 000 conjunctions: 6.5 µs per conjunction. @x0k's whole run is 8 µs per property, @fastify's 2.7 µs.

### 2.2 Operation counts per wide-2000 merge (instrumented bundle)

| Counter | Total | Per property |
|---|---:|---:|
| hook visits (`visit`) | 20 003 | 10 |
| json-crawl rule resolutions (`resolveNodeRules`) | 32 002 | 16 |
| clean-subtree scans (`scan`) / scan frames | 12 002 / 14 002 | 6 / 7 |
| clean copies (`cleanCopy`) | 6 000 | 3 |
| `collectItems` / `intersect` / memo inserts / `simplifyMerged` | 4 000 each | 2 |
| keyword rule lookups in `intersect` (`knownKeyRule` → json-crawl `getNodeRules`) | 12 000 | 6 |
| keyword group resolutions | 8 000 | 4 |

The output has 7 objects per property; the engine visits 10 objects and builds about twice as many intermediate objects (merged values, lazy `{ allOf }` nodes, item lists, memo trie nodes, frames, json-crawl contexts) as it outputs.

### 2.3 CPU profiles (inclusive share of the samples inside `merge`, rounded)

| Part | wide-2000 | combinators-100 | corpus | data.json |
|---|---:|---:|---:|---:|
| json-crawl traversal outside the hook (`runSyncCrawl`, `advance`, `nextChild`, `resolveNodeRules`, exit hooks) | ~20 % | ~24 % | ~16 % | ~17 % |
| `intersect` (incl. keyword groups) | ~26 % | ~31 % | ~37 % | ~46 % |
| clean-subtree scan and copy of merged values | ~24 % | ~20 % | ~18 % | ~9 % |
| the rest of the hook: `collectItems`, `simplifyMerged`, frames, `popFrames`, done / active / memo maps | ~30 % | ~24 % | ~18 % | ~27 % |
| per-call setup (`createMerger`, `newCall`, settings; part of the row above for the corpus) | <1 % | <1 % | ~10 % | ~3 % |
| GC (allocation pressure from all of the above) | 15 % of the process | 8 % | 6 % | 5 % |

### 2.4 Prototypes that did not pay off

Both were measured with identical outputs on all eight workloads:

| Prototype | wide-2000 | combinators-100 | deep-200 | data.json | corpus | js-allof-200 | gql-github | oas-github |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| today | 37.7 | 9.1 | 3.67 | 1.12 | 21.6 | 4.23 | 17.1 | 117 |
| E2: memo of keyword rule lookups per `(rules object, key)` | 37.2 | 9.0 | 2.85 | 0.91 | 21.6 | 3.62 | 17.9 | 119 |
| E1 + E2: scan without per-call closures / sets, immediate answer for a node that needs work | 41.4 | 8.8 | 2.91 | 0.88 | 21.6 | 3.40 | 16.7 | 117 |

Local tuning of the hot functions gives at most 20 % on some workloads and nothing on the ones that matter. The cost is structural: every merged value is built, then visited again by json-crawl, scanned and copied a second time into the output, and each of those steps does several identity-map operations per object. The design therefore changes the structure, in two phases.

## 3. Root causes

1. **Merged values are copied twice.** `intersect` builds a fresh object; the hook returns it as `{ value }`; json-crawl crawls it and the clone step writes a new container per node; children that are input instances are scanned and copied once more by the fast path. Merged values are engine-owned and could be the output directly.
2. **Generic traversal for a known shape.** json-crawl resolves rules for every child (`resolveNodeRules`, 16 per property) by merging the exact, prefix, `/*` and `/**` rules, builds a context per node and runs the pre-hook / hook / clone-step chain. The engine's rule sets are frozen objects and constant thunks: the child rules of `(rules object, key)` never change.
3. **Per-visit identity bookkeeping.** Each visited object costs about ten Map / WeakMap / WeakSet operations: `done` lookup (twice), `active` set and delete, `scanned`, `unclean`, `containerOrigin`, `finished`, `outputCounts`, `recorded`, plus a `Frame` object and the `popFrames` holder walk. Values the engine just built (merged nodes, lazy `{ allOf }` nodes) can never be met a second time, so none of that is needed for them.
4. **`intersect` does a full generic pass for every conjunction.** A null-prototype `itemsMap` with one array per key, a group detection loop, `knownKeyRule` (json-crawl `getNodeRules`) per key, per-group `present` / `values` maps, a `MergeContext` object per per-key keyword, `safeSet` for every key. Most conjunctions are two or three items with a handful of keys.
5. **Per-call setup.** `merge()` creates a merger (about 80 closures and 15 weak maps) and a call state (20 collections, most of them used only by whole-document merges) for every call; for the corpus that is ~10 % of the merge time.

## 4. Phase 1 — engine-local changes (low risk)

Each item is independent, keeps json-crawl `syncClone` as the traversal, and is measured on its own (gate: no workload slower, identical output).

| # | Change | Removes | Estimate |
|---|---|---|---|
| 1.1 | **Compiled rule tables.** Per frozen rules object, a lazily built `Map<key, { rule, group, resolver, childRules }>`; `knownKeyRule` / `findKeyRule` read it (E2, generalized), and so does the new walker of phase 2. A rule set with function rules (custom rules) is compiled per key only where every candidate rule is an object or a thunk marked constant (the built-in `child` thunks get a `CONSTANT_RULE` marker); anything else falls back to `getNodeRules`. | rule resolution in `intersect` (6 per property) | −3 to −5 % wide, −15 % data.json |
| 1.2 | **Fresh values skip the bookkeeping.** Values the engine creates (merged nodes, lazy `{ allOf }` nodes, product branches) are registered in one `WeakSet` when created; `visit` treats a fresh object as "cannot recur, cannot be shared": no `done` / `active` / `scanned` entries, no memo key containing only fresh items, no `containerOrigin` lookup. `doneGet` is called once instead of twice. | 5–7 of the ~10 identity operations for half of the visited objects | −10 to −15 % wide / combinators |
| 1.3 | **`intersect` fast lane.** When the items have at most one owner per keyword group and no per-key keyword occurs twice (the common case: disjoint keywords, e.g. `type` + `properties` in one item, `required` in the other), the result is the union of the items' keys with the groups' single-owner copy rules (`copyContainer`, tuple copies), validated by the same validators; otherwise the current algorithm. One pass over the keys with the compiled table of 1.1, no `itemsMap`. | the generic pass for most conjunctions | −8 to −12 % wide, −15 % corpus |
| 1.4 | **Lazy call state and cheap `merge()`.** Whole-document-only collections (`sites`, `siteNodes`, `sitePositions`, `owners`, `shifts`, `rewritten`, `verified`, `unclean`) created on first use; `resolveMergeSettings` of the default options shared; the merger's caches allocated on first use; `asyncApi3` detection cached per resolution index (§3.8 of NORMALIZATION_DESIGN, not done in 1.0.0). | per-call setup | −6 to −9 % corpus |
| 1.5 | **Cheaper dedupe of small arrays.** `dedupeValues` / `dedupeCombinaryGroups` compare two or three values with `deepEqual` (identity first) instead of building `canonicalKey` strings. | `canonicalKey` in combinators (5 %) | −4 % combinators |

Phase 1 estimate: wide-2000 ≈ 27 ms, combinators-100 ≈ 6.5 ms, corpus ≈ 15 ms, data.json ≈ 0.7 ms. Not enough for the gates on its own, but it shrinks the hot paths phase 2 moves and is useful even if phase 2 is postponed. Effort 2–3 days.

## 5. Phase 2 — a dedicated walker for `merge` (structural)

Replace json-crawl `syncClone` inside `mergeWith` by an iterative walker written for the merge, which builds the output directly.

- **Work item:** `{ input, rules, holder, key, depth, parent }` on an explicit stack; the stack is the frame list (no separate `Frame` objects, no `popFrames` holder walk, no json-crawl contexts). The output path is built from the stack only when an issue is emitted or a pointer is needed (D-22 sites, cycle `$ref`s), as json-crawl's lazy paths do now.
- **Node kinds:** a clean input subtree → the shared clean copy (as now); an input node that needs work → collect items, intersect, and **adopt** the merged value as the output container (no second copy): its input-instance children are replaced in place by their outputs, its fresh children are walked; a container at a non-schema location → copied key by key with the child rules of 1.1.
- **Child rules:** from the compiled tables (1.1); custom function rules are called with a `{ key, path, value }` context like json-crawl does (the path built lazily), so custom rule semantics stay the same.
- **Everything else unchanged:** cycle detection (`active`), the done memo per rules, the tuple memo, inlining counts, taint, issue recording and replay, D-17 rounds and D-22 relink operate on the walker's entries instead of json-crawl frames; the exit hooks become post-order steps of the walker (`simplifyMerged`, the combinator check, memo completion).
- **`hook` / `allOfResolverHook`:** stay on the current json-crawl implementation for users who compose it with their own hooks (open question P1); `merge` and `merger.merge` use the walker. The test suite runs every audit file against both paths for one release (an internal switch like `engine.fastPath`), and a differential test compares them on the resources, the corpus and the bench fixtures.

Estimate: the traversal floor drops from ~10 ms to ~3 ms on wide-2000 (json-crawl without hooks and rules takes 2.9 ms for the output shape), the double copy of merged values disappears (~5 ms), per-visit bookkeeping halves: wide-2000 ≈ 14–17 ms, combinators-100 ≈ 4–5 ms, corpus ≈ 9–11 ms, data.json ≈ 0.4–0.5 ms; document workloads unchanged or slightly faster (their time is in the fast path's scan and copy). Effort 5–7 days including the differential tests. Risk medium–high: the link machinery (D-17, D-22, D-27) and instance sharing (D-11) are tied to json-crawl's clone order today; the differential test and the existing B16–B22 audit files are the safety net.

A prototype of the walker for the no-`$ref` path (fragment mode, no D-22) is the first step: it measures the estimate on wide-2000 / corpus before the link machinery is ported, and phase 2 stops there if it misses the gate.

## 6. Test plan

| # | Check |
|---|---|
| T1 | every phase-1 item: full suite + fuzz green, `cmp.mjs` on the eight workloads (identical JSON output, no workload slower than today) |
| T2 | phase 2: the audit suite (`test/audit`, `test/asyncapi`, `test/merge.*`) runs twice, walker and json-crawl path, with identical results |
| T3 | differential: walker vs json-crawl path on `test/resources`, the fuzz corpus, the asd bench fixtures (gql-github, oas-github, js-allof-200, aa2 / aa3 events, oas-petstore): deep-equal outputs, identical issue lists, identical `onMergeError` / `onRefResolveError` call sequences, identical instance-sharing pattern (the map from output objects to the input objects they came from) |
| T4 | the raw `hook` keeps passing B17 / B18 (hook-based tests) |
| T5 | benchmark rerun (`yarn benchmark speed`) and the gates of §1 |

## 7. Order and effort

1.1 → 1.2 → 1.4 → 1.3 → 1.5 (2–3 days, each measured) → walker prototype for fragment mode without `$ref` (1–2 days, go / no-go against the §1 gates) → full walker with the link machinery and the differential tests (4–5 days) → docs, CHANGELOG, benchmark rerun (0.5 day).

## 8. Open questions

P1. **Raw `hook` / `allOfResolverHook`.** With the walker, `merge` no longer runs through json-crawl. Options: (a) keep the hook on the current json-crawl implementation (two traversal paths to maintain, the hook keeps composing with other json-crawl hooks); (b) reimplement the hook as an adapter that runs the walker on the subtree and returns `{ value, done: true }` (one implementation, but other hooks no longer see the merged subtree's children); (c) deprecate the hook in 1.x and remove it in 2.0. Recommendation: (a) for 1.x, decide (b) / (c) for 2.0.

P2. **Timing.** Phase 1 changes no behaviour and can ship in 1.0.x; phase 2 is a larger internal change. Options: (a) phase 1 before the 1.0.0 release, phase 2 in 1.1.0; (b) both before 1.0.0; (c) only phase 1. Recommendation: (a).

P3. **Gate on wide-2000.** ≤ 18 ms is "about @x0k's speed with $ref resolution, rule sets and issues". Is that the right bar, or should the target be relative (e.g. 2× faster than 1.0.0 on every plain-schema workload)?
