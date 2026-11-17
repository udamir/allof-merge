export const ErrorMessage = {
  mergeError: () => "Could not merge values, they are probably incompatible",
  ruleNotFound: (key: any) => `Merge rule not found for key: ${key}`,
  refResolveError: () => "Cannot resolve $ref",
  branchBudgetExceeded: (count: number, budget: number) => `Could not merge combinaries: ${count} combinations exceed the branch budget of ${budget}`,
  malformedValue: (key: string) => `Malformed ${key} value is ignored`,
  refExpansionExceeded: (ref: string, max: number) => `$ref target ${ref} is inlined more than ${max} times (maxRefExpansion): the $ref is kept`,
  expansionBudgetExceeded: (max: number) => `$ref inlining would copy more than ${max} schema nodes in this merge() call (expansionBudget): the remaining $refs are kept`,
  maxDepthExceeded: (max: number) => `Nodes deeper than ${max} levels (maxDepth) are copied without merging`,
  schemaFormatNotMergeable: (format: string) => `Schema in format ${format} cannot be merged into allOf: the $ref is kept`,
  schemaFormatWithoutSchema: () => "Multi Format Schema Object without schema cannot be merged into allOf: the $ref is kept",
  cyclicValue: () => "Cyclic value outside the source document cannot be referenced: replaced by {}",
} as const
