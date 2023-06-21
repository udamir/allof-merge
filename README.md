# allof-merge
<img alt="npm" src="https://img.shields.io/npm/v/allof-merge"> <img alt="npm" src="https://img.shields.io/npm/dm/allof-merge?label=npm"> ![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/udamir/allof-merge/ci.yml)
 <img alt="npm type definitions" src="https://img.shields.io/npm/types/allof-merge"> ![Coveralls branch](https://img.shields.io/coverallsCoverage/github/udamir/allof-merge) <img alt="GitHub" src="https://img.shields.io/github/license/udamir/allof-merge">

Merge schemas combined using allOf into a more readable composed schema free from allOf.

## Features
- Safe merging of schemas combined with allOf in whole JsonSchema document
- Fastest implmentation - up to x4 times faster then other popular libraries
- Merged schema does not validate more or less than the original schema
- Removes almost all logical impossibilities
- Correctly merge additionalProperties, patternProperties and properties taking into account common validations
- Correctly merge items and additionalItems taking into account common validations
- Supports merging allOf in OpenApi 3.x
- Supports merging allOf in JsonSchemas draft-04 and draft-06
- Supports rules extension to merge other JsonSchema versions
- Supports $refs and circular references either (internal references only)
- Typescript syntax support out of the box
- No dependencies, can be used in nodejs or browser

## Other libraries
There are some libraries that can merge schemas combined with allOf. One of the most popular is [mokkabonna/json-schema-merge-allof](https://www.npmjs.com/package/json-schema-merge-allof), but it has some limitatons: Does not support circular $refs and no Typescript syntax out of the box.

## External $ref
If schema contains an external $ref, you should bundle it via [api-ref-bundler](https://github.com/udamir/api-ref-bundler) first.

## Installation
```SH
npm install allof-merge --save
```

## Usage

### Nodejs
```ts
import { merge } from 'allof-merge'

const merged = merge({
  type: ['object', 'null'],
  additionalProperties: {
    type: 'string',
    minLength: 5
  },
  allOf: [{
    type: ['array', 'object'],
    additionalProperties: {
      type: 'string',
      minLength: 10,
      maxLength: 20
    }
  }]
})

console.log(merged)
// {
//   type: 'object',
//   additionalProperties: {
//     type: 'string',
//     minLength: 10,
//     maxLength: 20
//   }
// }

```

### Browsers

A browser version of `allof-merge` is also available via CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/allof-merge@latest/browser/allof-merge.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/allof-merge@latest/browser/allof-merge.js"></script>
```

Reference `allof-merge.min.js` in your HTML and use the global variable `AllOfMerge`.
```HTML
<script>
  var merged = AllOfMerge.merge({ /* ... */ })
</script>
```

## Documentation

TBD

## Benchmark
```
allof-merge x 671 ops/sec ±3.39% (85 runs sampled)
json-schema-merge-allof x 209 ops/sec ±2.65% (83 runs sampled)
Fastest is allof-merge
```

Check yourself:
```SH
npm run benchmark
```


## Contributing
When contributing, keep in mind that it is an objective of `allof-merge` to have no package dependencies. This may change in the future, but for now, no-dependencies.

Please run the unit tests before submitting your PR: `npm test`. Hopefully your PR includes additional unit tests to illustrate your change/modification!

## License

MIT
