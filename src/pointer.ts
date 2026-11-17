import type { JsonPath } from "json-crawl"

import type { RefNode } from "./types"
import { hasOwn } from "./safe"

// own `$ref` member only: an inherited `$ref` (polluted Object.prototype) never makes a node a reference
export const isRefNode = (value: any): value is RefNode => {
  return hasOwn(value, "$ref") && typeof value.$ref === "string" && !!value.$ref
}

export const parseRef = ($ref: string, basePath = "") => {
  const hashIndex = $ref.indexOf("#")
  const filePath = (hashIndex < 0 ? $ref : $ref.slice(0, hashIndex)) || basePath
  const ref = hashIndex < 0 ? "" : $ref.slice(hashIndex + 1)

  // `#/` is the member "" of the root (RFC 6901), not the root; a fragment without a leading "/" is a plain-name
  // fragment (`$anchor`, draft-06/07 `$id: "#name"`) and is resolved by name, see isAnchorPointer
  const pointer = ref
  const normalized = createRef(filePath, pointer)
  const jsonPath = parsePointer(pointer)

  return { filePath, pointer, normalized, jsonPath }
}

export const createRef = (basePath?: string, pointer?: string): string => {
  if (!basePath) {
    return !pointer ? "#" : `#${pointer}`
  } else {
    return `${basePath}${!pointer ? "" : "#" + pointer}`
  }
}

export const pathMask = {
  slash: /\//g,
  tilde: /~/g,
  escapedSlash: /~1/g,
  escapedTilde: /~0/g
}

const decodeSegment = (segment: string): string => {
  const unescaped = segment.replace(pathMask.escapedSlash, "/").replace(pathMask.escapedTilde, "~")
  try {
    return decodeURIComponent(unescaped)
  } catch {
    return unescaped
  }
}

// a plain-name fragment (`#foo`) rather than a JSON pointer (`#/foo`)
export const isAnchorPointer = (pointer: string): boolean => !!pointer && pointer.charAt(0) !== "/"

export const parsePointer = (pointer: string): string[] => {
  if (!pointer) { return [] }
  // not a JSON pointer: no segments can be derived (callers resolve plain-name fragments separately)
  if (isAnchorPointer(pointer)) { return [] }
  return pointer.split("/").slice(1).map(decodeSegment)
}

// characters RFC 3986 allows unencoded in a URI fragment (sub-delims, ":" and "@") that encodeURIComponent encodes:
// kept literal, so that pointers read like the ones people write (`#/$defs/A`, not `#/%24defs/A`)
const FRAGMENT_SAFE = /%(24|26|2B|2C|3B|3D|3A|40)/gi
const FRAGMENT_CHARS: Record<string, string> = { "24": "$", "26": "&", "2B": "+", "2C": ",", "3B": ";", "3D": "=", "3A": ":", "40": "@" }

export const buildPointer = (path: JsonPath): string => {
  if (!path.length) { return "" }
  return "/" + path.map((i) => encodeURIComponent((String(i).replace(pathMask.tilde, "~0").replace(pathMask.slash, "~1"))).replace(FRAGMENT_SAFE, (_, hex: string) => FRAGMENT_CHARS[hex.toUpperCase()])).join("/")
}
