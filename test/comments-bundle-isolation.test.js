const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("comments script keeps selector state inside a private bundle scope", () => {
  const commentsSourcePath = path.join(__dirname, "..", "resources", "js", "comments.js");
  const source = fs.readFileSync(commentsSourcePath, "utf8");

  assert.match(
    source,
    /^\(\(\) => \{\s*const commentSelectors = \{/,
    "comments.js should start inside an IIFE so minified selector variables cannot be clobbered globally"
  );
  assert.match(
    source,
    /refreshCommentsPageUi\(\);\s*\}\)\(\);\s*$/,
    "comments.js should close the private IIFE after initializing the comments UI"
  );
});
