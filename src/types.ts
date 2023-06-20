import { JsonPath } from "json-crawl"

export type JsonSchema = any

export interface MergeOptions {
  source?: any          // source JsonSchema if merging only part of it
  rules?: MergeRules    // custom merge rules
  onMergeError?: (message: string, path: JsonPath, values: any[]) => void
}

export interface RefNode {
  $ref: string
  [key: string]: any
}

export type MergeError = (values: any[]) => void

export interface MergeContext {
  allOfItems: JsonSchema[]
  mergeRules: MergeRules
  mergeError: MergeError
}

export type MergeResolver = (args: any[], ctx: MergeContext) => any 
export type MergeRulesFunc = () => MergeRules 
export type MergeRule = { "$": MergeResolver }
export type MergeRules = {
  [key: `/${string}` | "/"]: MergeRules | MergeRulesFunc
} | MergeRule
