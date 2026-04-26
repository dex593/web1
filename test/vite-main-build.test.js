const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const postcssConfig = require("../postcss.config.js");
const viteConfig = require("../vite.config.js");

const projectRoot = path.resolve(__dirname, "..");
const readProjectFile = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

test("root asset build is Vite-backed for CSS and JS", () => {
  assert.equal(packageJson.scripts.build, "bun run assets:build");
  assert.equal(packageJson.scripts.prestart, "bun run assets:build");
  assert.equal(packageJson.scripts["assets:build"], "vite build --config vite.config.js");
  assert.equal(packageJson.scripts["assets:watch"], "vite build --config vite.config.js --watch");
  assert.equal(packageJson.scripts["styles:build"], "bun run assets:build");
  assert.equal(packageJson.scripts["styles:watch"], "bun run assets:watch");
});

test("Vite build preserves Express asset URL contracts", () => {
  assert.equal(viteConfig.publicDir, false);
  assert.equal(viteConfig.build.outDir, "public");
  assert.equal(viteConfig.build.emptyOutDir, false);
  assert.equal(viteConfig.build.minify, true);
  assert.equal(
    viteConfig.build.rollupOptions.input.styles,
    path.resolve(projectRoot, "public", "styles.source.css")
  );
  assert.equal(viteConfig.build.rollupOptions.input["auth-ui"], path.resolve(projectRoot, "resources", "js", "auth-ui.js"));
  assert.equal(viteConfig.build.rollupOptions.input.reader, path.resolve(projectRoot, "resources", "js", "reader.js"));
  assert.equal(viteConfig.build.rollupOptions.input.sw, path.resolve(projectRoot, "resources", "js", "sw.js"));
  assert.equal(
    viteConfig.build.rollupOptions.input["build/news/js/main"],
    path.resolve(projectRoot, "resources", "news", "js", "main.js")
  );

  const entryFileNames = viteConfig.build.rollupOptions.output.entryFileNames;
  assert.equal(typeof entryFileNames, "function");
  assert.equal(entryFileNames({ name: "auth-ui" }), "build/js/[name].js");
  assert.equal(entryFileNames({ name: "build/news/js/main" }), "[name].js");

  const plugin = viteConfig.plugins.find((entry) => entry && entry.name === "main-stylesheet-output");
  assert.ok(plugin, "main stylesheet output plugin should be registered");

  const cleanPlugin = viteConfig.plugins.find((entry) => entry && entry.name === "clean-generated-build-output");
  assert.ok(cleanPlugin, "generated public/build output cleaner should be registered");

  const bundle = {
    "assets/styles-abcd1234.css": {
      type: "asset",
      name: "styles.source.css",
      fileName: "assets/styles-abcd1234.css",
      source: "body{}"
    }
  };

  plugin.generateBundle.call({
    error(message) {
      throw new Error(message);
    }
  }, {}, bundle);

  assert.equal(bundle["assets/styles-abcd1234.css"].fileName, "styles.css");
});

test("Vite uses the existing Tailwind/PostCSS stylesheet source", () => {
  assert.deepEqual(Object.keys(postcssConfig.plugins), ["tailwindcss", "autoprefixer"]);
  assert.equal(postcssConfig.plugins.tailwindcss.config, "./tailwind.config.js");
});

test("server asset version includes Vite build output", () => {
  const appSource = readProjectFile("app.js");
  assert.match(appSource, /addDirectoryAssetCandidates\(path\.join\(publicDir, "build"\), true\)/);
});

test("old runtime JavaScript minify path is removed", () => {
  assert.equal(Object.hasOwn(packageJson.dependencies, "terser"), false);

  const forbiddenMarkersByFile = {
    "app.js": [
      "JS_MINIFY_ENABLED",
      "minifyJs",
      "prebuildMinifiedScriptsAtStartup",
      "require(\"terser\")"
    ],
    "server.js": [
      "onMinifyProgress",
      "formatMinifyProgressBar",
      "JS_MINIFY_ENABLED"
    ],
    "src/app/configure-core-runtime.js": [
      "getMinifiedScriptPayload",
      "listPublicScriptNamesForMinify",
      "prebuildMinifiedScriptsAtStartup",
      "minifyJs"
    ],
    "src/routes/news-routes.js": [
      "getMinifiedNewsJsPayload",
      "isJsMinifyEnabled",
      "minifyJs"
    ]
  };

  Object.entries(forbiddenMarkersByFile).forEach(([relativePath, markers]) => {
    const source = readProjectFile(relativePath);
    markers.forEach((marker) => {
      assert.equal(source.includes(marker), false, `${relativePath} should not contain ${marker}`);
    });
  });
});

test("removed panel stream feature stays out of main web JS sources", () => {
  const forbiddenMarker = ["ko", "ma"].join("");
  const checkedFiles = [
    path.resolve(projectRoot, "resources", "js", "auth-ui.js"),
    path.resolve(projectRoot, "resources", "js", "homepage-refresh.js"),
    path.resolve(projectRoot, "public", "styles.source.css")
  ];

  checkedFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, "utf8").toLowerCase();
    assert.equal(
      source.includes(forbiddenMarker),
      false,
      `${path.relative(projectRoot, filePath)} should not contain removed panel stream references`
    );
  });
});
