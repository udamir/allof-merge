// Own-property-safe object helpers. Keys such as `__proto__`, `constructor` and `prototype`
// come from user documents; plain assignment `obj[key] = v` with `key === "__proto__"` would set the prototype,
// and `key in obj` sees inherited members. Every dynamic-key write / lookup in the engine goes through these.

const hasOwnProperty = Object.prototype.hasOwnProperty

/** `true` when `obj` is a non-null object that has `key` as an own property. */
export const hasOwn = (obj: unknown, key: PropertyKey): boolean =>
  typeof obj === "object" && obj !== null && hasOwnProperty.call(obj, key)

/** Own property value or `undefined` (never an inherited member such as `Object.prototype`). */
export const getOwn = (obj: unknown, key: PropertyKey): any =>
  hasOwn(obj, key) ? (obj as any)[key] : undefined

/** Sets `obj[key] = value` as an own, enumerable, writable, configurable data property (never calls setters). */
// (`__proto__` is the only accessor of Object.prototype, so every other key is a plain data write)
export const safeSet = <T extends object>(obj: T, key: PropertyKey, value: unknown): T => {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
  } else {
    ;(obj as any)[key] = value
  }
  return obj
}

/** Shallow copy of own enumerable string keys, own-property safe (replacement for `{ ...obj }` / `Object.assign`). */
export const safeClone = <T extends object>(obj: T): T => {
  const out: any = Array.isArray(obj) ? [] : {}
  for (const key of Object.keys(obj)) {
    safeSet(out, key, (obj as any)[key])
  }
  return out
}

/** Copies own enumerable string keys of `source` into `target`, own-property safe (replacement for `Object.assign`). */
export const safeAssign = <T extends object>(target: T, ...sources: object[]): T => {
  for (const source of sources) {
    if (!source) continue
    for (const key of Object.keys(source)) {
      safeSet(target, key, (source as any)[key])
    }
  }
  return target
}
