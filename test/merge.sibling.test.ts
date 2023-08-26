import { merge } from "../src"

describe("merge sibling content", function () {
  it("should merge $ref sibling with mergeRefSibling option", () => {
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
      { source, mergeRefSibling: true }
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
          type: "object",
          properties: {
            admin: {
              type: "boolean",
            },
            level: {
              type: "number",
            },
          },
        },
      },
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

  it("should merges oneOf and sibling with mergeCombinarySibling option", function () {
    const result = merge({
      required: ["id"],
      type: "object",
      properties: {
        id: {
          type: "string",
        },
      },
      oneOf: [
        {
          type: "object",
          properties: {
            key: {
              type: "string",
            },
          },
        },
        {
          type: "object",
          additionalProperties: {
            type: "string",
          },
        },
      ],
    }, { mergeCombinarySibling: true })

    expect(result).toMatchObject({
      oneOf: [
        {
          required: ["id"],
          type: "object",
          properties: {
            id: {
              type: "string",
            },
            key: {
              type: "string",
            },
          },
        },
        {
          required: ["id"],
          type: "object",
          properties: {
            id: {
              type: "string",
            },
          },
          additionalProperties: {
            type: "string",
          },
        },
      ],
    })
  })
})