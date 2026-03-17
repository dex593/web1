const { createApp, startServer } = require("./app");

const canInlineUpdate = Boolean(
  process.stdout
    && process.stdout.isTTY
    && typeof process.stdout.clearLine === "function"
    && typeof process.stdout.cursorTo === "function"
);

const formatMinifyProgressBar = (completed, total) => {
  const safeCompleted = Number.isFinite(completed) ? Math.max(0, Math.floor(completed)) : 0;
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (!safeTotal) {
    return "";
  }

  const width = 18;
  const filled = Math.round((Math.min(safeCompleted, safeTotal) / safeTotal) * width);
  const empty = Math.max(0, width - filled);
  return `[${"#".repeat(filled)}${"-".repeat(empty)}] ${Math.min(safeCompleted, safeTotal)}/${safeTotal}`;
};

const writeLoadingLine = (message, persist = false) => {
  const text = String(message == null ? "" : message);
  if (!canInlineUpdate) {
    console.log(text);
    return;
  }

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(text);
  if (persist) {
    process.stdout.write("\n");
  }
};

const startupLoadingState = {
  active: false
};

const setStartupLoading = (message) => {
  startupLoadingState.active = true;
  writeLoadingLine(`[LOADING] ${message}`, false);
};

const finishStartupLoading = (message, success = true) => {
  if (!startupLoadingState.active) {
    return;
  }
  startupLoadingState.active = false;
  const prefix = success ? "[DONE]" : "[FAIL]";
  writeLoadingLine(`${prefix} ${message}`, true);
};

const createServerStartupHooks = () => {
  return {
    onMinifyProgress: (payload) => {
      const phase = String(payload && payload.phase ? payload.phase : "").trim().toLowerCase();
      if (!phase) return;

      if (phase === "disabled") {
        finishStartupLoading("Bỏ qua minify JS startup (JS_MINIFY_ENABLED=false).", true);
        return;
      }

      if (phase === "start") {
        const total = Number(payload.total) || 0;
        setStartupLoading(`Đang minify JavaScript startup... ${formatMinifyProgressBar(0, total)}`.trim());
        return;
      }

      if (phase === "item:start") {
        const scriptName = String(payload.scriptName || "").trim();
        const built = Number(payload.built) || 0;
        const failed = Number(payload.failed) || 0;
        const total = Number(payload.total) || 0;
        const completed = built + failed;
        const progress = formatMinifyProgressBar(completed, total);
        const fileText = scriptName ? ` ${scriptName}.js` : "";
        setStartupLoading(`Đang minify${fileText}... ${progress}`.trim());
        return;
      }

      if (phase === "item:done" || phase === "item:fail") {
        const scriptName = String(payload.scriptName || "").trim();
        const built = Number(payload.built) || 0;
        const failed = Number(payload.failed) || 0;
        const total = Number(payload.total) || 0;
        const completed = built + failed;
        const progress = formatMinifyProgressBar(completed, total);
        const statusText = phase === "item:done" ? "xong" : "lỗi";
        const fileText = scriptName ? ` ${scriptName}.js` : "";
        setStartupLoading(`Minify${fileText}: ${statusText}. ${progress}`.trim());
        return;
      }

      if (phase === "done") {
        const built = Number(payload.built) || 0;
        const total = Number(payload.total) || 0;
        const failed = Number(payload.failed) || 0;
        finishStartupLoading(`Minify JS startup hoàn tất (${built}/${total}, lỗi ${failed}).`, true);
      }
    }
  };
};

const runtime = createApp({
  hooks: createServerStartupHooks()
});

setStartupLoading("MOETRUYEN server đang khởi tạo...");

startServer(runtime)
  .then(() => {
    finishStartupLoading("MOETRUYEN server đã sẵn sàng.", true);
  })
  .catch((error) => {
    finishStartupLoading("MOETRUYEN server khởi tạo thất bại.", false);
    console.error("Failed to initialize database", error);
    process.exit(1);
  });
