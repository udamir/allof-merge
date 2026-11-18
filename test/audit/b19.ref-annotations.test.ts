/*
 * B19 — refAnnotations (#222): node-level annotations that arrive only
 * through a `$ref` are dropped with "omit" / a key list; the node's own values always stay; default "merge" keeps the
 * 0.x / 1.0.0 output. With mergeCombinarySibling a oneOf/anyOf branch that is a `$ref` keeps its target's
 * annotations (: doc viewers label branches by them); a branch of a oneOf/anyOf product keeps the
 * annotations of its `$ref` components, combined by the keyword's merge rule.
 */
import { describe, it, expect } from "vite-plus/test"
import { createMerger, DEFAULT_OMITTED_ANNOTATIONS, graphapiMergeRules, jsonSchemaMergeRules, openApiMergeRules, type RefAnnotations } from "../../src/index.ts"
import { expectRefsResolve } from "../helpers/refIntegrity.ts"
import { clone, deepFreeze, expectSameValidation, isJsonSerializable, merge, sharesReferences } from "./helpers.ts"

const S = (name: string) => ({ $ref: `#/components/schemas/${name}` })

// the #222 example
const doc222 = () => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
  components: {
    schemas: {
      Base: {
        title: "Base",
        description: "Base entity",
        $comment: "base note",
        type: "object",
        properties: { id: { type: "string", title: "Id" } },
        "x-go-name": "BaseEntity",
        examples: [{ id: "1" }],
        deprecated: true,
      },
      Other: { title: "Other", description: "Other one", properties: { x: { type: "number" } } },
      Derived: { allOf: [S("Base"), { type: "object", properties: { name: { type: "string" } } }] },
      Titled: { title: "Titled", allOf: [S("Base"), { properties: { name: { type: "string" } } }] },
      Alias: { allOf: [S("Base")] },
      Two: { allOf: [S("Base"), S("Other")] },
      RefSib: { $ref: "#/components/schemas/Base", description: "override" },
      RefSibT: { allOf: [{ $ref: "#/components/schemas/Base", title: "Explicit" }] },
      Prop: { type: "object", properties: { owner: { allOf: [S("Base")], description: "The owner" } } },
      OneOfT: { oneOf: [S("Base"), S("Other")], properties: { k: { type: "string" } } },
      Inline: { allOf: [{ title: "A", type: "object" }, { title: "B" }] },
    },
  },
})

const FLAGS = { mergeRefSibling: true, mergeCombinarySibling: true }
const schemasOf = (refAnnotations?: RefAnnotations) => merge(doc222(), { ...FLAGS, refAnnotations }).components.schemas

const annotationsOf = (schema: Record<string, unknown>) => {
  const result: Record<string, unknown> = {}
  for (const key of ["title", "description", "$comment", "x-go-name", "examples", "deprecated"]) {
    if (key in schema) { result[key] = schema[key] }
  }
  return result
}

const BASE_ANNOTATIONS = { title: "Base", description: "Base entity", $comment: "base note", "x-go-name": "BaseEntity", examples: [{ id: "1" }], deprecated: true }
const KEPT_BY_OMIT = { "x-go-name": "BaseEntity", examples: [{ id: "1" }], deprecated: true }

describe("B19.1 default \"merge\": output unchanged", () => {
  it("B19.1.1 the #222 document: inherited annotations are promoted as before", () => {
    const merged = schemasOf()
    expect(merged).toEqual(schemasOf("merge"))
    expect(annotationsOf(merged.Derived)).toEqual(BASE_ANNOTATIONS)
    expect(annotationsOf(merged.Titled)).toEqual({ ...BASE_ANNOTATIONS, title: "Titled" })
    expect(annotationsOf(merged.Alias)).toEqual(BASE_ANNOTATIONS)
    expect(annotationsOf(merged.Two)).toEqual({ ...BASE_ANNOTATIONS, title: "Other", description: "Other one" })
    expect(annotationsOf(merged.RefSib)).toEqual({ ...BASE_ANNOTATIONS, description: "override" })
    expect(annotationsOf(merged.Prop.properties.owner)).toEqual({ ...BASE_ANNOTATIONS, description: "The owner" })
    expect(DEFAULT_OMITTED_ANNOTATIONS).toEqual(["title", "description", "$comment"])
  })
})

describe("B19.2 \"omit\"", () => {
  const merged = schemasOf("omit")

  it("B19.2.1 Derived / Alias / Two lose title, description, $comment; other promoted keys stay", () => {
    expect(annotationsOf(merged.Derived)).toEqual(KEPT_BY_OMIT)
    expect(annotationsOf(merged.Alias)).toEqual(KEPT_BY_OMIT)
    expect(annotationsOf(merged.Two)).toEqual(KEPT_BY_OMIT)
    expect(merged.Derived.properties).toEqual({ id: { type: "string", title: "Id" }, name: { type: "string" } })
    expect(merged.Derived.type).toBe("object")
  })

  it("B19.2.2 the node's own title / description stay", () => {
    expect(annotationsOf(merged.Titled)).toEqual({ ...KEPT_BY_OMIT, title: "Titled" })
    expect(annotationsOf(merged.Prop.properties.owner)).toEqual({ ...KEPT_BY_OMIT, description: "The owner" })
  })

  it("B19.2.3 a sibling of the $ref allOf item is the node's own", () => {
    expect(annotationsOf(merged.RefSibT)).toEqual({ ...KEPT_BY_OMIT, title: "Explicit" })
  })

  it("B19.2.4 inline allOf members are the node's own: last wins as before", () => {
    expect(merged.Inline).toEqual({ type: "object", title: "B" })
  })

  it("B19.2.5 nested property annotations of the target stay", () => {
    expect(merged.Derived.properties.id.title).toBe("Id")
  })

  it("B19.2.6 mergeRefSibling: the target's title is dropped, the own description stays", () => {
    expect(annotationsOf(merged.RefSib)).toEqual({ ...KEPT_BY_OMIT, description: "override" })
  })

  it("B19.2.7 the referenced schemas themselves are unchanged", () => {
    expect(merged.Base).toEqual(doc222().components.schemas.Base)
    expect(merged.Other).toEqual(doc222().components.schemas.Other)
  })
})

describe("B19.3 key lists", () => {
  it("B19.3.1 [\"title\", \"x-*\"]: title and every x- key of the target dropped, description kept", () => {
    const merged = schemasOf(["title", "x-*"])
    expect(annotationsOf(merged.Derived)).toEqual({ description: "Base entity", $comment: "base note", examples: [{ id: "1" }], deprecated: true })
    expect(annotationsOf(merged.Titled)).toEqual({ description: "Base entity", $comment: "base note", examples: [{ id: "1" }], deprecated: true, title: "Titled" })
  })

  it("B19.3.2 \"omit\" equals the explicit default list; an empty list equals \"merge\"", () => {
    expect(schemasOf("omit")).toEqual(schemasOf([...DEFAULT_OMITTED_ANNOTATIONS]))
    expect(schemasOf([])).toEqual(schemasOf("merge"))
  })

  it("B19.3.3 a prefix entry and an exact entry for the same keys; non-annotation keys can be listed too", () => {
    const merged = schemasOf(["examples", "deprecated", "$comm*"])
    expect(annotationsOf(merged.Derived)).toEqual({ title: "Base", description: "Base entity", "x-go-name": "BaseEntity" })
  })

  it("B19.3.4 a key present on the node and through the ref keeps the node's own value", () => {
    const doc = { definitions: { B: { title: "B", "x-a": 1, type: "string" } }, properties: { p: { "x-a": 2, allOf: [{ $ref: "#/definitions/B" }] } } }
    expect(merge(clone(doc), { refAnnotations: ["x-*", "title"] }).properties.p).toEqual({ type: "string", "x-a": 2 })
    expect(merge(clone(doc), { refAnnotations: "merge" }).properties.p).toEqual({ title: "B", "x-a": 2, type: "string" })
  })
})

describe("B19.4 nesting, aliases, combinaries", () => {
  it("B19.4.1 nested target: A = allOf [$ref B, { title: A }] used through $ref drops both titles", () => {
    const doc = {
      definitions: {
        B: { title: "B", type: "object" },
        A: { allOf: [{ $ref: "#/definitions/B" }, { title: "A", description: "a" }] },
      },
      properties: { p: { allOf: [{ $ref: "#/definitions/A" }, { minProperties: 1 }] } },
    }
    const result = merge(clone(doc), { refAnnotations: "omit" })
    expect(result.properties.p).toEqual({ type: "object", minProperties: 1 })
    // A merged in its own right: its inline member is its own, B's title is inherited
    expect(result.definitions.A).toEqual({ type: "object", title: "A", description: "a" })
  })

  it("B19.4.2 mergeCombinarySibling: a $ref branch keeps its target's annotations, the node-level ones are dropped", () => {
    const merged = schemasOf("omit")
    const [base, other] = merged.OneOfT.oneOf
    expect(base.title).toBe("Base")
    expect(base.description).toBe("Base entity")
    expect(other.title).toBe("Other")
    expect(base.properties).toEqual({ k: { type: "string" }, id: { type: "string", title: "Id" } })
    // same as "merge" there
    expect(merged.OneOfT).toEqual(schemasOf("merge").OneOfT)
  })

  it("B19.4.3 a branch $ref inside a node that is itself merged: the branch keeps, the node-level target drops", () => {
    const doc = {
      definitions: { Base: { title: "Base", type: "object" }, A: { title: "A", required: ["a"] }, B: { title: "B", required: ["b"] } },
      properties: { p: { allOf: [{ $ref: "#/definitions/Base" }, { oneOf: [{ $ref: "#/definitions/A" }, { $ref: "#/definitions/B" }] }] } },
    }
    const result = merge(clone(doc), { refAnnotations: "omit", mergeCombinarySibling: true })
    expect(result.properties.p).toEqual({ oneOf: [{ type: "object", title: "A", required: ["a"] }, { type: "object", title: "B", required: ["b"] }] })
  })

  it("B19.4.4 without mergeCombinarySibling a $ref branch stays a $ref", () => {
    const merged = merge(doc222(), { refAnnotations: "omit" }).components.schemas
    expect(merged.OneOfT).toEqual(doc222().components.schemas.OneOfT)
  })

  it("B19.4.5 a oneOf product of two $ref groups: the branch keeps its components' annotations, the title rule decides", () => {
    const doc = {
      definitions: { A: { title: "A", type: "string" }, B: { title: "B", minLength: 1 } },
      properties: { p: { allOf: [{ oneOf: [{ $ref: "#/definitions/A" }] }, { oneOf: [{ $ref: "#/definitions/B" }] }] } },
    }
    expect(merge(clone(doc), { refAnnotations: "omit" }).properties.p).toEqual({ oneOf: [{ title: "B", type: "string", minLength: 1 }] })
    expect(merge(clone(doc)).properties.p).toEqual({ oneOf: [{ title: "B", type: "string", minLength: 1 }] })
  })
})

describe("B19.5 reference resolutions keep the target's annotations", () => {
  it("B19.5.1 a bare $ref into an allOf member that is copied keeps its target's annotations", () => {
    const doc = {
      definitions: {
        Pet: { allOf: [{ title: "Id", type: "integer", description: "pet id" }, { minimum: 1 }] },
      },
      properties: { id: { $ref: "#/definitions/Pet/allOf/0" } },
    }
    const result = merge(clone(doc), { refAnnotations: "omit" })
    expect(result.properties.id).toEqual({ title: "Id", type: "integer", description: "pet id" })
    expectRefsResolve(doc, result)
  })

  it("B19.5.2 the copied target's own $ref members are inherited (dropped), like the target merged in its own right", () => {
    const doc = {
      definitions: {
        Base: { title: "Base", type: "object" },
        A: { properties: { x: { title: "X", allOf: [{ $ref: "#/definitions/Base" }, { description: "x" }] } }, allOf: [{ properties: { x: { minProperties: 1 } } }] },
      },
      properties: { p: { $ref: "#/definitions/A/properties/x" } },
    }
    const result = merge(clone(doc), { refAnnotations: "omit" })
    expect(result.definitions.A.properties.x).toEqual({ title: "X", type: "object", description: "x", minProperties: 1 })
    expect(result.properties.p).toEqual({ title: "X", type: "object", description: "x" })
  })

  it("B19.5.3 a link to an equal merged location stays a link", () => {
    const doc = {
      definitions: {
        Base: { title: "Base", type: "object", properties: { id: { title: "Id", type: "string" } } },
        Pet: { allOf: [{ $ref: "#/definitions/Base" }, { required: ["id"] }] },
      },
      properties: { id: { $ref: "#/definitions/Pet/allOf/0/properties/id" } },
    }
    const result = merge(clone(doc), { refAnnotations: "omit" })
    expect(result.definitions.Pet).toEqual({ type: "object", properties: { id: { title: "Id", type: "string" } }, required: ["id"] })
    expect(result.properties.id).toEqual({ $ref: "#/definitions/Base/properties/id" })
  })
})

describe("B19.6 memo, caches, cycles", () => {
  it("B19.6.1 one document with two mergers (\"merge\" / \"omit\") and one merger twice: each result follows its own option", () => {
    const shared = doc222()
    const omit = createMerger({ ...FLAGS, refAnnotations: "omit" })
    const keep = createMerger({ ...FLAGS })
    const a = omit.merge(shared) as any
    const b = keep.merge(shared) as any
    const a2 = omit.merge(shared) as any
    expect(a.components.schemas.Derived.title).toBeUndefined()
    expect(b.components.schemas.Derived.title).toBe("Base")
    expect(a2).toEqual(a)
    expect(sharesReferences(a, b)).toBe(false)
  })

  it("B19.6.2 createMerger reuse across documents with freezeOutput: the cached stripped copies are not mutated", () => {
    const merger = createMerger({ refAnnotations: "omit", freezeOutput: true })
    const source = deepFreeze(doc222())
    const first = merger.merge(source) as any
    const second = merger.merge(deepFreeze(doc222())) as any
    expect(Object.isFrozen(first)).toBe(true)
    expect(second).toEqual(first)
    expect(source.components.schemas.Base.title).toBe("Base")
    expect(first.components.schemas.Derived.title).toBeUndefined()
  })

  it("B19.6.3 a cycle through allOf and $ref: cycle $ref placeholder as with \"merge\", serializable", () => {
    const doc = {
      definitions: {
        Node: { title: "Node", allOf: [{ properties: { next: { $ref: "#/definitions/Next" } } }, { type: "object" }] },
        Next: { title: "Next", allOf: [{ $ref: "#/definitions/Node" }, { minProperties: 0 }] },
      },
      properties: { root: { $ref: "#/definitions/Node" } },
    }
    const omit = merge(clone(doc), { refAnnotations: "omit" })
    const plain = merge(clone(doc))
    expect(isJsonSerializable(omit)).toBe(true)
    expectRefsResolve(doc, omit)
    expect(omit.definitions.Node.title).toBe("Node")
    expect(omit.definitions.Next.title).toBe("Next")
    const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === "title" ? undefined : v)))
    expect(strip(omit)).toEqual(strip(plain))
  })

  it("B19.6.4 an identity keyword and an annotation of the target: both stripped, the node's own identity kept", () => {
    const doc = { $defs: { B: { $id: "https://x/b", $anchor: "b", title: "B", type: "string" } }, properties: { p: { $comment: "own", allOf: [{ $ref: "#/$defs/B" }] } } }
    const result = merge(clone(doc), { rules: jsonSchemaMergeRules("2020-12"), refAnnotations: "omit" })
    expect(result.properties.p).toEqual({ $comment: "own", type: "string" })
  })
})

describe("B19.7 rule sets and equivalence", () => {
  it.each(["3.0.x", "3.1.x"] as const)("B19.7.1 OpenAPI %s rules: same behaviour", (version) => {
    const doc = doc222()
    doc.openapi = version === "3.0.x" ? "3.0.3" : "3.1.0"
    const merged = merge(doc, { rules: openApiMergeRules(version), refAnnotations: "omit" }).components.schemas
    expect(annotationsOf(merged.Derived)).toEqual(KEPT_BY_OMIT)
    expect(annotationsOf(merged.Titled)).toEqual({ ...KEPT_BY_OMIT, title: "Titled" })
  })

  it("B19.7.2 JSON Schema draft-07 / 2020-12 rules", () => {
    for (const draft of ["draft-07", "2020-12"] as const) {
      const doc = { definitions: { B: { title: "B", description: "b", type: "string" } }, allOf: [{ $ref: "#/definitions/B" }, { minLength: 1 }] }
      expect(merge(doc, { rules: jsonSchemaMergeRules(draft), refAnnotations: "omit" })).toEqual({ definitions: doc.definitions, type: "string", minLength: 1 })
    }
  })

  it("B19.7.3 GraphApi rules: the inherited description is dropped, the own one stays", () => {
    const doc = {
      graphapi: "0.1.2",
      components: {
        objects: {
          Base: { title: "Base", description: "base", type: "object", properties: { id: { type: "string" } } },
          User: { description: "a user", allOf: [{ $ref: "#/components/objects/Base" }, { type: "object", properties: { name: { type: "string" } } }] },
        },
      },
    }
    const result = merge(clone(doc), { rules: graphapiMergeRules, refAnnotations: "omit" })
    expect(result.components.objects.User).toEqual({ description: "a user", type: "object", properties: { id: { type: "string" }, name: { type: "string" } } })
  })

  it("B19.7.4 \"omit\" output validates exactly like the input (annotations do not validate)", () => {
    const doc = doc222()
    const result = merge(clone(doc), { ...FLAGS, refAnnotations: "omit" })
    const VALUES: unknown[] = [null, "a", 1, {}, { id: "1" }, { id: 1 }, { name: "n" }, { name: 1 }, { k: 1 }, { x: "1" }, { id: "1", x: 2, k: "k" }]
    for (const name of ["Derived", "Titled", "Alias", "Two", "RefSib", "RefSibT", "Prop", "OneOfT", "Inline"]) {
      const wrap = (d: any) => ({ ...d, $ref: `#/components/schemas/${name}` })
      expectSameValidation(wrap(doc), wrap(result), VALUES, "2020")
    }
  })
})

describe("B19.8 product branches keep the annotations of their $ref components", () => {
  const R = (name: string) => ({ $ref: `#/definitions/${name}` })
  const defs = () => ({
    Cat: { title: "Cat", description: "a cat", type: "object", required: ["meow"] },
    Dog: { title: "Dog", description: "a dog", type: "object", required: ["bark"] },
    Indoor: { title: "Indoor", required: ["room"] },
    Outdoor: { title: "Outdoor", description: "outside", required: ["yard"] },
  })
  const product = (extra: Record<string, unknown> = {}) => ({
    definitions: defs(),
    properties: { p: { allOf: [{ oneOf: [R("Cat"), R("Dog")] }, { oneOf: [R("Indoor"), R("Outdoor")] }], ...extra } },
  })
  const titles = (schema: any) => schema.oneOf.map((branch: any) => branch.title)
  const descriptions = (schema: any) => schema.oneOf.map((branch: any) => branch.description)

  it("B19.8.1 default title rule (last wins): Cat × Indoor is titled Indoor; the same output as \"merge\"", () => {
    const omit = merge(clone(product()), { refAnnotations: "omit" }).properties.p
    expect(titles(omit)).toEqual(["Indoor", "Outdoor", "Indoor", "Outdoor"])
    expect(omit.oneOf[0]).toEqual({ title: "Indoor", description: "a cat", type: "object", required: ["meow", "room"] })
    expect(omit).toEqual(merge(clone(product())).properties.p)
  })

  it("B19.8.2 description: the default rule over the components that carry one", () => {
    const omit = merge(clone(product()), { refAnnotations: "omit" }).properties.p
    expect(descriptions(omit)).toEqual(["a cat", "outside", "a dog", "outside"])
  })

  it("B19.8.3 a custom /title rule is honoured: first wins, concatenation", () => {
    const firstWins = jsonSchemaMergeRules("draft-06", { "/title": { $: (values: unknown[]) => values[0] } })
    expect(titles(merge(clone(product()), { rules: firstWins, refAnnotations: "omit" }).properties.p)).toEqual(["Cat", "Cat", "Dog", "Dog"])
    const joined = jsonSchemaMergeRules("draft-06", { "/title": { $: (values: unknown[]) => values.join(" & ") } })
    expect(titles(merge(clone(product()), { rules: joined, refAnnotations: "omit" }).properties.p)).toEqual(["Cat & Indoor", "Cat & Outdoor", "Dog & Indoor", "Dog & Outdoor"])
    // a key list drops only its keys: description is kept from the components, title is resolved by the rule
    const listed = merge(clone(product()), { rules: joined, refAnnotations: ["description"] }).properties.p
    expect(titles(listed)).toEqual(["Cat & Indoor", "Cat & Outdoor", "Dog & Indoor", "Dog & Outdoor"])
    expect(descriptions(listed)).toEqual(["a cat", "outside", "a dog", "outside"])
  })

  it("B19.8.4 a $ref component and an inline component: both contribute, the rule decides", () => {
    const doc = { definitions: defs(), properties: { p: { allOf: [{ oneOf: [R("Cat")] }, { oneOf: [{ title: "Inline", required: ["x"] }, { required: ["y"] }] }] } } }
    const omit = merge(clone(doc), { refAnnotations: "omit" }).properties.p
    expect(omit.oneOf).toEqual([
      { title: "Inline", description: "a cat", type: "object", required: ["meow", "x"] },
      { title: "Cat", description: "a cat", type: "object", required: ["meow", "y"] },
    ])
  })

  it("B19.8.5 node-level inherited annotations are still omitted next to a product", () => {
    const doc = { definitions: { ...defs(), Base: { title: "Base", description: "base", $comment: "c", type: "object" } }, properties: { p: { allOf: [R("Base"), { oneOf: [R("Indoor")] }, { oneOf: [{ required: ["x"] }] }] } } }
    const omit = merge(clone(doc), { refAnnotations: "omit" }).properties.p
    expect(omit).toEqual({ type: "object", oneOf: [{ title: "Indoor", required: ["room", "x"] }] })
    // a product component reached through a nested $ref of the component's own allOf is node-level of that component
    const nested = { definitions: { ...defs(), Wrap: { allOf: [R("Cat")], required: ["w"] } }, properties: { p: { allOf: [{ oneOf: [R("Wrap")] }, { oneOf: [{ required: ["x"] }] }] } } }
    expect(merge(clone(nested), { refAnnotations: "omit" }).properties.p).toEqual({ oneOf: [{ type: "object", required: ["meow", "w", "x"] }] })
  })

  it("B19.8.6 mergeCombinarySibling: the distributed product branch keeps its components' annotations", () => {
    const doc = product({ properties: { k: { type: "string" } } })
    const omit = merge(clone(doc), { refAnnotations: "omit", mergeCombinarySibling: true }).properties.p
    expect(titles(omit)).toEqual(["Indoor", "Outdoor", "Indoor", "Outdoor"])
    expect(omit.oneOf[0]).toEqual({ properties: { k: { type: "string" } }, type: "object", title: "Indoor", description: "a cat", required: ["meow", "room"] })
    expect(omit).toEqual(merge(clone(doc), { mergeCombinarySibling: true }).properties.p)
    // a node-level $ref next to the distributed product still drops its annotations
    const withBase = { definitions: { ...defs(), Base: { title: "Base", type: "object" } }, properties: { p: { allOf: [R("Base"), { oneOf: [R("Indoor")] }, { oneOf: [R("Outdoor")] }], properties: { k: { type: "string" } } } } }
    const distributed = merge(clone(withBase), { refAnnotations: "omit", mergeCombinarySibling: true }).properties.p
    expect(distributed).toEqual({ oneOf: [{ properties: { k: { type: "string" } }, type: "object", title: "Outdoor", description: "outside", required: ["room", "yard"] }] })
  })

  it("B19.8.7 anyOf products follow the same rule; the output validates like the input", () => {
    const doc = { definitions: defs(), properties: { p: { allOf: [{ anyOf: [R("Cat"), R("Dog")] }, { anyOf: [R("Indoor")] }] } } }
    const omit = merge(clone(doc), { refAnnotations: "omit" })
    expect(omit.properties.p.anyOf.map((branch: any) => branch.title)).toEqual(["Indoor", "Indoor"])
    const VALUES: unknown[] = [null, 1, {}, { meow: 1 }, { meow: 1, room: 1 }, { bark: 1, room: 1 }, { bark: 1 }]
    const wrap = (d: any) => ({ ...d, $ref: "#/properties/p" })
    expectSameValidation(wrap(clone(doc)), wrap(omit), VALUES, "2020")
    expectRefsResolve(doc, omit)
  })
})
