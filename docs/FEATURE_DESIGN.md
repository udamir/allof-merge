# allof-merge 1.0.0 — feature design for D-12 (2026-11-17)

This document covers the four features that `docs/VERIFICATION.md` §7 left open as D-12: #222 (control over annotation promotion), #107 (AsyncAPI rule sets), safe simplifications, and a property-based equivalence test in CI. §8 of `docs/VERIFICATION.md` was the starting point. Each feature has a problem statement with a real example, two to four design options (API sketch, input → output, pros/cons), a recommendation, a test plan, an effort and risk estimate, and open questions phrased as decisions. §5 has the summary table and the decision list.

Unless marked "proposed", every output in this document was produced by the current `src/` (redesign branch, 2026-11-17) with probe scripts in `/tmp/amr-feat/` (`p222*.ts`, `p107.ts`, `p3*.ts`, `cex.mjs`, `fz.ts`, `fc.ts`). Outputs marked "prototype" come from a patched copy of `src/` in `/tmp/amr-feat/proto` (feature 1, option A, about 10 changed lines); the repository itself was not changed. Validator verdicts were checked with `@cfworker/json-schema` 4.1.6 and `@hyperjump/json-schema` 1.18.1 installed in `/tmp/amr-feat` only.

## 0. Consumers and why output form matters

| Consumer | Call | What it does with the result |
|---|---|---|
| api-smart-diff 1.x (`src/jsonSchema/jsonSchema.transform.ts:186`) | `merge(value, { rules: jsonSchemaMergeRules(draft), mergeCombinarySibling: true, mergeRefSibling: true })` on every schema node that is compared | diffs the merged before/after; every change of output form between the two sides is a diff (annotation diffs included) |
| api-smart-diff-redesign (`src/jsonSchema/jsonSchema.transform.ts`) | `createMerger({ source: root, rules, mergeCombinarySibling, mergeRefSibling })` cached per session under the key `ruleSetId|mergeRefSibling|mergeCombinarySibling` | same as above; has its own semantic layer (`jsonSchema.semantics.ts`: `isUnsatisfiable` with type-aware bounds, "a `oneOf` whose every branch has an identical twin", required + unsatisfiable property) and POLICY-40 (`false` = unsatisfiable response) |
| api-model-tree (behind api-doc-viewer / api-diff-viewer) | `merge(value, { source, mergeRefSibling: true, mergeCombinarySibling: true, rules })` | renders the merged node: `title`/`description` are shown to readers, `oneOf` branches become tabs labelled by their `title` |
| json-schema-tree | `merge(schema, {})` | tree view |
| code generators (#222 reporter: OpenAPI 3.1 → classes) | whole-document `merge(doc)` | a class per titled schema; a promoted `title` produces duplicate class names |

Two consequences recur below. First, the output form is part of the contract: a consumer that diffs merged output sees every form change as a change, so form changes after 1.0.0 should be opt-in. Second, api-smart-diff merges only nodes that carry `allOf` (and, with the sibling options, `$ref`/`oneOf`/`anyOf` siblings); a rewrite that the merge applies only to merged nodes makes a merged node and an equal hand-written node look different.

## 1. Feature 1 — #222: control over annotation promotion

### 1.1 Problem

Issue #222 (drpump, 2026-04-08, open, no comments): "We are using allof-merge to simplify our OpenAPI specifications (3.1.x). The merge will promote the title attribute of any referenced schema … multiple component schemas having the same title, and code generation consequently generates multiple classes with the same name and a numeric suffix … the merged schema is a new, different schema. Could we have an option to skip promotion of `title` attributes? It probably applies to all rulesets … The same could probably be said for `description`."

Input (OpenAPI 3.1, abbreviated):

```yaml
components:
  schemas:
    Base:
      title: Base
      description: Base entity
      type: object
      properties: { id: { type: string, title: Id } }
      x-go-name: BaseEntity
      examples: [{ id: "1" }]
      deprecated: true
    Other: { title: Other, description: Other one, properties: { x: { type: number } } }
    Derived: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: object, properties: { name: { type: string } } }] }
    Titled:  { title: Titled, allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { name: { type: string } } }] }
    Alias:   { allOf: [{ $ref: "#/components/schemas/Base" }] }
    Two:     { allOf: [{ $ref: "#/components/schemas/Base" }, { $ref: "#/components/schemas/Other" }] }
    RefSib:  { $ref: "#/components/schemas/Base", description: override }
    Prop:    { type: object, properties: { owner: { allOf: [{ $ref: "#/components/schemas/Base" }], description: The owner } } }
    OneOfT:  { oneOf: [{ $ref: "#/components/schemas/Base" }, { $ref: "#/components/schemas/Other" }], properties: { k: { type: string } } }
```

Current output (`merge(doc, { mergeRefSibling: true, mergeCombinarySibling: true })`, nested `properties` abbreviated):

| Schema | Current merged annotations |
|---|---|
| `Derived` | `title: Base`, `description: Base entity`, `x-go-name: BaseEntity`, `examples: [{id: "1"}]`, `deprecated: true` |
| `Titled` | `title: Titled` (own wins), `description: Base entity`, `x-go-name: BaseEntity`, `examples`, `deprecated` |
| `Alias` | identical to `Base` (incl. `title: Base`) |
| `Two` | `title: Other`, `description: Other one` (last wins), `x-go-name: BaseEntity` (only Base has it), `examples`, `deprecated` |
| `RefSib` | `title: Base`, `description: override` (own wins) |
| `Prop.owner` | `title: Base`, `description: The owner` |
| `OneOfT` branches | branch 0 `title: Base …`, branch 1 `title: Other, description: Other one` |

A code generator now sees four schemas titled `Base` (`Base`, `Derived`, `Alias`, `Prop.owner`) and two titled `Other`. `x-go-name` (and any `x-java-class`, `x-typescript-type` …) has the same effect for generators that name by vendor extension.

A custom rule cannot fix it today. In `intersect` a key present in only one item is copied without calling its resolver (`values.length === 1` shortcut), so `jsonSchemaMergeRules("2020-12", { "/title": { $: () => undefined } })` still yields `title: "B"` for `{ allOf: [{ $ref: "#/$defs/B" }, { type: object }] }`; with two owners the same resolver returns `undefined`, which the engine reads as a contradiction, and the whole node becomes `false` (verified). There is no way for a resolver to know where a value came from.

### 1.2 Terms: own and inherited annotations

The merged node of `{ <siblings>, allOf: [i1, …, in] }` gets keywords from three kinds of places:

| Source | Example | Proposed status |
|---|---|---|
| the node's own siblings | `Titled.title`, `Prop.owner.description` | own |
| inline `allOf` members (written in place, not via `$ref`) | `{ allOf: [{ title: A, type: object }, { title: B }] }` | own (the author wrote them here; today last wins → `B`) |
| siblings of a `$ref` item inside `allOf` | `{ allOf: [{ $ref: Base, title: Explicit }] }` | own |
| the target of a `$ref` item (and that target's own `allOf` members, recursively) | `Base.title` in `Derived` | inherited |

The engine already tracks exactly this distinction: `collectItems` marks every work item reached through a `$ref` as `inlined`, and since VR-36 / B15.3 it strips identity keywords (`$id`, `$anchor`, …) from such items through a cached, identity-stable copy (`withoutIdentity`). Inherited annotations are the same mechanism with a different key list.

Only the node-level keywords of an inlined target are affected: `Base.properties.id.title` ("Id") stays, because it is a value inside `properties`, not a keyword merged into the node.

### 1.3 Which keys

| Key | Nature | Promote by default today | In the proposed default omit list | Reason |
|---|---|---|---|---|
| `title` | naming annotation | yes | yes | the #222 case |
| `description` | annotation | yes | yes | the issue's second ask; the target's description describes the target |
| `$comment` | author note | yes (draft-07+) | yes | belongs to the target's source |
| `examples` / `example` | annotation | yes (mergeObjects) | no (listable) | an example of `Base` is often invalid for `Derived` (extra required fields), but doc viewers like to show it |
| `x-*` | vendor | yes (last wins) | no (listable as `"x-*"`) | some are naming (`x-go-name`), some semantic (`x-nullable`, `x-kubernetes-*`, `x-ms-enum`) |
| `deprecated` | annotation (OR) | yes | no (listable) | "extends a deprecated type" is usually still deprecated |
| `default` | annotation, used by codegen and by defaulting validators | yes | no | changes generated defaults |
| `readOnly` / `writeOnly` | annotation, but drives OpenAPI request/response semantics | yes | no | semantic in OpenAPI |
| `externalDocs`, `xml` | annotation / serialization | yes | no (listable) | `xml.name` renames the element, which is serialization, not just naming |
| `discriminator` | structural for OpenAPI codegen | yes | never | not an annotation |
| identity keywords | identity | no (since B15.3) | already omitted | unchanged |

### 1.4 Options

#### Option A — merge option `refAnnotations`

```ts
export type RefAnnotations = "merge" | "omit" | readonly string[]

export interface MergeOptions {
  // node-level annotations of $ref targets inlined into a merged node:
  // "merge" (default) = as today; "omit" = drop DEFAULT_OMITTED_ANNOTATIONS;
  // a list = drop these keys ("x-*" style entries are prefixes); the node's own keys always stay
  refAnnotations?: RefAnnotations
}

export const DEFAULT_OMITTED_ANNOTATIONS: readonly string[] = ["title", "description", "$comment"]
```

Implementation: in `collectItems`, `inlined ? withoutIdentity(item) : item` becomes `inlined ? withoutInherited(item) : item`, where `withoutInherited` drops identity keys plus the configured annotation keys, cached per input item like `withoutIdentity`. The option is also carried in `ResolvedMergeSettings`, so `mergeNested` (already `createMerger({ ...options })`) and a direct `jsonSchemaMergeResolver` call keep it.

Prototype output, `refAnnotations: "omit"` (same input and flags as §1.1):

| Schema | Prototype output (annotations) |
|---|---|
| `Derived` | no `title`/`description`; `x-go-name`, `examples`, `deprecated` still promoted |
| `Titled` | `title: Titled` only (own) |
| `Alias` | no `title`/`description` (the alias is named by its key) |
| `Two` | no `title`/`description` |
| `RefSib` | `description: override` (own), no `title` |
| `RefSibT` `{ allOf: [{ $ref: Base, title: Explicit }] }` | `title: Explicit` (sibling of the `$ref` item = own) |
| `Prop.owner` | `description: The owner` (own) |
| `Inline` `{ allOf: [{ title: A, type: object }, { title: B }] }` | `title: B` (unchanged; not via `$ref`) |
| `OneOfT` branches (`mergeCombinarySibling`) | branches lose `title: Base` / `title: Other` |

With `refAnnotations: ["title", "description", "$comment", "x-*"]` the `x-go-name: BaseEntity` disappears as well; `examples` and `deprecated` stay.

| Pros | Cons |
|---|---|
| Small (S): ~15 lines in `merge.ts` plus settings plumbing; the prototype passes the §1.1 cases | A global switch: the same policy for every node of the call |
| Reuses the identity-stripping path: identity-stable cached copies keep the tuple memo and output sharing correct | Does not help users with custom rule sets that want per-key logic beyond "drop" (no "keep the first", no "concatenate") |
| Additive, default unchanged: no output change for api-smart-diff, viewers, existing users | Strips annotations from `oneOf` branches built by `mergeCombinarySibling` too (viewer tab labels, see §1.5) |
| Covers vendor naming keys (`x-*`) without needing D-19 vendor rules | The key order of the merged node changes slightly (own `title` is written after the merged keys); harmless but visible in snapshots |
| Explicit semantics that are easy to document: "inherited = reached through `$ref`" | |

#### Option B — rule-level flag `inherit: false`

```ts
export type MergeRule = {
  $?: MergeResolver
  sibling?: string[]
  group?: string
  inherit?: boolean // false: the key is not taken from $ref-inlined items (default true)
}

// usage: custom rules, including D-19 vendor prefixes
jsonSchemaMergeRules("2020-12", {
  "/title": { $: last, inherit: false },
  "/description": { $: last, inherit: false },
  "/^": { "x-go-": { $: last, inherit: false } },
})
```

`collectItems` gets the node's `rules` and, for an inlined item, drops each key whose `findKeyRule(rules, key, path, value).inherit === false` (cached per item and rules object). Option A's `refAnnotations` can be implemented on top as a preset, or the two can coexist (the option overrides the rule).

| Pros | Cons |
|---|---|
| The general mechanism: works with custom rule sets, per location (e.g. inherit `description` in GraphApi args but not in OpenAPI components), combines with D-19 `"/^"` vendor-prefix rules | Rule sets are memoized and deep-frozen per `(draft, customRules)`; the OpenAPI/GraphApi sets nest the schema rules, so a user needs a new rule-set builder parameter to set the flag there (`openApiMergeRules("3.1.x", customSchemaRules)` does not exist today) |
| The memo is already per rules object (VR-33), so a flagged rule set never shares results with an unflagged one | One rule lookup per key of every inlined item (cached per item × rules; cheap but on the hot path) |
| No new top-level option | Harder to explain to the #222 reporter ("build a rule set") than a flag |

Example (proposed): with `"/title": { $: last, inherit: false }` in custom rules, `Derived` → no `title`, `description: Base entity` still promoted.

#### Option C — provenance for resolvers

Resolvers receive where each value came from and are called for single values when the rule asks for it.

```ts
export interface MergeContext {
  // … existing fields
  origins?: ("own" | "inline" | "ref")[] // parallel to the resolver's args
}
export type MergeRule = { $?: MergeResolver; sibling?: string[]; group?: string; always?: boolean } // always: call $ for a single value too
```

| Pros | Cons |
|---|---|
| Most expressive: "first `$ref` title wins", "concatenate descriptions", "keep own else drop" are all user code | Largest API surface; every resolver author has to understand origins |
| Fixes the documented gap that single-owner keys skip their resolver | `always` resolvers run for every node with that key (hot path); `undefined` still means contradiction, an easy trap (§1.1) |
| | Origins must travel through groups (`GroupContext`) as well, or grouped keys behave differently |

#### Option D — provenance in the output / "first `$ref` keeps title"

Two variants seen in other tools: keep the title of the first `$ref` (mokka json-schema-merge-allof is first-wins), or drop the inherited annotations and record where they came from, e.g. `"x-allof-merge-refs": ["#/components/schemas/Base"]`.

| Pros | Cons |
|---|---|
| First-wins is a one-line rule change | Does not solve #222: `Derived` is still titled `Base` |
| A provenance key lets viewers show "extends Base" | Adds a vendor key to every merged node: api-smart-diff would diff it (renamed base → spurious diff), and the output is no longer "the schema without `allOf`" |

#### Comparison

| Criterion | A option | B rule flag | C provenance | D output provenance |
|---|---|---|---|---|
| Solves #222 | yes | yes | yes (user code) | no / partly |
| Effort | S | S–M | M | S |
| Works with custom rule sets | yes (global) | yes (per key/location) | yes | yes |
| Default output change | none | none | none | yes (D2) |
| Hot-path cost | none when `"merge"` | small | medium | small |
| API surface | 1 option | 1 rule field | 2 fields + semantics | 1 key |

### 1.5 Interactions

- `mergeRefSibling`: `{ $ref: Base, description: override }` becomes `allOf: [{ $ref: Base }]` + own sibling; the target's `title` is inherited and dropped, the own `description` stays. This matches the issue's view ("the merged schema is a new schema").
- `mergeCombinarySibling` (and #137): the distributed branches are `{ allOf: [rest, { $ref: Base }] }`, so the branch's `title: Base` is inherited and dropped under A. For codegen this is right (the branch is a new anonymous schema); for doc viewers the branch tab label disappears. Two sub-options: (A1) treat the branch member as inherited like any other `$ref` (simple, consistent); (A2) treat the member a combinary branch came from as own (the engine marks the `allOf` nodes it creates in `distribute` in a `WeakSet` and reads the member as `nodeLevel`). #137 (root `title` lost under `mergeCombinarySibling`) is unchanged by both: the root's own title is pushed into every branch and the branch title wins; that stays as decided.
- Bare `$ref` whose pointer runs through an `allOf` member (`pointsIntoAllOf`, D-16): the engine inlines the target as a one-item `allOf` only to keep the pointer valid; that is a reference resolution, not a merge, so its annotations must be kept. The implementation passes a flag for this path (no stripping).
- Single-item `allOf: [{ $ref: X }]` (alias): stripped (`Alias` above). This is what codegen wants; a viewer would show the key name instead of the title.
- Cycles: a cycle re-entry is a `{ $ref }` to the source location, unaffected; the referenced original keeps its own title.
- Memo and sharing: the stripped copy is a different object from the original, cached per merger (like `identityFree`), so memo keys (`TupleMemo` over item identities) and the `done` map never mix a stripped and an unstripped result. The memo lives inside one `createMerger`, whose options are fixed, so the option is implicitly part of the key. Consumers that cache mergers must add the option to their own cache key (api-smart-diff-redesign: `ruleSetId|mergeRefSibling|mergeCombinarySibling` → add `|refAnnotations`). With option B the memo is already per rules object.
- Custom rules and groups: stripping happens before `intersect`, so groups and custom resolvers just do not see the dropped values; no resolver change.
- OpenAPI 3.0: `$ref` siblings are ignored by the 3.0 spec, which is why `mergeRefSibling` exists; nothing changes there. GraphApi: `description` is the main GraphQL annotation; dropping it from inlined interfaces is what "omit" means there too, which is why the default stays `"merge"`.

### 1.6 Recommendation

Option A in 1.0.0, default `"merge"` (no output change), default omit list `title`, `description`, `$comment`, lists with `"x-*"` prefixes allowed, combinary branches handled as A1 unless the user prefers A2. Option B stays a possible 1.1.0 extension (it also needs a schema-rules parameter on `openApiMergeRules`, which D-19 vendor rules want anyway). C and D are not recommended. The issue is the only open user-reported bug-like issue and the change is additive, so it can also slip to 1.1.0 without harm if 1.0.0 is frozen.

### 1.7 Test plan

| ID | Case | Expected |
|---|---|---|
| F1.1 | §1.1 document, default options | output identical to today (snapshot of the table in §1.1) |
| F1.2 | `refAnnotations: "omit"`, `Derived` / `Alias` / `Two` | no `title`, `description`, `$comment`; other promoted keys unchanged |
| F1.3 | own title / description next to `allOf` (`Titled`, `Prop.owner`) | own values kept |
| F1.4 | sibling of the `$ref` item (`RefSibT`) | kept |
| F1.5 | inline `allOf` members (`Inline`) | last wins as today |
| F1.6 | `refAnnotations: ["title", "x-*"]` | `title` and every `x-` key of the target dropped, `description` kept |
| F1.7 | nested target: `allOf: [{ $ref: A }]`, `A = { allOf: [{ $ref: B }, { title: A }] }` | both `A`'s and `B`'s titles dropped (both inlined) |
| F1.8 | nested property titles of the target (`Base.properties.id.title`) | kept |
| F1.9 | `mergeRefSibling` with `{ $ref, description }` | target title dropped, own description kept |
| F1.10 | `mergeCombinarySibling` `OneOfT` | per decision Q1-2 (A1: titles dropped; A2: kept) |
| F1.11 | bare `$ref` into an `allOf` member (D-16 path) | annotations of the target kept |
| F1.12 | memo isolation: one document merged with two mergers (`"merge"` and `"omit"`) and with one merger called twice | each result matches its own option; no instance shared between the two mergers |
| F1.13 | `createMerger` reuse across documents, `freezeOutput: true` | no mutation of cached stripped copies |
| F1.14 | cycle through `allOf` + `$ref` with `"omit"` | cycle `$ref` placeholder as today, serializable |
| F1.15 | OpenAPI 3.0 / 3.1 / GraphApi rule sets | same behaviour (option is rule-set independent) |
| F1.16 | equivalence (ajv/cfworker) of `"omit"` output vs input on the existing B-suite fixtures | always equivalent (annotations do not validate) |

### 1.8 Effort and risk

Effort S (prototype exists; plus settings plumbing, README, CHANGELOG, tests). Risk low: validation is unaffected by construction; the only risk is a missed path that inlines targets without the `inlined` flag (covered by F1.7, F1.11).

### 1.9 Open questions

- Q1-1 Ship in 1.0.0 or 1.1.0? Options: (a) 1.0.0 (recommended; small, additive); (b) 1.1.0.
- Q1-2 Combinary branches under `mergeCombinarySibling`: (a) A1 — strip like any inherited annotation (recommended, consistent, what codegen wants); (b) A2 — keep the branch member's annotations (viewer tab labels).
- Q1-3 Default omit list for `"omit"`: (a) `title`, `description`, `$comment` (recommended); (b) `title` only (the minimum the issue asks for); (c) (a) plus `examples`/`example` and `x-*`.
- Q1-4 Option name and shape: (a) `refAnnotations: "merge" | "omit" | string[]` (recommended); (b) `annotations: "merge" | "own"`; (c) boolean `omitRefTitle` (too narrow).
- Q1-5 Rule-level `inherit: false` (option B): (a) 1.1.0 together with a schema-rules parameter for `openApiMergeRules` / D-19 (recommended); (b) together with A in 1.0.0; (c) not at all.

## 2. Feature 2 — #107: AsyncAPI rule sets

### 2.1 Problem

Issue #107 (udamir, 2024-07-20, open, no body): "Rules for AsyncAPI 2.x". The README lists AsyncAPI 2.x and 3.x as roadmap. Today `selectMergeRules` has a commented-out AsyncAPI branch, so an AsyncAPI document falls through to `jsonSchemaMergeRules()` and is treated as one JSON Schema: only a root `allOf` would be merged, every `allOf` inside the document is left as it is.

Input (AsyncAPI 2.6):

```yaml
asyncapi: 2.6.0
channels:
  user/signedup:
    parameters:
      userId: { schema: { allOf: [{ type: string }, { minLength: 1 }] } }
    subscribe: { message: { $ref: "#/components/messages/UserSignedUp" } }
components:
  schemas:
    Base: { type: object, properties: { id: { type: string } } }
    User: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { name: { type: string } } }] }
  messages:
    UserSignedUp:
      payload: { allOf: [{ $ref: "#/components/schemas/User" }, { required: [id] }] }
      headers: { allOf: [{ type: object }, { properties: { h: { type: string } } }] }
    Avro:
      schemaFormat: application/vnd.apache.avro;version=1.9.0
      payload: { type: record, name: U, fields: [{ name: allOf, type: string }] }
```

Current output: identical to the input (no `allOf` merged anywhere); the same holds for an AsyncAPI 3.0 document. Proposed output: `userId.schema` → `{ type: string, minLength: 1 }`, `User` → `{ type: object, properties: { id, name } }`, `UserSignedUp.payload` → `{ type: object, properties: { id, name }, required: [id] }`, `headers` → `{ type: object, properties: { h } }`, the Avro payload untouched.

Who needs it: whole-document users (docs, codegen, `api-model-tree` if it gains AsyncAPI). api-smart-diff merges schema nodes itself with JSON Schema rules, so for it the practical gain is a shared, tested `schemaFormat` → rules mapping (api-smart-diff-redesign already has one: `asyncapi.schema.ts` `schemaDialect`, `bindingSchemaFields`).

### 2.2 Schema locations

| Location | 2.0–2.6 | 3.0 |
|---|---|---|
| `components.schemas.*` | Schema | Schema or Multi Format Schema Object (`{ schemaFormat, schema }`) |
| message `payload` | any; a Schema when the message `schemaFormat` is absent or an AsyncAPI / JSON Schema / OpenAPI format | Schema or Multi Format Schema Object |
| message `headers` | Schema (always AsyncAPI schema, `schemaFormat` applies to `payload` only) | Schema or Multi Format Schema Object |
| messages reached from | `channels.*.{publish,subscribe}.message` (a Message or `{ oneOf: [Message] }` — not a schema `oneOf`), `components.messages.*` | `channels.*.messages.*`, `components.messages.*` (`operations.*.messages` are `$ref`s only) |
| message traits | `components.messageTraits.*.headers`, `message.traits[*].headers`; a 2.x trait may carry `schemaFormat` | `components.messageTraits.*.headers`, `message.traits[*].headers` |
| channel parameters | `channels.*.parameters.*.schema`, `components.parameters.*.schema` | none (3.0 Parameter has `enum`/`default`/`examples`, no schema) |
| bindings (schema-valued fields) | `ws` channel `query`/`headers`, `http` operation `query` and message `headers`, `kafka` operation `groupId`/`clientId` and message `key`, `mqtt` message `correlationData`, `anypointmq` message `headers` — under `channels.*.bindings`, `*.bindings`, `components.*Bindings.*` | same fields, same places (3.0 bindings) |
| operation traits | `components.operationTraits.*`, `operation.traits[*]` (bindings only) | same |
| `components.channels` / `components.operations` / `replies` | 2.3+: `components.channels.*` (as channels) | `components.channels.*`, `components.operations.*`, `components.replies.*` (refs to messages) |
| servers, server variables, correlation ids, security schemes | no schemas | no schemas |

The binding field list follows the api-smart-diff-redesign table (POLICY-19 (b), ISSUE-139), so both libraries agree.

Schema dialect: the AsyncAPI 2.x and 3.0 Schema Object is a superset of JSON Schema draft-07 (plus `discriminator` as a string property name, `externalDocs`, `deprecated`). In allof-merge terms that is `jsonSchemaMergeRules("draft-07", { "/discriminator": …, "/oneOf"/"/anyOf" with sibling discriminator })`.

### 2.3 `schemaFormat` → rules

| `schemaFormat` (case-insensitive, `+json`/`+yaml` variants) | Rules for the schema |
|---|---|
| absent, `application/vnd.aai.asyncapi;version=2.x.y`, `application/vnd.aai.asyncapi+json;version=3.0.0` | AsyncAPI schema (draft-07 superset) |
| `application/schema+json;version=draft-07` / `draft-06` / `draft-04` / `2019-09` / `2020-12` | `jsonSchemaMergeRules(draft)` (2019-09 → the 2020-12 table) |
| `application/vnd.oai.openapi;version=3.0.x` | `openApiJsonSchemaMergeRules("3.0.x")` (draft-04 bounds, D-1 `nullable`) |
| `application/vnd.oai.openapi;version=3.1.x` | `openApiJsonSchemaMergeRules("3.1.x")` |
| Avro (`application/vnd.apache.avro…`), RAML (`application/raml+yaml…`), Protobuf (`application/vnd.google.protobuf…`), anything else | none: the value is copied unchanged (an Avro record with a field named `allOf` or a RAML type must never be read as a schema) |

In 2.x the format is a sibling of `payload` (message level), so the message rule is a json-crawl function rule that reads `value.schemaFormat` and returns `{ "/payload": rulesFor(format), "/headers": asyncApiSchema, … }`. In 3.0 the format is inside the Multi Format Schema Object, so the rule at every schema site is a function rule: a value with `schemaFormat` and `schema` gets `{ "/schema": rulesFor(value.schemaFormat) }`, any other value gets the AsyncAPI schema rules.

### 2.4 Detection

`selectMergeRules` gains `asyncapi: "2.<n>.<m>"` → `asyncApi2MergeRules`, `asyncapi: "3.<n>.<m>"` → `asyncApi3MergeRules` (an unknown 3.x minor uses the 3.0 tree), other values → JSON Schema rules as today. Only own string `asyncapi` members count (like `openapi`).

### 2.5 Options

#### Option A — full document rule sets plus auto-detection

```ts
export const asyncApiVersion = ["2.x", "3.x"] as const
export type AsyncApiVersion = typeof asyncApiVersion[number]

export const asyncApi2MergeRules: () => MergeRules // memoized, frozen
export const asyncApi3MergeRules: () => MergeRules
export const asyncApiMergeRules: (version?: AsyncApiVersion) => MergeRules
// schema rules for one AsyncAPI schema, also for per-node consumers (api-smart-diff)
export const asyncApiSchemaMergeRules: (schemaFormat?: string) => MergeRules | undefined // undefined = not a mergeable format
```

Sketch of the 2.x tree (abbreviated):

```ts
const schema = asyncApiSchemaMergeRules()!                     // draft-07 + discriminator
const bindings: MergeRules = { "/*": (({ key }) => bindingRules(key)) }  // ws/http/kafka/mqtt/anypointmq fields → schema
const message: MergeRules = ({ value }) => ({
  "/payload": asyncApiSchemaMergeRules(value?.schemaFormat) ?? EMPTY_RULES,
  "/headers": schema,
  "/traits": { "/*": { "/headers": schema, "/bindings": bindings } },
  "/bindings": bindings,
})
const operation: MergeRules = { "/message": { ...message, "/oneOf": { "/*": message } }, "/bindings": bindings, "/traits": { "/*": { "/bindings": bindings } } }
const channel: MergeRules = { "/parameters": { "/*": { "/schema": schema } }, "/publish": operation, "/subscribe": operation, "/bindings": bindings }
return freezeRules({
  "/channels": { "/*": channel },
  "/components": {
    "/schemas": { "/*": schema }, "/messages": { "/*": message }, "/parameters": { "/*": { "/schema": schema } },
    "/messageTraits": { "/*": { "/headers": schema } }, "/channels": { "/*": channel },
    "/channelBindings": { "/*": bindings }, "/operationBindings": { "/*": bindings }, "/messageBindings": { "/*": bindings }, "/serverBindings": { "/*": bindings },
  },
})
```

(The function rule at `/message` must not carry `/allOf` itself, so the message-level `oneOf` is never treated as a schema `oneOf`, and `mergeCombinarySibling` never distributes into it.)

| Pros | Cons |
|---|---|
| `merge(asyncDoc)` works like `merge(openapiDoc)`: README roadmap delivered, both 2.x and 3.0 | Medium effort: two rule trees, the binding table, `schemaFormat` parsing, fixtures |
| `schemaFormat` handled in one tested place; non-JSON-Schema payloads are never touched | Changes the output of `merge(asyncDoc)` from "unchanged" to "merged" (only relevant if anyone calls it today; nothing is merged now, so nothing can depend on a merged form) |
| Additive exports; no change for JSON Schema/OpenAPI/GraphApi | The binding list is protocol-specific and evolves with the bindings repository; unknown bindings stay untouched |
| `asyncApiSchemaMergeRules(format)` is reusable by api-smart-diff for per-node merges | |

#### Option B — rule sets exported, no auto-detection

Same exports, but `selectMergeRules` keeps returning JSON Schema rules for AsyncAPI documents; users pass `rules: asyncApiMergeRules("3.x")`.

| Pros | Cons |
|---|---|
| No change for anyone who does not opt in; auto-detection can be added in a later major | `merge(asyncDoc)` silently stays a no-op, which is surprising next to OpenAPI auto-detection |
| Same effort as A minus a few lines | Two ways to merge depending on the spec, worse docs |

#### Option C — schema rules only

Only `asyncApiSchemaMergeRules(schemaFormat)` (plus `isMergeableSchemaFormat`), no document trees.

| Pros | Cons |
|---|---|
| Small (S); covers the per-node consumers (api-smart-diff) and the hard part (`schemaFormat`) | Does not close #107 for whole-document users; they must write the tree themselves |
| No document-structure maintenance | |

#### Version: 2.x only, 3.0 only, or both

| Choice | Pros | Cons |
|---|---|---|
| 2.x only (the issue's title) | smallest | 3.0 (2023) is current; a 2.x-only release looks dated |
| 3.0 only | current spec | most AsyncAPI documents in the wild are still 2.x |
| both (recommended) | shared schema rules and `schemaFormat` code; one release, one README section | about 1.5× the work of one |

### 2.6 Edge cases

- `allOf: [{ $ref: "#/components/schemas/Mf" }]` where `Mf` is a 3.0 Multi Format Schema Object: inlining `{ schemaFormat, schema }` as if it were a schema would be wrong. The engine leaves such an item as `{ $ref }` (fragment) and reports it, unless the format is the default AsyncAPI one, in which case it inlines `Mf.schema` (needs a small hook: the AsyncAPI rules expose an "unwrap" function for `$ref` targets; or simpler, keep the `$ref` and report — decision Q2-4).
- Traits are not applied: AsyncAPI says traits are merged into the message (JSON Merge Patch); that is not an `allOf` and stays out of scope. Schemas inside traits are merged in place.
- A 2.x trait carrying `schemaFormat` that differs from the message's: out of scope (the message's own `schemaFormat` decides; documented).
- `discriminator` is a string in AsyncAPI (OpenAPI: object): rule `{ $: last }` plus `sibling: ["discriminator"]` for `oneOf`/`anyOf` (like the OpenAPI rules).
- An OpenAPI-format payload uses the OpenAPI 3.0 `nullable` semantics (D-1, D-13) and draft-04 bounds; this is the main reason not to merge every payload with AsyncAPI rules.
- `$ref` resolution: AsyncAPI refs are `#/components/...` JSON pointers; external refs are left as they are (as for OpenAPI).

### 2.7 Recommendation

Option A, both 2.x and 3.0, in 1.1.0. Nothing about it needs a major version: the exports are additive and the only behaviour change is that `merge(asyncDoc)` starts merging, which today produces the input unchanged. To make the 1.1.0 change formally clean, the 1.0.0 README can state "AsyncAPI documents are not merged yet (returned unchanged); 1.1.0 adds auto-detection". If the user prefers maximal stability, Option B for 1.1.0 and auto-detection later.

### 2.8 Test plan

| ID | Case | Expected |
|---|---|---|
| F2.1 | §2.1 document (2.6) | payload, headers, parameter schema, `components.schemas` merged; Avro payload byte-identical |
| F2.2 | same content as 3.0 (channels.messages, Multi Format Schema Object with default format) | merged inside `schema`; the wrapper keeps `schemaFormat` |
| F2.3 | `schemaFormat: application/schema+json;version=draft-04` payload with boolean `exclusiveMinimum` | draft-04 bounds semantics |
| F2.4 | OpenAPI 3.0 format payload with `nullable` | D-1 semantics (same output as the OpenAPI 3.0 rules) |
| F2.5 | Avro, RAML, Protobuf (string payload), unknown format, non-string `schemaFormat` | untouched |
| F2.6 | 2.x `message: { oneOf: [M1, M2] }` with `mergeCombinarySibling: true` | not distributed (not a schema `oneOf`); schemas inside M1/M2 merged |
| F2.7 | bindings: kafka `key`, http `query`, ws `headers`, unknown binding with an `allOf` | known fields merged, unknown binding untouched |
| F2.8 | message traits `headers` | merged |
| F2.9 | `discriminator` string next to `oneOf` with `mergeCombinarySibling` | kept as a sibling, not pushed into branches |
| F2.10 | `$ref` to a Multi Format Schema Object inside `allOf` | per Q2-4 |
| F2.11 | detection: `asyncapi: "2.0.0"`, `"2.6.0"`, `"3.0.0"`, `"3.1.0"`, `"1.2.0"`, non-string, inherited `asyncapi` | 2.x / 2.x / 3.x / 3.x / JSON Schema / JSON Schema / JSON Schema |
| F2.12 | real documents: AsyncAPI examples repository (streetlights 2.6 and 3.0, slack-rtm, gitter-streaming) | no throw, equivalent schemas (validator check per merged schema node), idempotent |
| F2.13 | `createMerger` reuse of the same document with AsyncAPI and JSON Schema rules | memo per rules object, results not mixed |

### 2.9 Effort and risk

Effort M (≈ 250 lines of rules and helpers, ≈ 40 tests, fixtures from the AsyncAPI examples repository). Risk low for existing users (additive), medium for AsyncAPI users only in the binding table (incomplete lists leave schemas unmerged, never wrong) and in `schemaFormat` parsing (a misdetected format would merge a non-JSON-Schema payload: mitigated by the allow-list approach — only known JSON-Schema-like formats are merged).

### 2.10 Open questions

- Q2-1 Version: (a) 1.1.0 (recommended); (b) 1.0.0.
- Q2-2 Scope: (a) 2.x and 3.0 together (recommended); (b) 2.x first, 3.0 later; (c) 3.0 only.
- Q2-3 Auto-detection in `selectMergeRules`: (a) yes, in the same release (recommended; today's output for AsyncAPI documents is the unchanged input); (b) exports only, detection in 2.0.
- Q2-4 `$ref` to a Multi Format Schema Object inside `allOf`: (a) keep `{ $ref }` and report (recommended for the first version, no engine change); (b) unwrap the default-format wrapper.
- Q2-5 Bindings: (a) the five-protocol field list shared with api-smart-diff-redesign (recommended); (b) no bindings at all (simpler, binding schemas stay unmerged).

## 3. Feature 3 — safe simplifications

### 3.1 Problem

The merge keeps every equivalent but redundant form it produces. Three real outputs of the current code:

```yaml
# identical oneOf groups (e.g. a bundler inlined two copies of the same external schema)
in:  { allOf: [{ oneOf: [S, N, B] }, { oneOf: [S, N, B] }, { oneOf: [S, N, B] }] }   # S/N/B = {type: string|number|boolean}
out: { oneOf: [S, false, false, false, false, false, false, false, false, false, false, false, false, N, false, …, B] }  # 27 branches, 24 false
# six copies of a 4-branch group: 4096 combinations > branchBudget 1024 → the node is left unmerged + onMergeError
in:  { allOf: [G, G, G, G, G, G] }   # G = { oneOf: [string, number, boolean, null] }
out: unchanged, "Could not merge combinaries: 4096 combinations exceed the branch budget of 1024"
# a contradiction that is kept as keywords
in:  { allOf: [{ type: number, minimum: 15 }, { maximum: 10 }] }
out: { type: number, minimum: 15, maximum: 10 }   # no value is valid; not reported
```

Five copies of G merge into 1 024 branches of which 4 are not `false`. Simplifications would make such outputs smaller and make impossible schemas visible as `false`. The catch is that several "obvious" rules are not equivalences, and every form change shows up as a diff for consumers that diff merged output.

### 3.2 Diff impact, in general

- Same library version on both sides: a deterministic rewrite is applied to before and after alike, so it does not create a diff by itself. It can change which diff is reported: a contradiction collapsed to `false` turns "`maximum` 10 → 20" into "`false` replaced by a schema" (one coarse `replaced` diff instead of a keyword diff), and it removes the node's `title`/`description` (DESIGN_PROPOSALS §9.2 item 5 kept bounds for exactly this reason).
- Merged vs not merged: api-smart-diff merges only nodes with `allOf` (or the sibling cases). If before is `{ type: number, minimum: 15, maximum: 10 }` (written) and after is the same split into `allOf`, today both compare equal; with a "bounds → `false`" rewrite inside the merge, after becomes `false` and a spurious `replaced` diff appears. A rewrite that is only applied to merged nodes breaks this symmetry; dedupe rules do not, because a written schema has no product branches to dedupe.
- Across library versions: a consumer that stores merged output (snapshots, cached normalized documents, api-diff-viewer exports) and compares it with output of a newer allof-merge sees every default form change as a change. 1.0.0 already changes the output contract versus 0.6.8, so a default rewrite costs nothing extra now and costs a contract change later.
- Consumers already have their own semantic layer: api-smart-diff-redesign's `isUnsatisfiable` covers type-aware bounds, empty enum, all-false combinaries, `oneOf` identical twins and required + unsatisfiable properties, and is applied to every node, merged or not. Duplicating it inside the merge adds little for that consumer.

### 3.3 Candidates

Notation: "safe" means equivalent for every instance under the draft's semantics including annotation-dependent keywords (`unevaluated*`); "verdict" is the proposal.

| ID | Rule | Current output (real) | Proposed output | Safe? | Verdict |
|---|---|---|---|---|---|
| S1 | dedupe structurally equal `anyOf` branches | `{ anyOf: [S, S], minLength: 1 }` kept | `anyOf: [S]` | yes | default (1.0.0) |
| S1' | dedupe equal `oneOf` branches | `{ oneOf: [S, N, S] }` kept | — | **no** | never |
| S2 | dedupe structurally equal `allOf` fragments | `allOf: [{contains: N}, {contains: S}, {contains: N}]` | `allOf: [{contains: N}, {contains: S}]` | yes | default |
| S3 | dedupe equal `oneOf`/`anyOf` groups before the product | 27 / 1024 branches, budget overflow | `oneOf: [S, N, B]` | yes | default |
| S4a | `contains: true` / `{}` → dropped | `{ type: array, contains: true }` | — | **no** | never |
| S4b | `contains: true` / `{}` (no `minContains`/`maxContains`) → `minItems: max(1, minItems)` | same | `{ type: array, minItems: 1 }` | only without `unevaluatedItems` in scope (draft-07 rules) | opt-in |
| S4c | `contains: false` → `false` when `type` is array-only and no `minContains: 0` | `{ type: array, contains: false }` | `false` | yes (with the guards) | opt-in |
| S5 | filter `enum`/`const` by `type` | `{ type: string, enum: [a, 1, null] }`, `{ type: null, const: 0 }` | `{ type: string, enum: [a] }`, `false` | yes | opt-in |
| S6a | numeric/length/count bounds contradiction → `false` when `type` admits only the matching kind | `{ type: number, minimum: 15, maximum: 10 }` | `false` | yes | opt-in |
| S6b | same, multi-type → remove the kind from `type` | `{ type: [number, string], minimum: 15, maximum: 10 }` | `{ type: string }` | yes | opt-in |
| S6c | same, untyped → `false` | `{ minimum: 15, maximum: 10 }` | — | **no** | never (at most a report) |
| S7 | required + `false` property → `false` when `type` is object-only | `{ type: object, properties: { a: false }, required: [a] }` | `false` | yes; untyped **no** | opt-in (typed only) |
| S8 | `if` without `then`/`else` dropped | `{ type: string, if: { minLength: 3 } }` | `{ type: string }` | draft-07 yes, 2019-09+ **no** | not recommended |
| S9 | redundant inclusive/exclusive bounds (draft-06+) | `{ minimum: 5, exclusiveMinimum: 3, maximum: 10, exclusiveMaximum: 10 }` | `{ minimum: 5, exclusiveMaximum: 10 }` | yes | opt-in |
| S10 | drop `false` branches of `oneOf`/`anyOf` | `{ oneOf: [S, false, false, N] }` | `{ oneOf: [S, N] }` | yes | opt-in (CHANGELOG promises they stay) |
| S11 | `oneOf`/`anyOf` whose every branch is `false` → node `false` | `{ oneOf: [false, false] }` (reported) | `false` | yes | opt-in |

#### S1 / S1' — duplicate branches

S1 proof: `anyOf` is a disjunction, `A ∨ A ∨ B ≡ A ∨ B`. Annotations: in 2019-09+ `anyOf` collects annotations of every valid branch; a duplicate contributes the same annotations, so `unevaluated*` sees the same set. Structural equality (`deepEqual`, already in `utils.ts`) implies semantic equality because allof-merge resolves every `$ref` against the same `source` (no per-subschema base URI).

S1' counterexample (verified with cfworker and hyperjump, draft 2020-12): `{ oneOf: [S, N, S] }` rejects `"a"` (two branches valid), `{ oneOf: [S, N] }` accepts it. `oneOf [A, A, B] ≡ ¬A ∧ B`. api-smart-diff-redesign uses exactly this fact ("every branch has an identical twin → unsatisfiable"). Never dedupe `oneOf` branches.

#### S2 — duplicate `allOf` fragments

Proof: conjunction is idempotent, `A ∧ B ∧ A ≡ A ∧ B`; each `allOf` member is evaluated independently, also with its own `unevaluated*` (D-8 fragments), so duplicates add nothing. Applies to every fragment kind (`contains`, `if`/`then`/`else`, `pattern`, `format`, object shapes, `multipleOf`, `$ref` fragments by string equality). Today identical `$ref` targets are already deduped by identity in `collectItems`; S2 adds structural equality for fragments only (not for the items before merging, where it would not change the result).

#### S3 — duplicate groups before the product

Proof: `oneOf(G) ∧ oneOf(G) ≡ oneOf(G)` (idempotence of `∧`, for any schema `X ∧ X ≡ X`); the same for `anyOf`. Groups equal as multisets (`[S, N]` vs `[N, S]`) are also equal (`oneOf`/`anyOf` are order-insensitive), but order-insensitive comparison is optional. Must run before `countCombinations`, so the budget counts the deduplicated product: the six-copy case above merges into 4 branches instead of overflowing. Diff impact: only outputs that contained such products change, and those were the 1 024-branch forms nobody wants to diff.

#### S4 — `contains` collapse

S4a counterexample: `{ type: array, contains: true }` rejects `[]` (`contains` needs at least one matching item), `{ type: array }` accepts it. The VERIFICATION §8.3 recommendation "`contains: true|{}` → drop" is wrong and must not be implemented.

S4b proof: with no `minContains`/`maxContains`, `contains: true` ⇔ "length ≥ 1" for arrays and vacuous for non-arrays, which is exactly `minItems: 1`. Counterexample in 2020-12: `{ contains: true, unevaluatedItems: false }` accepts `[1]` (the `contains` annotation marks the item as evaluated), `{ minItems: 1, unevaluatedItems: false }` rejects it; the `unevaluatedItems` can also sit in a parent schema that sees the annotation through `allOf`/`$ref`. Safe only where `unevaluatedItems` does not exist: the draft-04/06/07 rule sets. The shared draft-06/07/2020-12 keyword table does not know the draft today; the builder does (`buildJsonSchemaMergeRules(draft)`), so the flag can be passed in.

S4c proof: for an array, `contains: false` needs one item valid against `false`, impossible, so every array is rejected; with `type` array-only every instance is rejected. Guards: `minContains: 0` (2019-09+) makes `contains` vacuous (`{ type: array, contains: false, minContains: 0 }` accepts `[]` and `[1]`, verified); without `type` the schema accepts every non-array (equivalent rewrite would be `not: { type: array }`, a form change not worth it).

#### S5 — `enum`/`const` filtered by `type`

Proof: an instance must satisfy both `type` and `enum`; a member whose JSON type is not admitted can never validate, so removing it does not change the valid set; an empty result is `false` (an empty `enum` is invalid in draft-06+ meta-schemas anyway). `integer` admits numbers with zero fractional part (`2.0` is `2` in JavaScript). OpenAPI 3.0 rules use the effective type set including `null` when `nullable: true` (D-1); GraphApi rules (`nullable` OR, untagged) are excluded. Diff impact: `{ type: string, enum: [a, 1] }` → `enum: [a, 2]` changes are hidden when they only touch filtered members; that is semantically right but differs from the written schema's diff (asymmetry, §3.2).

#### S6 — bounds contradictions

S6c counterexample (verified): `{ minimum: 15, maximum: 10 }` accepts `"x"`; `false` does not. Bounds restrict only instances of their kind (numbers, strings, arrays, objects).

S6a proof: if `type` admits only numbers (`number` and/or `integer`) and the interval `[minimum, maximum]` (with exclusive bounds, `exclusiveMinimum ≥ exclusiveMaximum` etc.) is empty, no instance is valid. For `integer` the interval must also contain an integer (`{ type: integer, exclusiveMinimum: 1, exclusiveMaximum: 2 }` → `false`, verified). The same for `minLength > maxLength` with `type: string`, `minItems > maxItems` with `type: array`, `minProperties > maxProperties` or `required.length > maxProperties` with `type: object`, `minContains > maxContains`. `multipleOf` interplay (`{ type: integer, multipleOf: 2, minimum: 3, maximum: 3 }`) is a further rule, not proposed.

S6b proof: with `type: [number, string]` and an empty numeric interval, no number is valid, so `type: string` (the bound keywords may stay or go) is equivalent. Diff impact: the type list changes, which api-smart-diff reports as a type change.

#### S7 — required property that must be absent

Proof: with `type` object-only, `required: [a]` needs `a` present and `properties.a: false` rejects any value of `a`; nothing is valid. Untyped counterexample (verified): `{ required: [a], properties: { a: false } }` accepts `"x"`. Extensions (same proof): `required` name not in `properties`, no `patternProperties`, `additionalProperties: false` — needs pattern matching only when patterns exist (bounded by `matchPatterns`).

#### S8 — `if` without `then`/`else`

`if` alone never affects validity in draft-07, so dropping it is safe there. Counterexample in 2020-12 (verified with hyperjump and cfworker): `{ if: { properties: { a: true } }, unevaluatedProperties: false }` accepts `{ a: 1 }` (the `if` annotations count as evaluated), without the `if` it rejects; the same through a parent `{ allOf: [{ if: … }], unevaluatedProperties: false }`. Value is low (authors rarely write it); not recommended.

#### S9 — redundant inclusive/exclusive bounds (draft-06+)

Proof: `x ≥ m ∧ x > e` equals `x > e` when `e ≥ m` and `x ≥ m` when `e < m`; the same for the upper side. Draft-04 is already a single bound with a flag. Diff impact: the keyword that carries the bound can switch (`minimum` ↔ `exclusiveMinimum`) when one side changes, which api-smart-diff reports as a removed + added keyword instead of a value change.

#### S10 / S11 — `false` branches

S10 proof: a `false` branch is never valid, so it never counts for `oneOf` ("exactly one") nor for `anyOf`; annotation-free. S11 proof: all branches `false` → no instance valid; written as `contradiction(sibling)` (keeps container siblings, D-10). Diff impact: branch indexes shift; api-smart-diff matches `oneOf`/`anyOf` branches by similarity, not index, but viewers and stored outputs see a different array. The current output contract states "An impossible `oneOf`/`anyOf` branch stays in the array as `false` … Consumers that want pruning can filter `false` branches", so S10 as default would revert a documented 1.0.0 decision (AM-08).

### 3.4 Delivery options

#### Option A — a small default set in 1.0.0 (S1, S2, S3), the rest not implemented

| Pros | Cons |
|---|---|
| Only pure dedupes: provably safe, symmetric for consumers (a written schema has nothing to dedupe), fixes real budget overflows | Contradictions stay invisible inside the merge (consumers detect them, as api-smart-diff-redesign does) |
| In 1.0.0 the form change is free (the contract changes anyway); later it would not be | |
| Cheap: `deepEqual` only where at least two groups/fragments of one kind exist | |

#### Option B — A as default plus an opt-in `simplify` option (1.0.0 or 1.1.0)

```ts
export interface SimplifyOptions {
  enumByType?: boolean        // S5
  contradictions?: boolean    // S6a/S6b, S7, S4c, S11 (type-guarded only)
  redundantBounds?: boolean   // S9
  pruneBranches?: boolean     // S10
  containsToMinItems?: boolean // S4b, ignored by the 2020-12 / OpenAPI 3.1 rule sets
}
export interface MergeOptions {
  simplify?: boolean | SimplifyOptions // true = every rule above; default false
}
```

Example (proposed), `simplify: true`: `{ allOf: [{ type: [number, string], minimum: 15 }, { maximum: 10, enum: ["a", 12, 20] }] }` → `{ type: string, enum: ["a"] }`; without the option → `{ type: [number, string], minimum: 15, maximum: 10, enum: ["a", 12, 20] }` (equivalent).

| Pros | Cons |
|---|---|
| Users who want compact output (codegen, docs) get it; diffing consumers keep the default | More code on the hot path when enabled (each rule a few lines in its group) and more rules to prove and test |
| Opt-in rules can be added in minor versions without contract changes | The asymmetry of §3.2 remains for diffing consumers who enable it (documented) |
| Each rule individually switchable | `false` loses the node's annotations (`title`, `description`) |

#### Option C — a separate `simplify()` export applied to any schema

`simplify(schema, { rules, source })` walks a schema (merged or not) and applies the opt-in rules to every schema node; `merge` keeps only the default dedupes.

| Pros | Cons |
|---|---|
| Symmetric for diffing consumers: they can run it on every node of both sides | A second pass (cost ≈ one clone of the document) |
| Keeps `merge` focused; reusable `isUnsatisfiable`-style helpers | A second public API to maintain; overlaps with api-smart-diff-redesign's semantics module |

### 3.5 Recommendation

Option A in 1.0.0: S1 (`anyOf` only), S2 and S3 as default behaviour, announced in the CHANGELOG output-contract section. The type-guarded rules (S4b/S4c, S5, S6a/S6b, S7, S9, S10, S11) go into an opt-in `simplify` option (Option B) in 1.1.0, or in 1.0.0 if the user wants them at once; they are additive and safe to ship later because they are off by default. Never implement S1' (`oneOf` dedupe), S4a (`contains: true` drop), S6c / untyped S7 (untyped collapse). S8 is not worth it. This corrects VERIFICATION §8.3, which listed "`contains: true|{}` → drop" as safe and "filter `enum`/`const` by `type`" and typed bound contradictions as default candidates.

### 3.6 Test plan

| ID | Case | Expected |
|---|---|---|
| F3.1 | `anyOf: [S, S]` (input) and `anyOf` products with equal results | deduped, first-seen order |
| F3.2 | `oneOf: [S, N, S]` | unchanged (S1' guard), equivalence check |
| F3.3 | `allOf` fragments `[{contains: N}, {contains: S}, {contains: N}]`, equal `if`/`then` triples, equal `pattern` fragments, equal `{ $ref }` fragments | deduped |
| F3.4 | 3 × `oneOf [S, N, B]`; 6 × G (4 branches) | `oneOf: [S, N, B]`; 4 branches, no budget report |
| F3.5 | groups equal up to order `[S, N]` / `[N, S]` | per Q3-3 |
| F3.6 | budget accounting: 5 distinct groups of 4 + 1 duplicate | budget counts 1 024, not 4 096 |
| F3.7 | (opt-in) S4b in draft-07 rules; same input in 2020-12 rules | `minItems: 1`; unchanged in 2020-12 |
| F3.8 | (opt-in) S4c with and without `minContains: 0`, with and without `type` | `false` only for the guarded case |
| F3.9 | (opt-in) S5 string / integer (`1.5`, `2`) / OpenAPI 3.0 `nullable` + `null` member / GraphApi excluded / empty result → `false` | as specified |
| F3.10 | (opt-in) S6a number, integer interval without integer, string lengths, array counts, `required.length > maxProperties`; S6b multi-type; S6c untyped unchanged | as specified |
| F3.11 | (opt-in) S7 typed → `false`, untyped unchanged | |
| F3.12 | (opt-in) S9 four combinations of inclusive/exclusive on each side | tighter bound kept |
| F3.13 | (opt-in) S10/S11 with container siblings (`$defs`) | `{ allOf: [false], $defs }` (D-10) |
| F3.14 | every case above through the property-based oracle (feature 4) with the rule switched on | equivalent |
| F3.15 | the counterexamples of §3.3 as regression tests (`oneOf` twins, `contains: true` with `unevaluatedItems`, `if` with `unevaluatedProperties`, untyped bounds) | the rule is not applied |

### 3.7 Effort and risk

Option A: S (three dedupe sites: `mergeArray` values in `intersect`, `allOfFragments` in `intersect`, fragment lists in the groups). Option B: M (each rule S, about eight rules with guards and tests). Risk: A low; B medium — soundness bugs are exactly what the guards and counterexamples above are about, which is why feature 4 should land before or with B.

### 3.8 Open questions

- Q3-1 Default set for 1.0.0: (a) S1 (`anyOf`), S2, S3 (recommended); (b) none (keep 1.0.0 as is); (c) (a) plus S10 false-branch pruning (reverts the AM-08 contract line).
- Q3-2 Opt-in rules: (a) `simplify` option in 1.1.0 (recommended); (b) in 1.0.0; (c) a separate `simplify()` export (Option C); (d) not at all, leave to consumers.
- Q3-3 Group equality for S3: (a) order-sensitive `deepEqual` (recommended, cheaper, output order stable); (b) order-insensitive multiset equality.
- Q3-4 Untyped bound contradictions (S6c): (a) keep silently (recommended, as today); (b) report through `onMergeError` (a warning for a satisfiable schema, noisy for api-smart-diff which forwards reports).

## 4. Feature 4 — property-based equivalence test in CI

### 4.1 Problem

The only unsound class found after the 468-test suite (VR-10/11, `patternProperties × additionalProperties`) came from random fuzzing in scratch harnesses (`/tmp/amr-verify/fuzz.ts`, `fuzz2.ts`, the replay in `/tmp/amr-replay`), which are not in the repository. Nothing guards future keyword changes (features 1–3 included) against regressions of that kind.

The existing oracle is ajv 8.20 (`test/audit/helpers.ts`), which is wrong for `contains` next to tuple `items`. Minimal reproduction (verified): `{ items: [{ type: "string" }], contains: true }` validates `[]` as `true` with ajv 8.20.0; the correct result is `false` (cfworker, hyperjump and schemasafe agree). Every ajv-only mismatch in the replay was this bug (70 + 33 cases), so ajv alone cannot be the oracle of an automatic test.

### 4.2 Oracle

| Validator | Version / licence | Runtime deps | API | Module | Drafts | Measured on 2 944 fuzz pairs (draft-07, 35 instances) |
|---|---|---|---|---|---|---|
| ajv | 8.20.0, MIT | 4 | sync, compiles code | CJS | 04 (ajv-draft-04), 06, 07, 2019-09, 2020-12 | 10 false mismatches (`contains` bug), 6.0 s |
| @cfworker/json-schema | 4.1.6, MIT | 0 | sync, interpreter | CJS + ESM | 4, 7, 2019-09, 2020-12 (no 6) | 0 mismatches, 1.9 s |
| @hyperjump/json-schema | 1.18.1, MIT | 7 (`uuid`, `content-type`, `just-curry-it`, `@hyperjump/uri`, `/pact`, `/json-pointer`, `/json-schema-formats`) | async (`registerSchema` + `await validate`) | ESM only | 04, 06, 07, 2019-09, 2020-12, OpenAPI 3.0 / 3.1 / 3.2 dialects | 0 mismatches on 487 pairs, ≈ same speed as cfworker |
| @exodus/schemasafe | 1.3.0, MIT | 0 | sync, compiles code | CJS | 4, 6, 7, 2019-09, 2020-12 | refused 1 630 of 2 944 schemas ("Unexpected rules in type") even with `mode: "spec", allowUnusedKeywords: true` |

Further facts checked: cfworker treats draft-07 `$ref` siblings as ignored (correct for draft-07); supports draft-04 boolean exclusive bounds, `prefixItems`, `unevaluatedProperties`, `dependentSchemas`, `minContains`. Hyperjump's OpenAPI 3.0 dialect agrees with D-1/D-13 (`{ allOf: [{ type: string, nullable: true }, { type: string }] }` rejects `null`, `{ allOf: [{ type: string, nullable: true }, { minLength: 1 }] }` accepts it) — the only independent oracle for the OpenAPI 3.0 rules. Hyperjump loads with `require()` under Node 26 but not inside Jest 29's module registry (ESM-only), so it fits a Node script, not the Jest suite.

Proposed oracle: cfworker as the primary oracle in Jest (sync, zero dependencies, CJS); draft-06 profiles validated with cfworker `"7"` and a generator that does not emit draft-07-only keywords; ajv kept as a second opinion (a case counts as a failure only if cfworker reports it; an ajv-only disagreement is logged, not failed); hyperjump in the nightly script for the OpenAPI 3.0 profile and as a tie-breaker.

### 4.3 Generator

#### Option A — fast-check arbitraries

```ts
import fc from "fast-check"
const leaf = fc.oneof(
  fc.record({ type: fc.constantFrom("string", "number", "integer", "object", "array", "null") }),
  fc.record({ minLength: fc.nat(3) }), fc.record({ maxLength: fc.nat(3) }),
  fc.record({ pattern: fc.constantFrom("^a", "b", "^[ab]+$") }),
  fc.record({ minimum: fc.integer({ min: -2, max: 4 }) }), /* … per profile */
  fc.constant(true), fc.constant(false), fc.constant({}),
)
const { schema } = fc.letrec((tie) => ({
  schema: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("allOf"), tie("props"), tie("items"), tie("comb"), tie("not")),
  allOf: fc.record({ allOf: fc.array(tie("schema"), { minLength: 2, maxLength: 4 }) }),
  props: fc.record({ properties: fc.dictionary(fc.constantFrom("a", "b"), tie("schema"), { maxKeys: 2 }), additionalProperties: tie("schema") }, { requiredKeys: ["properties"] }),
  items: fc.record({ items: tie("schema") }),
  comb: fc.record({ anyOf: fc.array(tie("schema"), { minLength: 1, maxLength: 3 }) }),
  not: fc.record({ not: tie("schema") }),
}))
fc.assert(fc.property(fc.record({ allOf: fc.array(schema, { minLength: 2, maxLength: 4 }) }), sameVerdicts), { seed, numRuns })
```

Measured (prototype `/tmp/amr-feat/fc.ts`): 2 000 runs in 1.6 s against `src`, no failure. With an injected bug (`maxLength` merged with `Math.max`) fast-check fails after 369 runs and prints `{ seed: 42, path: "368:0:0:0:0:6:3:6:5:5:5:5:5:5:5:5" }` plus a counterexample shrunk 15 times: `{"allOf":[{"required":["a"]},{"allOf":[{"allOf":[{"maxLength":1},{},true]},{"allOf":[{"maxLength":0},true,{}]},{"required":["a"]},{"minItems":0}]}]}` → merged `{"maxLength":1,"required":["a"],"minItems":0}`. The shrink is useful but not minimal (`{}`, `true`, `required` noise remain), so a small post-shrink minimizer (below) is still worth it.

| Pros | Cons |
|---|---|
| Shrinking, seed + path replay, reporting, `numRuns`, `endOnFailure` for free | devDependency (1.5 MB + `pure-rand` 236 KB, MIT, CJS export available, Node ≥ 12.17) |
| Arbitraries are declarative and easy to extend per keyword/profile | `letrec` shrinking of deep schemas leaves noise; arbitraries for `$ref`/`definitions` need custom code |

#### Option B — hand-written seeded generator (as `/tmp/amr-verify/fuzz2.ts`)

A mulberry32 PRNG, a weighted leaf table and a depth-bounded `node(d)`; own delta-debugging minimizer.

| Pros | Cons |
|---|---|
| No dependency; the existing scratch generators found VR-10/11 | Shrinking, replay and reporting must be written (≈ 100 lines) |
| Full control over `$ref`/`definitions` generation and option combinations | Less readable than arbitraries; easy to bias without noticing |

#### Option C — corpus replay plus a small random run

Commit the interesting inputs of the replay corpora (`/tmp/amr-replay`: mokka/stoplight, hypothesis, x0k, qubership, json-schema-intersect, datamodel-code-generator, oasdiff, ≈ 1 100 cases) as fixtures and replay them with the oracle; add A or B for new random cases.

| Pros | Cons |
|---|---|
| Deterministic, covers real-world shapes the generators would not invent | Fixtures to maintain (≈ 1–2 MB JSON); a corpus never finds new classes on its own |

Proposal: A + C. fast-check for the random part, a committed corpus of the minimized replay cases, and a 40-line minimizer that, after fast-check's shrink, greedily removes `allOf` members, object keys and array elements while the mismatch persists.

#### Keyword coverage and profiles

| Profile | Rules | Validator | Extra keywords beyond the common set |
|---|---|---|---|
| draft-04 | `jsonSchemaMergeRules("draft-04")` | cfworker `"4"` | boolean `exclusiveMinimum`/`exclusiveMaximum`, no `const`/`contains`/`propertyNames` |
| draft-07 | `"draft-07"` | cfworker `"7"` | `const`, `contains`, `propertyNames`, `if`/`then`/`else`, tuple `items` + `additionalItems`, `dependencies` |
| 2020-12 | `"2020-12"` | cfworker `"2020-12"` | `prefixItems`, `minContains`/`maxContains`, `dependentRequired`/`dependentSchemas`, `unevaluated*` (D-8 fragments) |
| OpenAPI 3.0 (nightly) | `openApiJsonSchemaMergeRules("3.0.x")` | hyperjump OpenAPI 3.0 dialect | `nullable`, `format` lattice (D-2/D-14) |
| refs (each profile) | `source` = `{ definitions/$defs: … }` | same | `$ref` items, ref → ref chains, cycles (output must be serializable; cycle `$ref`s are validated against the source by registering the root) |

Common set: `type` (incl. arrays and `integer`), numeric bounds, `multipleOf` (2, 3, 0.5), `minLength`/`maxLength`, `pattern` (from a small safe list incl. anchored and unanchored), `enum`/`const` (mixed types incl. `null`, `[1]`, `{a:1}`), `required`, `properties`, `patternProperties`, `additionalProperties` (schema and `false`), `minProperties`/`maxProperties`, `items`, `minItems`/`maxItems`, `uniqueItems`, `not`, `oneOf`, `anyOf`, nested `allOf`, `true`/`false`/`{}`, annotations (`title`, `description`, `x-a`) that must not change validity. Options generated per case: `mergeCombinarySibling`, `mergeRefSibling`, `refAnnotations` (feature 1), `simplify` (feature 3).

### 4.4 Instances

Per case: a fixed pool (`null`, booleans, `0`, `1`, `1.5`, `2`, `3`, `-1`, `""`, `"a"`, `"b"`, `"ab"`, `"ba"`, `"abc"`, `[]`, `[1]`, `["a"]`, `[1, 2]`, `[1, "a", 3]`, `{}`, …) plus values derived from the schema: every numeric literal `n` → `n - 1`, `n`, `n + 0.5`, `n + 1`; every length/count `L` → strings, arrays and objects of size `L - 1`, `L`, `L + 1`; every `enum`/`const` member; every property name of `properties`/`required`/`dependencies` combined singly and in pairs with pool values (the existing `objectInstances` of `test/audit/b14.oracle.ts`); strings matching each `pattern` from a per-pattern sample list. Typical size 60–200 instances. Property: every instance gets the same verdict from the original and the merged schema. Additional invariants checked on the same cases: no throw; `JSON.stringify` succeeds (no cycles); `merge(merge(x))` is equivalent to `merge(x)` (idempotence); no `allOf` remains unless it is a documented fragment kind; `onMergeError` is never called for a case without a contradiction or limit (checked loosely: a report implies the merged schema differs from a plain conjunction).

### 4.5 Seeds and budget

| Run | Seeds | Cases | Measured / estimated time |
|---|---|---|---|
| PR / push CI (Jest, every Node in the matrix) | fixed (one per profile, e.g. 1, 2, 3) | 700 per profile, ≈ 2 100 total | ≈ 2–4 s (2 000 fast-check runs measured 1.6 s; 3 000 hand-generated cases with 35 instances 1.9 s of validation + 0.3 s merging) |
| Corpus replay (Jest) | — | ≈ 1 100 | ≈ 1–2 s |
| Nightly (GitHub Actions `schedule`, Node script) | random, printed | 50 000 per profile incl. OpenAPI 3.0 via hyperjump | ≈ 1–2 min |
| Local | `FUZZ_SEED`, `FUZZ_RUNS`, `FUZZ_PATH` env | any | — |

A fixed seed keeps PR CI deterministic (no flaky red builds); new seeds come only from the nightly job, whose failures are turned into fixed regression tests.

### 4.6 Failure reporting

A failure prints: profile, seed, fast-check path, options, the minimized original, the merged output, the first differing instance with both verdicts, the ajv verdict, and a one-line replay command (`FUZZ_SEED=… FUZZ_PATH=… yarn test:fuzz`). The nightly job uploads the failing cases as a JSON artifact and fails the workflow. Known validator bugs are kept in an allowlist (`test/fuzz/known-oracle-issues.ts`, e.g. the ajv `contains` case) and only apply to ajv's second opinion.

### 4.7 Layout

```
test/fuzz/arbitraries.ts        // fast-check arbitraries per profile (leaf tables, letrec, $ref sources)
test/fuzz/instances.ts          // fixed pool + schema-derived values (moves objectInstances out of b14.oracle.ts)
test/fuzz/oracle.ts             // cfworker wrapper per profile, ajv second opinion, allowlist
test/fuzz/minimize.ts           // greedy post-shrink minimizer
test/fuzz/equivalence.test.ts   // Jest: fixed seeds per profile + invariants
test/fuzz/corpus.test.ts        // Jest: replay of test/fuzz/corpus/*.json
test/fuzz/corpus/*.json         // minimized replay cases
scripts/fuzz-nightly.mjs        // Node script: random seeds, hyperjump OpenAPI 3.0 profile, artifact output
.github/workflows/fuzz.yml      // schedule + workflow_dispatch
```

`package.json`: `"test:fuzz": "jest test/fuzz"`, `"fuzz:nightly": "node scripts/fuzz-nightly.mjs"` (needs a build or ts-node for `src`).

### 4.8 Dev-dependency cost

| Package | Size on disk | Deps | Needed for |
|---|---|---|---|
| `@cfworker/json-schema` | 648 KB | 0 | oracle (Jest) |
| `fast-check` + `pure-rand` | 1.5 MB + 236 KB | 1 | generator (Option A) |
| `@hyperjump/json-schema` | 1.3 MB + 7 small deps | 7 | nightly OpenAPI 3.0 oracle (optional) |

All MIT, devDependencies only: no runtime or bundle impact; the README's "no dependencies" statement concerns runtime dependencies. Each new devDependency is one more Dependabot stream (VR-51).

### 4.9 Recommendation

Include in 1.0.0 (no runtime impact, protects the release and features 1 and 3): Option A + C, cfworker as oracle with ajv as logged second opinion, fixed seeds in PR CI (≈ 5 s budget), nightly random run with hyperjump for OpenAPI 3.0. If the user prefers zero new devDependencies besides the oracle, Option B + C with cfworker only.

### 4.10 Test plan

| ID | Case | Expected |
|---|---|---|
| F4.1 | oracle self-test: the ajv `contains` reproduction | cfworker `false`, ajv `true`, allowlisted |
| F4.2 | injected bug (test-only rule set with `maxLength` merged by max) | the property fails within the PR run budget and the minimizer reduces it to ≤ 3 `allOf` members |
| F4.3 | each profile with its fixed seed | green; runtime within budget |
| F4.4 | replay determinism: same seed twice | same cases, same result |
| F4.5 | corpus replay | green (intentional differences — D-2, D-6, D-8 fragments — are equivalent by construction) |
| F4.6 | invariants (no throw, serializable, idempotent) | green |
| F4.7 | nightly script locally with `FUZZ_RUNS=1000` | green, artifact empty |

### 4.11 Effort and risk

Effort M (≈ 400 lines of test code plus corpus import and workflow). Risk: flaky CI (mitigated by fixed seeds), oracle bugs (two validators, allowlist), long runtimes on Node 18 in the matrix (budget by case count, measured on the slowest Node).

### 4.12 Open questions

- Q4-1 Generator: (a) fast-check + committed corpus (recommended); (b) hand-written generator + corpus (no fast-check dependency); (c) corpus only.
- Q4-2 Oracle: (a) cfworker primary, ajv logged second opinion (recommended); (b) cfworker and ajv both must agree with the merge (needs the allowlist to stay green); (c) hyperjump primary (ESM/async, Node script instead of Jest).
- Q4-3 Nightly job: (a) yes, with the hyperjump OpenAPI 3.0 profile (recommended); (b) no, PR CI only; (c) on demand (`workflow_dispatch`) only.
- Q4-4 PR CI budget: (a) ≈ 5 s (≈ 2 000 random + corpus, recommended); (b) ≈ 30 s (≈ 15 000 random).

## 5. Summary

| Feature | Recommended option | Version | Effort | Risk |
|---|---|---|---|---|
| 1. #222 annotation promotion | A: `refAnnotations: "merge" \| "omit" \| string[]`, default `"merge"`, omit list `title`/`description`/`$comment`; rule-level `inherit: false` later | 1.0.0 (B in 1.1.0) | S | low |
| 2. #107 AsyncAPI | A: `asyncApi2MergeRules`, `asyncApi3MergeRules`, `asyncApiSchemaMergeRules(schemaFormat)`, auto-detection, both 2.x and 3.0, non-JSON-Schema formats untouched | 1.1.0 | M | low |
| 3. Simplifications | A: default S1 (`anyOf` dedupe), S2 (fragment dedupe), S3 (group dedupe before the product) in 1.0.0; opt-in `simplify` for the type-guarded rules; never S1', S4a, S6c, untyped S7 | 1.0.0 (default set), 1.1.0 (opt-in) | S (A) / M (B) | low / medium |
| 4. Property-based CI test | A + C: fast-check + corpus, cfworker oracle (ajv second opinion), fixed seeds in PR CI, nightly random + hyperjump OpenAPI 3.0 | 1.0.0 (test-only) | M | low |

Corrections to `docs/VERIFICATION.md` §8: "`contains: true|{}` → drop" is unsound (counterexample `[]`; even `→ minItems: 1` is unsound in 2020-12 next to `unevaluatedItems`); "dedupe identical branches" must exclude `oneOf` (counterexample `"a"` against `oneOf: [S, N, S]`); enum filtering and typed bound contradictions are sound but change the output form and are therefore proposed as opt-in, not default.

Decisions for the user (details in each feature's open questions):

| ID | Decision | Recommended |
|---|---|---|
| Q1-1 | #222 in 1.0.0 or 1.1.0 | 1.0.0 |
| Q1-2 | `mergeCombinarySibling` branches: strip inherited annotations (A1) or keep the branch member's (A2) | A1 |
| Q1-3 | default omit list | `title`, `description`, `$comment` |
| Q1-4 | option name/shape | `refAnnotations: "merge" \| "omit" \| string[]` |
| Q1-5 | rule-level `inherit: false` | 1.1.0 with a schema-rules parameter for `openApiMergeRules` |
| Q2-1 | AsyncAPI version | 1.1.0 |
| Q2-2 | AsyncAPI scope | 2.x and 3.0 together |
| Q2-3 | auto-detection | yes, same release |
| Q2-4 | `$ref` to a Multi Format Schema Object inside `allOf` | keep `{ $ref }` + report |
| Q2-5 | bindings | five-protocol list shared with api-smart-diff-redesign |
| Q3-1 | default simplifications in 1.0.0 | S1 (`anyOf`), S2, S3 |
| Q3-2 | opt-in simplifications | `simplify` option in 1.1.0 |
| Q3-3 | group equality | order-sensitive |
| Q3-4 | untyped bound contradictions | keep silently |
| Q4-1 | generator | fast-check + corpus |
| Q4-2 | oracle | cfworker primary, ajv logged |
| Q4-3 | nightly job | yes, with hyperjump OpenAPI 3.0 |
| Q4-4 | PR CI budget | ≈ 5 s |

## Decisions (2026-11-17)

| Question | Decision |
|---|---|
| Q1-1 #222 release | 1.0.0 — option `refAnnotations: "merge" \| "omit" \| string[]`, default `"merge"` (output unchanged). |
| Q1-3 omit list | `"omit"` drops `title`, `description`, `$comment` that arrive only through a `$ref`; the schema's own values always stay. |
| Q1-2 branch titles with `mergeCombinarySibling` | Keep branch titles: a `oneOf`/`anyOf` branch that is a `$ref` keeps the referenced schema's annotations (doc viewers use them as tab labels); only node-level inherited annotations are dropped. |
| Q1-5 rule-level `inherit: false` | 1.1.0. |
| Q2-1 / Q2-2 AsyncAPI | 2.x and 3.0 together, in 1.0.0. |
| Q2-3 auto-detection | Same release (follows from Q2-1). |
| Q2-4 `$ref` to a 3.0 `{schemaFormat, schema}` wrapper inside `allOf` | Unwrap when the schemaFormat is AsyncAPI / JSON Schema (merge the inner `schema`); other formats (Avro, Protobuf, RAML, unknown) keep the `$ref` + `onMergeError`. |
| Q2-5 bindings | Merge schema fields of the known protocols (ws, http, kafka, mqtt, anypointmq — same list as api-smart-diff); unknown protocols untouched. |
| Q3-1 always-safe simplifications | All four — dedupe identical `anyOf` branches, dedupe identical kept `allOf` parts, dedupe repeated `oneOf`/`anyOf` groups before the product, drop `false` branches of `oneOf`/`anyOf` — each as its own option, default `true`. Dropping `false` branches replaces the documented "impossible branches stay as `false`" contract (now the default-off alternative). |
| Q3-2 form-changing simplifications | `simplify` option in 1.0.0 (default off): enum/const filtered by type, typed bound contradictions → `false`, multi-type kind removal, typed required + `false` property → `false`, `contains:false` with array-only type → `false`, `contains:true`/`{}` → `minItems` only without `unevaluatedItems` in scope, redundant inclusive/exclusive bounds. Never: `oneOf` branch dedupe, untyped contradiction collapse, `if` without `then`/`else` drop. |
| Q3-3 group equality | Order-sensitive (minor, self-decided per recommendation). |
| Q3-4 untyped bound contradictions | Keep silently, no report. |
| Q4-1 property-based test | fast-check + committed corpus; oracle `@cfworker/json-schema`, ajv logged only. |
| Q4-2 oracle | cfworker primary, ajv logged (follows from Q4-1). |
| Q4-3 / Q4-4 CI | ≈ 5 s per PR (≈ 2 000 random pairs + corpus); no nightly job. |

## Implementation status (2026-11-17)

| Feature / decision | Status | Where | Notes |
|---|---|---|---|
| Q1-1, Q1-3, Q1-4 `refAnnotations` | implemented | `src/merge.ts` (`withoutInherited`, `DEFAULT_OMITTED_ANNOTATIONS`), `src/types.ts` | Option A: inherited items stripped through a cached copy (identity-stable memo keys) together with the identity keywords; the key list accepts `*`-suffixed prefixes; tests B19 |
| Q1-2 branch titles | implemented | `distribute` marks the branch member of each distributed `{ allOf: [rest, branch] }` | a `$ref` branch keeps its target's annotations; a branch of a `oneOf`/`anyOf` product (two groups multiplied) is a new schema and loses them (self-decided); a D-22 copy is a reference resolution and keeps the target's annotations (F1.11), the target's own `$ref` members are inherited |
| Q1-5 `inherit: false` | not implemented | — | 1.1.0 |
| Q2-1 … Q2-3 AsyncAPI 2.x / 3.0, auto-detection | implemented | `src/rules/asyncapi.ts`, `selectMergeRules` | tests `test/asyncapi/*` (149) |
| Q2-4 `$ref` to a Multi Format Schema Object | implemented | `collectItems` (`unwrapSchemaFormat`, AsyncAPI 3.x sources only) | AsyncAPI / JSON Schema formats unwrapped; OpenAPI, Avro, Protobuf, RAML, unknown, non-string formats and wrappers without `schema` keep `{ $ref }` + `onMergeError` (once per wrapper and node); works with the link rules (a pointer into the inner schema is linked or copied) and the rules-keyed memo |
| Q2-5 bindings | implemented | `asyncApiBindingSchemaFields` | ws, http, kafka, mqtt, anypointmq |
| Q3-1 four safe simplifications | implemented | options `dedupeAnyOf`, `dedupeFragments`, `dedupeCombinaryGroups`, `dropFalseBranches` (default `true`) | S3 in `intersect` before the product is counted, S2 in `intersect` and the fragment lists of `merge.ts`, S1/S10/S11 when a node's subtree is finished; S1/S10 also on not-merged nodes with `oneOf`/`anyOf` (such nodes count as rewritable for the link rules; a branch holding a pointer target of the call's output keeps its index); all branches impossible → `contradiction()` (D-10), reported once by the branch array; tests B20.1–B20.4 |
| Q3-2 `simplify` | implemented | `src/simplify.ts`, option `simplify: boolean \| { enumByType, contradictions, redundantBounds, containsToMinItems }` (default off) | S4b (draft-06/07 rule sets), S4c, S5 (OAS 3.0 `nullable: true` admits null, GraphApi excluded), S6a, S6b (kind and its bounds removed from `type`), S7 typed (also a required name rejected by `additionalProperties: false` without `patternProperties`), S9 (draft-06+); merged nodes only; a typed contradiction is reported unless inside a `oneOf`/`anyOf` branch; rule sets carry a `draft` marker; never S1', S4a, S6c, S8; tests B20.5–B20.9, every case with the cfworker oracle |
| Q3-3 group equality | implemented | order-sensitive structural equality (`dedupeValues`, `canonicalKey`) | |
| Q3-4 untyped contradictions | implemented | kept silently | B20.6.6 |
| Q4-1 … Q4-4 property-based test | implemented | `test/fuzz`, `npm run test:fuzz` | options randomized (sibling options, `refAnnotations`, the four safe simplifications, `simplify` all / selection); draft-07 `$ref` siblings read with 2019+ semantics by the oracle (D-24) |
