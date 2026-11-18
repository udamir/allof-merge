/*
 * allof-merge benchmark: speed and correctness against other JSON Schema allOf mergers.
 *
 * An independent project in benchmark/ (its own dependencies), run from this directory:
 *
 *   pnpm install
 *   pnpm start                 # build allof-merge (the parent project), run everything
 *   pnpm start speed|quality   # one part (the other is taken from results.json)
 *   pnpm start report          # RESULTS.md from results.json
 *
 * Speed: every workload of fixtures.ts, a fresh copy of the input per run (not timed), min and median of the runs.
 * Quality: every case of the fuzz corpus (test/fuzz/corpus, without allof-merge-specific options) is merged by every
 * library; the result is checked with the equivalence oracle of the test suite (@cfworker/json-schema on generated
 * instances, oracle.ts). Each library runs in a child process with a per-case timeout.
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fork } from "node:child_process"

import { ADAPTERS, type Adapter, type Profile } from "./adapters.ts"
import { WORKLOADS, corpusSchemas } from "./fixtures.ts"
import { cfValidator, instancesFor } from "./oracle.ts"

const CASE_TIMEOUT_MS = 10_000
const RESULTS_JSON = path.join(import.meta.dirname, "results.json")
const RESULTS_MD = path.join(import.meta.dirname, "RESULTS.md")

// ---- quality -------------------------------------------------------------------------------------------------------

type Verdict =
  | { kind: "equivalent", allOfLeft: boolean }
  | { kind: "mismatch", lax: boolean, strict: boolean, formatRule: boolean }
  | { kind: "throws", message: string }
  | { kind: "invalid", message: string }
  | { kind: "timeout" }
  | { kind: "skipped" }

interface QualityCase { id: string, source: string, profile: Profile, schema: unknown, hasRef: boolean }

const qualityCases = (): QualityCase[] => corpusSchemas().map((c) => ({ ...c, hasRef: JSON.stringify(c.schema).includes('"$ref"') }))

const countKey = (value: unknown, key: string, seen = new Set<object>()): number => {
  if (typeof value !== "object" || value === null || seen.has(value)) { return 0 }
  seen.add(value)
  let n = !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key) ? 1 : 0
  for (const child of Object.values(value)) { n += countKey(child, key, seen) }
  return n
}

const formatsOf = (value: unknown, found = new Set<unknown>(), seen = new Set<object>()): Set<unknown> => {
  if (typeof value !== "object" || value === null || seen.has(value)) { return found }
  seen.add(value)
  if (!Array.isArray(value) && typeof (value as any).format === "string") { found.add((value as any).format) }
  for (const child of Object.values(value)) { formatsOf(child, found, seen) }
  return found
}

const judge = (adapter: Adapter, c: QualityCase): Verdict => {
  let original: (x: unknown) => boolean
  try { original = cfValidator(structuredClone(c.schema), c.profile) } catch { return { kind: "skipped" } }
  let merged: unknown
  try { merged = adapter.mergeSchema(structuredClone(c.schema), c.profile) } catch (error: any) {
    return { kind: "throws", message: String(error?.message ?? error).slice(0, 200) }
  }
  let json: string | undefined
  try { json = JSON.stringify(merged) } catch (error: any) { return { kind: "invalid", message: "not serializable: " + String(error?.message ?? error) } }
  if (json === undefined) { return { kind: "invalid", message: "undefined result" } }
  merged = JSON.parse(json)
  let result: (x: unknown) => boolean
  try { result = cfValidator(structuredClone(merged), c.profile) } catch (error: any) {
    return { kind: "invalid", message: "the validator rejects the result: " + String(error?.message ?? error).slice(0, 200) }
  }
  let lax = false
  let strict = false
  for (const instance of instancesFor([c.schema, merged])) {
    let a: boolean
    let b: boolean
    try { a = original(instance) } catch { continue }
    try { b = result(instance) } catch (error: any) { return { kind: "invalid", message: "the validator fails on the result: " + String(error?.message ?? error).slice(0, 200) } }
    if (a && !b) { strict = true }
    if (!a && b) { lax = true }
  }
  if (lax || strict) {
    // allof-merge's decided format rule: different formats make the schema false
    const formatRule = !lax && formatsOf(c.schema).size > 1 && json.includes("false")
    return { kind: "mismatch", lax, strict, formatRule }
  }
  return { kind: "equivalent", allOfLeft: countKey(merged, "allOf") > 0 }
}

// child process: judges the cases of one adapter from `start`, one message per case
const qualityWorker = (adapterIndex: number, start: number) => {
  const adapter = ADAPTERS[adapterIndex]
  const cases = qualityCases()
  for (let i = start; i < cases.length; i++) {
    process.send!({ i, started: true })
    process.send!({ i, verdict: judge(adapter, cases[i]) })
  }
  process.send!({ done: true })
}

const runQualityFor = (adapterIndex: number, total: number): Promise<Verdict[]> => new Promise((resolve) => {
  const verdicts: Verdict[] = new Array(total)
  const startWorker = (start: number) => {
    if (start >= total) { return resolve(verdicts) }
    const child = fork(import.meta.filename, ["--quality-worker", String(adapterIndex), String(start)], { execArgv: process.execArgv, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    let current = start
    let timer: NodeJS.Timeout | undefined
    const arm = () => {
      if (timer) { clearTimeout(timer) }
      timer = setTimeout(() => {
        verdicts[current] = { kind: "timeout" }
        child.kill("SIGKILL")
      }, CASE_TIMEOUT_MS)
    }
    child.on("message", (message: any) => {
      if (message.started) { current = message.i; arm() }
      if (message.verdict) { verdicts[message.i] = message.verdict }
      if (message.done) { if (timer) { clearTimeout(timer) }; child.disconnect() }
    })
    child.on("exit", () => {
      if (timer) { clearTimeout(timer) }
      // the case that was running when the process ended without a verdict crashed it (stack overflow, out of memory)
      if (verdicts[current] === undefined) { verdicts[current] = { kind: "throws", message: "process crashed" } }
      const next = verdicts.findIndex((v, i) => i >= start && v === undefined)
      if (next === -1) { resolve(verdicts) } else { startWorker(next) }
    })
  }
  startWorker(0)
})

interface QualitySummary {
  adapter: string
  groups: Record<string, Record<string, number>>
  failures: { id: string, source: string, verdict: Verdict }[]
}

const summarize = (adapter: Adapter, cases: QualityCase[], verdicts: Verdict[]): QualitySummary => {
  const groups: Record<string, Record<string, number>> = {}
  const failures: QualitySummary["failures"] = []
  cases.forEach((c, i) => {
    const v = verdicts[i] ?? { kind: "timeout" }
    if (v.kind === "skipped") { return }
    const group = c.hasRef ? "with $ref" : "without $ref"
    for (const key of [group, `${group} / ${c.source}`, `${group} / ${c.profile}`]) {
      const g = (groups[key] ??= { cases: 0, equivalent: 0, allOfFree: 0, mismatch: 0, lax: 0, strict: 0, formatRule: 0, throws: 0, invalid: 0, timeout: 0 })
      g.cases++
      if (v.kind === "equivalent") {
        g.equivalent++
        if (!v.allOfLeft) { g.allOfFree++ }
      } else if (v.kind === "mismatch") {
        g.mismatch++
        if (v.lax) { g.lax++ }
        if (v.strict) { g.strict++ }
        if (v.formatRule) { g.formatRule++ }
      } else {
        g[v.kind]++
      }
    }
    if (v.kind !== "equivalent") { failures.push({ id: c.id, source: c.source, verdict: v }) }
  })
  return { adapter: adapter.name, groups, failures }
}

const runQuality = async (): Promise<QualitySummary[]> => {
  const cases = qualityCases()
  const out: QualitySummary[] = []
  for (let a = 0; a < ADAPTERS.length; a++) {
    const started = Date.now()
    const verdicts = await runQualityFor(a, cases.length)
    out.push(summarize(ADAPTERS[a], cases, verdicts))
    console.error(`quality: ${ADAPTERS[a].name} done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  return out
}

// ---- speed ---------------------------------------------------------------------------------------------------------

interface Timing { min: number, median: number, runs: number, verdict?: Verdict["kind"], allOfLeft?: boolean }
type SpeedCell = Timing | { error: string } | { skipped: string }

const time = (input: unknown, run: (value: unknown) => unknown): SpeedCell => {
  const budgetMs = 3000
  const maxRuns = 30
  const samples: number[] = []
  try {
    for (let i = 0; i < 2; i++) { run(structuredClone(input)) }
    const until = performance.now() + budgetMs
    while (samples.length < maxRuns && (samples.length < 5 || performance.now() < until)) {
      const value = structuredClone(input)
      const start = performance.now()
      run(value)
      samples.push(performance.now() - start)
    }
  } catch (error: any) {
    return { error: String(error?.message ?? error).slice(0, 120) }
  }
  samples.sort((a, b) => a - b)
  return { min: samples[0], median: samples[samples.length >> 1], runs: samples.length }
}

const runSpeed = (qualityByAdapter?: Map<string, Set<string>>) => {
  const table: Record<string, Record<string, SpeedCell>> = {}
  for (const workload of WORKLOADS) {
    const input = workload.load()
    const row: Record<string, SpeedCell> = (table[workload.name] = {})
    for (const adapter of ADAPTERS) {
      if (workload.kind === "document" && !adapter.mergeDocument) {
        row[adapter.name] = { skipped: "no $ref resolution" }
        continue
      }
      const run = workload.kind === "document" ? adapter.mergeDocument! : (value: unknown) => adapter.mergeSchema(value, workload.profile)
      const timing = time(input, run)
      // a fast wrong answer is not a result: schema workloads are checked with the oracle
      if (workload.kind === "schema" && "min" in timing) {
        const verdict = judge(adapter, { id: workload.name, source: "workload", profile: workload.profile, schema: input, hasRef: false })
        timing.verdict = verdict.kind
        if (verdict.kind === "equivalent") { timing.allOfLeft = verdict.allOfLeft }
      }
      row[adapter.name] = timing
      console.error(`speed: ${workload.name} / ${adapter.name}: ${JSON.stringify(row[adapter.name])}`)
    }
  }

  // many small schemas: the corpus cases without $ref that every library merges without throwing
  const cases = corpusSchemas().filter((c) => !JSON.stringify(c.schema).includes('"$ref"'))
  const common = cases.filter((c) => ADAPTERS.every((adapter) => {
    if (qualityByAdapter && !qualityByAdapter.get(adapter.name)?.has(c.id)) { return false }
    try { adapter.mergeSchema(structuredClone(c.schema), c.profile); return true } catch { return false }
  }))
  const row: Record<string, SpeedCell> = (table[`corpus-${common.length}`] = {})
  for (const adapter of ADAPTERS) {
    row[adapter.name] = time(common.map((c) => c.schema), (values) => {
      const list = values as unknown[]
      for (let i = 0; i < list.length; i++) { adapter.mergeSchema(list[i], common[i].profile) }
    })
    console.error(`speed: corpus / ${adapter.name}: ${JSON.stringify(row[adapter.name])}`)
  }
  return { table, corpusCases: common.length }
}

// ---- report --------------------------------------------------------------------------------------------------------

const cell = (c: SpeedCell | undefined): string => {
  if (!c) { return "" }
  if ("skipped" in c) { return "n/a" }
  if ("error" in c) { return "throws" }
  const f = (ms: number) => ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)
  const mark = c.verdict && c.verdict !== "equivalent" ? " ✗" : c.allOfLeft ? " ◐" : ""
  return `${f(c.min)} (${f(c.median)})${mark}`
}

const pct = (n: number, d: number) => d ? `${n} (${(100 * n / d).toFixed(1)} %)` : "0"

const report = (speed: ReturnType<typeof runSpeed> | undefined, quality: QualitySummary[] | undefined): string => {
  const lines: string[] = []
  lines.push("# allof-merge benchmark", "")
  lines.push(`Node ${process.version}, ${os.cpus()[0]?.model ?? os.arch()}, ${os.platform()}. Generated by \`pnpm start\` in benchmark/ (benchmark/index.ts).`, "")
  lines.push("| Library | Version | How it is called |", "|---|---|---|")
  for (const a of ADAPTERS) { lines.push(`| ${a.name} | ${a.version} | ${a.notes} |`) }
  lines.push("")
  if (speed) {
    lines.push("## Speed", "", "Milliseconds per merge, min (median); a fresh copy of the input per run, not timed. `n/a`: the library does not resolve `$ref`, `throws`: the library throws on the input. Schema workloads are also checked with the oracle: ✗ the result is not equivalent to the input, ◐ equivalent but `allOf` is left (parts without an exact merged form are kept). Document workloads (OpenAPI / JSON Schema documents with `$ref`) are not checked.", "")
    lines.push(`| Workload | ${ADAPTERS.map((a) => a.name).join(" | ")} |`, `|---|${ADAPTERS.map(() => "---:").join("|")}|`)
    for (const [name, row] of Object.entries(speed.table)) {
      lines.push(`| ${name} | ${ADAPTERS.map((a) => cell(row[a.name])).join(" | ")} |`)
    }
    lines.push("")
    for (const w of WORKLOADS) { lines.push(`- \`${w.name}\`: ${w.description}`) }
    lines.push(`- \`corpus-${speed.corpusCases}\`: every corpus case without \`$ref\` that every library merges without throwing, merged one after the other`, "")
  }
  if (quality) {
    lines.push("## Correctness", "")
    lines.push("Every case of the fuzz corpus (`test/fuzz/corpus`: real-world cases collected from the test suites and issue trackers of these and other libraries, probes, allof-merge fuzz regressions) without allof-merge-specific options. A result is **equivalent** when it gives every generated instance the same verdict as the input (@cfworker/json-schema, the oracle of the test suite), **allOf-free** when it is equivalent and holds no `allOf`; a **mismatch** accepts (lax) or rejects (strict) an instance the input does not. Cases whose input the oracle cannot load are skipped. The corpus was used to develop allof-merge 1.0, so read its numbers as a regression check rather than an unbiased comparison; the `real-world` rows are the fairest.", "")
    const groupNames = [...new Set(quality.flatMap((q) => Object.keys(q.groups)))].filter((g) => !g.includes("/")).sort().reverse()
    for (const group of groupNames) {
      lines.push(`### ${group[0].toUpperCase()}${group.slice(1)}`, "")
      lines.push("| Library | Cases | Equivalent | allOf-free | Mismatch (lax / strict) | Throws | Invalid output | Timeout |", "|---|---:|---:|---:|---:|---:|---:|---:|")
      for (const q of quality) {
        const g = q.groups[group]
        if (!g) { continue }
        const fr = g.formatRule ? `, ${g.formatRule} by the format rule` : ""
        lines.push(`| ${q.adapter} | ${g.cases} | ${pct(g.equivalent, g.cases)} | ${pct(g.allOfFree, g.cases)} | ${g.mismatch} (${g.lax} / ${g.strict}${fr}) | ${g.throws} | ${g.invalid} | ${g.timeout} |`)
      }
      lines.push("")
      const sub = [...new Set(quality.flatMap((q) => Object.keys(q.groups)))].filter((g) => g.startsWith(`${group} / `)).sort()
      lines.push("Equivalent per source / profile:", "", `| Subset | ${quality.map((q) => q.adapter).join(" | ")} |`, `|---|${quality.map(() => "---:").join("|")}|`)
      for (const s of sub) {
        lines.push(`| ${s.slice(group.length + 3)} | ${quality.map((q) => q.groups[s] ? `${q.groups[s].equivalent}/${q.groups[s].cases}` : "").join(" | ")} |`)
      }
      lines.push("")
    }
  }
  lines.push("## Caveats", "")
  lines.push("- The oracle compares verdicts on generated instances (boundary values, enum members, pattern samples, property names of the schemas); a difference no generated instance exposes is not seen. Example: for `allOf: [{ properties: { foo, foo123 }, patternProperties: { \"^bar\": {} }, additionalProperties: false }, { properties: { bar, bar123 }, patternProperties: { \".+\\\\d+$\": {} }, additionalProperties: false }]` json-schema-merge-allof returns `{ additionalProperties: false, properties: { foo123, bar, bar123 } }`, which rejects `barX9` (allowed by both items); it counts as equivalent here. allof-merge keeps the two shapes and reports `object-shape-kept`.")
  lines.push("- `throws` includes libraries reporting a contradiction by throwing (json-schema-merge-allof, @x0k/json-schema-merge, @fastify/merge-json-schemas throw on incompatible `type`s); allof-merge writes `false` and reports an `unsatisfiable` issue instead.")
  lines.push("- Libraries that do not resolve `$ref` are run on the `$ref` cases as they are (no dereferencing): a `$ref` inside `allOf` stays a part, which is equivalent but not allOf-free.")
  lines.push("- allof-merge's non-equivalent results are its decided format rule: two different `format`s make the schema `false`, which rejects non-string instances the input accepts.")
  lines.push("- Each library runs the corpus in a child process with a 10 s per-case timeout; speed is measured in one process, one library after the other, with a fresh copy of the input per run.")
  lines.push("")
  return lines.join("\n")
}

// ---- main ----------------------------------------------------------------------------------------------------------

const main = async () => {
  const mode = process.argv[2]
  if (mode === "--quality-worker") { return qualityWorker(Number(process.argv[3]), Number(process.argv[4])) }
  const previous = fs.existsSync(RESULTS_JSON) ? JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8")) : {}
  const quality = mode === "speed" || mode === "report" ? previous.quality : await runQuality()
  const equivalentIds = quality ? new Map<string, Set<string>>((quality as QualitySummary[]).map((q) => {
    const failed = new Set(q.failures.filter((f) => f.verdict.kind === "throws" || f.verdict.kind === "timeout").map((f) => f.id))
    return [q.adapter, new Set(corpusSchemas().map((c) => c.id).filter((id) => !failed.has(id)))]
  })) : undefined
  const speed = mode === "quality" || mode === "report" ? previous.speed : runSpeed(equivalentIds)
  if (mode !== "report") { fs.writeFileSync(RESULTS_JSON, JSON.stringify({ date: new Date().toISOString(), node: process.version, speed, quality }, null, 1)) }
  const md = report(speed, quality)
  fs.writeFileSync(RESULTS_MD, md + "\n")
  console.log(md)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
