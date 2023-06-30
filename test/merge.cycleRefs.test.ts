import { merge } from "../src"

describe("cycle refs", () => {
  it("should support cycle refs in allOf", () => {
    const data = {
      type: 'object',
      properties: {
        foo: {
          allOf: [
            {
              description: '1-st parent',
            },
            {
              $ref: '#',
            },
          ],
        },
        baz: {
          allOf: [
            {
              description: '2-st parent',
            },
            {
              $ref: '#',
            },
          ],
        },
      },
    }

    const result = merge(data)
 
    expect(result).toEqual( {
      type: 'object',
      properties: {
        foo: {
          description: '1-st parent',
          type: 'object',
          properties: {
            foo: {
              $ref: '#/properties/foo',
            },
            baz: {
              description: '2-st parent',
              type: 'object',
              properties: {
                foo: {
                  $ref: '#/properties/foo',
                },
                baz: {
                  $ref: '#/properties/foo/properties/baz',
                },
              }
            },

          }
        },
        baz: {
          $ref: '#/properties/foo/properties/baz',
        },
      },
    })
  })
  
  it("should support cross cycle refs in allOf", () => {
    const data = {
      type: 'object',
      properties: {
        foo: {
          allOf: [
            {
              properties: {
                test: {
                  type: "string"
                }
              },
              description: '1-st parent',
            },
            {
              $ref: '#/properties/baz',
            },
          ],
        },
        baz: {
          properties: {
            test: {
              $ref: '#/properties/foo',
            },
          },
        },
      },
    }

    const result = merge(data)
 
    expect(result).toEqual({
      type: 'object',
      properties: {
        foo: {
          description: '1-st parent',
          properties: {
            test: {
              type: "string",
              description: '1-st parent',
              properties: {
                test: {
                  $ref: '#/properties/foo/properties/test',
                },
              }
            },
          },
        },
        baz: {
          properties: {
            test: {
              $ref: '#/properties/foo',
            },
          },
        },
      },
    })
  })
})