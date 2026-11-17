import type { KeywordGroup } from "../types"
import { typeGroup } from "./type"
import { numericBoundsGroup } from "./numeric"
import { stringGroup } from "./string"
import { objectShapeGroup } from "./object"
import { arrayShapeGroup } from "./array"
import { dependenciesGroup } from "./dependencies"
import { enumConstGroup } from "./enum"
import { conditionalGroup } from "./conditional"

export * from "./common"
export * from "./type"
export * from "./numeric"
export * from "./string"
export * from "./object"
export * from "./array"
export * from "./dependencies"
export * from "./enum"
export * from "./conditional"

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
