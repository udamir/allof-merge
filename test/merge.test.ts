import { merge } from "../src"

describe("module", function () {
  it("merges schema with same object reference multiple places", () => {
    const commonSchema = {
      allOf: [
        {
          properties: {
            test: true,
          },
        },
      ],
    }
    const result = merge({
      properties: {
        list: {
          items: commonSchema,
        },
      },
      allOf: [commonSchema],
    })

    expect(result).toMatchObject({
      properties: {
        list: {
          items: {
            properties: {
              test: true,
            },
          },
        },
        test: true,
      },
    })
  })

  it("does not alter original schema", () => {
    const schema = {
      allOf: [
        {
          properties: {
            test: true,
          },
        },
      ],
    }

    const result = merge(schema)

    expect(result).toMatchObject({
      properties: {
        test: true,
      },
    })

    expect(result).not.toEqual(schema) // not strict equal (identity)
    expect(schema).toMatchObject({
      allOf: [
        {
          properties: {
            test: true,
          },
        },
      ],
    })
  })

  it("does not use any original objects or arrays", () => {
    const schema = {
      properties: {
        arr: {
          type: "array",
          items: {
            type: "object",
          },
          additionalItems: [
            {
              type: "array",
            },
          ],
        },
      },
      allOf: [
        {
          properties: {
            test: true,
          },
        },
      ],
    }

    const result = merge(schema)
    expect(schema).toEqual({
      properties: {
        arr: {
          type: "array",
          items: {
            type: "object",
          },
          additionalItems: [
            {
              type: "array",
            },
          ],
        },
      },
      allOf: [
        {
          properties: {
            test: true,
          },
        },
      ],
    })

    expect(result).toEqual({
      properties: {
        arr: {
          type: "array",
          items: {
            type: "object",
          },
          additionalItems: [
            {
              type: "array",
            },
          ],
        },
        test: true,
      },
    })
  })

  it("combines simple usecase", function () {
    const result = merge({
      allOf: [
        {
          type: "string",
          minLength: 1,
        },
        {
          type: "string",
          maxLength: 5,
        },
      ],
    })

    expect(result).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 5,
    })
  })

  it("combines without allOf", function () {
    const result = merge({
      properties: {
        foo: {
          type: "string",
        },
      },
    })

    expect(result).toMatchObject({
      properties: {
        foo: {
          type: "string",
        },
      },
    })
  })

  describe("handle wrong allOf items", function () {
    it("handles non-array allOf", function () {
      var result = merge({
        allOf: {},
      })

      expect(result).toEqual({})
    })

    it("filters out invalid allOf members", function () {
      var result = merge({
        allOf: [
          null,
          1,
          0,
          {
            type: "object",
            properties: {
              bar: {
                type: "string",
              },
            },
          },
          [],
          "",
          "foo",
          {
            type: "object",
            properties: {
              foo: {
                type: "string",
              },
            },
          },
        ],
      })

      expect(result).toEqual({
        type: "object",
        properties: {
          bar: {
            type: "string",
          },
          foo: {
            type: "string",
          },
        },
      })
    })

    it("default $ref resolver leaves schema unchanged", function () {
      const expected = {
        $ref: "#/yonder",
      }

      const actual = merge(expected)

      expect(actual).toEqual(expected)
    })

    it("is capable of resolving $refs", () => {
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
              allOf: [
                {
                  $ref: "#/permission",
                },
                {
                  type: "object",
                  properties: {
                    admin: {
                      type: "boolean",
                    },
                  },
                },
              ],
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
  })

  describe("simple resolve functionality", function () {
    it("merges with default resolver if not defined resolver", function () {
      const result = merge({
        title: "schema1",
        allOf: [
          {
            title: "schema2",
          },
          {
            title: "schema3",
          },
        ],
      })

      expect(result).toMatchObject({
        title: "schema1",
      })

      const result3 = merge({
        allOf: [
          {
            title: "schema2",
          },
          {
            title: "schema3",
          },
        ],
      })

      expect(result3).toMatchObject({
        title: "schema3",
      })
    })

    it("merges minLength if conflict", function () {
      const result = merge({
        allOf: [
          {
            minLength: 1,
          },
          {
            minLength: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        minLength: 5,
      })
    })

    it("merges minimum if conflict", function () {
      const result = merge({
        allOf: [
          {
            minimum: 1,
          },
          {
            minimum: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        minimum: 5,
      })
    })

    it("merges exclusiveMinimum if conflict", function () {
      const result = merge({
        allOf: [
          {
            exclusiveMinimum: 1,
          },
          {
            exclusiveMinimum: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        exclusiveMinimum: 5,
      })
    })

    it("merges minItems if conflict", function () {
      const result = merge({
        allOf: [
          {
            minItems: 1,
          },
          {
            minItems: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        minItems: 5,
      })
    })

    it("merges maximum if conflict", function () {
      const result = merge({
        allOf: [
          {
            maximum: 1,
          },
          {
            maximum: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        maximum: 1,
      })
    })

    it("merges exclusiveMaximum if conflict", function () {
      const result = merge({
        allOf: [
          {
            exclusiveMaximum: 1,
          },
          {
            exclusiveMaximum: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        exclusiveMaximum: 1,
      })
    })

    it("merges maxItems if conflict", function () {
      const result = merge({
        allOf: [
          {
            maxItems: 1,
          },
          {
            maxItems: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        maxItems: 1,
      })
    })

    it("merges maxLength if conflict", function () {
      const result = merge({
        allOf: [
          {
            maxLength: 4,
          },
          {
            maxLength: 5,
          },
        ],
      })

      expect(result).toMatchObject({
        maxLength: 4,
      })
    })

    it("merges uniqueItems to most restrictive if conflict", function () {
      const result = merge({
        allOf: [
          {
            uniqueItems: true,
          },
          {
            uniqueItems: false,
          },
        ],
      })

      expect(result).toMatchObject({
        uniqueItems: true,
      })

      expect(
        merge({
          allOf: [
            {
              uniqueItems: false,
            },
            {
              uniqueItems: false,
            },
          ],
        })
      ).toMatchObject({
        uniqueItems: false,
      })
    })

    it("throws if merging incompatible type", function () {
      expect(function () {
        merge({
          allOf: [
            {
              type: "null",
            },
            {
              type: "text",
            },
          ],
        })
      }).toThrow(/incompatible/)
    })

    it("merges type if conflict", function () {
      const result = merge({
        allOf: [
          {},
          {
            type: ["string", "null", "object", "array"],
          },
          {
            type: ["string", "null"],
          },
          {
            type: ["null", "string"],
          },
        ],
      })

      expect(result).toMatchObject({
        type: ["string", "null"],
      })

      const result2 = merge({
        allOf: [
          {},
          {
            type: ["string", "null", "object", "array"],
          },
          {
            type: "string",
          },
          {
            type: ["null", "string"],
          },
        ],
      })

      expect(result2).toMatchObject({
        type: "string",
      })

      expect(function () {
        merge({
          allOf: [
            {
              type: ["null"],
            },
            {
              type: ["text", "object"],
            },
          ],
        })
      }).toThrow(/incompatible/)
    })

    it("merges enum", function () {
      const result = merge({
        allOf: [
          {},
          {
            enum: ["string", "null", "object", {}, [2], [1], null],
          },
          {
            enum: ["string", {}, [1], [1]],
          },
          {
            enum: ["null", "string", {}, [3], [1], null],
          },
        ],
      })

      expect(result).toMatchObject({
        enum: [[1], {}, "string"],
      })
    })

    it("throws if enum is incompatible", function () {
      expect(function () {
        merge({
          allOf: [
            {},
            {
              enum: ["string", {}],
            },
            {
              enum: [{}, "string"],
            },
          ],
        })
      }).not.toThrow(/incompatible/)

      expect(function () {
        merge({
          allOf: [
            {},
            {
              enum: ["string", {}],
            },
            {
              enum: [[], false],
            },
          ],
        })
      }).toThrow(/incompatible/)
    })

    it("merges const", function () {
      const result = merge({
        allOf: [
          {},
          {
            const: ["string", {}],
          },
          {
            const: ["string", {}],
          },
        ],
      })

      expect(result).toMatchObject({
        const: ["string", {}],
      })
    })

    it("merges anyOf", function () {
      const result = merge({
        allOf: [
          {
            anyOf: [
              {
                required: ["123"],
              },
            ],
          },
          {
            anyOf: [
              {
                required: ["123"],
              },
              {
                required: ["456"],
              },
            ],
          },
        ],
      })

      expect(result).toMatchObject({
        anyOf: [
          {
            required: ["123"],
          },
          {
            required: ["123", "456"],
          },
        ],
      })
    })

    it("merges anyOf by finding valid combinations", function () {
      const result = merge({
        allOf: [
          {
            anyOf: [
              {
                type: ["null", "string", "array"],
              },
              {
                type: ["null", "string", "object"],
              },
            ],
          },
          {
            anyOf: [
              {
                type: ["null", "string"],
              },
              {
                type: ["integer", "object", "null"],
              },
            ],
          },
        ],
      })

      expect(result).toMatchObject({
        anyOf: [
          {
            type: ["null", "string"],
          },
          {
            type: "null",
          },
          {
            type: ["null", "object"],
          },
        ],
      })
    })

    it("extracts common logic", function () {
      const result = merge({
        allOf: [
          {
            anyOf: [
              {
                type: ["null", "string", "array"],
                minLength: 5,
              },
              {
                type: ["null", "string", "object"],
                minLength: 5,
              },
            ],
          },
          {
            anyOf: [
              {
                type: ["null", "string"],
                minLength: 5,
              },
              {
                type: ["integer", "object", "null"],
              },
            ],
          },
        ],
      })

      expect(result).toEqual({
        anyOf: [
          {
            type: ["null", "string"],
            minLength: 5,
          },
          {
            type: "null",
            minLength: 5,
          },
          {
            type: ["null", "object"],
            minLength: 5,
          },
        ],
      })
    })

    it("merges anyOf into main schema if left with only one combination", function () {
      const result = merge({
        required: ["abc"],
        allOf: [
          {
            anyOf: [
              {
                required: ["123"],
              },
              {
                required: ["456"],
              },
            ],
          },
          {
            anyOf: [
              {
                required: ["123"],
              },
            ],
          },
        ],
      })

      expect(result).toEqual({
        anyOf: [{ required: ["123"] }, { required: ["123", "456"] }],
        required: ["abc"],
      })
    })

    it("merges nested allOf if inside singular anyOf", function () {
      const result = merge({
        allOf: [
          {
            anyOf: [
              {
                required: ["123"],
                allOf: [
                  {
                    required: ["768"],
                  },
                ],
              },
            ],
          },
          {
            anyOf: [
              {
                required: ["123"],
              },
              {
                required: ["456"],
              },
            ],
          },
        ],
      })

      expect(result).toMatchObject({
        anyOf: [
          {
            required: ["123", "768"],
          },
          {
            required: ["123", "456", "768"],
          },
        ],
      })
    })

    it("throws if no intersection at all", function () {
      expect(function () {
        merge({
          allOf: [
            {
              anyOf: [
                {
                  type: ["object", "string", "null"],
                },
              ],
            },
            {
              anyOf: [
                {
                  type: ["array", "integer"],
                },
              ],
            },
          ],
        })
      }).toThrow(/incompatible/)

      expect(function () {
        merge({
          allOf: [
            {
              anyOf: [
                {
                  type: ["object", "string", "null"],
                },
              ],
            },
            {
              anyOf: [
                {
                  type: ["array", "integer"],
                },
              ],
            },
          ],
        })
      }).toThrow(/incompatible/)
    })

    it("merges more complex oneOf", function () {
      const result = merge({
        allOf: [
          {
            oneOf: [
              {
                type: ["array", "string", "object"],
                required: ["123"],
              },
              {
                required: ["abc"],
              },
            ],
          },
          {
            oneOf: [
              {
                type: ["string"],
              },
              {
                type: ["object", "array"],
                required: ["abc"],
              },
            ],
          },
        ],
      })

      expect(result).toMatchObject({
        oneOf: [
          {
            type: "string",
            required: ["123"],
          },
          {
            type: ["array", "object"],
            required: ["123", "abc"],
          },
          {
            type: ["string"],
            required: ["abc"],
          },
          {
            type: ["object", "array"],
            required: ["abc"],
          },
        ],
      })
    })

    it("merges nested allOf if inside singular oneOf", function () {
      const result = merge({
        allOf: [
          {
            type: ["array", "string", "number"],
            oneOf: [
              {
                required: ["123"],
                allOf: [
                  {
                    required: ["768"],
                  },
                ],
              },
            ],
          },
          {
            type: ["array", "string"],
          },
        ],
      })

      expect(result).toMatchObject({
        type: ["array", "string"],
        oneOf: [
          {
            required: ["123", "768"],
          },
        ],
      })
    })

    it("merges nested allOf if inside multiple oneOf", function () {
      const result = merge({
        allOf: [
          {
            type: ["array", "string", "number"],
            oneOf: [
              {
                type: ["array", "object"],
                allOf: [
                  {
                    type: "object",
                  },
                ],
              },
            ],
          },
          {
            type: ["array", "string"],
            oneOf: [
              {
                type: "string",
              },
              {
                type: "object",
              },
            ],
          },
        ],
      })

      expect(result).toMatchObject({
        type: ["array", "string"],
        oneOf: [
          {
            type: "object",
          },
        ],
      })
    })

    it("merges not using allOf", function () {
      const result = merge({
        allOf: [
          {
            not: {
              properties: {
                name: {
                  type: "string",
                },
              },
            },
          },
          {
            not: {
              properties: {
                name: {
                  type: ["string", "null"],
                },
              },
            },
          },
        ],
      })

      expect(result).toMatchObject({
        not: {
          anyOf: [
            {
              properties: {
                name: {
                  type: "string",
                },
              },
            },
            {
              properties: {
                name: {
                  type: ["string", "null"],
                },
              },
            },
          ],
        },
      })
    })

    it("merges contains", function () {
      const result = merge({
        allOf: [
          {},
          {
            contains: {
              properties: {
                name: {
                  type: "string",
                  pattern: "bar",
                },
              },
            },
          },
          {
            contains: {
              properties: {
                name: {
                  type: "string",
                  pattern: "foo",
                },
              },
            },
          },
        ],
      })

      expect(result).toMatchObject({
        contains: {
          properties: {
            name: {
              type: "string",
              pattern: "(?=bar)(?=foo)",
            },
          },
        },
      })
    })

    it("merges pattern using allOf", function () {
      const result = merge({
        allOf: [
          {},
          {
            pattern: "fdsaf",
          },
          {
            pattern: "abba",
          },
        ],
      })

      expect(result).toMatchObject({
        pattern: "(?=fdsaf)(?=abba)",
      })

      const result2 = merge({
        allOf: [
          {
            pattern: "abba",
          },
        ],
      })

      expect(result2).toMatchObject({
        pattern: "abba",
      })
    })

    it.skip("merges multipleOf using allOf or direct assignment", function () {
      const result = merge({
        allOf: [
          {
            title: "foo",
            type: ["number", "integer"],
            multipleOf: 2,
          },
          {
            type: "integer",
            multipleOf: 3,
          },
        ],
      })

      expect(result).toMatchObject({
        type: "integer",
        title: "foo",
        allOf: [
          {
            multipleOf: 2,
          },
          {
            multipleOf: 3,
          },
        ],
      })

      const result2 = merge({
        allOf: [
          {
            multipleOf: 1,
          },
        ],
      })

      expect(result2).toMatchObject({
        multipleOf: 1,
      })
    })

    it("merges multipleOf by finding lowest common multiple (LCM)", function () {
      const result = merge({
        allOf: [
          {},
          {
            multipleOf: 0.2,
            allOf: [
              {
                multipleOf: 2,
                allOf: [
                  {
                    multipleOf: 2,
                    allOf: [
                      {
                        multipleOf: 2,
                        allOf: [
                          {
                            multipleOf: 3,
                            allOf: [
                              {
                                multipleOf: 1.5,
                                allOf: [
                                  {
                                    multipleOf: 0.5,
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            multipleOf: 0.3,
          },
        ],
      })

      expect(result).toMatchObject({
        multipleOf: 6,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 4,
            },
            {
              multipleOf: 15,
            },
            {
              multipleOf: 3,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 60,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 0.3,
            },
            {
              multipleOf: 0.7,
            },
            {
              multipleOf: 1,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 21,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 0.5,
            },
            {
              multipleOf: 2,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 2,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 0.3,
            },
            {
              multipleOf: 0.5,
            },
            {
              multipleOf: 1,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 3,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 0.3,
            },
            {
              multipleOf: 0.7,
            },
            {
              multipleOf: 1,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 21,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 0.4,
            },
            {
              multipleOf: 0.7,
            },
            {
              multipleOf: 3,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 42,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 0.2,
            },
            {
              multipleOf: 0.65,
            },
            {
              multipleOf: 1,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 13,
      })

      expect(
        merge({
          allOf: [
            {
              multipleOf: 100000,
            },
            {
              multipleOf: 1000000,
            },
            {
              multipleOf: 500000,
            },
          ],
        })
      ).toMatchObject({
        multipleOf: 1000000,
      })
    })
  })

  describe("merging arrays", function () {
    it("merges required object", function () {
      expect(
        merge({
          required: ["prop2"],
          allOf: [
            {
              required: ["prop2", "prop1"],
            },
          ],
        })
      ).toMatchObject({
        required: ["prop1", "prop2"],
      })
    })

    it("merges default value", function () {
      expect(
        merge({
          default: [
            "prop2",
            {
              prop1: "foo",
            },
          ],
          allOf: [
            {
              default: ["prop2", "prop1"],
            },
          ],
        })
      ).toMatchObject({
        default: [
          "prop2",
          {
            prop1: "foo",
          },
        ],
      })
    })

    it("merges default value", function () {
      expect(
        merge({
          default: {
            foo: "bar",
          },
          allOf: [
            {
              default: ["prop2", "prop1"],
            },
          ],
        })
      ).toMatchObject({
        default: {
          foo: "bar",
        },
      })
    })
  })

  describe("merging objects", function () {
    it("merges child objects", function () {
      expect(
        merge({
          properties: {
            name: {
              title: "Name",
              type: "string",
            },
          },
          allOf: [
            {
              properties: {
                name: {
                  title: "allof1",
                  type: "string",
                },
                added: {
                  type: "integer",
                },
              },
            },
            {
              properties: {
                name: {
                  type: "string",
                },
              },
            },
          ],
        })
      ).toMatchObject({
        properties: {
          name: {
            title: "Name",
            type: "string",
          },
          added: {
            type: "integer",
          },
        },
      })
    })

    it("merges boolean schemas", function () {
      expect(
        merge({
          properties: {
            name: true,
          },
          allOf: [
            {
              properties: {
                name: {
                  title: "allof1",
                  type: "string",
                },
                added: {
                  type: "integer",
                },
              },
            },
            {
              properties: {
                name: {
                  type: "string",
                  minLength: 5,
                },
              },
            },
          ],
        })
      ).toMatchObject({
        properties: {
          name: {
            title: "allof1",
            type: "string",
            minLength: 5,
          },
          added: {
            type: "integer",
          },
        },
      })

      expect(
        merge({
          properties: {
            name: false,
          },
          allOf: [
            {
              properties: {
                name: {
                  title: "allof1",
                  type: "string",
                },
                added: {
                  type: "integer",
                },
              },
            },
            {
              properties: {
                name: true,
              },
            },
          ],
        })
      ).toMatchObject({
        properties: {
          name: false,
          added: {
            type: "integer",
          },
        },
      })

      expect(
        merge({
          properties: {
            name: true,
          },
          allOf: [
            {
              properties: {
                name: false,
                added: {
                  type: "integer",
                },
              },
            },
            {
              properties: {
                name: true,
              },
            },
          ],
        })
      ).toMatchObject({
        properties: {
          name: false,
          added: {
            type: "integer",
          },
        },
      })
    })

    it("merges all allOf", function () {
      expect(
        merge({
          properties: {
            name: {
              allOf: [
                {
                  pattern: "^.+$",
                },
              ],
            },
          },
          allOf: [
            {
              properties: {
                name: true,
                added: {
                  type: "integer",
                  title: "pri1",
                  allOf: [
                    {
                      title: "pri2",
                      type: ["string", "integer"],
                      minimum: 15,
                      maximum: 10,
                    },
                  ],
                },
              },
              allOf: [
                {
                  properties: {
                    name: true,
                    added: {
                      type: "integer",
                      minimum: 5,
                    },
                  },
                  allOf: [
                    {
                      properties: {
                        added: {
                          title: "pri3",
                          type: "integer",
                          minimum: 10,
                        },
                      },
                    },
                  ],
                },
              ],
            },
            {
              properties: {
                name: true,
                added: {
                  minimum: 7,
                },
              },
            },
          ],
        })
      ).toMatchObject({
        properties: {
          name: {
            pattern: "^.+$",
          },
          added: {
            type: "integer",
            title: "pri3",
            minimum: 15,
            maximum: 10,
          },
        },
      })
    })
  })

  describe("merging definitions", function () {
    it("merges circular", function () {
      const schema: any = {
        properties: {
          person: {
            properties: {
              name: {
                type: "string",
                minLength: 8,
              },
              child: {
                $ref: "#/properties/person"
              }
            },
            allOf: [
              {
                properties: {
                  name: {
                    minLength: 5,
                    maxLength: 10,
                  },
                },
                allOf: [
                  {
                    properties: {
                      prop1: {
                        minLength: 7,
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      }

      const result = merge(schema)

      expect(result).toMatchObject({
        properties: {
          person: {
            properties: {
              name: {
                minLength: 8,
                maxLength: 10,
                type: "string",
              },
              prop1: {
                minLength: 7,
              },
              child: {
                $ref: "#/properties/person"
              }
            },
          },
        },
      })
    })

    it("merges any definitions and circular", function () {
      const schema = {
        properties: {
          person: {
            $ref: "#/definitions/person",
          },
        },
        definitions: {
          person: {
            properties: {
              name: {
                type: "string",
                minLength: 8,
              },
              child: {
                $ref: "#/definitions/person",
              },
            },
            allOf: [
              {
                properties: {
                  name: {
                    minLength: 5,
                    maxLength: 10,
                  },
                },
                allOf: [
                  {
                    properties: {
                      prop1: {
                        minLength: 7,
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      }

      const result = merge(schema)

      expect(result).toEqual({
        properties: {
          person: {
            $ref: "#/definitions/person",
          },
        },
        definitions: {
          person: {
            properties: {
              name: {
                minLength: 8,
                maxLength: 10,
                type: "string",
              },
              prop1: {
                minLength: 7,
              },
              child: {
                $ref: "#/definitions/person",
              },
            },
          },
        },
      })
    })
  })

  describe("dependencies", function () {
    it("merges simliar schemas", function () {
      const result = merge({
        dependencies: {
          foo: {
            type: ["string", "null", "integer"],
            allOf: [
              {
                minimum: 5,
              },
            ],
          },
          bar: ["prop1", "prop2"],
        },
        allOf: [
          {
            dependencies: {
              foo: {
                type: ["string", "null"],
                allOf: [
                  {
                    minimum: 7,
                  },
                ],
              },
              bar: ["prop4"],
            },
          },
        ],
      })

      expect(result).toMatchObject({
        dependencies: {
          foo: {
            type: ["string", "null"],
            minimum: 7,
          },
          bar: ["prop1", "prop2", "prop4"],
        },
      })
    })

    it("merges mixed mode dependency", function () {
      const result = merge({
        dependencies: {
          bar: {
            type: ["string", "null", "integer"],
            required: ["abc"],
          },
        },
        allOf: [
          {
            dependencies: {
              bar: ["prop4"],
            },
          },
        ],
      })

      expect(result).toMatchObject({
        dependencies: {
          bar: {
            type: ["string", "null", "integer"],
            required: ["abc", "prop4"],
          },
        },
      })
    })
  })

  describe("propertyNames", function () {
    it("merges simliar schemas", function () {
      const result = merge({
        propertyNames: {
          type: "string",
          allOf: [
            {
              minLength: 5,
            },
          ],
        },
        allOf: [
          {
            propertyNames: {
              type: "string",
              pattern: "abc.*",
              allOf: [
                {
                  maxLength: 7,
                },
              ],
            },
          },
        ],
      })

      expect(result).toMatchObject({
        propertyNames: {
          type: "string",
          pattern: "abc.*",
          minLength: 5,
          maxLength: 7,
        },
      })
    })
  })

  describe("title merging", function () {
    it("prefers the last occurrence", function () {
      expect(
        merge({
          allOf: [
            {
              title: "First",
            },
            {
              title: "Last",
            },
          ],
        })
      ).toEqual({
        title: "Last",
      })
    })

    it("prefers the top-level occurrence", function () {
      expect(
        merge({
          title: "Top Level",
          allOf: [
            {
              title: "First",
            },
            {
              title: "Last",
            },
          ],
        })
      ).toEqual({
        title: "Top Level",
      })
    })
  })

  describe("description merging", function () {
    it("prefers the last occurrence", function () {
      expect(
        merge({
          allOf: [
            {
              description: "First",
            },
            {
              description: "Last",
            },
          ],
        })
      ).toEqual({
        description: "Last",
      })
    })

    it("prefers the top-level occurrence", function () {
      expect(
        merge({
          description: "Top Level",
          allOf: [
            {
              description: "First",
            },
            {
              description: "Last",
            },
          ],
        })
      ).toEqual({
        description: "Top Level",
      })
    })
  })
})
