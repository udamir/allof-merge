import { JsonPath } from "json-crawl"

import { merge } from "../src"

describe("merge errors handling", function () {
  it("should trigger onRefResolveError when mergin groken $ref", (done) => {

    const onRefResolveError = (message: string, path: JsonPath, ref: string) => {
      expect(ref).toEqual("#/foo")
      done()
    }

    const result = merge({
      allOf: [
        {
          $ref: "#/foo",
        },
        {
          $ref: "#/bar",
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
          $ref: "#/bar",
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
    const source = {
      foo: {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
        },
      },
      bar: {
        type: "object",
        properties: {
          permissions: {
            $ref: "#/permission",
            type: "object",
            properties: {
              admin: {
                type: "boolean",
              },
            },
          },
        },
      },
      permission: {
        type: "object",
        properties: {
          level: {
            type: "number",
          },
        },
      },
    }

    const result = merge(
      {
        allOf: [
          {
            $ref: "#/foo",
          },
          {
            $ref: "#/bar",
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
      },
      { source }
    )

    expect(result).toEqual({
      type: "object",
      properties: {
        id: {
          type: "string",
        },
        name: {
          type: "string",
        },
        permissions: {
          $ref: "#/permission",
          type: "object",
          properties: {
            admin: {
              type: "boolean",
            },
          },
        },
      },
    })
  })
})
