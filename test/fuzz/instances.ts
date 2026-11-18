/*
 * Instance generation for the equivalence oracle: a fixed pool plus values derived from the
 * schema (boundary numbers, lengths/counts ± 1, enum/const members, property names incl. names matching the
 * patterns, `__proto__`/`constructor` keys). Deterministic: the same schemas always give the same list.
 */

// pattern -> sample strings (matching and non-matching); patterns outside the table use their literal characters
export const PATTERN_SAMPLES: Record<string, string[]> = {
  "^a": ["a", "ab", "abc", "ba", "A"],
  "b": ["b", "ab", "ba", "a"],
  "^[ab]+$": ["a", "ab", "aab", "abc", "c"],
  "^x\\d+$": ["x1", "x12", "x", "1x", "xa"],
  "^_": ["_", "_a", "__proto__", "a_"],
  "^c": ["c", "constructor", "ca", "ac"],
  "\\d$": ["1", "a1", "x12", "1a"],
  "^.{2}$": ["ab", "a", "abc", "xy"],
}

const FIXED_NAMES = ["a", "__proto__", "constructor"]

const BASE_SCALARS: unknown[] = [null, true, false, 0, 1, -1, 0.5, 1.5, 2, 3, 4, 6, "", "a", "b", "ab", "ba", "abc", "aa", "x1", "1", "2020-01-01", "a@b.co", "http://x.io/a", "1.2.3.4"]
const BASE_COMPOSITES: unknown[] = [[], [1], ["a"], [null], [1, 2], [1, 1], ["a", 1], [1, "a"], ["a", "a"], [1, 2, 3], [1, "a", 3], [[1]], [{}], {}, { a: 1 }, { a: "a" }, { b: "ab" }, { a: 1, b: 2 }, { a: [] }, { a: {} }]

const NUMERIC_KEYS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
const LENGTH_KEYS = new Set(["minLength", "maxLength"])
const COUNT_KEYS = new Set(["minItems", "maxItems", "minContains", "maxContains"])
const PROP_COUNT_KEYS = new Set(["minProperties", "maxProperties"])
const NAME_CONTAINERS = new Set(["properties", "dependencies", "dependentSchemas", "dependentRequired"])

// an own enumerable property, also for `__proto__`
const define = (target: Record<string, unknown>, key: string, value: unknown) => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

const objectOf = (entries: [string, unknown][]): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of entries) { define(result, key, value) }
  return result
}

interface Collected {
  numbers: number[]
  lengths: number[]
  counts: number[]
  propCounts: number[]
  members: unknown[]
  strings: string[]
  names: string[]
}

const literal = (pattern: string) => pattern.replace(/[\^$\\.*+?()[\]{}|]/g, "")

const patternSamples = (pattern: string): string[] => {
  if (Object.prototype.hasOwnProperty.call(PATTERN_SAMPLES, pattern)) { return PATTERN_SAMPLES[pattern] }
  const lit = literal(pattern)
  return lit.length > 20 ? [] : [lit, lit + "x", "x" + lit]
}

const collect = (node: unknown, acc: Collected, seen: Set<unknown>, depth = 0) => {
  if (depth > 60 || !node || typeof node !== "object" || seen.has(node)) { return }
  seen.add(node)
  if (Array.isArray(node)) {
    for (const child of node) { collect(child, acc, seen, depth + 1) }
    return
  }
  for (const key of Object.keys(node)) {
    const value = (node as any)[key]
    if (key === "const") { acc.members.push(value); continue }
    if (key === "enum" && Array.isArray(value)) { acc.members.push(...value); continue }
    if (key === "default" || key === "examples" || key === "example") { continue }
    if (typeof value === "number") {
      if (NUMERIC_KEYS.has(key)) { acc.numbers.push(value) }
      else if (key === "multipleOf" && value > 0) { acc.numbers.push(value, value * 2, value * 3, value * 6, value / 2, -value) }
      else if (LENGTH_KEYS.has(key)) { acc.lengths.push(value) }
      else if (COUNT_KEYS.has(key)) { acc.counts.push(value) }
      else if (PROP_COUNT_KEYS.has(key)) { acc.propCounts.push(value) }
    }
    if (key === "pattern" && typeof value === "string") { acc.strings.push(...patternSamples(value)) }
    if (key === "required" && Array.isArray(value)) {
      for (const name of value) { if (typeof name === "string") { acc.names.push(name) } }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (NAME_CONTAINERS.has(key)) {
        acc.names.push(...Object.keys(value))
        for (const dep of Object.values(value)) {
          if (Array.isArray(dep)) { for (const name of dep) { if (typeof name === "string") { acc.names.push(name) } } }
        }
      } else if (key === "patternProperties") {
        for (const pattern of Object.keys(value)) { acc.names.push(...patternSamples(pattern)) }
      }
    }
    if (typeof value === "object") { collect(value, acc, seen, depth + 1) }
  }
}

// stable dedupe key that keeps `__proto__` own keys apart from plain objects
const keyOf = (value: unknown): string => {
  if (value === undefined) { return "u" }
  if (typeof value !== "object" || value === null) { return JSON.stringify(value) + typeof value }
  if (Array.isArray(value)) { return "[" + value.map(keyOf).join(",") + "]" }
  return "{" + Object.keys(value).map((k) => JSON.stringify(k) + ":" + keyOf((value as any)[k])).join(",") + "}"
}

export interface InstanceOptions {
  extra?: unknown[]        // additional instances (e.g. the failing instance of a counterexample)
  limit?: number           // hard cap of the list (default 400)
}

/** Instances targeted at the given schemas (usually the original and the merged schema). */
export const instancesFor = (schemas: unknown[], options: InstanceOptions = {}): unknown[] => {
  const acc: Collected = { numbers: [], lengths: [], counts: [], propCounts: [], members: [], strings: [], names: [] }
  const seen = new Set<unknown>()
  for (const schema of schemas) { collect(schema, acc, seen) }

  const out: unknown[] = []
  const keys = new Set<string>()
  const limit = options.limit ?? 400
  const add = (value: unknown) => {
    if (value === undefined || out.length >= limit) { return }
    const key = keyOf(value)
    if (keys.has(key)) { return }
    keys.add(key)
    out.push(value)
  }

  for (const value of options.extra ?? []) { add(value) }

  const numbers: number[] = []
  for (const n of acc.numbers) {
    if (!Number.isFinite(n)) { continue }
    numbers.push(n - 1, n - 0.5, n, n + 0.5, n + 1)
  }
  const sizes = (list: number[]) => [...new Set(list.flatMap((n) => [n - 1, n, n + 1]).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))]
  const strings = [...acc.strings, ...sizes(acc.lengths).flatMap((n) => ["a".repeat(n), "b".repeat(n)])]

  const scalars: unknown[] = []
  const scalarKeys = new Set<string>()
  for (const value of [...BASE_SCALARS, ...acc.members, ...numbers, ...strings]) {
    const key = keyOf(value)
    if (value === undefined || scalarKeys.has(key)) { continue }
    scalarKeys.add(key)
    scalars.push(value)
  }
  for (const value of scalars) { add(value) }
  for (const value of BASE_COMPOSITES) { add(value) }

  // a small value set used inside arrays and objects (enum/const members first: they are the interesting ones)
  const small = [...acc.members.filter((v) => v === null || typeof v !== "object"), null, 1, 1.5, "a", "ab", true]
    .filter((v, i, list) => list.findIndex((w) => keyOf(w) === keyOf(v)) === i).slice(0, 8)

  // arrays: single members, duplicates, pairs, counts around the bounds, tuples
  for (const x of small) { add([x]); add([x, x]) }
  for (let i = 0; i < small.length; i++) { for (let j = 0; j < small.length; j++) { if (i !== j && (i + j) % 2 === 0) { add([small[i], small[j]]) } } }
  for (const n of sizes(acc.counts)) {
    add(Array.from({ length: n }, (_, i) => i))
    add(Array.from({ length: n }, () => "a"))
    add(Array.from({ length: n }, (_, i) => (i % 2 ? "a" : 1)))
  }
  for (const m of acc.members) { add([m]); add([m, 1]); add(["a", m]) }

  // objects: every name with each small value, pairs of names, counts around the bounds, nesting
  const names = [...new Set([...FIXED_NAMES, ...acc.names])].slice(0, 10)
  for (const name of names) {
    for (const value of small.slice(0, 4)) { add(objectOf([[name, value]])) }
    add(objectOf([[name, {}]]))
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      add(objectOf([[names[i], "a"], [names[j], (i + j) % 2 ? 1 : null]]))
    }
  }
  for (const n of sizes(acc.propCounts)) { add(objectOf(names.slice(0, n).map((name) => [name, 1]))) }
  add(objectOf(names.map((name) => [name, "a"])))
  add(objectOf(names.map((name) => [name, 1])))
  return out
}
