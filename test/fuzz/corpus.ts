/*
 * Committed replay corpus, replayed by corpus.test.ts with the same oracle as the random property:
 *   real-world.json   — allOf schemas collected from public JSON Schema and OpenAPI test suites
 *   probes.json       — hand-written probes and reproductions of reported issues
 *   fuzz-history.json — random cases of earlier fuzz runs that were interesting (a validator disagreement or crash, an
 *                       allOf fragment left in the output, or a contradiction report)
 * Every case is a JSON Schema object (no OpenAPI / AsyncAPI / GraphApi document, no `nullable`, no draft-04 booleans,
 * no external or `$id`-based refs), valid against the meta-schema of its profile (malformed-value robustness cases live
 * in test/audit), contains an allOf, has at most 3 000 characters, is loadable and evaluable by the oracle, and is
 * unique (canonical JSON of schema + profile + options). Profile: 2020-12 when the case uses a 2019-09 / 2020-12 keyword
 * or `$schema`, else draft-07. Options: only mergeCombinarySibling and mergeRefSibling.
 */
import * as fs from "fs"
import * as path from "path"

import type { CaseOptions, Profile } from "./oracle.ts"

export interface CorpusCase {
  id: string
  source: string
  profile: Profile
  options?: CaseOptions
  schema: unknown
}

export const CORPUS_DIR = path.join(import.meta.dirname, "corpus")

export const loadCorpus = (): { file: string, cases: CorpusCase[] }[] =>
  fs.readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, cases: JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), "utf8")) as CorpusCase[] }))
