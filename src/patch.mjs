// This file is a patch for zx that fixes quoting of empty strings.

import { $ } from "zx";

// Original function: https://github.com/google/zx/blob/a9b573e026b16da617d99c1605a71c4242bd81eb/src/util.ts#L31-L48
const origQuote = $.quote;
function myQuote(arg) {
  // Patch zx to quote empty strings properly
  if (arg === "") {
    return `$''`;
  }

  return origQuote(arg);
}
$.quote = myQuote;
