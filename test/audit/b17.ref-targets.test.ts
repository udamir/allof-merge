import { describe, it, expect } from "vite-plus/test"
import fs from "fs"
import path from "path"
import { syncClone } from "json-crawl"

import { allOfResolverHook, createMerger, jsonSchemaMergeRules } from "../../src/index.ts"
import { createResolutionIndex } from "../../src/resolve.ts"
import {
  collectRefs,
  expectRefMeaningPreserved,
  expectRefsKeepMeaning,
  expectRefsResolve,
  refsThroughMergedNodes,
} from "../helpers/refIntegrity.ts"
import { clone, expectIdempotent, expectSameValidation, merge, mergeReport } from "./helpers.ts"

const resources = path.resolve(import.meta.dirname, "../resources")
const loadResource = (name: string) => JSON.parse(fs.readFileSync(path.join(resources, name), "utf8"))

const oasDoc = (version: string, schemas: Record<string, unknown>) => ({ openapi: version, info: { title: "t", version: "1" }, paths: {}, components: { schemas } })

// values every case below is judged on (strings of several lengths, numbers, objects with the property names used)
const VALUES: unknown[] = [null, "", "a", "abc", "abcdefgh", "abcdefghi", 0, 1, -1, 2.5, true, [], ["a"], [1], {}]
const objects = (names: string[]): unknown[] => {
  const result: unknown[] = []
  for (const name of names) {
    for (const value of VALUES) { result.push({ [name]: value }) }
  }
  return result
}
const instances = (names: string[]): unknown[] => [...VALUES, ...objects(names), ...objects(names).map((value) => ({ id: "abc", next: value }))]

// whole-document contract of every case: refs resolve, none runs through a merged node, each keeps its meaning
const expectContract = (input: unknown, output: unknown, names: string[], draft: "07" | "2020" = "07") => {
  expectRefsResolve(input, output)
  expectRefsKeepMeaning(input, output)
  return expectRefMeaningPreserved(input, output, instances(names), draft)
}

describe("B17.1 $ref into a member a contradiction drops (D-20)", () => {
  const legacyDoc = () => oasDoc("3.0.3", {
    LegacyId: {
      allOf: [{ type: "string" }, { type: "number" }],
      properties: { code: { type: "string", maxLength: 8 } },
    },
    Order: { properties: { code: { $ref: "#/components/schemas/LegacyId/properties/code" } } },
  })

  it("B17.1.1 the $ref is replaced by the original target; the node stays false", () => {
    const doc = legacyDoc()
    const { result, mergeErrors, refErrors } = mergeReport(clone(doc))
    expect(result.components.schemas.LegacyId).toBe(false)
    expect(result.components.schemas.Order).toEqual({ properties: { code: { type: "string", maxLength: 8 } } })
    // the contradiction is reported once, the inlining is silent
    expect(mergeErrors).toHaveLength(1)
    expect(refErrors).toEqual([])
    // before D-20 the pointer dangled (LegacyId: false has no properties)
    expectContract(doc, result, ["code"])
  })

  it("B17.1.2 the inlined target is merged in its own right (its own allOf)", () => {
    const doc = oasDoc("3.0.3", {
      LegacyId: {
        allOf: [{ type: "string" }, { type: "number" }],
        properties: { code: { allOf: [{ type: "string" }, { maxLength: 8 }] } },
      },
      Order: { properties: { code: { $ref: "#/components/schemas/LegacyId/properties/code" } } },
    })
    const result = merge(clone(doc))
    expect(result.components.schemas.LegacyId).toBe(false)
    expect(result.components.schemas.Order.properties.code).toEqual({ type: "string", maxLength: 8 })
    expectContract(doc, result, ["code"])
  })

  it("B17.1.3 next to container siblings: { allOf: [false], definitions }, refs into definitions stay $ref", () => {
    const doc = {
      definitions: {
        A: {
          allOf: [{ type: "string" }, { type: "number" }],
          properties: { code: { type: "string", maxLength: 8 } },
          definitions: { Code: { type: "string", minLength: 2 } },
        },
      },
      properties: {
        code: { $ref: "#/definitions/A/properties/code" },
        other: { $ref: "#/definitions/A/definitions/Code" },
      },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ allOf: [false], definitions: { Code: { type: "string", minLength: 2 } } })
    expect(result.properties.code).toEqual({ type: "string", maxLength: 8 })
    expect(result.properties.other).toEqual({ $ref: "#/definitions/A/definitions/Code" })
    expectContract(doc, result, ["code", "other"])
    expectSameValidation(doc, result, instances(["code", "other"]))
  })

  it("B17.1.4 unsatisfiable: \"not-empty\" writes { not: {} } and inlines the same way", () => {
    const doc = clone(legacyDoc())
    const result = merge(clone(doc), { unsatisfiable: "not-empty" })
    expect(result.components.schemas.LegacyId).toEqual({ not: {} })
    expect(result.components.schemas.Order.properties.code).toEqual({ type: "string", maxLength: 8 })
    expectRefsResolve(doc, result)
  })

  it("B17.1.5 a contradiction from a $ref item (JSON Schema) and a deep pointer below the dropped member", () => {
    const doc = {
      definitions: {
        Num: { type: "number" },
        A: {
          allOf: [{ $ref: "#/definitions/Num" }, { type: "string" }],
          properties: { list: { type: "array", items: { type: "string", maxLength: 3 } } },
        },
      },
      properties: { item: { $ref: "#/definitions/A/properties/list/items" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toBe(false)
    expect(result.properties.item).toEqual({ type: "string", maxLength: 3 })
    expectContract(doc, result, ["item"])
    expectSameValidation(doc, result, instances(["item"]))
  })
})

describe("B17.2 $ref to a sibling member of a merged node (D-21)", () => {
  const aDoc = () => ({
    definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
    properties: { p: { $ref: "#/definitions/A/properties/x" }, a: { $ref: "#/definitions/A" } },
  })

  it("B17.2.1 the original (unmerged) value is inlined; the node is fully merged", () => {
    const doc = aDoc()
    const { result, mergeErrors, refErrors } = mergeReport(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 } } })
    // before D-21: p stayed { $ref } and resolved to the merged x (minLength 3), accepting fewer values than meant
    expect(result.properties.p).toEqual({ type: "string" })
    // a $ref to the merged node itself is equivalent and stays
    expect(result.properties.a).toEqual({ $ref: "#/definitions/A" })
    expect(mergeErrors).toEqual([])
    expect(refErrors).toEqual([])
    expectContract(doc, result, ["p", "a", "x"])
    expectSameValidation(doc, result, instances(["p", "a", "x"]))
  })

  it("B17.2.2 a member the merge leaves unchanged keeps its link (D-23; was a copy under D-21)", () => {
    const doc = {
      definitions: { A: { properties: { x: { type: "string" }, y: { type: "number" } }, allOf: [{ properties: { y: { minimum: 0 } } }] } },
      properties: { p: { $ref: "#/definitions/A/properties/x" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { x: { type: "string" }, y: { type: "number", minimum: 0 } } })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/A/properties/x" })
    expectContract(doc, result, ["p"])
  })

  it("B17.2.3 OpenAPI: $ref to #/components/schemas/Pet/properties/id where Pet has allOf", () => {
    const doc = oasDoc("3.0.3", {
      Base: { type: "object", properties: { id: { minimum: 1 } } },
      Pet: { allOf: [{ $ref: "#/components/schemas/Base" }], properties: { id: { type: "integer", format: "int64" } } },
      Order: { type: "object", properties: { petId: { $ref: "#/components/schemas/Pet/properties/id" }, pet: { $ref: "#/components/schemas/Pet" } } },
    })
    const result = merge(clone(doc))
    expect(result.components.schemas.Pet).toEqual({ type: "object", properties: { id: { minimum: 1, type: "integer", format: "int64" } } })
    expect(result.components.schemas.Order.properties.petId).toEqual({ type: "integer", format: "int64" })
    expect(result.components.schemas.Order.properties.pet).toEqual({ $ref: "#/components/schemas/Pet" })
    expectContract(doc, result, ["petId", "pet", "id"])
  })

  it("B17.2.4 the inlined value's own allOf is merged", () => {
    const doc = {
      definitions: { A: { properties: { x: { allOf: [{ type: "string" }, { maxLength: 8 }] } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/definitions/A/properties/x" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { x: { minLength: 3, type: "string", maxLength: 8 } } })
    expect(result.properties.p).toEqual({ type: "string", maxLength: 8 })
    expectContract(doc, result, ["p"])
  })

  it("B17.2.5 a pointer deeper below the merged node, and one through an intermediate $ref", () => {
    const doc = {
      definitions: {
        A: { properties: { list: { type: "array", items: { type: "string" } } }, allOf: [{ properties: { list: { items: { minLength: 3 } } } }] },
        B: { $ref: "#/definitions/A" },
      },
      properties: {
        item: { $ref: "#/definitions/A/properties/list/items" },
        viaB: { $ref: "#/definitions/B/properties/list" },
      },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { list: { type: "array", items: { type: "string", minLength: 3 } } } })
    expect(result.properties.item).toEqual({ type: "string" })
    expect(result.properties.viaB).toEqual({ type: "array", items: { type: "string" } })
    expect(result.definitions.B).toEqual({ $ref: "#/definitions/A" })
    // a pointer through an intermediate $ref is an allof-merge extension that ajv cannot resolve: structural checks only
    expectRefsResolve(doc, result)
    expectRefsKeepMeaning(doc, result)
    const { viaB: _viaB, ...plain } = doc.properties
    const { viaB: _merged, ...mergedPlain } = result.properties
    expectRefMeaningPreserved({ ...doc, properties: plain }, { ...result, properties: mergedPlain }, instances(["item"]))
  })

  it("B17.2.6 refs into definitions/$defs of a merged node (and of a merged root) are not touched", () => {
    const doc = {
      allOf: [{ type: "object" }],
      definitions: {
        S: { type: "string" },
        A: { allOf: [{ type: "object" }], properties: { x: { type: "string" } }, definitions: { T: { type: "number" } } },
      },
      properties: { s: { $ref: "#/definitions/S" }, t: { $ref: "#/definitions/A/definitions/T" } },
    }
    const result = merge(clone(doc))
    expect(result.allOf).toBeUndefined()
    expect(result.properties.s).toEqual({ $ref: "#/definitions/S" })
    expect(result.properties.t).toEqual({ $ref: "#/definitions/A/definitions/T" })
    expect(result.definitions.A).toEqual({ type: "object", properties: { x: { type: "string" } }, definitions: { T: { type: "number" } } })
    expectContract(doc, result, ["s", "t"])
  })

  it("B17.2.7 a $ref inside the merged node to its own sibling member (no cycle) is inlined", () => {
    const doc = {
      definitions: { A: { properties: { x: { type: "string" }, y: { $ref: "#/definitions/A/properties/x" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
      properties: { a: { $ref: "#/definitions/A" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 }, y: { type: "string" } } })
    expectContract(doc, result, ["a", "x", "y"])
  })

  it("B17.2.8 a pointer into a merged node from inside that same node (cycle): the node is merged, the copies point to themselves (D-22), no loop", () => {
    const doc = {
      definitions: {
        A: {
          properties: { x: { properties: { next: { $ref: "#/definitions/A/properties/x" } } } },
          allOf: [{ properties: { x: { required: ["id"] } } }],
        },
        Other: { allOf: [{ type: "object" }, { minProperties: 1 }] },
      },
      properties: { a: { $ref: "#/definitions/A" }, n: { $ref: "#/definitions/A/properties/x" } },
    }
    const started = Date.now()
    const { result, mergeErrors } = mergeReport(clone(doc))
    expect(Date.now() - started).toBeLessThan(1000)
    // inlining x inside x re-enters x: D-17 kept A unmerged; D-22 merges A, the copy of the original x at next
    // re-enters itself through a pointer to its own output location; n is a copy (merged x is stricter: required id)
    const copy = { properties: { next: { $ref: "#/definitions/A/properties/x/properties/next" } } }
    expect(result.definitions.A).toEqual({ properties: { x: { properties: { next: copy }, required: ["id"] } } })
    expect(result.properties.n).toEqual(copy)
    // unrelated allOf nodes are merged
    expect(result.definitions.Other).toEqual({ type: "object", minProperties: 1 })
    expect(mergeErrors).toEqual([])
    const nested = { x: { next: { next: {} } }, id: "abc" }
    expectContract(doc, result, ["a", "n", "x", "next"])
    expectSameValidation(doc, result, [...instances(["a", "n", "x"]), { a: nested }, { a: { x: { next: { id: 1 } } } }, { n: { next: 1 } }, { n: { next: { next: "a" } } }])
    for (const ref of collectRefs(result)) { expect(createResolutionIndex(result).resolve(ref).ok).toBe(true) }
  })

  it("B17.2.9 fragment mode (source given): links resolve against the unchanged source and stay as they are (D-22), cycle pointers resolve against source", () => {
    const doc = aDoc()
    const p = merge(doc.properties.p, { source: doc })
    // was inlined under D-21; the pointer means the original x in source
    expect(p).toEqual({ $ref: "#/definitions/A/properties/x" })

    const cyclic = {
      definitions: { A: { properties: { x: { properties: { next: { $ref: "#/definitions/A/properties/x" } } } }, allOf: [{ properties: { x: { required: ["id"] } } }] } },
    }
    const fragment = merge(cyclic.definitions.A, { source: cyclic })
    expect(fragment.allOf).toBeUndefined()
    expect(fragment.properties.x.required).toEqual(["id"])
    const index = createResolutionIndex(cyclic)
    const refs = [...collectRefs(fragment)]
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) { expect(index.resolve(ref).ok).toBe(true) }
    // the fragment, resolved against the unchanged source, validates like A
    const wrapped = (schema: unknown) => ({ ...clone(cyclic), properties: { root: schema } })
    expectSameValidation(wrapped({ $ref: "#/definitions/A" }), wrapped(fragment), [{ root: {} }, { root: { x: {} } }, { root: { x: { id: 1 } } }, { root: { x: { id: 1, next: {} } } }, { root: { x: { id: 1, next: { next: 5 } } } }])
  })

  it("B17.2.10 a $ref with siblings through a merged node: copy conjoined with the siblings in every draft (D-24), the node is merged (D-22); with mergeRefSibling merged with the original", () => {
    const doc = {
      definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/definitions/A/properties/x", maxLength: 5 } },
    }
    const kept = mergeReport(clone(doc))
    // was kept as { $ref, maxLength } with A unmerged (D-17); then the draft-07 copy dropped maxLength (changed by D-24)
    expect(kept.result.properties.p).toEqual({ type: "string", maxLength: 5 })
    expect(kept.result.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 } } })
    expect(kept.mergeErrors).toEqual([])
    expectRefsResolve(doc, kept.result)
    expectRefsKeepMeaning(doc, kept.result)
    expectSameValidation(doc, kept.result, instances(["p"]), "2020")

    const sibling = merge(clone(doc), { mergeRefSibling: true })
    expect(sibling.properties.p).toEqual({ type: "string", maxLength: 5 })
    expect(sibling.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 } } })
    expectRefsResolve(doc, sibling)
    // mergeRefSibling reads the siblings as a conjunction (2019-09+ semantics)
    expectSameValidation(doc, sibling, instances(["p"]), "2020")
  })

  it("B17.2.11 maxRefExpansion / expansionBudget: a $ref that is not inlined keeps its node unmerged", () => {
    const doc = {
      definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/definitions/A/properties/x" }, q: { $ref: "#/definitions/A/properties/x" } },
    }
    for (const limit of [{ maxRefExpansion: 1 }, { expansionBudget: 1 }]) {
      const { result, mergeErrors } = mergeReport(clone(doc), limit)
      expect(mergeErrors.length).toBeGreaterThan(0)
      // the ref that hit the limit stays: A keeps its allOf, so both pointers keep their meaning
      expect(result.definitions.A.allOf).toHaveLength(1)
      expectContract(doc, result, ["p", "q"])
    }
  })

  it("B17.2.12 mergeCombinarySibling: a member pushed into oneOf branches is a rewritten node too", () => {
    const doc = {
      definitions: { A: { properties: { x: { type: "string" } }, oneOf: [{ properties: { x: { minLength: 3 } } }, { required: ["x"] }] } },
      properties: { p: { $ref: "#/definitions/A/properties/x" } },
    }
    const distributed = merge(clone(doc), { mergeCombinarySibling: true })
    expect(distributed.definitions.A.properties).toBeUndefined()
    expect(distributed.properties.p).toEqual({ type: "string" })
    expectContract(doc, distributed, ["p", "x"])
    // without the option A is not rewritten and the ref stays
    expect(merge(clone(doc)).properties.p).toEqual({ $ref: "#/definitions/A/properties/x" })
  })

  it("B17.2.13 mergeRefSibling: a pointer through a merged $ref-with-siblings node", () => {
    const doc = {
      definitions: {
        Base: { properties: { x: { minLength: 3 } } },
        R: { $ref: "#/definitions/Base", properties: { x: { type: "string" } } },
      },
      properties: { p: { $ref: "#/definitions/R/properties/x" } },
    }
    const result = merge(clone(doc), { mergeRefSibling: true })
    expect(result.definitions.R).toEqual({ properties: { x: { minLength: 3, type: "string" } } })
    expect(result.properties.p).toEqual({ type: "string" })
    expectRefsResolve(doc, result)
  })

  it("B17.2.14 the raw hook (single pass) inlines the same way", () => {
    const doc = aDoc()
    const result: any = syncClone(clone(doc), allOfResolverHook(), { rules: jsonSchemaMergeRules(), circular: false })
    expect(result.properties.p).toEqual({ type: "string" })
    expect(result.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 } } })
  })

  it("B17.2.15 2020-12 $defs document", () => {
    const doc = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/$defs/A/properties/x" } },
    }
    const result = merge(clone(doc), { rules: jsonSchemaMergeRules("2020-12") })
    expect(result.properties.p).toEqual({ type: "string" })
    expectContract(doc, result, ["p"], "2020")
  })
})

describe("B17.3 order of the ref rules (D-16, D-17, D-20, D-21)", () => {
  it("B17.3.1 one document with every case: each $ref follows its rule", () => {
    const doc = {
      definitions: {
        // D-16: through an allOf member
        M: { allOf: [{ properties: { a: { type: "string" } } }, { required: ["a"] }] },
        // D-17: a cycle re-entry pointer through an allOf member keeps that allOf
        Node: { allOf: [{ properties: { child: { $ref: "#/definitions/Node/allOf/0" }, v: { type: "string" } } }, { required: ["v"] }] },
        // D-20: into a member a contradiction drops
        Bad: { allOf: [{ type: "string" }, { type: "number" }], properties: { code: { type: "string", maxLength: 8 } } },
        // D-21: a sibling member of a merged node
        A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] },
      },
      properties: {
        m: { $ref: "#/definitions/M/allOf/0" },
        node: { $ref: "#/definitions/Node" },
        code: { $ref: "#/definitions/Bad/properties/code" },
        x: { $ref: "#/definitions/A/properties/x" },
      },
    }
    const result = merge(clone(doc))
    expect(result.definitions.M).toEqual({ properties: { a: { type: "string" } }, required: ["a"] })
    expect(result.properties.m).toEqual({ properties: { a: { type: "string" } } })
    // D-22 (was kept unmerged by D-17): child is a copy of allOf/0 whose re-entry points to the copy itself
    expect(result.definitions.Node).toEqual({
      properties: { child: { properties: { child: { $ref: "#/definitions/Node/properties/child" }, v: { type: "string" } } }, v: { type: "string" } },
      required: ["v"],
    })
    expect(result.properties.node).toEqual({ $ref: "#/definitions/Node" })
    expect(result.definitions.Bad).toBe(false)
    expect(result.properties.code).toEqual({ type: "string", maxLength: 8 })
    expect(result.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 } } })
    expect(result.properties.x).toEqual({ type: "string" })
    expectContract(doc, result, ["m", "node", "code", "x", "a", "v", "child"])
    expectSameValidation(doc, result, [...instances(["m", "code", "x"]), { node: { v: "a", child: { child: {} } } }, { node: { v: 1 } }, { m: { a: 1 } }])
  })

  it("B17.3.2 merging the output again changes nothing (idempotent)", () => {
    const doc = {
      definitions: {
        Bad: { allOf: [{ type: "string" }, { type: "number" }], properties: { code: { type: "string" } } },
        A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] },
      },
      properties: { code: { $ref: "#/definitions/Bad/properties/code" }, x: { $ref: "#/definitions/A/properties/x" } },
    }
    expectIdempotent(doc)
  })

  it("B17.3.3 a merger reused after a D-21 call with a kept node merges the next document normally", () => {
    const merger = createMerger()
    const cyclic = {
      definitions: { A: { properties: { x: { properties: { next: { $ref: "#/definitions/A/properties/x" } } } }, allOf: [{ properties: { x: { required: ["id"] } } }] } },
    }
    const first: any = merger.merge(clone(cyclic))
    // D-22: the cyclic member is merged too (D-17 kept it)
    expect(first.definitions.A.allOf).toBeUndefined()
    const second: any = merger.merge({ definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } } })
    expect(second.definitions.A).toEqual({ properties: { x: { type: "string", minLength: 3 } } })
  })

  it.each(["openapi30x.json", "openapi31x.json"])("B17.3.4 no $ref of the whole-document merge of %s runs through a merged node", (name) => {
    const doc = loadResource(name)
    expectRefsKeepMeaning(doc, merge(clone(doc)))
    expectRefsKeepMeaning(doc, merge(clone(doc), { mergeRefSibling: true, mergeCombinarySibling: true }))
  })
})

describe("B17.4 meaning helpers (self-check)", () => {
  it("B17.4.1 refsThroughMergedNodes flags a pointer into a merged node and accepts kept / container pointers", () => {
    const input = {
      definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }], definitions: { T: {} } } },
      properties: { p: { $ref: "#/definitions/A/properties/x" }, t: { $ref: "#/definitions/A/definitions/T" }, a: { $ref: "#/definitions/A" } },
    }
    const merged = { definitions: { A: { properties: { x: { type: "string", minLength: 3 } }, definitions: { T: {} } } }, properties: input.properties }
    expect(refsThroughMergedNodes(input, merged)).toEqual(["#/definitions/A/properties/x"])
    expect(refsThroughMergedNodes(input, input)).toEqual([])
  })

  it("B17.4.2 expectRefMeaningPreserved fails when a $ref resolves to a stricter value", () => {
    const input = { definitions: { X: { type: "string" } }, properties: { p: { $ref: "#/definitions/X" } } }
    const stricter = { definitions: { X: { type: "string", minLength: 3 } }, properties: { p: { $ref: "#/definitions/X" } } }
    expect(() => expectRefMeaningPreserved(input, stricter, ["a", "abc"])).toThrow()
    expect(expectRefMeaningPreserved(input, input, ["a", "abc"])).toEqual(["/properties/p", "/definitions/X"])
  })
})
