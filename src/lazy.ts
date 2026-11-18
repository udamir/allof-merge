// a WeakMap / WeakSet whose table is created on first write: a merger allocates only the tables its merges use

export class LazyWeakMap<K extends object, V> {
  #map?: WeakMap<K, V>

  get(key: K): V | undefined { return this.#map?.get(key) }
  has(key: K): boolean { return this.#map !== undefined && this.#map.has(key) }
  set(key: K, value: V): this {
    (this.#map ??= new WeakMap()).set(key, value)
    return this
  }
  delete(key: K): boolean { return this.#map !== undefined && this.#map.delete(key) }
}

export class LazyWeakSet<T extends object> {
  #set?: WeakSet<T>

  has(value: T): boolean { return this.#set !== undefined && this.#set.has(value) }
  add(value: T): this {
    (this.#set ??= new WeakSet()).add(value)
    return this
  }
  delete(value: T): boolean { return this.#set !== undefined && this.#set.delete(value) }
}
