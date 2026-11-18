import { isObject } from "json-crawl"

import type { AnyOfNode, OneOfNode, PatternMatchLimits, ResolvedMergeSettings } from "./types.ts"
import { createResolutionIndex } from "./resolve.ts"
import { hasOwn, safeClone, safeSet } from "./safe.ts"

export * from "./pointer.ts"

export const popValues = (data: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const source: Record<string | number, unknown> = {}

  for (const key of keys) {
    if (hasOwn(data, key)) {
      safeSet(source, key, data[key])
      delete data[key]
    }
  }

  return source
}

// nesting depth after which mergeValues stops descending and takes the patch by reference (cyclic input)
const MERGE_VALUES_MAX_DEPTH = 100_000

// deep merge of annotation values (`example`, `default`, ...): arrays are concatenated, objects merged key by key,
// anything else is replaced by the patch. Iterative (no stack overflow on deep values) and own-property safe
// (`__proto__`, `constructor` survive as own data)
export const mergeValues = (value: any, patch: any) => {
  const root: Record<string, any> = {}
  const stack: [Record<string, any>, string, any, any, number][] = [[root, "value", value, patch, 0]]
  while (stack.length) {
    const [target, key, v, p, depth] = stack.pop()!
    if (Array.isArray(v) && Array.isArray(p)) {
      safeSet(target, key, [...v, ...p])
    } else if (isObject(v) && isObject(p) && depth < MERGE_VALUES_MAX_DEPTH) {
      const result: Record<string, any> = safeClone(v)
      safeSet(target, key, result)
      for (const k of Object.keys(p)) {
        stack.push([result, k, hasOwn(result, k) ? result[k] : undefined, (p as any)[k], depth + 1])
      }
    } else {
      safeSet(target, key, p)
    }
  }
  return root.value
}

export const isAnyOfNode = (value: any): value is AnyOfNode => {
  return value && value.anyOf && Array.isArray(value.anyOf)
}

export const isOneOfNode = (value: any): value is OneOfNode => {
  return value && value.oneOf && Array.isArray(value.oneOf)
}

// plain (non-array, non-null) object
export const isPlainObject = (value: unknown): value is Record<string, any> => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const isEmptyObject = (value: unknown): boolean => {
  return isPlainObject(value) && Object.keys(value).length === 0
}

// resolves a JSON pointer against data, following intermediate $ref nodes and applying the remaining segments to their targets
export const resolvePointer = (data: unknown, pointer: string): any => {
  if (!isObject(data)) { return }
  return createResolutionIndex(data).resolvePointer(pointer)
}

// structural equality (zero dependencies); key order of objects is not significant. Iterative (no stack overflow
// on deeply nested values) and cycle safe (a pair of objects already being compared is assumed equal)
export const deepEqual = (a: any, b: any): boolean => {
  if (a === b) { return true }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) { return false }
  const stack: any[] = [a, b]
  let seen: Map<object, Set<object>> | undefined
  while (stack.length) {
    const y = stack.pop()
    const x = stack.pop()
    if (x === y) { continue }
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) { return false }
    seen ??= new Map()
    let pairs = seen.get(x)
    if (pairs?.has(y)) { continue }
    if (!pairs) {
      pairs = new Set()
      seen.set(x, pairs)
    }
    pairs.add(y)
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) { return false }
      for (let i = 0; i < x.length; i++) { stack.push(x[i], y[i]) }
      continue
    }
    if (Array.isArray(y)) { return false }
    const keys = Object.keys(x)
    if (keys.length !== Object.keys(y).length) { return false }
    for (const key of keys) {
      if (!hasOwn(y, key)) { return false }
      stack.push(x[key], y[key])
    }
  }
  return true
}

// literal output / close marker of canonicalKey (never a user value)
class Token {
  readonly text: string
  readonly closes?: object
  constructor(text: string, closes?: object) {
    this.text = text
    this.closes = closes
  }
}

const TOO_DEEP = Symbol("too deep")

// recursive canonical key for shallow values (the common case); throws TOO_DEEP past 64 levels
const shallowKey = (v: unknown, depth: number): string | undefined => {
  switch (typeof v) {
    case "string": return JSON.stringify(v)
    case "number": return Object.is(v, -0) ? "0" : String(v)
    case "boolean": return String(v)
    case "undefined": return "u"
    case "object": break
    default: return undefined
  }
  if (v === null) { return "null" }
  if (depth > 64) { throw TOO_DEEP }
  if (Array.isArray(v)) {
    let out = "["
    for (let i = 0; i < v.length; i++) {
      const key = shallowKey(v[i], depth + 1)
      if (key === undefined) { return undefined }
      out += `,${key}`
    }
    return `${out}]`
  }
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) { return undefined }
  const keys = Object.keys(v as object).sort()
  let out = "{"
  for (const k of keys) {
    const key = shallowKey((v as any)[k], depth + 1)
    if (key === undefined) { return undefined }
    out += `,${JSON.stringify(k)}:${key}`
  }
  return `${out}}`
}

// canonical string of a JSON value (object keys sorted), equal for deepEqual values; undefined for values that
// cannot be keyed (cycles, functions, symbols, non-plain objects). Deep values are keyed iteratively
export const canonicalKey = (value: unknown): string | undefined => {
  try {
    return shallowKey(value, 0)
  } catch (error) {
    if (error !== TOO_DEEP) { throw error }
  }
  return deepKey(value)
}

const deepKey = (value: unknown): string | undefined => {
  const out: string[] = []
  const stack: unknown[] = [value]
  const open = new Set<object>()
  while (stack.length) {
    const v = stack.pop()
    if (v instanceof Token) {
      if (v.closes) { open.delete(v.closes) }
      out.push(v.text)
      continue
    }
    if (typeof v === "string") { out.push(JSON.stringify(v)); continue }
    if (typeof v === "number") { out.push(Object.is(v, -0) ? "0" : String(v)); continue }
    if (typeof v === "boolean" || v === null) { out.push(String(v)); continue }
    if (v === undefined) { out.push("u"); continue }
    if (typeof v !== "object") { return undefined }
    const proto = Object.getPrototypeOf(v)
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) { return undefined }
    if (open.has(v)) { return undefined }
    open.add(v)
    if (Array.isArray(v)) {
      out.push("[")
      stack.push(new Token("]", v))
      for (let i = v.length - 1; i >= 0; i--) { stack.push(v[i], new Token(",")) }
    } else {
      out.push("{")
      stack.push(new Token("}", v))
      const keys = Object.keys(v).sort()
      for (let i = keys.length - 1; i >= 0; i--) { stack.push((v as any)[keys[i]], new Token(`,${JSON.stringify(keys[i])}:`)) }
    }
  }
  return out.join("")
}

/**
 * Set of JSON values compared structurally: primitives by value, objects by canonical key (falling back to a
 * linear deepEqual scan only for values that cannot be keyed). Used by enum / required / dependencies merges so
 * that intersections and unions are linear instead of quadratic.
 */
export class ValueSet {
  private primitives = new Set<unknown>()
  private keys = new Set<string>()
  private unkeyed: unknown[] = []

  has(value: unknown): boolean {
    if (typeof value !== "object" || value === null) { return this.primitives.has(value) }
    const key = canonicalKey(value)
    if (key !== undefined) { return this.keys.has(key) }
    return this.unkeyed.some((v) => deepEqual(v, value))
  }

  add(value: unknown): boolean {
    if (typeof value !== "object" || value === null) {
      if (this.primitives.has(value)) { return false }
      this.primitives.add(value)
      return true
    }
    const key = canonicalKey(value)
    if (key !== undefined) {
      if (this.keys.has(key)) { return false }
      this.keys.add(key)
      return true
    }
    if (this.unkeyed.some((v) => deepEqual(v, value))) { return false }
    this.unkeyed.push(value)
    return true
  }
}

// first-seen order union without duplicates (structural comparison for non-primitive members); lists that are
// not arrays are ignored
export const uniqueConcat = <T>(lists: T[][]): T[] => {
  const result: T[] = []
  const seen = new ValueSet()
  for (const list of lists) {
    if (!Array.isArray(list)) { continue }
    for (const item of list) {
      if (seen.add(item)) { result.push(item) }
    }
  }
  return result
}

// largest decimal multiplier used to turn a decimal multipleOf into an integer (15 decimal digits)
export const MAX_MULTIPLIER = 1e15

// a valid multipleOf value: a finite number > 0
export const isValidMultipleOf = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

// number of decimal digits of the shortest representation of a finite number (1.5 -> 1, 1e-7 -> 7)
const decimalDigits = (value: number): number => {
  const [mantissa, exponent] = String(value).split("e")
  const fraction = mantissa.split(".")[1]?.length ?? 0
  return Math.max(0, fraction - (exponent ? Number(exponent) : 0))
}

// power of ten that turns `number` into an integer; Infinity when it needs more than 15 decimal digits or the
// number is not finite (never loops)
export const findMultiplierForInteger = (number: number): number => {
  if (!Number.isFinite(number)) { return Infinity }
  const digits = decimalDigits(Math.abs(number))
  const multiplier = 10 ** digits
  return multiplier > MAX_MULTIPLIER ? Infinity : multiplier
}

/**
 * Least common multiple of positive finite numbers (decimals included, up to 15 decimal digits).
 * Returns undefined when it cannot be computed exactly: a value is not a finite positive number, needs more than
 * 15 decimal digits, or a scaled value / the result is not a safe integer.
 */
export const lcmOf = (values: number[]): number | undefined => {
  if (!values.length || !values.every(isValidMultipleOf)) { return undefined }
  const unique = [...new Set(values)]
  if (unique.length === 1) { return unique[0] }
  const multiplier = unique.reduce((r, v) => Math.max(r, findMultiplierForInteger(v)), 1)
  if (!Number.isFinite(multiplier)) { return undefined }
  let lcm = 1
  for (const value of unique) {
    const scaled = Math.round(value * multiplier)
    if (!Number.isSafeInteger(scaled) || scaled <= 0) { return undefined }
    lcm = (lcm / calculateGCD(lcm, scaled)) * scaled
    if (!Number.isSafeInteger(lcm)) { return undefined }
  }
  const result = lcm / multiplier
  if (!Number.isFinite(result) || result <= 0 || Math.round(result * multiplier) !== lcm) { return undefined }
  return result
}

// least common multiple; NaN when it cannot be computed exactly (see lcmOf)
export function calculateLCM(args: number[]): number {
  return lcmOf(args) ?? NaN
}

// greatest common divisor (iterative)
export function calculateGCD(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) { return NaN }
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

// cartesian product of the vectors; values that are not arrays are ignored (iterative)
export const findCombinations = (vectors: any[][]): any[][] => {
  let combinations: any[][] = [[]]
  for (const vector of vectors) {
    if (!Array.isArray(vector)) { continue }
    const next: any[][] = []
    for (const combination of combinations) {
      for (const element of vector) {
        next.push([...combination, element])
      }
    }
    combinations = next
  }
  return combinations
}

// number of combinations findCombinations would produce
export const countCombinations = (vectors: any[][]): number => {
  let count = 1
  for (const vector of vectors) {
    if (!Array.isArray(vector)) { continue }
    count *= vector.length
    if (!count) { return 0 }
  }
  return count
}

// bounded LRU cache of compiled patterns (an attacker-controlled document cannot grow it without limit)
export const REGEXP_CACHE_SIZE = 1000
const regexpCache = new Map<string, RegExp | null>()

// compiled pattern (unicode mode first, legacy mode as fallback), null when the pattern is invalid
export const compilePattern = (pattern: string): RegExp | null => {
  const cached = regexpCache.get(pattern)
  if (cached !== undefined) {
    regexpCache.delete(pattern)
    regexpCache.set(pattern, cached)
    return cached
  }
  let regexp: RegExp | null
  try {
    regexp = new RegExp(pattern, "u")
  } catch {
    try {
      regexp = new RegExp(pattern)
    } catch {
      regexp = null
    }
  }
  if (regexpCache.size >= REGEXP_CACHE_SIZE) {
    regexpCache.delete(regexpCache.keys().next().value as string)
  }
  regexpCache.set(pattern, regexp)
  return regexp
}

// number of compiled patterns currently cached (for tests)
export const regexpCacheSize = (): number => regexpCache.size

// compiled pattern cache; an invalid pattern never matches
export const testPattern = (pattern: string, value: string): boolean => {
  const regexp = compilePattern(pattern)
  return regexp ? regexp.test(value) : false
}

/**
 * Static ReDoS heuristic: true when a quantified group (`*`, `+` or `{…}` after `)`) contains a quantifier or an
 * alternation, e.g. `(a+)+`, `(a*)*`, `(a|aa)+`, `(.*a){10}`. Conservative: some harmless patterns such as
 * `(a|b)+` are flagged too (they are then not executed, which only costs output size).
 */
export const hasNestedQuantifier = (pattern: string): boolean => {
  const groups: boolean[] = [] // per open group: it contains a quantifier or an alternation
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\") { i++; continue }
    if (inClass) {
      if (c === "]") { inClass = false }
      continue
    }
    if (c === "[") { inClass = true; continue }
    if (c === "(") {
      groups.push(false)
      if (pattern[i + 1] === "?") { i++ }
      continue
    }
    if (c === ")") {
      const complex = groups.pop() ?? false
      const next = pattern[i + 1]
      if (complex && (next === "*" || next === "+" || next === "{")) { return true }
      if (complex && groups.length) { groups[groups.length - 1] = true }
      continue
    }
    if ((c === "*" || c === "+" || c === "?" || c === "{" || c === "|") && groups.length) {
      groups[groups.length - 1] = true
    }
  }
  return false
}

export const DEFAULT_PATTERN_LIMITS: Readonly<Required<PatternMatchLimits>> = Object.freeze({ maxPatternLength: 256, maxNameLength: 256 })

// pattern-matching limits of the merge settings (defaults when no settings are given); false = matching disabled
export const patternLimits = (settings?: Pick<ResolvedMergeSettings, "matchPatterns">): false | Required<PatternMatchLimits> => {
  if (!settings) { return DEFAULT_PATTERN_LIMITS }
  return settings.matchPatterns === false ? false : settings.matchPatterns ?? DEFAULT_PATTERN_LIMITS
}

// whether `pattern` may be executed by the merge (valid, within the length cap, no nested quantifiers)
export const isMatchablePattern = (pattern: string, limits: false | Required<PatternMatchLimits>): boolean => {
  return limits !== false && pattern.length <= limits.maxPatternLength && !hasNestedQuantifier(pattern) && compilePattern(pattern) !== null
}

/**
 * Bounded pattern test: true / false when the pattern is allowed to run against the name, undefined when matching
 * is disabled, the pattern or the name exceeds the length cap, or the pattern is invalid or has nested quantifiers.
 */
export const matchPattern = (pattern: string, name: string, limits: false | Required<PatternMatchLimits>): boolean | undefined => {
  if (limits === false || name.length > limits.maxNameLength || !isMatchablePattern(pattern, limits)) { return undefined }
  return testPattern(pattern, name)
}

// marker for a per-key resolver result that is written as allOf fragments of the node instead of the key
// (an empty list drops the key)
export const FRAGMENTS: unique symbol = Symbol.for("allof-merge/fragments") as any

// with `value`, the key is written as well (a key whose merged value comes with fragments, e.g. the 2020-12 `items`
// tail next to legacy tuple fragments)
export const FRAGMENTS_VALUE: unique symbol = Symbol.for("allof-merge/fragments-value") as any

export interface Fragments {
  [FRAGMENTS]: unknown[]
  [FRAGMENTS_VALUE]?: { value: unknown }
}

export const asFragments = (list: unknown[], value?: { value: unknown }): Fragments => value ? { [FRAGMENTS]: list, [FRAGMENTS_VALUE]: value } : { [FRAGMENTS]: list }

export const fragmentsValue = (value: Fragments): { value: unknown } | undefined => value[FRAGMENTS_VALUE]

export const isFragments = (value: unknown): value is Fragments => typeof value === "object" && value !== null && FRAGMENTS in value

export const fragmentsOf = (value: Fragments): unknown[] => value[FRAGMENTS]

// the values without structural duplicates (deepEqual), first-seen order; the input array when nothing is removed
export const dedupeValues = <T>(values: T[]): T[] => {
  if (values.length < 2) { return values }
  const keys = new Set<string>()
  const unkeyed: T[] = []
  const result: T[] = []
  for (const value of values) {
    const key = canonicalKey(value)
    if (key !== undefined) {
      if (keys.has(key)) { continue }
      keys.add(key)
    } else {
      if (unkeyed.some((other) => deepEqual(other, value))) { continue }
      unkeyed.push(value)
    }
    result.push(value)
  }
  return result.length === values.length ? values : result
}
