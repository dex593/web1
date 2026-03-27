"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { resolveSourceManga, downloadSourceChapter } = require("./services/source-ingest");

const DEFAULT_REQUEST_TIMEOUT_MS = 180000;
const WINDOW_ICON_PATH = path.join(__dirname, "assets", "icon.png");

const serializeErrorForDebug = (error, depth = 0) => {
  if (error == null) return null;
  if (depth >= 3) {
    return { message: "(truncated)" };
  }

  if (typeof error !== "object") {
    return {
      name: "Error",
      message: String(error)
    };
  }

  const payload = {
    name: error.name ? String(error.name) : "Error",
    message: error.message ? String(error.message) : ""
  };

  ["statusCode", "status", "code", "errno", "type"].forEach((key) => {
    if (error[key] == null) return;
    payload[key] = error[key];
  });

  if (typeof error.stack === "string" && error.stack.trim()) {
    payload.stack = error.stack.split("\n").slice(0, 10).join("\n");
  }

  if (error.debugInfo && typeof error.debugInfo === "object") {
    payload.debugInfo = error.debugInfo;
  }

  if (error.cause) {
    payload.cause = serializeErrorForDebug(error.cause, depth + 1);
  }

  return payload;
};

const logIpcError = (scope, error) => {
  const debugPayload = serializeErrorForDebug(error);
  console.error(`[desktop-main] ${scope}:`, JSON.stringify({
    at: new Date().toISOString(),
    scope,
    debug: debugPayload
  }, null, 2));
  return debugPayload;
};

const normalizeEndpointForRequest = (value) => {
  const raw = (value == null ? "" : String(value)).trim();
  if (!raw) return "";

  const tryParse = (candidate) => {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "";
      }
      return `${parsed.protocol}//${parsed.host}${parsed.pathname || ""}`.replace(/\/+$/, "");
    } catch (_err) {
      return "";
    }
  };

  const direct = tryParse(raw);
  if (direct) {
    if (direct.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(direct)) {
      const upgraded = tryParse(direct.replace(/^http:\/\//i, "https://"));
      return upgraded || direct;
    }
    return direct;
  }

  return tryParse(`https://${raw}`);
};

const sanitizeRoute = (value) => {
  const raw = (value == null ? "" : String(value)).trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw.startsWith("/") ? raw : `/${raw}`;
};

const summarizeError = (err) => {
  if (!err || typeof err !== "object") return { message: String(err || "") };
  return {
    name: err.name ? String(err.name) : "Error",
    message: err.message ? String(err.message) : "",
    code: err.code ? String(err.code) : "",
    statusCode: Number.isFinite(Number(err.statusCode)) ? Number(err.statusCode) : null
  };
};

const runApiRequest = async (payload) => {
  const input = payload && typeof payload === "object" ? payload : {};
  const endpoint = normalizeEndpointForRequest(input.endpoint);
  const route = sanitizeRoute(input.route);
  const method = (input.method || "GET").toString().trim().toUpperCase();
  if (!endpoint || !route) {
    return {
      ok: false,
      status: 400,
      error: "Endpoint hoặc route không hợp lệ.",
      debug: {
        endpoint,
        route,
        method,
        stage: "validate-input"
      }
    };
  }

  let requestUrl = "";
  try {
    requestUrl = /^https?:\/\//i.test(route) ? new URL(route).toString() : new URL(route, `${endpoint}/`).toString();
  } catch (_err) {
    return {
      ok: false,
      status: 400,
      error: "URL request không hợp lệ.",
      debug: {
        endpoint,
        route,
        method,
        stage: "build-url"
      }
    };
  }

  const headers = {
    Accept: "application/json"
  };

  const apiKey = (input.apiKey || "").toString().trim();
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const timeoutMs = Math.max(1000, Math.floor(Number(input.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestOptions = {
    method,
    headers,
    redirect: "follow",
    signal: controller.signal
  };

  const jsonBody = input.jsonBody && typeof input.jsonBody === "object" ? input.jsonBody : null;
  const pageUpload = input.pageUpload && typeof input.pageUpload === "object" ? input.pageUpload : null;

  if (pageUpload) {
    if (typeof FormData !== "function" || typeof Blob !== "function") {
      clearTimeout(timer);
      return { ok: false, status: 500, error: "Môi trường runtime không hỗ trợ upload multipart." };
    }

    const formData = new FormData();
    const pageIndex = Number(pageUpload.pageIndex);
    const base64Data = (pageUpload.fileBase64 || "").toString();
    const fileName = (pageUpload.fileName || "page.webp").toString().trim() || "page.webp";
    if (!base64Data) {
      clearTimeout(timer);
      return { ok: false, status: 400, error: "Thiếu dữ liệu ảnh upload." };
    }

    const buffer = Buffer.from(base64Data, "base64");
    if (!buffer.length) {
      clearTimeout(timer);
      return { ok: false, status: 400, error: "Dữ liệu ảnh upload không hợp lệ." };
    }

    formData.append("pageIndex", Number.isFinite(pageIndex) && pageIndex > 0 ? String(Math.floor(pageIndex)) : "1");
    formData.append("page", new Blob([buffer], { type: "image/webp" }), fileName);
    requestOptions.body = formData;
  } else if (jsonBody) {
    headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(jsonBody);
  }

  let response = null;
  try {
    response = await fetch(requestUrl, requestOptions);
  } catch (err) {
    clearTimeout(timer);
    const message = err && err.name === "AbortError"
      ? "Yêu cầu quá thời gian."
      : "Không thể kết nối API server.";
    return {
      ok: false,
      status: 0,
      error: message,
      debug: {
        stage: "fetch",
        requestUrl,
        method,
        timeoutMs,
        error: summarizeError(err)
      }
    };
  }

  clearTimeout(timer);

  const rawText = await response.text().catch(() => "");
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    parsed = null;
  }

  if (!response.ok || !parsed || parsed.ok !== true) {
    const message =
      (parsed && parsed.error ? String(parsed.error) : "").trim() ||
      `HTTP ${response.status}`;
    return {
      ok: false,
      status: response.status,
      error: message,
      data: parsed,
      debug: {
        stage: "response",
        requestUrl,
        method,
        timeoutMs,
        httpStatus: response.status,
        parsedOk: Boolean(parsed && parsed.ok === true)
      }
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed
  };
};

const createMainWindow = () => {
  const iconPath = fs.existsSync(WINDOW_ICON_PATH) ? WINDOW_ICON_PATH : undefined;
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1140,
    minHeight: 740,
    autoHideMenuBar: true,
    backgroundColor: "#050505",
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      devTools: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => null);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if ((url || "").startsWith("file://")) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url).catch(() => null);
  });

  return win;
};

ipcMain.handle("desktop:pick-parent-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Chọn thư mục mẹ chứa chapter",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) {
    return "";
  }

  return String(result.filePaths[0] || "").trim();
});

ipcMain.handle("desktop:pick-title-map-file", async () => {
  const result = await dialog.showOpenDialog({
    title: "Chọn file .txt tên chapter",
    properties: ["openFile"],
    filters: [
      { name: "Text files", extensions: ["txt"] },
      { name: "All files", extensions: ["*"] }
    ]
  });

  if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) {
    return "";
  }

  return String(result.filePaths[0] || "").trim();
});

ipcMain.handle("desktop:api-request", async (_event, payload) => {
  return runApiRequest(payload);
});

ipcMain.handle("desktop:source-resolve-manga", async (_event, payload) => {
  try {
    const data = await resolveSourceManga(payload || {});
    return {
      ok: true,
      data
    };
  } catch (err) {
    const debug = logIpcError("desktop:source-resolve-manga", err);
    return {
      ok: false,
      status: Number(err && err.statusCode) || 500,
      error: (err && err.message) ? String(err.message) : "Không thể tải danh sách chapter từ nguồn ngoài.",
      debug
    };
  }
});

ipcMain.handle("desktop:source-download-chapter", async (_event, payload) => {
  try {
    const data = await downloadSourceChapter(payload || {});
    return {
      ok: true,
      data
    };
  } catch (err) {
    const debug = logIpcError("desktop:source-download-chapter", err);
    return {
      ok: false,
      status: Number(err && err.statusCode) || 500,
      error: (err && err.message) ? String(err.message) : "Không thể tải ảnh chapter từ nguồn ngoài.",
      debug
    };
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
