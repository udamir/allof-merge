import { describe, it, test, expect } from "vite-plus/test"
import { syncClone } from "json-crawl"

import * as api from "../../src/index.ts"
import { allOfResolverHook, createRef, isAnyOfNode, isOneOfNode, isRefNode, jsonSchemaMergeRules, mergeValues, parseRef, pathMask, resolvePointer } from "../../src/index.ts"
import { merge } from "./helpers.ts"

// B11 - public API surface and utilities

describe("B11.1 exports", () => {
  it("B11.1.1 exports the documented functions", () => {
    for (const name of ["merge", "allOfResolverHook", "jsonSchemaMergeRules", "openApiMergeRules", "graphapiMergeRules", "isRefNode", "isAnyOfNode", "isOneOfNode", "parseRef", "createRef", "resolvePointer", "mergeValues", "pathMask"]) {
      expect((api as any)[name]).toBeDefined()
    }
    expect(typeof api.merge).toBe("function")
    expect(typeof api.graphapiMergeRules).toBe("object")
  })

  it("B11.1.2 allOfResolverHook can be used directly with syncClone", () => {
    const hook = allOfResolverHook({ mergeRefSibling: true })
    const result: any = syncClone({ definitions: { A: { type: "string" } }, properties: { a: { $ref: "#/definitions/A", minLength: 1 } }, allOf: [{ type: "object" }, { required: ["a"] }] }, hook, { rules: jsonSchemaMergeRules() })
    expect(result).toMatchObject({ type: "object", required: ["a"], properties: { a: { type: "string", minLength: 1 } } })
  })

  it("B11.1.3 allOfResolverHook without rules does nothing", () => {
    const data = { allOf: [{ type: "string" }, { minLength: 1 }] }
    expect(syncClone(data, allOfResolverHook())).toEqual(data)
  })
})

describe("B11.2 node predicates", () => {
  it("B11.2.1 isRefNode", () => {
    expect(isRefNode({ $ref: "#" })).toBeTruthy()
    expect(isRefNode({ $ref: "#/a", description: "d" })).toBeTruthy()
    expect(isRefNode({ $ref: 1 })).toBeFalsy()
    expect(isRefNode({ $ref: "" })).toBeFalsy()
    expect(isRefNode({})).toBeFalsy()
    expect(isRefNode(null)).toBeFalsy()
    expect(isRefNode("#/a")).toBeFalsy()
  })

  it("B11.2.2 isAnyOfNode / isOneOfNode", () => {
    expect(isAnyOfNode({ anyOf: [] })).toBeTruthy()
    expect(isAnyOfNode({ anyOf: {} })).toBeFalsy()
    expect(isAnyOfNode({ oneOf: [] })).toBeFalsy()
    expect(isOneOfNode({ oneOf: [{}] })).toBeTruthy()
    expect(isOneOfNode({ oneOf: "x" })).toBeFalsy()
    expect(isOneOfNode(undefined)).toBeFalsy()
  })
})

describe("B11.3 parseRef / createRef", () => {
  it("B11.3.1 parses local pointers with escapes", () => {
    expect(parseRef("#/a~1b/c~0d")).toEqual({ filePath: "", pointer: "/a~1b/c~0d", normalized: "#/a~1b/c~0d", jsonPath: ["a/b", "c~d"] })
  })

  it("B11.3.2 parses root references", () => {
    expect(parseRef("#")).toEqual({ filePath: "", pointer: "", normalized: "#", jsonPath: [] })
    // `#/` is the member "" of the root (RFC 6901), not the root
    expect(parseRef("#/")).toEqual({ filePath: "", pointer: "/", normalized: "#/", jsonPath: [""] })
  })

  it("B11.3.3 parses external references", () => {
    expect(parseRef("file.json#/x")).toEqual({ filePath: "file.json", pointer: "/x", normalized: "file.json#/x", jsonPath: ["x"] })
    expect(parseRef("file.json")).toEqual({ filePath: "file.json", pointer: "", normalized: "file.json", jsonPath: [] })
  })

  // 0.x bug, fixed: the basePath parameter is only applied when the file part is undefined, but "#/x".split("#") yields "" so basePath is never used for local refs
  test("B11.3.3b applies basePath to local references", () => {
    expect(parseRef("#/x", "base.json").filePath).toBe("base.json")
    expect(parseRef("#/x", "base.json").normalized).toBe("base.json#/x")
  })

  it("B11.3.4 decodes percent-encoded segments", () => {
    expect(parseRef("#/a%20b").jsonPath).toEqual(["a b"])
  })

  it("B11.3.5 createRef builds normalized refs", () => {
    expect(createRef()).toBe("#")
    expect(createRef("", "/a")).toBe("#/a")
    expect(createRef(undefined, "/a")).toBe("#/a")
    expect(createRef("f.json")).toBe("f.json")
    expect(createRef("f.json", "/a")).toBe("f.json#/a")
  })

  it("B11.3.6 parseRef and createRef round-trip", () => {
    for (const ref of ["#", "#/a/b", "f.json", "f.json#/a~1b"]) {
      const { filePath, pointer } = parseRef(ref)
      expect(createRef(filePath, pointer)).toBe(ref)
    }
  })
})

describe("B11.4 resolvePointer", () => {
  const data = { a: { "b/c": [1, { d: 2 }], "e~f": "x" }, r: { $ref: "#/a" }, self: { $ref: "#/self" }, cyc1: { $ref: "#/cyc2" }, cyc2: { $ref: "#/cyc1" } }

  it("B11.4.1 resolves plain pointers, array indices and escapes", () => {
    expect(resolvePointer(data, "")).toBe(data)
    expect(resolvePointer(data, "/a/b~1c/1/d")).toBe(2)
    expect(resolvePointer(data, "/a/e~0f")).toBe("x")
    expect(resolvePointer(data, "/a/b~1c/0")).toBe(1)
  })

  it("B11.4.2 returns undefined for missing paths, out-of-range indices and non-object data", () => {
    expect(resolvePointer(data, "/nope")).toBeUndefined()
    expect(resolvePointer(data, "/a/b~1c/5")).toBeUndefined()
    expect(resolvePointer(data, "/a/e~0f/x")).toBeUndefined()
    expect(resolvePointer(5, "/a")).toBeUndefined()
    expect(resolvePointer(null, "/a")).toBeUndefined()
    expect(resolvePointer({ a: null }, "/a/b")).toBeUndefined()
  })

  // 0.x bug, fixed: when an intermediate node is a $ref the remaining path segments are not applied to the resolved target
  test("B11.4.3 resolves through an intermediate $ref and applies the remaining path", () => {
    expect(resolvePointer(data, "/r/e~0f")).toBe("x")
    expect(resolvePointer({ a: { $ref: "#/b" }, b: { c: 1 } }, "/a/c")).toBe(1)
  })

  // 0.x bug, fixed: a self-referencing $ref returns the $ref node itself instead of undefined
  test("B11.4.4 returns undefined for a path through a self-referencing $ref", () => {
    expect(resolvePointer(data, "/self/x")).toBeUndefined()
    expect(resolvePointer(data, "/cyc1/x")).toBeUndefined()
  })
})

describe("B11.5 mergeValues and pathMask", () => {
  it("B11.5.1 deep merges objects, concatenates arrays and lets the patch win otherwise", () => {
    expect(mergeValues({ a: 1, b: { c: 1 } }, { b: { d: 2 }, e: [1] })).toEqual({ a: 1, b: { c: 1, d: 2 }, e: [1] })
    expect(mergeValues([1], [2])).toEqual([1, 2])
    expect(mergeValues({ a: 1 }, 5)).toBe(5)
    expect(mergeValues(1, { a: 1 })).toEqual({ a: 1 })
    expect(mergeValues({ a: [1] }, { a: [2] })).toEqual({ a: [1, 2] })
  })

  it("B11.5.2 mergeValues does not mutate its arguments", () => {
    const a = { x: { y: 1 }, arr: [1] }
    const b = { x: { z: 2 }, arr: [2] }
    mergeValues(a, b)
    expect(a).toEqual({ x: { y: 1 }, arr: [1] })
    expect(b).toEqual({ x: { z: 2 }, arr: [2] })
  })

  it("B11.5.3 pathMask exposes the pointer escaping regexps", () => {
    expect(Object.keys(pathMask).sort()).toEqual(["escapedSlash", "escapedTilde", "slash", "tilde"])
    expect("a/b~c".replace(pathMask.tilde, "~0").replace(pathMask.slash, "~1")).toBe("a~1b~0c")
    expect("a~1b~0c".replace(pathMask.escapedSlash, "/").replace(pathMask.escapedTilde, "~")).toBe("a/b~c")
  })
})

describe("B11.6 merge options", () => {
  it("B11.6.1 accepts no options", () => {
    expect(merge({ allOf: [{ type: "string" }, { minLength: 1 }] })).toEqual({ type: "string", minLength: 1 })
  })

  it("B11.6.2 accepts an empty options object", () => {
    expect(merge({ allOf: [{ type: "string" }, { minLength: 1 }] }, {})).toEqual({ type: "string", minLength: 1 })
  })

  it("B11.6.3 source defaults to the merged document itself", () => {
    const result = merge({ definitions: { A: { type: "string" } }, allOf: [{ $ref: "#/definitions/A" }] })
    expect(result).toMatchObject({ type: "string" })
  })
})
