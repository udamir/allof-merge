import { merge } from "../src";

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

		expect(result).toMatchObject({
			type: "object",
			properties: {
				foo: {
					description: "1-st parent",
					type: "object",
					properties: {
						foo: result.properties.foo,
						baz: result.properties.baz,
					},
				},
				baz: {
					description: "2-st parent",
					type: "object",
					properties: {
						foo: result.properties.foo,
						baz: result.properties.baz,
					},
				},
			},
		});

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

		expect(result).toMatchObject({
			type: "object",
			properties: {
				foo: {
					description: "1-st parent",
					type: "object",
					properties: {
						foo: result.properties.foo,
						baz: result.properties.baz,
					},
				},
				baz: {
					description: "2-st parent",
					type: "object",
					properties: {
						foo: result.properties.foo,
						baz: result.properties.baz,
					},
				},
			},
		});
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
								test: {
									$ref: "#/properties/foo/properties/test",
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
