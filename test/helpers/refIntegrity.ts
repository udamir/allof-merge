import { expect } from "vite-plus/test"
import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020.js"

import { createResolutionIndex } from "../../src/resolve.ts"
import { buildPointer, isRefNode, parseRef } from "../../src/pointer.ts"
import { deepEqual } from "../../src/utils.ts"

// every distinct `$ref` string of a value (iterative, each instance visited once)
export const collectRefs = (value: unknown): Set<string> => {
  const refs = new Set<string>()
  if (typeof value !== "object" || value === null) { return refs }
  const seen = new Set<object>()
  const stack: object[] = [value]
  while (stack.length) {
    const node = stack.pop() as Record<string, unknown>
    if (seen.has(node)) { continue }
    seen.add(node)
    if (!Array.isArray(node) && typeof node.$ref === "string") { refs.add(node.$ref) }
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (typeof child === "object" && child !== null && !seen.has(child)) { stack.push(child) }
    }
  }
  return refs
}

/**
 * D-17 / D-22 output contract of a whole-document merge: every local `$ref` of the output resolves in the output.
 * Only refs that already were in the input and did not resolve there (broken) are not checked, nor are external refs.
 * A pointer the merge wrote itself (a link rewritten to the matching merged location, a cycle re-entry to an output
 * location) need not exist in the input. Returns the dangling refs (empty when the contract holds).
 */
export const danglingRefs = (input: unknown, output: unknown): string[] => {
  const refs = collectRefs(output)
  if (!refs.size) { return [] }
  const inputRefs = collectRefs(input)
  const inputIndex = createResolutionIndex(input)
  const outputIndex = createResolutionIndex(output)
  const dangling: string[] = []
  for (const ref of refs) {
    if (parseRef(ref).filePath) { continue }
    if (inputRefs.has(ref) && !inputIndex.resolve(ref).ok) { continue }
    if (!outputIndex.resolve(ref).ok) { dangling.push(ref) }
  }
  return dangling
}

// value at a JSON pointer by own members only (no intermediate $ref is followed)
const strictAt = (value: unknown, pointer: string): unknown => {
  let current: any = value
  for (const segment of parseRef(`#${pointer}`).jsonPath) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) { return undefined }
    current = current[segment]
  }
  return current
}

const hasOwnAllOf = (value: any): boolean => !!value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.allOf) && Object.prototype.hasOwnProperty.call(value, "allOf")

// the input pointer walked like the resolution index: whether it runs through a node with its own allOf (container
// members definitions / $defs / components excepted), and its matching merged location (allOf member steps removed)
const walkPointer = (input: unknown, index: ReturnType<typeof createResolutionIndex>, ref: string): { through: boolean, matching?: string } => {
  const { jsonPath } = parseRef(ref)
  let value: any = input
  const followed = new Set<object>()
  const out: string[] = []
  let through = false
  let i = 0
  while (i < jsonPath.length) {
    const segment = jsonPath[i]
    if (Array.isArray(value)) {
      value = value[Number(segment)]
      out.push(segment)
      i++
      continue
    }
    if (!value || typeof value !== "object") { return { through: false } }
    if (hasOwnAllOf(value) && !UNAFFECTED_MEMBERS.has(segment)) { through = true }
    if (segment === "allOf" && hasOwnAllOf(value) && i + 1 < jsonPath.length) {
      value = value.allOf[Number(jsonPath[i + 1])]
      i += 2
      continue
    }
    if (Object.prototype.hasOwnProperty.call(value, segment)) {
      value = value[segment]
      out.push(segment)
      i++
      continue
    }
    if (!isRefNode(value) || followed.has(value)) { return { through: false } }
    followed.add(value)
    const resolved = index.resolve(value.$ref)
    if (!resolved.ok) { return { through: false } }
    value = resolved.target
  }
  return { through, matching: `#${buildPointer(out)}` }
}

/**
 * D-22 / D-23 "links stay links" check (structural, cheap): a bare input `$ref` whose pointer runs through a node with
 * its own allOf is replaced by a copy of its target only where the merged output holds no equal value at the pointer
 * or at its matching location (allOf member steps removed). Checked at the input locations of such `$ref`s that are
 * not allOf items and have no ancestor with its own allOf (there the value is conjoined with other members, so it is
 * not a copy). Cycle safe. Returns the locations of copies that should have been links.
 */
export const copiesWithEqualLink = (input: unknown, output: unknown): string[] => {
  if (!input || typeof input !== "object" || !output || typeof output !== "object") { return [] }
  const inputIndex = createResolutionIndex(input)
  const outputIndex = createResolutionIndex(output)
  const offending: string[] = []
  // parent-linked locations: deep inputs (maxDepth tests) must not copy their paths per node
  interface Location { parent?: Location, key: string | number }
  const pathOf = (at: Location | undefined): (string | number)[] => {
    const path: (string | number)[] = []
    for (let current = at; current?.parent; current = current.parent) { path.push(current.key) }
    return path.reverse()
  }
  const seen = new Set<object>()
  const root: Location = { key: "" }
  const stack: [unknown, Location, boolean][] = [[input, root, false]]
  while (stack.length) {
    const [node, location, conjoined] = stack.pop()!
    if (!node || typeof node !== "object" || seen.has(node)) { continue }
    seen.add(node)
    const record = node as Record<string, any>
    if (!Array.isArray(node) && isRefNode(record) && Object.keys(record).length === 1 && !conjoined && location.parent?.key !== "allOf") {
      const path = pathOf(location)
      const ref = record.$ref
      const { filePath, pointer } = parseRef(ref)
      if (!filePath && pointer.startsWith("/") && inputIndex.resolve(ref).ok) {
        const { through, matching } = walkPointer(input, inputIndex, ref)
        const site = buildPointer(path)
        const copy = through ? strictAt(output, site) : undefined
        if (copy !== undefined && !(copy && typeof copy === "object" && Object.prototype.hasOwnProperty.call(copy, "$ref"))) {
          for (const candidate of new Set([ref, matching!])) {
            const at = parseRef(candidate).pointer
            if (at === site || at.startsWith(`${site}/`)) { continue }
            const resolved = outputIndex.resolve(candidate)
            if (resolved.ok && resolved.target !== copy && deepEqual(resolved.target, copy)) {
              offending.push(site)
              break
            }
          }
        }
      }
    }
    const below = conjoined || hasOwnAllOf(node)
    for (const key of Object.keys(record)) {
      const child = record[key]
      if (child && typeof child === "object" && !seen.has(child)) { stack.push([child, { parent: location, key: Array.isArray(node) ? Number(key) : key }, below]) }
    }
  }
  return offending
}

export const expectRefsResolve = (input: unknown, output: unknown) => {
  expect(danglingRefs(input, output)).toEqual([])
}

// members of a merged node whose meaning the merge keeps (container siblings, D-10)
const UNAFFECTED_MEMBERS = new Set(["definitions", "$defs", "components"])

/**
 * Diagnostic (no longer part of the contract since D-22: a link to a merged location is valid when the value there is
 * equal). D-16 / D-17 / D-20 / D-21 meaning check (structural, cheap): every local `$ref` of the output that resolves in the
 * input must not run through a node that has its own `allOf` in the input and was merged in the output (the output
 * node at the same location no longer has an `allOf`): such a pointer would dangle or resolve to the merged, stricter
 * value. The target itself may be merged (it is equivalent); pointers into `definitions` / `$defs` / `components`
 * members are not affected. Returns the offending refs.
 */
export const refsThroughMergedNodes = (input: unknown, output: unknown): string[] => {
  const refs = collectRefs(output)
  if (!refs.size) { return [] }
  const inputIndex = createResolutionIndex(input)
  const outputIndex = createResolutionIndex(output)
  const offending: string[] = []
  for (const ref of refs) {
    const { filePath, pointer, jsonPath } = parseRef(ref)
    if (filePath || !pointer.startsWith("/") || !inputIndex.resolve(ref).ok) { continue }
    // walk the input pointer like the resolution index (intermediate $refs followed), collecting the allOf owners
    let value: any = input
    const followed = new Set<object>()
    let i = 0
    let through = false
    while (i < jsonPath.length) {
      const segment = jsonPath[i]
      if (Array.isArray(value)) {
        value = value[Number(segment)]
        i++
        continue
      }
      if (!value || typeof value !== "object") { break }
      if (!UNAFFECTED_MEMBERS.has(segment) && Array.isArray(value.allOf) && Object.prototype.hasOwnProperty.call(value, "allOf")) {
        const at = inputIndex.pointerOf(value)
        const kept = at === undefined ? undefined : outputIndex.resolvePointer(at)
        if (!kept || typeof kept !== "object" || !Array.isArray((kept as any).allOf)) { through = true }
      }
      if (Object.prototype.hasOwnProperty.call(value, segment)) {
        value = value[segment]
        i++
        continue
      }
      if (!isRefNode(value) || followed.has(value)) { break }
      followed.add(value)
      const resolved = inputIndex.resolve(value.$ref)
      if (!resolved.ok) { break }
      value = resolved.target
    }
    if (through) { offending.push(ref) }
  }
  return offending
}

/**
 * D-22 / D-23 contract of a whole-document merge (structural): every `$ref` of the output resolves (danglingRefs) and
 * a `$ref` was replaced by a copy only where no equal merged value exists (copiesWithEqualLink). The semantic
 * counterpart is expectRefMeaningPreserved (ajv).
 */
export const expectRefsKeepMeaning = (input: unknown, output: unknown) => {
  expect(danglingRefs(input, output)).toEqual([])
  expect(copiesWithEqualLink(input, output)).toEqual([])
}

// JSON pointers of every `$ref` node of an acyclic JSON value
export const refSites = (value: unknown): string[] => {
  const sites: string[] = []
  const stack: [unknown, (string | number)[]][] = [[value, []]]
  while (stack.length) {
    const [node, path] = stack.pop()!
    if (!node || typeof node !== "object") { continue }
    if (!Array.isArray(node) && isRefNode(node)) { sites.push(buildPointer(path)) }
    for (const key of Object.keys(node)) { stack.push([(node as any)[key], [...path, Array.isArray(node) ? Number(key) : key]]) }
  }
  return sites
}

/**
 * Semantic (ajv) version of the meaning check: the input and the output document are registered with ajv, and
 * (a) every `$ref` site of the input that still exists in the output (the location of the `$ref` node, now possibly
 * an inlined schema) and (b) every local `$ref` of the output that resolves in the input must accept exactly the
 * same instances in both documents. Use with small documents: one ajv compilation per checked location.
 */
export const expectRefMeaningPreserved = (input: unknown, output: unknown, instances: unknown[], draft: "07" | "2020" = "07") => {
  const ajvOptions = { strict: false, allErrors: false, validateSchema: false, validateFormats: false }
  const ajv = draft === "2020" ? new Ajv2020(ajvOptions) : new Ajv(ajvOptions)
  ajv.addSchema(input as any, "https://allof-merge.test/input")
  ajv.addSchema(output as any, "https://allof-merge.test/output")
  const inputIndex = createResolutionIndex(input)
  const outputIndex = createResolutionIndex(output)
  const locations = new Set<string>()
  for (const site of refSites(input)) {
    if (outputIndex.resolvePointer(site) !== undefined) { locations.add(site) }
  }
  for (const ref of collectRefs(output)) {
    const { filePath, pointer } = parseRef(ref)
    if (!filePath && pointer.startsWith("/") && inputIndex.resolve(ref).ok) { locations.add(pointer) }
  }
  // ajv does not follow intermediate $refs inside a pointer: address the resolved node by its own location
  const schemaAt = (index: ReturnType<typeof createResolutionIndex>, base: string, location: string): any => {
    const value = index.resolvePointer(location)
    const at = value && typeof value === "object" ? index.pointerOf(value) : undefined
    return at === undefined ? value : { $ref: `${base}#${at}` }
  }
  for (const location of locations) {
    const before = ajv.compile(schemaAt(inputIndex, "https://allof-merge.test/input", location))
    const after = ajv.compile(schemaAt(outputIndex, "https://allof-merge.test/output", location))
    for (const instance of instances) {
      expect({ location, instance, valid: after(instance) }).toEqual({ location, instance, valid: before(instance) })
    }
  }
  return [...locations]
}
