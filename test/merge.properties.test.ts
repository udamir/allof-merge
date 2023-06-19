import { merge } from "../src"

describe('properties', function() {
  describe('additionalProperties', function() {
    it('allows no extra properties if additionalProperties is false', function() {
      const result = merge({
        allOf: [{
          additionalProperties: true
        }, {
          additionalProperties: false
        }]
      })

      expect(result).toMatchObject({
        additionalProperties: false
      })
    })

    it('allows extra properties if additionalProperties are true', function() {
      const result = merge({
        allOf: [{
          additionalProperties: true
        }, {
          additionalProperties: true
        }]
      })

      expect(result).toMatchObject({
        additionalProperties: true
      })
    })

    it('allows only intersecting properties', function() {
      const result = merge({
        allOf: [{
          properties: {
            foo: true
          },
          additionalProperties: true
        }, {
          properties: {
            bar: true
          },
          additionalProperties: false
        }]
      })

      expect(result).toEqual({
        properties: {
          bar: true
        },
        additionalProperties: false
      })
    })

    it('allows intersecting patternproperties', function() {
      const result = merge({
        allOf: [{
          properties: {
            foo: true,
            foo123: true
          },
          additionalProperties: true
        }, {
          properties: {
            bar: true
          },
          patternProperties: {
            '.+\\d+$': true
          },
          additionalProperties: false
        }]
      })

      expect(result).toEqual({
        properties: {
          bar: true,
          foo123: true
        },
        patternProperties: {
          '.+\\d+$': true
        },
        additionalProperties: false
      })
    })

    it('disallows all except matching patternProperties if both false', function() {
      const result = merge({
        allOf: [{
          properties: {
            foo: true,
            foo123: true
          },
          additionalProperties: false
        }, {
          properties: {
            bar: true
          },
          patternProperties: {
            '.+\\d+$': true
          },
          additionalProperties: false
        }]
      })

      expect(result).toEqual({
        properties: {
          foo123: true
        },
        additionalProperties: false
      })
    })

    it('disallows all except matching patternProperties if both false', function() {
      const result = merge({
        allOf: [{
          properties: {
            foo: true,
            foo123: true
          },
          patternProperties: {
            '.+\\d+$': {
              type: 'string'
            }
          },
          additionalProperties: false
        }, {
          properties: {
            bar: true,
            bar123: true
          },
          patternProperties: {
            '.+\\d+$': true
          },
          additionalProperties: false
        }]
      })

      expect(result).toEqual({
        properties: {
          foo123: true,
          bar123: true
        },
        patternProperties: {
          '.+\\d+$': {
            type: 'string'
          }
        },
        additionalProperties: false
      })
    })

    it('disallows all except matching patternProperties if both false', function() {
      const schema = {
        allOf: [{
          type: 'object',
          properties: {
            foo: true,
            foo123: true
          },
          patternProperties: {
            '^bar': true
          },
          additionalProperties: false
        }, {
          type: 'object',
          properties: {
            bar: true,
            bar123: true
          },
          patternProperties: {
            '.+\\d+$': true
          },
          additionalProperties: false
        }]
      }
      const result = merge(schema)
      expect(result).not.toEqual(schema)

      expect(result).toEqual({
        type: 'object',
        properties: {
          bar: true,
          foo123: true,
          bar123: true
        },
        additionalProperties: false
      })
    })

    it('disallows all except matching patternProperties if both true', function() {
      const schema = {
        allOf: [{
          type: 'object',
          properties: {
            foo: true,
            foo123: true
          },
          patternProperties: {
            '^bar': true
          }
        }, {
          type: 'object',
          properties: {
            bar: true,
            bar123: true
          },
          patternProperties: {
            '.+\\d+$': true
          }
        }]
      }

      const result = merge(schema)
      expect(result).not.toEqual(schema)

      expect(result).toEqual({
        type: 'object',
        properties: {
          bar: true,
          foo123: true,
          bar123: true
        },
        patternProperties: {
          '^bar': true,
          '.+\\d+$': true
        }
      })
    })

    it('disallows all except matching patternProperties if one false', function() {
      const schema = {
        allOf: [{
          type: 'object',
          properties: {
            foo: true,
            foo123: true
          }
        }, {
          type: 'object',
          properties: {
            bar: true,
            bar123: true
          },
          patternProperties: {
            '.+\\d+$': true
          },
          additionalProperties: false
        }]
      }
    
      const result = merge(schema)
      expect(result).not.toEqual(schema)

      expect(result).toEqual({
        type: 'object',
        properties: {
          bar: true,
          foo123: true,
          bar123: true
        },
        patternProperties: {
          '.+\\d+$': true
        },
        additionalProperties: false
      })
    })

    it('disallows all if no patternProperties and if both false', function() {
      const result = merge({
        allOf: [{
          properties: {
            foo: true,
            foo123: true
          },
          additionalProperties: false
        }, {
          properties: {
            bar: true
          },
          additionalProperties: false
        }]
      })

      expect(result).toEqual({
        additionalProperties: false
      })
    })

    it('applies additionalProperties to other schemas properties if they have any', function() {
      const result = merge({
        properties: {
          common: true,
          root: true
        },
        additionalProperties: false,
        allOf: [{
          properties: {
            common: {
              type: 'string'
            },
            allof1: true
          },
          additionalProperties: {
            type: [
              'string', 'null'
            ],
            maxLength: 10
          }
        }, {
          properties: {
            common: {
              minLength: 1
            },
            allof2: true
          },
          additionalProperties: {
            type: [
              'string', 'integer', 'null'
            ],
            maxLength: 8
          }
        }, {
          properties: {
            common: {
              minLength: 6
            },
            allof3: true
          }
        }]
      })

      expect(result).toEqual({
        properties: {
          common: {
            type: 'string',
            minLength: 6
          },
          root: {
            type: [
              'string', 'null'
            ],
            maxLength: 8
          }
        },
        additionalProperties: false
      })
    })

    it('considers patternProperties before merging additionalProperties to other schemas properties if they have any', function() {
      const result = merge({
        properties: {
          common: true,
          root: true
        },
        patternProperties: {
          '.+\\d{2,}$': {
            minLength: 7
          }
        },
        additionalProperties: false,
        allOf: [{
          properties: {
            common: {
              type: 'string'
            },
            allof1: true
          },
          additionalProperties: {
            type: [
              'string', 'null', 'integer'
            ],
            maxLength: 10
          }
        }, {
          properties: {
            common: {
              minLength: 1
            },
            allof2: true,
            allowed123: {
              type: 'string'
            }
          },
          patternProperties: {
            '.+\\d{2,}$': {
              minLength: 9
            }
          },
          additionalProperties: {
            type: [
              'string', 'integer', 'null'
            ],
            maxLength: 8
          }
        }, {
          properties: {
            common: {
              minLength: 6
            },
            allof3: true,
            allowed456: {
              type: 'integer'
            }
          }
        }]
      })

      expect(result).toEqual({
        properties: {
          common: {
            type: 'string',
            minLength: 6
          },

          allowed123: {
            type: 'string',
            maxLength: 10
          },
          allowed456: {
            type: 'integer',
            maxLength: 10
          }
        },
        patternProperties: {
          '.+\\d{2,}$': {
            minLength: 9
          }
        },
        additionalProperties: false
      })
    })

    it('combines additionalProperties when schemas', function() {
      const result = merge({
        additionalProperties: true,
        allOf: [{
          additionalProperties: {
            type: [
              'string', 'null'
            ],
            maxLength: 10
          }
        }, {
          additionalProperties: {
            type: [
              'string', 'integer', 'null'
            ],
            maxLength: 8
          }
        }]
      })

      expect(result).toEqual({
        additionalProperties: {
          type: [
            'string', 'null'
          ],
          maxLength: 8
        }
      })
    })
  })

  describe('patternProperties', function() {
    it('merges simliar schemas', function() {
      const result = merge({
        patternProperties: {
          '^\\$.+': {
            type: [
              'string', 'null', 'integer'
            ],
            allOf: [{
              minimum: 5
            }]
          }
        },
        allOf: [{
          patternProperties: {
            '^\\$.+': {
              type: [
                'string', 'null'
              ],
              allOf: [{
                minimum: 7
              }]
            },
            '.*': {
              type: 'null'
            }
          }
        }]
      })

      expect(result).toEqual({
        patternProperties: {
          '^\\$.+': {
            type: [
              'string', 'null'
            ],
            minimum: 7
          },
          '.*': {
            type: 'null'
          }
        }
      })
    })
  })

  describe('when patternProperties present', function() {
    it('merges patternproperties', function() {
      const result = merge({
        allOf: [{
          patternProperties: {
            '.*': {
              type: 'string',
              minLength: 5
            }
          }
        }, {
          patternProperties: {
            '.*': {
              type: 'string',
              minLength: 7
            }
          }
        }]
      })

      expect(result).toEqual({
        patternProperties: {
          '.*': {
            type: 'string',
            minLength: 7
          }
        }
      })
    })

    it('merges with properties if matching property name', function() {
      const schema = {
        allOf: [{
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1
            }
          },
          patternProperties: {
            _long$: {
              type: 'string',
              minLength: 7
            }
          }
        }, {
          type: 'object',
          properties: {
            foo_long: {
              type: 'string',
              minLength: 9
            }
          },
          patternProperties: {
            '^name.*': {
              type: 'string',
              minLength: 8
            }
          }
        }]
      }

      const result = merge(schema)

      expect(result).not.toEqual(schema)

      expect(result).toEqual({
        type: 'object',
        properties: {
          foo_long: {
            type: 'string',
            minLength: 9
          },
          name: {
            type: 'string',
            minLength: 1
          }
        },
        patternProperties: {
          _long$: {
            type: 'string',
            minLength: 7
          },
          '^name.*': {
            type: 'string',
            minLength: 8
          }
        }
      })
    })
  })
})
