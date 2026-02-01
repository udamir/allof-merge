import { merge } from "../src"

describe("issue #208 - $ref corruption", () => {
  it("should not corrupt $ref when same ref is in both top-level and allOf", () => {
    const $ref = "#/reusable/person";

    const person = {
      type: "object",
      properties: {
        name: { type: "string" },
        friends: { type: "array", items: { $ref } },
        friend: { $ref },
      },
      required: ["name", "age", "friends"],
    };

    const source = { reusable: { person } };

    const schema = { $ref, allOf: [{ $ref }] };

    const merged: any = merge(schema, { source });

    // The key assertions - $ref values must be preserved
    expect(merged.properties.friend.$ref).toBe("#/reusable/person");
    expect(merged.properties.friends.items.$ref).toBe("#/reusable/person");

    // Full structure check
    expect(merged).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        friends: { type: "array", items: { $ref: "#/reusable/person" } },
        friend: { $ref: "#/reusable/person" },
      },
      required: expect.arrayContaining(["name", "age", "friends"]),
    });
  });

  it("should deduplicate identical property schemas without allOf wrapping", () => {
    const schema = {
      allOf: [
        { properties: { x: { type: "string" } } },
        { properties: { x: { type: "string" } } },
      ],
    };

    const merged: any = merge(schema);

    // Should not create { allOf: [...] } for identical values
    expect(merged.properties.x).toEqual({ type: "string" });
    expect(merged.properties.x.allOf).toBeUndefined();
  });

  it("should still properly merge different property schemas with allOf", () => {
    const schema = {
      allOf: [
        { properties: { x: { type: "string", minLength: 1 } } },
        { properties: { x: { type: "string", maxLength: 10 } } },
      ],
    };

    const merged: any = merge(schema);

    // Different values should still merge correctly
    expect(merged.properties.x).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
    });
  });

  it("should handle multiple identical $ref in allOf without corruption", () => {
    const schema = {
      definitions: {
        base: { type: "object", properties: { id: { type: "string" } } }
      },
      allOf: [
        { $ref: "#/definitions/base" },
        { $ref: "#/definitions/base" },
        { $ref: "#/definitions/base" },
      ]
    };

    const merged: any = merge(schema);

    expect(merged.type).toBe("object");
    expect(merged.properties.id).toEqual({ type: "string" });
  });

  it("should preserve $ref in nested structures after merge", () => {
    const schema = {
      definitions: {
        node: {
          type: "object",
          properties: {
            value: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/definitions/node" }
            }
          }
        }
      },
      allOf: [
        { $ref: "#/definitions/node" },
        { properties: { extra: { type: "number" } } }
      ]
    };

    const merged: any = merge(schema);

    expect(merged.type).toBe("object");
    expect(merged.properties.children.items.$ref).toBe("#/definitions/node");
    expect(merged.properties.extra).toEqual({ type: "number" });
  });
});
