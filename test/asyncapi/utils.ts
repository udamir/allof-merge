import fs from "fs"
import path from "path"
import YAML from "js-yaml"

export const loadAsyncApi = (name: string): any =>
  YAML.load(fs.readFileSync(path.join(__dirname, "../resources/asyncapi", name), "utf8"))

// JSON pointers of every member named `allOf` in a value
export const allOfPaths = (value: unknown, pointer = ""): string[] => {
  if (typeof value !== "object" || value === null) { return [] }
  const result: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`
    if (key === "allOf" && !Array.isArray(value)) { result.push(childPointer) }
    result.push(...allOfPaths(child, childPointer))
  }
  return result
}

export const collectErrors = () => {
  const errors: { message: string, path: (string | number)[], values: unknown }[] = []
  return {
    errors,
    onMergeError: (message: string, path: (string | number)[], values: unknown) => { errors.push({ message, path: [...path], values }) },
    onRefResolveError: (message: string, path: (string | number)[], values: unknown) => { errors.push({ message, path: [...path], values }) },
  }
}
