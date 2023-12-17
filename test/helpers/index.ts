import { buildFromSchema, GraphApiSchema } from "gqlapi"
import { buildSchema } from "graphql"
import YAML from "js-yaml"

export const yaml = (strings: TemplateStringsArray): object => {
  return YAML.load(strings[0]) as object
}

export const graphapi = (strings: TemplateStringsArray): GraphApiSchema => {
  return buildFromSchema(buildSchema(strings[0], { noLocation: true }))
}
