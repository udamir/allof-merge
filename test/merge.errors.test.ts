import { JsonPath } from "json-crawl"

import { merge } from "../src"

describe("merge errors handling", function () {
  it("should trigger onRefResolveError when mergin groken $ref", (done) => {

    const onRefResolveError = (message: string, path: JsonPath, ref: string) => {
      
      expect(ref).toBe ("#/foo")
      done()
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

    expect(result).toEqual({
      allOf: [{
        $ref: "#/permission",
      },{
        type: "object",
        properties: {
          admin: {
            type: "boolean",
          },
        }
      }]
    })
  })
})
