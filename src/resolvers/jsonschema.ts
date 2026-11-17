import type { JsonSchema } from "../types"
import { hasOwn, safeSet } from "../safe"

// key -> values of that key in every item that carries it (item order); own-property safe (`__proto__` is a key)
export const getAllOfItemsMap = (allOfItems: JsonSchema[]): Record<string, any[]> => {
  const result: Record<string, any[]> = {}

  for (const schema of allOfItems) {
    for (const key of Object.keys(schema)) {
      if (hasOwn(result, key)) {
        result[key].push(schema[key])
      } else {
        safeSet(result, key, [schema[key]])
      }
    }
  }
  return result
}
