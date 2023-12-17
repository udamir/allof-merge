const { Suite } = require("benchmark")
const merger = require("json-schema-merge-allof")
const { merge } = require("../dist/index.cjs")

const data = require("./data.json")

const suite = new Suite()

// add tests
suite
  .add('allof-merge', () => {
    const result = merge(data)
  })
  .add('json-schema-merge-allof', () => {
    const result = merger(data, {})
  })
  // add listeners
  .on('cycle', ((event) => {
    console.log(String(event.target));
  }))
  .on('complete', () => {
    console.log('Fastest is ' + suite.filter('fastest').map('name'));
  })
  // run async
  .run()
  