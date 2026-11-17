/*
 * Committed replay corpus (FEATURE_DESIGN §4.3 Option C), replayed by corpus.test.ts with the same oracle as the random
 * property. Provenance: built once (2026-11-17) from the scratch probe runs of the 1.0.0 verification, which are not in
 * the repository:
 *   real-world.json   — allOf cases ported from other projects' test suites (/tmp/amr-similar2/cases, /tmp/amr-replay):
 *                       datamodel-code-generator, hypothesis-jsonschema, json-schema-intersect, oasdiff (non-OpenAPI-3.0
 *                       schema cases), qubership-apihub, x0k/json-schema-merge, json-schema-merge-allof (mokka) and
 *                       @stoplight/json-schema-merge-allof
 *   probes.json       — inputs recorded from the hand-written probe scripts (/tmp/amr-verify p*.ts, /tmp/amr-sec
 *                       issues*.ts = GitHub issue reproductions, proto*.ts, lcm2.ts, /tmp/amr-feat p*.ts) and the probe
 *                       case files (/tmp/amr-similar2/cases/probe*.json)
 *   fuzz-history.json — random cases of the earlier scratch fuzz runs (/tmp/amr-similar2/cases/fuzz*.json,
 *                       /tmp/amr-replay/s2/nf*.cases.json) that were interesting there: an ajv disagreement or crash,
 *                       an allOf fragment left in the output, or a contradiction report; ajv disagreements first, then smallest, ≤ 350
 * Filter: a JSON Schema object (no OpenAPI/AsyncAPI/GraphApi document, no `nullable`, no draft-04 booleans, no external
 * or `$id`-based refs), valid against the profile meta-schema (malformed-value robustness cases live in test/audit),
 * contains an allOf, ≤ 3 000 characters, loadable and evaluable by cfworker, deduplicated (canonical JSON of
 * schema + profile + options). Profile: 2020-12 when the case uses a 2019-09/2020-12 keyword or `$schema`, else draft-07.
 * Merge options other than mergeCombinarySibling / mergeRefSibling (e.g. the other libraries' own options) are dropped.
 * The 3 draft-07 `$ref`-sibling cases (former known issue KI-1) were left out at first and are in probes.json since
 * D-24 (`$ref` siblings apply in every draft; the oracle reads draft-07 `$ref` siblings the same way).
 */
import * as fs from "fs"
import * as path from "path"

import type { CaseOptions, Profile } from "./oracle"

export interface CorpusCase {
  id: string
  source: string
  profile: Profile
  options?: CaseOptions
  schema: unknown
}

export const CORPUS_DIR = path.join(__dirname, "corpus")

export const loadCorpus = (): { file: string, cases: CorpusCase[] }[] =>
  fs.readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, cases: JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), "utf8")) as CorpusCase[] }))
