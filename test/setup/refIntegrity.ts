/*
 * D-17 / D-22 suite-wide check: every whole-document merge (`merge(value)`, `createMerger().merge(value)` without a
 * different `source`) of every test must return an output whose local `$ref`s all resolve in the output (only refs
 * already broken in the input are exempt), and a `$ref` whose pointer runs through a node with its own allOf may be
 * replaced by a copy of its target only where the merged output holds no equal value at the pointer or at its matching
 * location (links stay links, D-22 / D-23). A violation throws from merge, so the test that produced it fails with
 * the offending refs.
 * Set ALLOF_MERGE_REF_CHECK=0 to disable it (e.g. when timing merges).
 */
jest.mock("../../src/merge", () => {
  const actual = jest.requireActual("../../src/merge")
  const { danglingRefs, copiesWithEqualLink } = jest.requireActual("../helpers/refIntegrity")
  const enabled = process.env.ALLOF_MERGE_REF_CHECK !== "0"

  const check = (value: unknown, source: unknown, hasSource: boolean, result: unknown) => {
    if (!enabled || (hasSource && source !== value)) { return }
    const dangling = danglingRefs(value, result)
    if (dangling.length) {
      throw new Error(`D-17 ref integrity: dangling $ref in the merged output: ${dangling.join(", ")}`)
    }
    const copies = copiesWithEqualLink(value, result)
    if (copies.length) {
      throw new Error(`D-22 links stay links: $ref replaced by a copy although the merged output holds an equal value: ${copies.join(", ")}`)
    }
  }

  const createMerger = (options: any = {}) => {
    const merger = actual.createMerger(options)
    return {
      ...merger,
      merge: (value: unknown, callOptions?: any) => {
        const result = merger.merge(value, callOptions)
        const hasCallSource = !!callOptions && "source" in callOptions
        const source = hasCallSource ? callOptions.source : options.source
        check(value, source, source !== undefined, result)
        return result
      },
    }
  }

  return {
    ...actual,
    createMerger,
    merge: (value: unknown, options?: any) => createMerger(options).merge(value),
  }
})
