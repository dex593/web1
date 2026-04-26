const fs = require("fs");
const path = require("path");
const { defineConfig } = require("vite");

const stylesEntryPath = path.resolve(__dirname, "public", "styles.source.css");
const rootScriptSourceDir = path.resolve(__dirname, "resources", "js");
const newsScriptSourceDir = path.resolve(__dirname, "resources", "news", "js");
const buildOutputDir = path.resolve(__dirname, "public", "build");
const mainStylesheetFileName = "styles.css";
const newsScriptOutputPrefix = "build/news/js";

const listJavaScriptEntryFiles = (directoryPath) => {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry && entry.isFile && entry.isFile())
    .map((entry) => (entry.name || "").toString().trim())
    .filter((fileName) => /^[a-z0-9][a-z0-9_-]*\.js$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
};

const buildRootScriptInputs = () => {
  return Object.fromEntries(
    listJavaScriptEntryFiles(rootScriptSourceDir).map((fileName) => {
      const scriptName = fileName.slice(0, -3);
      return [scriptName, path.join(rootScriptSourceDir, fileName)];
    })
  );
};

const buildNewsScriptInputs = () => {
  return Object.fromEntries(
    listJavaScriptEntryFiles(newsScriptSourceDir).map((fileName) => {
      const scriptName = fileName.slice(0, -3);
      return [
        `${newsScriptOutputPrefix}/${scriptName}`,
        path.join(newsScriptSourceDir, fileName)
      ];
    })
  );
};

const mainStylesheetOutputPlugin = () => ({
  name: "main-stylesheet-output",
  generateBundle(_options, bundle) {
    const cssAssets = Object.values(bundle).filter((entry) => (
      entry
        && entry.type === "asset"
        && typeof entry.fileName === "string"
        && entry.fileName.toLowerCase().endsWith(".css")
    ));

    const mainStylesheet = cssAssets.find((entry) => (
      entry.name === "styles.source.css"
        || entry.name === "styles.css"
        || (Array.isArray(entry.originalFileNames)
          && entry.originalFileNames.some((fileName) => fileName.replace(/\\/g, "/").endsWith("public/styles.source.css")))
    )) || (cssAssets.length === 1 ? cssAssets[0] : null);

    if (!mainStylesheet) {
      this.error("Vite did not generate the main stylesheet from public/styles.source.css.");
      return;
    }

    mainStylesheet.fileName = mainStylesheetFileName;
  }
});

const cleanGeneratedBuildOutputPlugin = () => ({
  name: "clean-generated-build-output",
  buildStart() {
    fs.rmSync(buildOutputDir, { recursive: true, force: true });
  }
});

module.exports = defineConfig({
  appType: "custom",
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    cssMinify: true,
    minify: true,
    rollupOptions: {
      input: {
        styles: stylesEntryPath,
        ...buildRootScriptInputs(),
        ...buildNewsScriptInputs()
      },
      output: {
        entryFileNames: (chunkInfo) => (
          chunkInfo.name.startsWith(`${newsScriptOutputPrefix}/`)
            ? "[name].js"
            : "build/js/[name].js"
        ),
        chunkFileNames: "build/chunks/[name].js",
        assetFileNames: "build/assets/[name][extname]"
      }
    }
  },
  plugins: [
    cleanGeneratedBuildOutputPlugin(),
    mainStylesheetOutputPlugin()
  ]
});
