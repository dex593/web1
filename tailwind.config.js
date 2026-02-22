/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./views/**/*.ejs",
    "./public/**/*.js",
    "./src/**/*.js",
    "./app.js",
    "./server.js",
    "./node_modules/flowbite/**/*.js"
  ],
  corePlugins: {
    preflight: false
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ["Noto Sans JP", "Helvetica Neue", "Arial", "sans-serif"],
        display: ["Noto Sans JP", "Helvetica Neue", "Arial", "sans-serif"]
      }
    }
  },
  plugins: [require("flowbite/plugin")]
};
