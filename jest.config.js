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

/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testRegex: "(/__tests__/.*|(\\.|/)(test|spec))\\.(m?jsx?|tsx?)$",
  transform: {
    "^.+\.jsx?$": "babel-jest",
    "^.+\.mjs$": "babel-jest",
    // Disable esModuleInterop warning:
    // https://github.com/fuzzc0re/electron-svelte-typescript/issues/9#issuecomment-2041212043
    "^.+\.tsx?$": ["ts-jest", { diagnostics: { ignoreCodes: ['TS151001'] } }],
  },
  testPathIgnorePatterns: ["<rootDir>/build/", "<rootDir>/node_modules/"],
  transformIgnorePatterns: [
      `<rootDir>/node_modules/(?!(${depsToTransform.join("|")}))`
  ],
  moduleFileExtensions: ["js", "jsx", "mjs", "ts", "tsx"],
};
