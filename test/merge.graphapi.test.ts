import { graphapi, yaml } from "./helpers"
import { merge } from "../src"

describe("Build GraphApi", () => {

  it("should be nullable query for Scalar result", () => {
    const schema = graphapi`
      type Todo {
        id: ID!
        name: String!
        completed: Boolean
        color: Color
      
        "A field that requires an argument"
        colors(filter: [Color!]!): [Color!]!
      }
      
      enum Color {
        "Red color"
        RED
      
        "Green color"
        GREEN
      }
      
      input TodoInputType {
        name: String!
        completed: Boolean @deprecated(reason: "not used")
        color: Color = RED
      }
      
      type Query {
        "A Query with 1 required argument and 1 optional argument"
        todo(
          id: ID!
      
          "A default value of false"
          isCompleted: Boolean = false
      ): Todo
      
      """
        Returns a list (or null) that can contain null values
      """
      todos(
          "Required argument that is a list that cannot contain null values"
          ids: [String!]!
        ): [Todo]
      }
      
      type Mutation {
        "A Mutation with 1 required argument"
        create_todo(
          todo: TodoInputType!
        ): Todo!
      }
    `

    const merged = merge(schema, { mergeCombinarySibling: true, mergeRefSibling: true })

    const expected = yaml`
      graphapi: 0.1.2
      queries:
        todo:
          description: A Query with 1 required argument and 1 optional argument
          args:
            type: object
            required:
              - id
            properties:
              id:
                type: string
                format: ID
              isCompleted:
                type: boolean
                description: A default value of false
                default: false
          title: Todo
          type: object
          required:
            - id
            - name
            - colors
          properties:
            id:
              type: string
              format: ID
            name:
              type: string
            completed:
              type: boolean
            color:
              $ref: "#/components/enums/Color"
            colors:
              description: A field that requires an argument
              type: array
              items:
                $ref: "#/components/enums/Color"
              args:
                type: object
                required:
                  - filter
                properties:
                  filter:
                    type: array
                    items:
                      $ref: "#/components/enums/Color"
          nullable: true
        todos:
          description: Returns a list (or null) that can contain null values
          args:
            type: object
            required:
              - ids
            properties:
              ids:
                type: array
                items:
                  type: string
                description: Required argument that is a list that cannot contain null values
          type: array
          items:
            nullable: true
            title: Todo
            type: object
            required:
              - id
              - name
              - colors
            properties:
              id:
                type: string
                format: ID
              name:
                type: string
              completed:
                type: boolean
              color:
                $ref: "#/components/enums/Color"
              colors:
                description: A field that requires an argument
                type: array
                items:
                  $ref: "#/components/enums/Color"
                args:
                  type: object
                  required:
                    - filter
                  properties:
                    filter:
                      type: array
                      items:
                        $ref: "#/components/enums/Color"
          nullable: true
      mutations:
        create_todo:
          description: A Mutation with 1 required argument
          args:
            type: object
            required:
              - todo
            properties:
              todo:
                $ref: "#/components/inputObjects/TodoInputType"
          title: Todo
          type: object
          required:
            - id
            - name
            - colors
          properties:
            id:
              type: string
              format: ID
            name:
              type: string
            completed:
              type: boolean
            color:
              $ref: "#/components/enums/Color"
            colors:
              description: A field that requires an argument
              type: array
              items:
                $ref: "#/components/enums/Color"
              args:
                type: object
                required:
                  - filter
                properties:
                  filter:
                    type: array
                    items:
                      $ref: "#/components/enums/Color"
      components:
        objects:
          Todo:
            title: Todo
            type: object
            required:
              - id
              - name
              - colors
            properties:
              id:
                type: string
                format: ID
              name:
                type: string
              completed:
                type: boolean
              color:
                $ref: "#/components/enums/Color"
              colors:
                description: A field that requires an argument
                type: array
                items:
                  $ref: "#/components/enums/Color"
                args:
                  type: object
                  required:
                    - filter
                  properties:
                    filter:
                      type: array
                      items:
                        $ref: "#/components/enums/Color"
        enums:
          Color:
            title: Color
            type: string
            enum:
              - RED
              - GREEN
            values:
              RED:
                description: Red color
              GREEN:
                description: Green color
        inputObjects:
          TodoInputType:
            title: TodoInputType
            type: object
            required:
              - name
            properties:
              name:
                title: name
                type: string
              completed:
                title: completed
                deprecated:
                  reason: not used
                type: boolean
              color:
                title: color
                type: string
                enum:
                  - RED
                  - GREEN
                values:
                  RED:
                    description: Red color
                  GREEN:
                    description: Green color
                default: RED
        directives:
          include:
            title: include
            description: >-
              Directs the executor to include this field or fragment only when the
              \`if\` argument is true.
            locations:
              - FIELD
              - FRAGMENT_SPREAD
              - INLINE_FRAGMENT
            args:
              type: object
              required:
                - if
              properties:
                if:
                  type: boolean
                  description: Included when true.
            repeatable: false
          skip:
            title: skip
            description: >-
              Directs the executor to skip this field or fragment when the \`if\`
              argument is true.
            locations:
              - FIELD
              - FRAGMENT_SPREAD
              - INLINE_FRAGMENT
            args:
              type: object
              required:
                - if
              properties:
                if:
                  type: boolean
                  description: Skipped when true.
            repeatable: false
    `

    expect(merged).toMatchObject(expected)
  })
})