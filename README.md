# Linux Directory Provisioner

[![Version](https://img.shields.io/npm/v/@watonomous/linux-directory-provisioner)](https://npmjs.org/package/@watonomous/linux-directory-provisioner)
[![Publish to NPM](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/npm-publish-github-packages.yml/badge.svg)](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/npm-publish-github-packages.yml)
[![Test and Lint](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/test-and-lint.yml/badge.svg)](https://github.com/WATonomous/linux-directory-provisioner/actions/workflows/test-and-lint.yml)

Tool to provision Linux users and groups. Used internally at [WATcloud](https://cloud.watonomous.ca).

## Getting started

1. Prepare a configuration file in the format specified in [src/schema.mjs](./src/schema.mjs).
2. Run the following command to run the provisioner:
```bash
npx @watonomous/linux-directory-provisioner <path_to_config.json>
```

## Publishing to NPM

1. Increment the version number in `package.json`:
```bash
npm version prerelease --preid alpha
# or
npm version patch # or minor or major
```

2. Push the new version to GitHub:
```bash
git push --atomic origin main <tag>
```

3. Create a release on GitHub with the tag you just pushed.
4. The GitHub Action pipeline will automatically publish the new version to NPM.
