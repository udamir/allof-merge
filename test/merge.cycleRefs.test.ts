import { describe, it, expect } from "vite-plus/test"
import { merge } from "../src/index.ts";

describe("cycle $refs", () => {
	it("should support cycle refs in allOf", () => {
		const data = {
			type: "object",
			properties: {
				foo: {
					allOf: [
						{
							description: "1-st parent",
						},
						{
							$ref: "#",
						},
					],
				},
				baz: {
					allOf: [
						{
							description: "2-st parent",
						},
						{
							$ref: "#",
						},
					],
				},
			},
		};

		const result: any = merge(data);

		// D-4b: a cycle re-entry is a $ref to the source location of the re-entered node, never a cyclic object
		const baz = {
			type: "object",
			description: "2-st parent",
			properties: { foo: { $ref: "#/properties/foo" }, baz: { $ref: "#/properties/baz" } },
		};
		expect(result).toEqual({
			type: "object",
			properties: {
				foo: {
					description: "1-st parent",
					type: "object",
					properties: { foo: { $ref: "#/properties/foo" }, baz },
				},
				baz,
			},
		});
		expect(() => JSON.stringify(result)).not.toThrow();

		// expect(result).toEqual( {
		//   type: 'object',
		//   properties: {
		//     foo: {
		//       description: '1-st parent',
		//       type: 'object',
		//       properties: {
		//         foo: {
		//           $ref: '#/properties/foo',
		//         },
		//         baz: {
		//           description: '2-st parent',
		//           type: 'object',
		//           properties: {
		//             foo: {
		//               $ref: '#/properties/foo',
		//             },
		//             baz: {
		//               $ref: '#/properties/foo/properties/baz',
		//             },
		//           }
		//         },

		//       }
		//     },
		//     baz: {
		//       $ref: '#/properties/foo/properties/baz',
		//     },
		//   },
		// })
	});

	it("should support dereferenced cycle refs in allOf", () => {
		const data: any = {
			type: "object",
			properties: {
				foo: {
					allOf: [
						{
							description: "1-st parent",
						},
						{
							$ref: "#",
						},
					],
				},
				baz: {
					allOf: [
						{
							description: "2-st parent",
						},
						{
							$ref: "#",
						},
					],
				},
			},
		};

		data.properties.foo.allOf[1] = data;
		data.properties.baz.allOf[1] = data;

		const result: any = merge(data);

		// D-4b: a cycle re-entry is a $ref to the source location of the re-entered node, never a cyclic object
		const baz = {
			type: "object",
			description: "2-st parent",
			properties: { foo: { $ref: "#/properties/foo" }, baz: { $ref: "#/properties/baz" } },
		};
		expect(result).toEqual({
			type: "object",
			properties: {
				foo: {
					description: "1-st parent",
					type: "object",
					properties: { foo: { $ref: "#/properties/foo" }, baz },
				},
				baz,
			},
		});
		expect(() => JSON.stringify(result)).not.toThrow();
	});

	it("should support cross cycle refs in allOf", () => {
		const data = {
			type: "object",
			properties: {
				foo: {
					allOf: [
						{
							properties: {
								test: {
									type: "string",
								},
							},
							description: "1-st parent",
						},
						{
							$ref: "#/properties/baz",
						},
					],
				},
				baz: {
					properties: {
						test: {
							$ref: "#/properties/foo",
						},
					},
				},
			},
		};

		const result = merge(data);

		expect(result).toEqual({
			type: "object",
			properties: {
				foo: {
					description: "1-st parent",
					properties: {
						test: {
							type: "string",
							description: "1-st parent",
							properties: {
								// D-4: the in-progress conjunction started at a node that is not in the source: kept as allOf
								test: {
									allOf: [{ type: "string" }, { $ref: "#/properties/foo" }],
								},
							},
						},
					},
				},
				baz: {
					properties: {
						test: {
							$ref: "#/properties/foo",
						},
					},
				},
			},
		});
	});

	it("should support direct cross cycle refs in allOf", () => {
		const data = {
			type: "object",
			properties: {
				foo: {
					allOf: [
						{
							description: "1-st parent",
						},
						{
							$ref: "#/properties/baz",
						},
					],
				},
				baz: {
					allOf: [
						{
							description: "2-nd parent",
						},
						{
							$ref: "#/properties/foo",
						},
					],
				},
			},
		};

		const result = merge(data);

		expect(result).toEqual({
			type: "object",
			properties: {
        foo: {
          description: "2-nd parent",
        },
				baz: {
          description: "1-st parent",
				},
			},
		});
	});
});
