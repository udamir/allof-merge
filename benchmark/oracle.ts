/*
 * Equivalence oracle of the benchmark: the same validator (@cfworker/json-schema), draft-07 `$ref` sibling reading and
 * instance generation as the test suite of allof-merge, and the committed fuzz corpus as the quality cases.
 */
import fs from "node:fs"
import path from "node:path"

import { Validator } from "@cfworker/json-schema"

import { withRefSiblingsApplied } from "../test/fuzz/ref-siblings.ts"
export { instancesFor } from "../test/fuzz/instances.ts"

export type Profile = "draft-07" | "2020-12"

const CF_DRAFT = { "draft-07": "7", "2020-12": "2020-12" } as const

export const cfValidator = (schema: unknown, profile: Profile) => {
  const validator = new Validator((profile === "draft-07" ? withRefSiblingsApplied(schema) : schema) as any, CF_DRAFT[profile], true)
  return (instance: unknown): boolean => validator.validate(instance).valid
}

export interface CorpusCase {
  id: string
  source: string
  profile: Profile
  options?: Record<string, unknown>
  schema: unknown
}

const CORPUS_DIR = path.join(import.meta.dirname, "../test/fuzz/corpus")

// the replay corpus of the test suite, one entry per file
export const loadCorpus = (): { file: string, cases: CorpusCase[] }[] =>
  fs.readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, cases: JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), "utf8")) as CorpusCase[] }))
