module.exports = {
  env: {
    browser: true,
    commonjs: true,
    es2021: true,
  },
  extends: ["airbnb-base", "prettier"],
  overrides: [
    {
      env: {
        node: true,
      },
      files: [".eslintrc.{js,cjs}"],
      parserOptions: {
        sourceType: "script",
      },
    },
  ],
  parserOptions: {
    ecmaVersion: "latest",
  },
  rules: {
    camelcase: "off",
    "no-console": "off",
    "import/extensions": "off",
    "no-unused-vars": [
      "error",
      {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "no-restricted-syntax": ["off", "ForOfStatement"],
    "no-param-reassign": "off",
    "consistent-return": "off",
    "no-await-in-loop": "off",
  },
  globals: {
    // zx globals
    $: true,
    question: true,
    argv: true,
    // jest globals
    test: true,
    describe: true,
    expect: true,
    jest: true,
  },
};
