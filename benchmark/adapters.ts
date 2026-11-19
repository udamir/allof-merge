/*
 * One adapter per library: `mergeSchema(schema, profile)` turns a JSON Schema with nested `allOf` into an allOf-free
 * schema the way the library's documentation recommends. Libraries with a deep (recursive) allOf merge are called
 * once; a library that only merges a list of schemas (@fastify/merge-json-schemas) is applied bottom-up to every node
 * with an `allOf`. `mergeDocument` is set only for libraries that resolve local `$ref`s themselves (whole OpenAPI /
 * JSON Schema documents); the others need a dereferenced input and are skipped for those workloads.
 *
 * Every adapter gets its own copy of the input (some libraries mutate it) and must not throw for valid input: a throw
 * is recorded as such by the correctness pass.
 */

import fs from "node:fs"
import path from "node:path"

import mokkaMergeAllOf from "json-schema-merge-allof"
import stoplightMergeAllOf from "@stoplight/json-schema-merge-allof"
import { mergeSchemas as fastifyMergeSchemas } from "@fastify/merge-json-schemas"
import * as x0k from "@x0k/json-schema-merge"
import * as x0kArray from "@x0k/json-schema-merge/lib/array"
import * as allofMerge06 from "allof-merge-0.6"
import * as redocly from "@redocly/allof-merge"

// allof-merge: the build of this repository, linked as a dependency (`pnpm start` builds it first)
import * as allofMerge10 from "allof-merge"
import pkg from "allof-merge/package.json" with { type: "json" }

import type { Profile } from "./oracle.ts"

export type { Profile }

export interface Adapter {
  name: string            // package name as published
  version: string
  mergeSchema: (schema: unknown, profile: Profile) => unknown
  mergeDocument?: (document: unknown) => unknown
  notes: string
}

// read from node_modules directly: some packages do not export their package.json
const versionOf = (name: string): string => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "node_modules", name, "package.json"), "utf8")).version

// bottom-up allOf resolution for a library that merges a list of schemas: children first, then the node itself as
// the conjunction of its own keywords and its allOf items
const deepAllOf = (merge: (schemas: unknown[]) => unknown) => {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) { return value.map(walk) }
    if (typeof value !== "object" || value === null) { return value }
    const node: Record<string, unknown> = {}
    for (const key of Object.keys(value)) { node[key] = walk((value as Record<string, unknown>)[key]) }
    if (!Array.isArray(node.allOf)) { return node }
    const { allOf, ...rest } = node
    return merge([rest, ...(allOf as unknown[])])
  }
  return walk
}

const x0kMerge = (() => {
  const { compareSchemaDefinitions, compareSchemaValues } = x0k.createComparator()
  const { mergeArrayOfSchemaDefinitions } = x0k.createMerger({
    intersectJson: x0kArray.createIntersector(compareSchemaValues),
    deduplicateJsonSchemaDef: x0kArray.createDeduplicator(compareSchemaDefinitions),
  })
  return x0k.createDeepAllOfMerge(x0k.createShallowAllOfMerge(mergeArrayOfSchemaDefinitions))
})()

// default options: a keyword without a built-in resolver (pattern, format, …) keeps equal values and throws on
// different ones (onConflict "throw")
const fastifyDeep = deepAllOf((schemas) => fastifyMergeSchemas(schemas as any[]))

export const ADAPTERS: Adapter[] = [
  {
    name: `allof-merge ${pkg.version} (this branch)`,
    version: `${pkg.version} (this repository)`,
    mergeSchema: (schema, profile) => allofMerge10.merge(schema, { rules: allofMerge10.jsonSchemaMergeRules(profile) }),
    mergeDocument: (document) => allofMerge10.merge(document),
    notes: "deep merge, local $refs (also circular), OpenAPI / AsyncAPI / GraphApi rule sets, issues reported",
  },
  {
    name: "allof-merge 0.6.8 (released)",
    version: versionOf("allof-merge-0.6"),
    mergeSchema: (schema) => allofMerge06.merge(schema, { rules: allofMerge06.jsonSchemaMergeRules() }),
    mergeDocument: (document) => allofMerge06.merge(document),
    notes: "the current npm release (latest dist-tag): deep merge, local $refs, OpenAPI / GraphApi rule sets",
  },
  {
    name: "@redocly/allof-merge",
    version: versionOf("@redocly/allof-merge"),
    mergeSchema: (schema) => (redocly as any).merge(schema, { rules: (redocly as any).jsonSchemaMergeRules() }),
    mergeDocument: (document) => (redocly as any).merge(document),
    notes: "Redocly's fork of allof-merge 0.6",
  },
  {
    name: "json-schema-merge-allof",
    version: versionOf("json-schema-merge-allof"),
    mergeSchema: (schema) => mokkaMergeAllOf(schema as any, { deep: true }),
    notes: "deep merge, no $ref resolution (dereference first), throws on incompatible values",
  },
  {
    name: "@stoplight/json-schema-merge-allof",
    version: versionOf("@stoplight/json-schema-merge-allof"),
    mergeSchema: (schema) => stoplightMergeAllOf(schema as any, { deep: true }),
    notes: "Stoplight's fork of json-schema-merge-allof",
  },
  {
    name: "@x0k/json-schema-merge",
    version: versionOf("@x0k/json-schema-merge"),
    mergeSchema: (schema) => x0kMerge(schema as any),
    notes: "createDeepAllOfMerge with the documented comparator / deduplicator; draft-07 only, no $ref resolution",
  },
  {
    name: "@fastify/merge-json-schemas",
    version: versionOf("@fastify/merge-json-schemas"),
    mergeSchema: (schema) => fastifyDeep(schema),
    notes: "mergeSchemas([...]) applied bottom-up to every allOf node (the library merges a list, not a tree); throws on conflicts and on differing values of keywords it has no resolver for (pattern, format, …)",
  },
]
