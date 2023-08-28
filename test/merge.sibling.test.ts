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
    const result = merge(
      {
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
      },
      { mergeCombinarySibling: true }
    )

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

  it("should merges anyOf and sibling with mergeCombinarySibling option", function () {
    const result = merge(
      {
        required: ["id"],
        type: "object",
        properties: {
          id: {
            type: "string",
          },
        },
        anyOf: [
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
      },
      { mergeCombinarySibling: true }
    )

    expect(result).toMatchObject({
      anyOf: [
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

  it("should merge oneOf with discriminator correctly", () => {
    const schema = {
      type: "object",
      description: "Vehicle",
      oneOf: [{ 
        $ref: "#/definitions/ElectricVehicle" 
      }, { 
        $ref: "#/definitions/PedaledVehicle"
      }],
      definitions: {
        ElectricVehicle: {
          type: "object",
          title: "Electric Vehicle",
          properties: {
            vehicleType: {
              description: "The type of vehicle.",
              type: "string",
              example: "bicycle",
            },
            idealTerrain: {
              type: "string",
              example: "roads",
            },
            powerSource: {
              description: "How is the vehicle powered.",
              type: "string",
              example: "pedaling",
            },
          },
        },
        PedaledVehicle: {
          type: "object",
          title: "Pedaled Vehicle",
          properties: {
            topSpeed: {
              description: "The top speed in kilometers per hour rounded to the nearest integer.",
              type: "integer",
              example: 83,
            },
            range: {
              description: "The 95th percentile range of a trip in kilometers.",
              type: "integer",
              example: 100,
            },
            powerSource: {
              description: "How is the vehicle powered.",
              type: "string",
              example: "pedaling",
            },
          },
        },
      },
    }

    const result = merge(schema, { mergeCombinarySibling: true })
    expect(result).toMatchObject({
      oneOf: [
        {
          type: "object",
          title: "Electric Vehicle",
          description: "Vehicle",
          properties: {
            vehicleType: {
              description: "The type of vehicle.",
              type: "string",
              example: "bicycle",
            },
            idealTerrain: {
              type: "string",
              example: "roads",
            },
            powerSource: {
              description: "How is the vehicle powered.",
              type: "string",
              example: "pedaling",
            },
          },
        },
        {
          type: "object",
          title: "Pedaled Vehicle",
          description: "Vehicle",
          properties: {
            topSpeed: {
              description: "The top speed in kilometers per hour rounded to the nearest integer.",
              type: "integer",
              example: 83,
            },
            range: {
              description: "The 95th percentile range of a trip in kilometers.",
              type: "integer",
              example: 100,
            },
            powerSource: {
              description: "How is the vehicle powered.",
              type: "string",
              example: "pedaling",
            },
          },
        }
      ],
      definitions: {
        ElectricVehicle: {
          type: "object",
          title: "Electric Vehicle",
          properties: {
            vehicleType: {
              description: "The type of vehicle.",
              type: "string",
              example: "bicycle",
            },
            idealTerrain: {
              type: "string",
              example: "roads",
            },
            powerSource: {
              description: "How is the vehicle powered.",
              type: "string",
              example: "pedaling",
            },
          },
        },
        PedaledVehicle: {
          type: "object",
          title: "Pedaled Vehicle",
          properties: {
            topSpeed: {
              description: "The top speed in kilometers per hour rounded to the nearest integer.",
              type: "integer",
              example: 83,
            },
            range: {
              description: "The 95th percentile range of a trip in kilometers.",
              type: "integer",
              example: 100,
            },
            powerSource: {
              description: "How is the vehicle powered.",
              type: "string",
              example: "pedaling",
            },
          },
        },
      },
    })
  })

  it("should not dereference $ref with no sibling content", () => {
    const schema = {
      type: 'object',
      properties: {
        id: { $ref: "#/defs/id" },
        name: { $ref: "#/defs/name" },
      },
      defs: {
        id: {
          title: 'id',
          type: 'string',
        },
        name: {
          title: 'name',
          type: 'string',
        } 
      }
    }
    const result = merge(schema, { mergeCombinarySibling: true })

    expect(result).toMatchObject(schema)
  })
})
