const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const readProjectFile = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

test("chapter add and edit forms expose a clear-all pages action next to save", () => {
  for (const relativePath of ["views/admin/chapter-form.ejs", "views/admin/chapter-new.ejs"]) {
    const source = readProjectFile(relativePath);
    const saveIndex = source.indexOf("data-chapter-save");
    const clearIndex = source.indexOf("data-chapter-clear-pages");

    assert.notEqual(saveIndex, -1, `${relativePath} should keep the chapter save button`);
    assert.notEqual(clearIndex, -1, `${relativePath} should render the clear-all pages button`);
    assert.ok(clearIndex > saveIndex, `${relativePath} should place clear-all after the save button`);
    assert.match(source, />\s*Xoá tất cả\s*</, `${relativePath} should label the button Xoá tất cả`);
    assert.match(
      source,
      /type="button"[\s\S]*data-chapter-clear-pages/,
      `${relativePath} clear-all action must not submit the chapter form directly`
    );
  }
});

test("chapter draft upload controller clears all visible page tiles at once", () => {
  const source = readProjectFile("resources/js/admin.js");
  const clearHandlerIndex = source.indexOf("const clearAllItems = () => {");

  assert.notEqual(clearHandlerIndex, -1, "admin.js should define a clearAllItems handler");
  assert.match(source, /form\.querySelector\("\[data-chapter-clear-pages\]"\)/);
  assert.match(source, /clearPagesBtn\.disabled = !hasItems \|\| uploading;/);
  assert.match(source, /clearAutoUploadTimer\(\);[\s\S]*items\.forEach/);
  assert.match(source, /if \(item\.state === "done"\) \{[\s\S]*deleteRemote\(item\.id\);[\s\S]*\}/);
  assert.match(source, /items = \[\];[\s\S]*queueEl\.textContent = "";/);
  assert.match(source, /markTouched\(\);[\s\S]*updateHiddenPages\(\);[\s\S]*updateControls\(\);/);
  assert.match(source, /clearPagesBtn\.addEventListener\("click", \(\) => \{[\s\S]*clearAllItems\(\);/);
});
