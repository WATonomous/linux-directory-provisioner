// Some dependencies are exported in ESM format (import/export) and Jest doesn't
// support this yet. This config tells Jest to transform these dependencies
// using the transform rules.
// https://stackoverflow.com/a/49676319
const depsToTransform = [
  "zx",
  "globby",
  "node-fetch",
  "data-uri-to-buffer",
  "fetch-blob",
  "formdata-polyfill",
  "webpod",
]

module.exports = {
  testRegex: "(/__tests__/.*|(\\.|/)(test|spec))\\.(m?jsx?|tsx?)$",
  transform: {
    "^.+\\.jsx?$": "babel-jest",
    "^.+\\.mjs$": "babel-jest",
  },
  testPathIgnorePatterns: ["<rootDir>/build/", "<rootDir>/node_modules/"],
  transformIgnorePatterns: [
      `<rootDir>/node_modules/(?!(${depsToTransform.join("|")}))`
  ],
  moduleFileExtensions: ["js", "jsx", "mjs"],
};
