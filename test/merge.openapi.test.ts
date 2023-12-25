import { merge } from "../src"
const source31x = require("./resources/openapi31x.json")
const source30x = require("./resources/openapi30x.json")

describe("merge allof in openapi schema", function () {
  it("merges schema in openapi 3.0.x", () => {
    const result = merge(source30x)

    expect(result).toMatchObject({
      openapi: "3.0.2",
      paths: {
        "/pets": {
          patch: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
                        $ref: "#/components/schemas/Cat",
                      },
                      {
                        $ref: "#/components/schemas/Dog",
                      },
                    ],
                    discriminator: {
                      propertyName: "pet_type",
                    },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Updated",
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: "object",
            required: [
              "pet_type",
            ],
            properties: {
              pet_type: {
                type: "string",
              },
            },
            discriminator: {
              propertyName: "pet_type",
            },
          },
          Dog: {
            type: "object",
            required: [
              "pet_type",
            ],
            properties: {
              pet_type: {
                type: "string",
              },
              bark: {
                type: "boolean",
              },
              breed: {
                type: "string",
                enum: [
                  "Dingo",
                  "Husky",
                  "Retriever",
                  "Shepherd",
                ],
              },
            },
            discriminator: {
              propertyName: "pet_type",
            },
          },
          Cat: {
            type: "object",
            required: [
              "pet_type",
            ],
            properties: {
              pet_type: {
                type: "string",
              },
              hunts: {
                type: "boolean",
              },
              age: {
                type: "integer",
              },
            },
            discriminator: {
              propertyName: "pet_type",
            },
          },
        },
      },
    })
  })

  it("merges schema in openapi 3.1.x", () => {
    const result = merge(source31x)

    expect(result).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/pets": {
          patch: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
                        $ref: "#/components/schemas/Cat",
                      },
                      {
                        $ref: "#/components/schemas/Dog",
                      },
                    ],
                    discriminator: {
                      propertyName: "pet_type",
                    },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Updated",
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: "object",
            required: [
              "pet_type",
            ],
            properties: {
              pet_type: {
                type: "string",
              },
            },
            discriminator: {
              propertyName: "pet_type",
            },
          },
          Dog: {
            type: "object",
            required: [
              "pet_type",
            ],
            properties: {
              pet_type: {
                type: "string",
              },
              bark: {
                type: "boolean",
              },
              breed: {
                type: "string",
                enum: [
                  "Dingo",
                  "Husky",
                  "Retriever",
                  "Shepherd",
                ],
              },
            },
            discriminator: {
              propertyName: "pet_type",
            },
          },
          Cat: {
            type: "object",
            required: [
              "pet_type",
            ],
            properties: {
              pet_type: {
                type: "string",
              },
              hunts: {
                type: "boolean",
              },
              age: {
                type: "integer",
              },
            },
            discriminator: {
              propertyName: "pet_type",
            },
          },
        },
      },
    })
  })
})
