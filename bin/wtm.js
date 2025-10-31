#!/usr/bin/env node

const path = require("node:path");

function main() {
  const entryPath = path.resolve(__dirname, "../dist/tui/cli.js");
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  require(entryPath);
}

main();
