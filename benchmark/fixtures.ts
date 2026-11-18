import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"

import { loadCorpus } from "../test/fuzz/corpus"
import type { Profile } from "./adapters"

/*
 * Workloads. Schema workloads have no $ref, so every library can merge them; document workloads hold local $refs and
 * run only for the libraries that resolve them. The GitHub REST API description is downloaded once (pinned commit)
 * into benchmark/.cache.
 */

export interface Workload {
  name: string
  description: string
  kind: "schema" | "document"
  profile: Profile
  load: () => unknown
}

const json = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"))

// 2 000 properties, each an allOf of two object fragments
const wide = () => ({
  type: "object",
  properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`p${i}`, {
    allOf: [
      { type: "object", properties: { id: { type: "string", minLength: 1 }, n: { type: "number" } }, required: ["id"] },
      { properties: { id: { maxLength: 64 }, tag: { enum: ["a", "b", `c${i}`] } }, required: ["n"] },
    ],
  }])),
})

// 200 levels of allOf nested through properties
const deep = () => {
  let node: Record<string, unknown> = { type: "string" }
  for (let i = 0; i < 200; i++) {
    node = { allOf: [{ type: "object", properties: { next: node } }, { required: ["next"], properties: { [`k${i}`]: { type: "integer" } } }] }
  }
  return node
}

// allOf of oneOf groups (a product of 4 × 3 × 2 branches) under 100 properties
const combinators = () => ({
  type: "object",
  properties: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, {
    allOf: [
      { oneOf: [{ type: "object", required: ["a"] }, { type: "object", required: ["b"] }, { type: "object", required: ["c"] }, { type: "object", required: ["d"] }] },
      { oneOf: [{ properties: { x: { type: "string" } } }, { properties: { x: { type: "number" } } }, { properties: { y: { minimum: i } } }] },
      { anyOf: [{ minProperties: 1 }, { maxProperties: 9 }] },
    ],
  }])),
})

// every corpus case without $ref and without allof-merge options: many small real-world schemas
export const corpusSchemas = (): { id: string, source: string, profile: Profile, schema: unknown }[] => {
  const out: { id: string, source: string, profile: Profile, schema: unknown }[] = []
  for (const { file, cases } of loadCorpus()) {
    for (const c of cases) {
      if (c.options && Object.keys(c.options).length) { continue }
      out.push({ id: c.id, source: file.replace(/\.json$/, ""), profile: c.profile, schema: c.schema })
    }
  }
  return out
}

const GITHUB_COMMIT = "c9c95fe34ced05fe076001f5c55704742bc8e7f8"
const GITHUB_URL = `https://raw.githubusercontent.com/github/rest-api-description/${GITHUB_COMMIT}/descriptions/api.github.com/api.github.com.json`

const github = () => {
  const file = path.join(__dirname, ".cache", `api.github.com-${GITHUB_COMMIT.slice(0, 7)}.json`)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    execFileSync("curl", ["-sSfL", "-o", file, GITHUB_URL], { stdio: "inherit" })
  }
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export const WORKLOADS: Workload[] = [
  { name: "data.json", description: "the repository's benchmark schema: 56 allOf over most keywords (6.5 KB)", kind: "schema", profile: "draft-07", load: () => json("data.json") },
  { name: "wide-2000", description: "2 000 properties, each an allOf of two object fragments", kind: "schema", profile: "draft-07", load: wide },
  { name: "deep-200", description: "200 levels of allOf nested through properties", kind: "schema", profile: "draft-07", load: deep },
  { name: "combinators-100", description: "100 allOf of three oneOf / anyOf groups (24 branches each)", kind: "schema", profile: "draft-07", load: combinators },
  { name: "js-allof-200", description: "JSON Schema with 200 definitions of allOf [$ref Base, $ref Mixin, own properties] (600 $refs, 42 KB)", kind: "document", profile: "draft-07", load: () => json("fixtures/js-allof-200.json") },
  { name: "github-rest", description: `GitHub REST API description (OpenAPI 3.0, ${GITHUB_COMMIT.slice(0, 7)}, ~12 MB, allOf with $ref)`, kind: "document", profile: "draft-07", load: github },
]
