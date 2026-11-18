import { describe, it, expect } from "vite-plus/test"
import type { JsonPath } from "json-crawl"

import { merge } from "../src/index.ts"

describe("merge errors handling", function () {
  it("should trigger onRefResolveError when merging a broken $ref", () => {
    const refs: string[] = []
    const onRefResolveError = (_message: string, _path: JsonPath, ref: string) => {
      refs.push(ref)
    }

    const result = merge({
      allOf: [
        {
          $ref: "#/foo",
        },
        {
          type: "object",
          properties: {
            name: {
              type: "string",
            },
          },
        },
      ],
    }, { onRefResolveError })

    expect(result).toEqual({
      allOf: [
        {
          $ref: "#/foo",
        },
        {
          type: "object",
          properties: {
            name: {
              type: "string",
            },
          },
        },
      ],
    })
    expect(refs).toEqual(["#/foo"])
  })

  it("should not merge $ref sibling without mergeRefSibling option", () => {
    const schema = {
      $ref: "#/permission",
      type: "object",
      properties: {
        admin: {
          type: "boolean",
        },
      }
    }

    const result = merge(schema, { mergeCombinarySibling: true, mergeRefSibling: true })

    // D-9 (VR-35): a broken $ref with siblings is left as it is
    expect(result).toEqual(schema)
  })
})
