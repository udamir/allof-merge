import type { KeywordGroup } from "../types.ts"
import { typeGroup } from "./type.ts"
import { numericBoundsGroup } from "./numeric.ts"
import { stringGroup } from "./string.ts"
import { objectShapeGroup } from "./object.ts"
import { arrayShapeGroup } from "./array.ts"
import { dependenciesGroup } from "./dependencies.ts"
import { enumConstGroup } from "./enum.ts"
import { conditionalGroup } from "./conditional.ts"

export * from "./common.ts"
export * from "./type.ts"
export * from "./numeric.ts"
export * from "./string.ts"
export * from "./object.ts"
export * from "./array.ts"
export * from "./dependencies.ts"
export * from "./enum.ts"
export * from "./conditional.ts"

// group resolvers run before the per-key rule table; a group owns the keys it lists
export const keywordGroups: readonly KeywordGroup[] = [
  typeGroup,
  enumConstGroup,
  numericBoundsGroup,
  stringGroup,
  objectShapeGroup,
  arrayShapeGroup,
  dependenciesGroup,
  conditionalGroup,
]
