/*
 * `$ref` siblings apply in every draft (author intent). Found by the fuzz test: draft-07 (and
 * draft-06/04, OpenAPI 3.0) validators ignore every sibling of `$ref`, while the merge conjoins the siblings of a `$ref`
 * with its target — inside an allOf item, at a node that has both `$ref` and `allOf`, with or without mergeRefSibling.
 * This is the documented reading now; the oracle reads draft-07 `$ref` siblings the same way (withRefSiblingsApplied).
 * Found by the corpus replay.
 */
import { describe, it, expect } from "vite-plus/test"
import { Validator } from "@cfworker/json-schema"

import { merge } from "../../src/index.ts"
import { checkCase, clone, profileRules, withRefSiblingsApplied, type FuzzCase } from "./oracle.ts"

const mergeCase = (c: FuzzCase) => merge(clone(c.schema), { ...c.options, rules: profileRules(c.profile) })
// a plain draft-07 validator (siblings of $ref ignored) and the reading
const plainDraft07 = (schema: unknown) => (instance: unknown) => new Validator(clone(schema) as any, "7", true).validate(instance).valid
const d24 = (schema: unknown) => plainDraft07(withRefSiblingsApplied(schema))

describe("fuzz: $ref siblings apply in every draft", () => {
  const ki1a: FuzzCase = {
    profile: "draft-07",
    schema: { definitions: { a: { type: "string" } }, allOf: [{ $ref: "#/definitions/a", maxLength: 3 }, { minLength: 1 }] },
  }
  it("KI-1a draft-07: a `$ref` allOf member's sibling `maxLength` is applied", () => {
    expect(mergeCase(ki1a)).toEqual({ definitions: { a: { type: "string" } }, type: "string", minLength: 1, maxLength: 3 })
    // a plain draft-07 validator ignores maxLength next to $ref; the documented reading applies it
    expect(plainDraft07(ki1a.schema)("abcd")).toBe(true)
    expect(d24(ki1a.schema)("abcd")).toBe(false)
    expect(checkCase(ki1a)).toBeUndefined()
    expect(checkCase({ ...ki1a, profile: "2020-12" })).toBeUndefined()
  })

  const ki1b: FuzzCase = {
    profile: "draft-07",
    schema: {
      $ref: "#/definitions/MySchema",
      allOf: [{ $ref: "#/definitions/Other" }],
      definitions: { Other: { properties: { b: { type: "number" } } }, MySchema: { type: "object", properties: { a: { type: "string" } } } },
    },
  }
  it("KI-1b draft-07: `allOf` next to a root `$ref` is applied", () => {
    const merged: any = mergeCase(ki1b)
    expect(merged.$ref).toBeUndefined()
    expect(merged.properties).toEqual({ a: { type: "string" }, b: { type: "number" } })
    expect(plainDraft07(ki1b.schema)({ b: "x" })).toBe(true)
    expect(d24(ki1b.schema)({ b: "x" })).toBe(false)
    expect(checkCase(ki1b)).toBeUndefined()
  })

  const ki1c: FuzzCase = {
    profile: "draft-07",
    options: { mergeRefSibling: true },
    schema: {
      definitions: { A: { type: "object", properties: { id: { type: "string" } } } },
      allOf: [{ $ref: "#/definitions/A", required: ["extra"] }, { type: "object" }],
    },
  }
  it("KI-1c draft-07 + mergeRefSibling: sibling `required` of a `$ref` allOf member is applied", () => {
    const merged: any = mergeCase(ki1c)
    expect(merged.required).toEqual(["extra"])
    expect(plainDraft07(ki1c.schema)({})).toBe(true)
    expect(d24(ki1c.schema)({})).toBe(false)
    expect(checkCase(ki1c)).toBeUndefined()
  })

  it("the oracle rewrite keeps every pointer into the node valid", () => {
    const schema = { definitions: { A: { $ref: "#/definitions/B", properties: { x: { type: "string" } }, allOf: [{ minProperties: 1 }] }, B: { type: "object" } } }
    expect(withRefSiblingsApplied(schema)).toEqual({
      definitions: { A: { properties: { x: { type: "string" } }, allOf: [{ minProperties: 1 }, { $ref: "#/definitions/B" }] }, B: { type: "object" } },
    })
    // a bare $ref and instance values are left as they are
    expect(withRefSiblingsApplied({ $ref: "#/x", enum: [{ $ref: "#/y", a: 1 }] })).toEqual({ allOf: [{ $ref: "#/x" }], enum: [{ $ref: "#/y", a: 1 }] })
    expect(withRefSiblingsApplied({ properties: { p: { $ref: "#/x" } } })).toEqual({ properties: { p: { $ref: "#/x" } } })
  })
})
