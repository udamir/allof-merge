import fs from "fs"
import path from "path"
import { syncClone } from "json-crawl"

import { allOfResolverHook, createMerger, jsonSchemaMergeRules, openApiMergeRules } from "../../src"
import { ErrorMessage } from "../../src/errors"
import { createResolutionIndex } from "../../src/resolve"
import { collectRefs, copiesWithEqualLink, expectRefMeaningPreserved, expectRefsKeepMeaning, expectRefsResolve } from "../helpers/refIntegrity"
import { clone, expectIdempotent, expectSameValidation, merge, mergeReport } from "./helpers"

const resources = path.resolve(__dirname, "../resources")
const loadResource = (name: string) => JSON.parse(fs.readFileSync(path.join(resources, name), "utf8"))

const oasDoc = (version: string, schemas: Record<string, unknown>) => ({ openapi: version, info: { title: "t", version: "1" }, paths: {}, components: { schemas } })

const VALUES: unknown[] = [null, "", "a", "abc", 0, 1, -1, 2.5, 100, 101, true, [], ["a"], [1], {}]
const instances = (names: string[]): unknown[] => {
  const result: unknown[] = [...VALUES]
  for (const name of names) {
    for (const value of VALUES) { result.push({ [name]: value }, { [name]: value, id: 1 }) }
  }
  return result
}

// whole-document contract: every ref resolves, copies only where no equal merged value exists, same meaning (ajv)
const expectContract = (input: unknown, output: unknown, names: string[], draft: "07" | "2020" = "07") => {
  expectRefsResolve(input, output)
  expectRefsKeepMeaning(input, output)
  return expectRefMeaningPreserved(input, output, instances(names), draft)
}

const draftOf = (version: string): "07" | "2020" => version.startsWith("3.1") ? "2020" : "07"

describe("B18.1 links into merged schemas stay links (D-22)", () => {
  // the user's example: Order.petId points into a member of Pet's allOf; merging Pet leaves id unchanged
  const petDoc = (version: string, petId: unknown) => oasDoc(version, {
    Base: { type: "object", required: ["id"] },
    Pet: {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        { properties: { id: { type: "integer", format: "int64" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
      ],
    },
    Order: { type: "object", properties: { petId, pet: { $ref: "#/components/schemas/Pet" } } },
  })

  it.each(["3.0.3", "3.1.0"])("B18.1.1 OpenAPI %s: a $ref with a description sibling is rewritten to the matching merged location", (version) => {
    const doc = petDoc(version, { $ref: "#/components/schemas/Pet/allOf/1/properties/id", description: "pet id" })
    const { result, mergeErrors, refErrors } = mergeReport(clone(doc))
    expect(result.components.schemas.Pet).toEqual({
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer", format: "int64" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
    })
    expect(result.components.schemas.Order.properties.petId).toEqual({ $ref: "#/components/schemas/Pet/properties/id", description: "pet id" })
    expect(result.components.schemas.Order.properties.pet).toEqual({ $ref: "#/components/schemas/Pet" })
    expect(mergeErrors).toEqual([])
    expect(refErrors).toEqual([])
    expectContract(doc, result, ["petId", "pet"], draftOf(version))
  })

  it.each(["3.0.3", "3.1.0"])("B18.1.2 OpenAPI %s: a bare $ref and a nested pointer below a member", (version) => {
    const doc = petDoc(version, { $ref: "#/components/schemas/Pet/allOf/1/properties/tags/items" })
    const result = merge(clone(doc))
    expect(result.components.schemas.Order.properties.petId).toEqual({ $ref: "#/components/schemas/Pet/properties/tags/items" })
    expectContract(doc, result, ["petId"], draftOf(version))
  })

  it("B18.1.3 a pointer that already is the matching location (sibling member of a merged node) is kept as it is", () => {
    const doc = {
      definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { y: { minimum: 0 } } }] } },
      properties: { p: { $ref: "#/definitions/A/properties/x" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ properties: { x: { type: "string" }, y: { minimum: 0 } } })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/A/properties/x" })
    expectContract(doc, result, ["p"])
  })

  it("B18.1.4 refs into allOf members of allOf members", () => {
    const doc = {
      definitions: { A: { allOf: [{ allOf: [{ type: "object" }, { properties: { x: { type: "string" } } }] }, { required: ["x"] }] } },
      properties: { p: { $ref: "#/definitions/A/allOf/0/allOf/1/properties/x" }, q: { $ref: "#/definitions/A/allOf/0/allOf/1" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A).toEqual({ type: "object", properties: { x: { type: "string" } }, required: ["x"] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/A/properties/x" })
    // the member itself is not equal to the merged A (type, required): a copy
    expect(result.properties.q).toEqual({ properties: { x: { type: "string" } } })
    expectContract(doc, result, ["p", "q", "x"])
  })

  it("B18.1.5 a pointer through an intermediate $ref: the input form is kept when it resolves, else the target's own place", () => {
    const doc = {
      definitions: {
        A: { allOf: [{ properties: { x: { type: "string" } } }, { required: ["x"] }] },
        B: { $ref: "#/definitions/A" },
      },
      properties: { p: { $ref: "#/definitions/B/allOf/0/properties/x" }, q: { $ref: "#/definitions/B/properties/x" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.B).toEqual({ $ref: "#/definitions/A" })
    // q is not run through a rewritten node in the input form (B is a bare $ref, A/properties/x is A's own member)
    expect(result.properties.q).toEqual({ $ref: "#/definitions/B/properties/x" })
    // p: the matching location of the target's own place, without the intermediate $ref (ajv-resolvable)
    expect(result.properties.p).toEqual({ $ref: "#/definitions/A/properties/x" })
    expectRefsResolve(doc, result)
    expectRefsKeepMeaning(doc, result)
  })

  it("B18.1.6 a pointer through a $ref allOf member links the member target's own place", () => {
    const doc = oasDoc("3.0.3", {
      Base: { type: "object", properties: { id: { type: "integer" } } },
      Pet: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { name: { type: "string" } } }] },
      Order: { properties: { petId: { $ref: "#/components/schemas/Pet/allOf/0/properties/id" } } },
    })
    const result = merge(clone(doc))
    expect(result.components.schemas.Order.properties.petId).toEqual({ $ref: "#/components/schemas/Base/properties/id" })
    // the input pointer runs through an intermediate $ref (an allof-merge extension ajv cannot resolve): structural
    // checks, and ajv on the output against the target's own place in the input
    expectRefsResolve(doc, result)
    expectRefsKeepMeaning(doc, result)
    const plain = clone(doc) as any
    plain.components.schemas.Order.properties.petId = { $ref: "#/components/schemas/Base/properties/id" }
    expectRefMeaningPreserved(plain, result, instances(["petId"]))
  })

  it("B18.1.7 the decision is per $ref: equal members link, stricter ones copy, in one document", () => {
    const doc = {
      definitions: { A: { allOf: [{ properties: { x: { type: "string" }, y: { type: "number" } } }, { properties: { y: { minimum: 0 } } }] } },
      properties: { x: { $ref: "#/definitions/A/allOf/0/properties/x" }, y: { $ref: "#/definitions/A/allOf/0/properties/y" } },
    }
    const result = merge(clone(doc))
    expect(result.properties.x).toEqual({ $ref: "#/definitions/A/properties/x" })
    expect(result.properties.y).toEqual({ type: "number" })
    expectContract(doc, result, ["x", "y"])
  })
})

describe("B18.2 copies where the merged location is stricter (D-22)", () => {
  const strictDoc = (version: string, petId: unknown) => oasDoc(version, {
    Pet: { allOf: [{ properties: { id: { type: "integer" } } }, { properties: { id: { minimum: 1 } } }] },
    Order: { properties: { petId } },
  })

  it.each(["3.0.3", "3.1.0"])("B18.2.1 OpenAPI %s: a bare $ref is replaced by the original target", (version) => {
    const doc = strictDoc(version, { $ref: "#/components/schemas/Pet/allOf/0/properties/id" })
    const result = merge(clone(doc))
    expect(result.components.schemas.Pet).toEqual({ properties: { id: { type: "integer", minimum: 1 } } })
    expect(result.components.schemas.Order.properties.petId).toEqual({ type: "integer" })
    expectContract(doc, result, ["petId"], draftOf(version))
  })

  it("B18.2.2 OpenAPI 3.0: every sibling applies next to the $ref (D-24), the copy is their conjunction, nothing is reported", () => {
    const doc = strictDoc("3.0.3", { $ref: "#/components/schemas/Pet/allOf/0/properties/id", description: "d", "x-internal": true, maximum: 100 })
    const { result, mergeErrors } = mergeReport(clone(doc))
    // was { type, description, x-internal } with maximum dropped + reported (changed by D-24)
    expect(result.components.schemas.Order.properties.petId).toEqual({ type: "integer", maximum: 100, description: "d", "x-internal": true })
    expect(mergeErrors).toEqual([])
    expectRefsResolve(doc, result)
    // author-intent reading (D-24): the siblings apply, as ajv 8 applies them in every draft
    const wrap = (d: any) => ({ ...d, properties: { o: { $ref: "#/components/schemas/Order" } } })
    expectSameValidation(wrap(doc), wrap(result), instances(["petId"]).map((value) => ({ o: value })))
  })

  it("B18.2.3 OpenAPI 3.1: siblings apply next to $ref, the copy is their conjunction", () => {
    const doc = strictDoc("3.1.0", { $ref: "#/components/schemas/Pet/allOf/0/properties/id", description: "d", maximum: 100 })
    const { result, mergeErrors } = mergeReport(clone(doc))
    expect(result.components.schemas.Order.properties.petId).toEqual({ type: "integer", maximum: 100, description: "d" })
    expect(mergeErrors).toEqual([])
    const wrap = (d: any) => ({ ...d, properties: { o: { $ref: "#/components/schemas/Order" } } })
    expectSameValidation(wrap(doc), wrap(result), instances(["petId"]).map((value) => ({ o: value })), "2020")
  })

  it("B18.2.4 a $ref with siblings whose target is equal is a link with the siblings kept as they are (3.1, constraint sibling)", () => {
    const doc = oasDoc("3.1.0", {
      Pet: { allOf: [{ properties: { id: { type: "integer" } } }, { required: ["id"] }] },
      Order: { properties: { petId: { $ref: "#/components/schemas/Pet/allOf/0/properties/id", maximum: 100, description: "d" } } },
    })
    const result = merge(clone(doc))
    expect(result.components.schemas.Order.properties.petId).toEqual({ $ref: "#/components/schemas/Pet/properties/id", maximum: 100, description: "d" })
    const wrap = (d: any) => ({ ...d, properties: { o: { $ref: "#/components/schemas/Order" } } })
    expectSameValidation(wrap(doc), wrap(result), instances(["petId"]).map((value) => ({ o: value })), "2020")
  })

  it("B18.2.5 2020-12 and the default rule set (draft-06): siblings apply in both (D-24)", () => {
    const doc = {
      $defs: { A: { properties: { x: { type: "string" } }, allOf: [{ properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/$defs/A/properties/x", maxLength: 5 } },
    }
    const modern = merge(clone(doc), { rules: jsonSchemaMergeRules("2020-12") })
    expect(modern.properties.p).toEqual({ type: "string", maxLength: 5 })
    expectSameValidation(doc, modern, instances(["p"]), "2020")
    // was { type: string } + one report (changed by D-24)
    const { result, mergeErrors } = mergeReport(clone(doc))
    expect(result.properties.p).toEqual({ type: "string", maxLength: 5 })
    expect(mergeErrors).toEqual([])
    expectSameValidation(doc, result, instances(["p"]))
  })

  it("B18.2.6 refs into a schema that became false keep being copies (D-20)", () => {
    const doc = oasDoc("3.0.3", {
      LegacyId: { allOf: [{ type: "string" }, { type: "number" }], properties: { code: { type: "string", maxLength: 8 } } },
      Order: { properties: { code: { $ref: "#/components/schemas/LegacyId/properties/code", description: "c" }, other: { $ref: "#/components/schemas/LegacyId/allOf/0" } } },
    })
    const result = merge(clone(doc))
    expect(result.components.schemas.LegacyId).toBe(false)
    expect(result.components.schemas.Order.properties).toEqual({ code: { type: "string", maxLength: 8, description: "c" }, other: { type: "string" } })
    expectContract(doc, result, ["code", "other"])
  })

  it("B18.2.7 a copy that is a boolean schema can become a link too", () => {
    const doc = {
      definitions: { A: { allOf: [{ properties: { never: false, any: true } }, { required: ["x"] }] } },
      properties: { n: { $ref: "#/definitions/A/allOf/0/properties/never" }, a: { $ref: "#/definitions/A/allOf/0/properties/any" } },
    }
    const result = merge(clone(doc))
    expect(result.properties.n).toEqual({ $ref: "#/definitions/A/properties/never" })
    expect(result.properties.a).toEqual({ $ref: "#/definitions/A/properties/any" })
    expectContract(doc, result, ["n", "a", "never", "any"])
  })
})

describe("B18.7 copies of targets with their own unevaluated* and pointers into a copy that became a link", () => {
  const r2020 = { rules: jsonSchemaMergeRules("2020-12") }

  it("B18.7.1 a target with unevaluatedProperties (kept as an allOf fragment) is linked at its own place", () => {
    const doc = {
      $defs: {
        U: { properties: { x: { type: "string" } }, unevaluatedProperties: false },
        A: { allOf: [{ $ref: "#/$defs/U" }, { required: ["x"] }] },
      },
      properties: { p: { $ref: "#/$defs/A/allOf/0" } },
    }
    const result = merge(clone(doc), r2020)
    expect(result.$defs.A).toEqual({ required: ["x"], allOf: [{ $ref: "#/$defs/U" }] })
    expect(result.properties.p).toEqual({ $ref: "#/$defs/U" })
    expectRefsResolve(doc, result)
    expectRefsKeepMeaning(doc, result)
    expectSameValidation(doc, result, [{}, { p: {} }, { p: { x: "a" } }, { p: { x: 1 } }, { p: { y: 1 } }], "2020")
  })

  it("B18.7.2 such a target inside a merged node is copied whole (the merged member keeps it as a fragment)", () => {
    const doc = {
      $defs: { B: { properties: { u: { properties: { x: { type: "string" } }, unevaluatedProperties: false } }, allOf: [{ properties: { u: { required: ["x"] } } }] } },
      properties: { p: { $ref: "#/$defs/B/properties/u" } },
    }
    const result = merge(clone(doc), r2020)
    expect(result.properties.p).toEqual({ properties: { x: { type: "string" } }, unevaluatedProperties: false })
    expectContract(doc, result, ["p", "x", "y"], "2020")
  })

  it("B18.7.3 a memo re-entry (D-4) whose source pointer runs through a merged node points to the output location", () => {
    const pair = () => ({ allOf: [{ $ref: "#/definitions/A/allOf/0" }, { $ref: "#/definitions/R" }] })
    const doc = { definitions: { R: { required: ["v"] }, A: { allOf: [{ properties: { next: pair(), other: pair() } }, { type: "object" }] } } }
    const result = merge(clone(doc))
    expect(result.definitions.A.allOf).toBeUndefined()
    expect(result.definitions.A.properties.other).toEqual({ $ref: "#/definitions/A/properties/next" })
    expect(result.definitions.A.properties.next.properties.other).toEqual({ $ref: "#/definitions/A/properties/next" })
    expectRefsResolve(doc, result)
    const wrap = (d: any) => ({ ...d, $ref: "#/definitions/A" })
    expectSameValidation(wrap(doc), wrap(result), [{}, { next: {} }, { next: { v: 1 } }, { other: { v: 1, next: {} } }, { other: { v: 1, next: { v: 2, other: 1 } } }, 1])
  })

  it("B18.7.4 a pointer below a copy that became a link moves below the link's target", () => {
    const doc = {
      definitions: { A: { allOf: [{ properties: { x: { type: "string" } } }] } },
      properties: { p: { $ref: "#/definitions/A/allOf/0" }, q: { $ref: "#/properties/p/properties/x" } },
    }
    const result = merge(clone(doc))
    expect(result.properties.p).toEqual({ $ref: "#/definitions/A" })
    expect(result.properties.q).toEqual({ $ref: "#/definitions/A/properties/x" })
    expectRefsResolve(doc, result)
    expectSameValidation({ ...doc, properties: { p: doc.properties.p, q: { $ref: "#/definitions/A/allOf/0/properties/x" } } }, result, instances(["p", "q"]))
  })

  it("B18.7.5 a root $ref with container siblings that points into a merged member stays a copy (its target lies inside it)", () => {
    const doc = { $ref: "#/definitions/A/allOf/0", definitions: { A: { allOf: [{ type: "object", properties: { x: { type: "string" } } }] } } }
    const result = merge(clone(doc))
    expect(result).toEqual({ type: "object", properties: { x: { type: "string" } }, definitions: { A: { type: "object", properties: { x: { type: "string" } } } } })
    expectSameValidation(doc, result, instances(["x"]))
  })
})

describe("B18.3 cycles (D-4, D-4b with D-22)", () => {
  it("B18.3.1 a member that refers to itself through its allOf location: the copy re-enters itself", () => {
    const doc = {
      definitions: { Node: { allOf: [{ properties: { child: { $ref: "#/definitions/Node/allOf/0" }, v: { type: "string" } } }, { required: ["v"] }] } },
      properties: { root: { $ref: "#/definitions/Node" } },
    }
    const { result, mergeErrors } = mergeReport(clone(doc))
    expect(result.definitions.Node.allOf).toBeUndefined()
    expect(result.definitions.Node.properties.child.properties.child).toEqual({ $ref: "#/definitions/Node/properties/child" })
    expect(mergeErrors).toEqual([])
    expectRefsResolve(doc, result)
    const nested = (depth: number, leaf: unknown): unknown => depth ? { v: "a", child: nested(depth - 1, leaf) } : leaf
    expectSameValidation(doc, result, [{ root: {} }, { root: { v: 1 } }, { root: nested(3, { v: 1 }) }, { root: nested(3, {}) }, { root: { v: "a", child: { child: { child: 5 } } } }])
  })

  it("B18.3.2 a cycle whose source pointer does not run through a rewritten node keeps its source pointer", () => {
    const doc = {
      definitions: { List: { allOf: [{ type: "object" }, { properties: { next: { $ref: "#/definitions/List" } } }] } },
      properties: { list: { $ref: "#/definitions/List" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.List).toEqual({ type: "object", properties: { next: { $ref: "#/definitions/List" } } })
    expectContract(doc, result, ["list", "next"])
  })

  it("B18.3.3 a cyclic member that is equal after merging becomes a link", () => {
    const doc = {
      definitions: {
        A: {
          allOf: [{ properties: { tree: { properties: { kids: { items: { $ref: "#/definitions/A/allOf/0/properties/tree" } } } } } }, { type: "object" }],
        },
      },
      properties: { t: { $ref: "#/definitions/A/allOf/0/properties/tree" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.A.allOf).toBeUndefined()
    expectRefsResolve(doc, result)
    expect(copiesWithEqualLink(doc, result)).toEqual([])
    expectSameValidation(doc, result, [{ t: {} }, { t: { kids: [{}] } }, { t: { kids: [{ kids: 1 }] } }, { t: { kids: [{ kids: [{ kids: "x" }] }] } }])
  })

  it("B18.3.4 terminates on mutually recursive members", () => {
    const doc = {
      definitions: {
        A: { allOf: [{ properties: { b: { $ref: "#/definitions/B/allOf/0" } } }, { required: ["b"] }] },
        B: { allOf: [{ properties: { a: { $ref: "#/definitions/A/allOf/0" } } }, { required: ["a"] }] },
      },
      properties: { a: { $ref: "#/definitions/A" } },
    }
    const started = Date.now()
    const result = merge(clone(doc))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.definitions.A.allOf).toBeUndefined()
    expect(result.definitions.B.allOf).toBeUndefined()
    expectRefsResolve(doc, result)
    expectSameValidation(doc, result, [{ a: {} }, { a: { b: {} } }, { a: { b: { a: {} } } }, { a: { b: { a: { b: 1 } } } }, { a: { b: { a: { b: { a: 1 } } } } }])
  })
})

describe("B18.4 options, reuse, modes", () => {
  const doc = () => ({
    definitions: {
      A: { allOf: [{ properties: { x: { type: "string" }, y: { type: "number" } } }, { properties: { y: { minimum: 0 } } }] },
      C: { properties: { x: { type: "string" } }, oneOf: [{ required: ["x"] }, { required: ["z"] }] },
      R: { $ref: "#/definitions/A", properties: { z: { type: "boolean" } } },
    },
    properties: {
      x: { $ref: "#/definitions/A/allOf/0/properties/x" },
      y: { $ref: "#/definitions/A/allOf/0/properties/y", description: "y" },
      c: { $ref: "#/definitions/C/properties/x" },
      z: { $ref: "#/definitions/R/properties/z" },
    },
  })

  it("B18.4.1 mergeRefSibling / mergeCombinarySibling off and on", () => {
    const plain = merge(clone(doc()))
    expect(plain.properties.x).toEqual({ $ref: "#/definitions/A/properties/x" })
    expect(plain.properties.y).toEqual({ type: "number", description: "y" })
    expect(plain.properties.c).toEqual({ $ref: "#/definitions/C/properties/x" })
    expect(plain.properties.z).toEqual({ $ref: "#/definitions/R/properties/z" })
    expectRefsKeepMeaning(doc(), plain)

    const both = merge(clone(doc()), { mergeRefSibling: true, mergeCombinarySibling: true })
    expect(both.properties.x).toEqual({ $ref: "#/definitions/A/properties/x" })
    // mergeRefSibling merges a $ref with siblings with the ORIGINAL target (unchanged behaviour)
    expect(both.properties.y).toEqual({ type: "number", description: "y" })
    // C's properties are distributed into its oneOf branches: no matching location, a copy
    expect(both.definitions.C.properties).toBeUndefined()
    expect(both.properties.c).toEqual({ type: "string" })
    // R (a $ref with siblings) is merged: its own member z is unchanged, the link stays
    expect(both.properties.z).toEqual({ $ref: "#/definitions/R/properties/z" })
    expectRefsResolve(doc(), both)
    expectRefsKeepMeaning(doc(), both)
  })

  it("B18.4.2 a reused merger gives the same output for the same document, and a fresh one for another", () => {
    const merger = createMerger()
    const first = merger.merge(clone(doc()))
    const second = merger.merge(clone(doc()))
    expect(second).toEqual(first)
    expect(second).toEqual(merge(clone(doc())))
    const other: any = merger.merge({ definitions: { A: { allOf: [{ properties: { x: { type: "string" } } }, { required: ["x"] }] } }, properties: { p: { $ref: "#/definitions/A/allOf/0/properties/x" } } })
    expect(other.properties.p).toEqual({ $ref: "#/definitions/A/properties/x" })
    // reusing the same input instances (outputs are shared) keeps every ref valid in each output
    const shared = doc()
    const a: any = merger.merge(shared)
    const b: any = merger.merge(shared)
    expectRefsResolve(shared, a)
    expectRefsResolve(shared, b)
  })

  it("B18.4.3 fragment mode (source given): pointers resolve against the unchanged source and are not rewritten", () => {
    const source = doc()
    const fragment = merge(source.properties, { source })
    expect(fragment).toEqual(source.properties)
    const a = merge(source.definitions.A, { source })
    expect(a).toEqual({ properties: { x: { type: "string" }, y: { type: "number", minimum: 0 } } })
    const index = createResolutionIndex(source)
    for (const ref of collectRefs(fragment)) { expect(index.resolve(ref).ok).toBe(true) }
  })

  it("B18.4.4 the raw hook relinks at the end of a whole-document clone", () => {
    const result: any = syncClone(clone(doc()), allOfResolverHook(), { rules: jsonSchemaMergeRules(), circular: false })
    expect(result.properties.x).toEqual({ $ref: "#/definitions/A/properties/x" })
    expect(result.properties.y).toEqual({ type: "number", description: "y" })
    expectRefsResolve(doc(), result)
  })

  it("B18.4.5 freezeOutput: the relinked output is frozen", () => {
    const result: any = merge(clone(doc()), { freezeOutput: true })
    expect(Object.isFrozen(result.properties.x)).toBe(true)
    expect(result.properties.x).toEqual({ $ref: "#/definitions/A/properties/x" })
  })

  it("B18.4.6 merging the output again is a no-op (idempotent)", () => {
    expectIdempotent(doc())
    expectIdempotent(doc(), { mergeRefSibling: true, mergeCombinarySibling: true })
    expectIdempotent(oasDoc("3.0.3", {
      Node: { allOf: [{ properties: { child: { $ref: "#/components/schemas/Node/allOf/0" }, v: { type: "string" } } }, { required: ["v"] }] },
      Ref: { properties: { v: { $ref: "#/components/schemas/Node/allOf/0/properties/v", description: "v" } } },
    }))
  })

  it("B18.4.7 limits: a $ref that is not copied keeps the node it points through unmerged (D-17 fallback)", () => {
    const limited = {
      definitions: { A: { allOf: [{ properties: { x: { type: "string" } } }, { properties: { x: { minLength: 3 } } }] } },
      properties: { p: { $ref: "#/definitions/A/allOf/0/properties/x" }, q: { $ref: "#/definitions/A/allOf/0/properties/x" } },
    }
    const { result, mergeErrors } = mergeReport(clone(limited), { maxRefExpansion: 1 })
    expect(mergeErrors.length).toBeGreaterThan(0)
    expect(result.definitions.A.allOf).toHaveLength(2)
    expectRefsResolve(limited, result)
  })
})

describe("B18.5 resource documents", () => {
  const extend = (name: string) => {
    const doc = loadResource(name)
    doc.components.schemas.Toy = {
      type: "object",
      properties: {
        breed: { $ref: "#/components/schemas/Dog/allOf/1/properties/breed", description: "breed of the dog" },
        kind: { $ref: "#/components/schemas/Cat/allOf/0/properties/pet_type" },
        cat: { $ref: "#/components/schemas/Cat/allOf/1" },
      },
    }
    return doc
  }

  it.each(["openapi30x.json", "openapi31x.json"])("B18.5.1 %s with refs into allOf members: links, contract, idempotence", (name) => {
    const doc = extend(name)
    const result = merge(clone(doc))
    const toy = result.components.schemas.Toy.properties
    expect(toy.breed).toEqual({ $ref: "#/components/schemas/Dog/properties/breed", description: "breed of the dog" })
    expect(toy.kind).toEqual({ $ref: "#/components/schemas/Pet/properties/pet_type" })
    // the member is not equal to the merged Cat (Pet's required / discriminator): a copy
    expect(toy.cat).toEqual({ type: "object", properties: { hunts: { type: "boolean" }, age: { type: "integer" } } })
    expectRefsResolve(doc, result)
    expectRefsKeepMeaning(doc, result)
    // kind's input pointer runs through an intermediate $ref (allOf/0 is a $ref), which ajv cannot resolve: the ajv
    // check uses the target's own place for it
    const plain = clone(doc)
    plain.components.schemas.Toy.properties.kind = { $ref: "#/components/schemas/Pet/properties/pet_type" }
    expectRefMeaningPreserved(plain, result, instances(["breed", "kind", "cat", "hunts"]), name === "openapi31x.json" ? "2020" : "07")
    expectIdempotent(doc)
    expectIdempotent(doc, { mergeRefSibling: true, mergeCombinarySibling: true })
    expectRefsKeepMeaning(doc, merge(clone(doc), { mergeRefSibling: true, mergeCombinarySibling: true }))
  })
})

describe("B18.6 the done memo is per rules (shared instances under different rules)", () => {
  it("B18.6.1 one object used under info (no merge rules) and under components.schemas", () => {
    const shared = { allOf: [{ type: "string" }, { minLength: 1 }] }
    const doc = { openapi: "3.0.3", info: { title: "t", version: "1", "x-example": shared }, paths: {}, components: { schemas: { S: shared } } }
    const result = merge(doc)
    expect(result.info["x-example"]).toEqual({ allOf: [{ type: "string" }, { minLength: 1 }] })
    expect(result.components.schemas.S).toEqual({ type: "string", minLength: 1 })
    // the other order
    const reversed = { openapi: "3.0.3", components: { schemas: { S: shared } }, info: { title: "t", version: "1", "x-example": shared }, paths: {} }
    const second = merge(reversed)
    expect(second.components.schemas.S).toEqual({ type: "string", minLength: 1 })
    expect(second.info["x-example"]).toEqual({ allOf: [{ type: "string" }, { minLength: 1 }] })
  })

  it("B18.6.2 the same instance under the same rules is still shared", () => {
    const shared = { allOf: [{ type: "string" }, { minLength: 1 }] }
    const result = merge(oasDoc("3.0.3", { A: shared, B: shared }), { rules: openApiMergeRules("3.0.x") })
    expect(result.components.schemas.A).toBe(result.components.schemas.B)
  })
})

describe("B18.8 links into oneOf/anyOf branches whose index shifts (D-27)", () => {
  const S = { type: "string" }
  const N = { type: "number" }
  const B = { type: "boolean" }
  const IMPOSSIBLE = { allOf: [S, N] }
  // expectRefMeaningPreserved reads an output pointer in the input as well, which a shifted index does not allow: the
  // meaning is checked per $ref site instead (input site vs output site, ajv), plus resolution and "no needless copy"
  const expectShiftContract = (input: any, output: any, names: string[]) => {
    expectRefsResolve(input, output)
    expect(copiesWithEqualLink(input, output)).toEqual([])
    for (const name of names) {
      const at = (d: any) => ({ ...d, $ref: `#/properties/${name}` })
      expectSameValidation(at(input), at(output), instances(["a", "b"]))
    }
  }

  it("B18.8.1 dropFalseBranches: pointers into the kept branches link their new index; into the removed one stays a copy", () => {
    const doc = {
      definitions: { X: { oneOf: [clone(IMPOSSIBLE), { type: "integer" }, clone(B), clone(IMPOSSIBLE), { type: "null" }] } },
      properties: {
        p: { $ref: "#/definitions/X/oneOf/2" },
        q: { $ref: "#/definitions/X/oneOf/1" },
        r: { $ref: "#/definitions/X/oneOf/4" },
        gone: { $ref: "#/definitions/X/oneOf/0" },
      },
    }
    const { result, mergeErrors } = mergeReport(clone(doc))
    // the copy of the impossible branch is a contradiction of its own (reported there), nothing else is reported
    expect(result.definitions.X).toEqual({ oneOf: [{ type: "integer" }, B, { type: "null" }] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/X/oneOf/1" })
    expect(result.properties.q).toEqual({ $ref: "#/definitions/X/oneOf/0" })
    expect(result.properties.r).toEqual({ $ref: "#/definitions/X/oneOf/2" })
    expect(result.properties.gone).toBe(false)
    expect(mergeErrors.map((error: { path: unknown[] }) => error.path)).toEqual([["properties", "gone"]])
    expectShiftContract(doc, result, ["p", "q", "r", "gone"])
  })

  it("B18.8.2 a pointer below a shifted branch and a $ref with siblings keep their place", () => {
    const doc = {
      definitions: { X: { anyOf: [clone(IMPOSSIBLE), { type: "object", properties: { a: { type: "string", maxLength: 3 } } }] } },
      properties: {
        p: { $ref: "#/definitions/X/anyOf/1/properties/a" },
        q: { $ref: "#/definitions/X/anyOf/1", description: "the object branch" },
      },
    }
    const result = merge(clone(doc))
    expect(result.definitions.X).toEqual({ anyOf: [{ type: "object", properties: { a: { type: "string", maxLength: 3 } } }] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/X/anyOf/0/properties/a" })
    expect(result.properties.q).toEqual({ $ref: "#/definitions/X/anyOf/0", description: "the object branch" })
    expectShiftContract(doc, result, ["p", "q"])
  })

  it("B18.8.3 dedupeAnyOf: a pointer into a removed duplicate links the equal branch that is kept", () => {
    const doc = {
      definitions: { X: { anyOf: [clone(S), { properties: { a: S } }, clone(S), { properties: { a: N } }] } },
      properties: { p: { $ref: "#/definitions/X/anyOf/2" }, q: { $ref: "#/definitions/X/anyOf/3/properties/a" }, r: { $ref: "#/definitions/X/anyOf/1" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.X).toEqual({ anyOf: [S, { properties: { a: S } }, { properties: { a: N } }] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/X/anyOf/0" })
    expect(result.properties.q).toEqual({ $ref: "#/definitions/X/anyOf/2/properties/a" })
    // a branch before the first removed one keeps its index
    expect(result.properties.r).toEqual({ $ref: "#/definitions/X/anyOf/1" })
    expectShiftContract(doc, result, ["p", "q", "r"])
  })

  it("B18.8.4 nested shifts: both indexes of the path are remapped", () => {
    const doc = {
      definitions: { X: { oneOf: [clone(IMPOSSIBLE), { oneOf: [{ allOf: [S, B] }, { type: "integer" }, { type: "null" }] }] } },
      properties: { p: { $ref: "#/definitions/X/oneOf/1/oneOf/2" } },
    }
    const result = merge(clone(doc))
    expect(result.definitions.X).toEqual({ oneOf: [{ oneOf: [{ type: "integer" }, { type: "null" }] }] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/X/oneOf/0/oneOf/1" })
    expectShiftContract(doc, result, ["p"])
  })

  it("B18.8.5 a shifted branch of a merged node (allOf next to oneOf) and of a distributed node", () => {
    const doc = {
      definitions: { X: { allOf: [{ type: "object" }], oneOf: [{ type: "string" }, { properties: { a: S } }, { required: ["b"] }] } },
      properties: { p: { $ref: "#/definitions/X/oneOf/2" } },
    }
    // without mergeCombinarySibling the oneOf branches are not conjoined with the merged node: nothing shifts
    const plain = merge(clone(doc))
    expect(plain.properties.p).toEqual({ $ref: "#/definitions/X/oneOf/2" })
    expectContract(doc, plain, ["p"])
    // mergeCombinarySibling: the string branch becomes impossible, the others move; the distributed branch is not equal
    // to its input (it now carries type: object), so the pointer stays a copy of the original branch
    const distributed = merge(clone(doc), { mergeCombinarySibling: true })
    expect(distributed.definitions.X).toEqual({ oneOf: [{ type: "object", properties: { a: S } }, { type: "object", required: ["b"] }] })
    expect(distributed.properties.p).toEqual({ required: ["b"] })
    expectShiftContract(doc, distributed, ["p"])
  })

  it("B18.8.6 dropFalseBranches: false / dedupeAnyOf: false: nothing shifts, the pointers stay", () => {
    const doc = {
      definitions: { X: { anyOf: [clone(IMPOSSIBLE), clone(S), clone(S), clone(B)] } },
      properties: { p: { $ref: "#/definitions/X/anyOf/3" } },
    }
    const result = merge(clone(doc), { dropFalseBranches: false, dedupeAnyOf: false })
    expect(result.definitions.X).toEqual({ anyOf: [false, S, S, B] })
    expect(result.properties.p).toEqual({ $ref: "#/definitions/X/anyOf/3" })
    expectContract(doc, result, ["p"])
  })

  it("B18.8.7 idempotent: merging the relinked output again changes nothing", () => {
    const doc = {
      definitions: { X: { oneOf: [clone(IMPOSSIBLE), { type: "integer" }, clone(B)] } },
      properties: { p: { $ref: "#/definitions/X/oneOf/2" } },
    }
    const result = merge(clone(doc))
    expect(merge(clone(result))).toEqual(result)
  })
})
