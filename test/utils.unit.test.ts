import { mergeValues } from "../src"

describe("utils unit tests", function () {
  test("mergeValues", () => {
    expect(mergeValues({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 })
    expect(mergeValues([1], [2])).toEqual([1, 2])
  })
})
