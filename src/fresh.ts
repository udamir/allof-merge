/*
 * `{ allOf }` nodes the engine creates while merging a node (schema-valued keywords of a merged node, conjunctions of
 * property schemas), merged later in the same clone pass. Such a node is reached exactly once and is never part of the
 * input, so the pass skips the identity bookkeeping for it (cycle check, done memo, fast-path scan, rewritten set).
 */

let current: Set<object> | undefined

// the set that records engine-created nodes until the returned previous set is restored
export const enterFreshScope = (set: Set<object> | undefined): Set<object> | undefined => {
  const previous = current
  current = set
  return previous
}

/** Records `node` as created by the engine in the current merge call (no-op outside a clone pass). */
export const freshNode = <T extends object>(node: T): T => {
  if (current !== undefined) { current.add(node) }
  return node
}
