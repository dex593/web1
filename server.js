const { createApp, startServer } = require("./app");

startServer(createApp()).catch((error) => {
  console.error("Failed to initialize database", error);
  process.exit(1);
});
