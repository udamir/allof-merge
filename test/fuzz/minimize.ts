/*
 * Greedy post-shrink minimizer (FEATURE_DESIGN §4.3): fast-check's shrink of letrec schemas leaves noise (`{}`, `true`,
 * unrelated keywords), so after it this removes `allOf` members, object keys and array elements, replaces subschemas
 * by `true`/`{}` and unwraps single-member `allOf`s for as long as the failure persists.
 */

type Path = (string | number)[]

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

const getAt = (root: unknown, path: Path): unknown => path.reduce((node: any, key) => node?.[key], root)

const setAt = (root: unknown, path: Path, value: unknown): unknown => {
  if (!path.length) { return value }
  const copy: any = Array.isArray(root) ? [...root] : { ...(root as any) }
  const [head, ...rest] = path
  if (isObject(copy) && head === "__proto__") {
    Object.defineProperty(copy, head, { value: setAt(copy[head], rest, value), enumerable: true, writable: true, configurable: true })
  } else {
    copy[head] = setAt(copy[head], rest, value)
  }
  return copy
}

const removeAt = (root: unknown, path: Path): unknown => {
  const parentPath = path.slice(0, -1)
  const key = path[path.length - 1]
  const parent = getAt(root, parentPath)
  let next: unknown
  if (Array.isArray(parent)) {
    next = parent.filter((_, i) => i !== key)
  } else {
    const copy: Record<string, unknown> = {}
    for (const k of Object.keys(parent as object)) {
      if (k !== key) { Object.defineProperty(copy, k, { value: (parent as any)[k], enumerable: true, writable: true, configurable: true }) }
    }
    next = copy
  }
  return setAt(root, parentPath, next)
}

// all paths, shallow first (removing a big subtree early saves predicate calls)
const pathsOf = (root: unknown): Path[] => {
  const result: Path[] = []
  const queue: Path[] = [[]]
  while (queue.length) {
    const path = queue.shift() as Path
    result.push(path)
    const node = getAt(root, path)
    if (Array.isArray(node)) { node.forEach((_, i) => queue.push([...path, i])) }
    else if (isObject(node)) { for (const key of Object.keys(node)) { queue.push([...path, key]) } }
  }
  return result
}

function* candidates(root: unknown): Generator<unknown> {
  for (const path of pathsOf(root)) {
    const node = getAt(root, path)
    if (path.length) { yield removeAt(root, path) }
    if (isObject(node) && Array.isArray(node.allOf) && node.allOf.length === 1 && Object.keys(node).length === 1) {
      yield setAt(root, path, node.allOf[0])
    }
    if (path.length && (isObject(node) || Array.isArray(node))) {
      if (Object.keys(node).length) { yield setAt(root, path, {}) }
      yield setAt(root, path, true)
    }
  }
}

const size = (value: unknown): number => JSON.stringify(value)?.length ?? 0

/**
 * Returns the smallest input found for which `fails` still holds. `budget` bounds the number of predicate calls.
 */
export const minimize = <T>(input: T, fails: (candidate: T) => boolean, budget = 3000): T => {
  let current = input
  let calls = 0
  let improved = true
  while (improved && calls < budget) {
    improved = false
    for (const candidate of candidates(current)) {
      if (calls++ >= budget) { break }
      if (size(candidate) >= size(current)) { continue }
      let failed = false
      try { failed = fails(candidate as T) } catch { failed = false }
      if (failed) {
        current = candidate as T
        improved = true
        break
      }
    }
  }
  return current
}
