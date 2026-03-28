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

const parseRetryAfterMs = (value) => {
  const text = (value == null ? "" : String(value)).trim();
  if (!text) return 0;

  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const unixMs = Date.parse(text);
  if (Number.isFinite(unixMs)) {
    return Math.max(0, unixMs - Date.now());
  }

  return 0;
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
  let rawText = "";
  try {
    response = await fetch(requestUrl, requestOptions);
    rawText = await response.text();
  } catch (err) {
    const isAbort = err && err.name === "AbortError";
    const hasResponse = Boolean(response);
    const message = isAbort
      ? "Yêu cầu quá thời gian."
      : hasResponse
        ? "Không thể đọc dữ liệu phản hồi từ API server."
        : "Không thể kết nối API server.";
    return {
      ok: false,
      status: hasResponse && Number.isFinite(Number(response.status)) ? Number(response.status) : 0,
      error: message,
      debug: {
        stage: hasResponse ? "response-body" : "fetch",
        requestUrl,
        method,
        timeoutMs,
        error: summarizeError(err)
      }
    };
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    parsed = null;
  }

  if (!response.ok || !parsed || parsed.ok !== true) {
    const retryAfterHeader = response && response.headers
      ? String(response.headers.get("retry-after") || "").trim()
      : "";
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    const message =
      (parsed && parsed.error ? String(parsed.error) : "").trim() ||
      `HTTP ${response.status}`;
    return {
      ok: false,
      status: response.status,
      error: message,
      data: parsed,
      retryAfterMs: retryAfterMs > 0 ? retryAfterMs : 0,
      debug: {
        stage: "response",
        requestUrl,
        method,
        timeoutMs,
        httpStatus: response.status,
        parsedOk: Boolean(parsed && parsed.ok === true),
        retryAfterHeader
      }
    };
  }

  return {
    ok: true,
    status: response.status,
    data: parsed
  };
};

const runPresignedUpload = async (payload) => {
  const input = payload && typeof payload === "object" ? payload : {};
  const uploadUrlRaw = (input.uploadUrl || input.url || "").toString().trim();
  if (!uploadUrlRaw) {
    return {
      ok: false,
      status: 400,
      error: "Thiếu presigned upload URL.",
      debug: {
        stage: "validate-input"
      }
    };
  }

  let uploadUrl = "";
  try {
    const parsed = new URL(uploadUrlRaw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid-protocol");
    }
    uploadUrl = parsed.toString();
  } catch (_err) {
    return {
      ok: false,
      status: 400,
      error: "Presigned upload URL không hợp lệ.",
      debug: {
        stage: "validate-url"
      }
    };
  }

  const base64Data = (input.fileBase64 || "").toString();
  if (!base64Data) {
    return {
      ok: false,
      status: 400,
      error: "Thiếu dữ liệu ảnh upload.",
      debug: {
        stage: "validate-input"
      }
    };
  }

  const buffer = Buffer.from(base64Data, "base64");
  if (!buffer.length) {
    return {
      ok: false,
      status: 400,
      error: "Dữ liệu ảnh upload không hợp lệ.",
      debug: {
        stage: "validate-input"
      }
    };
  }

  const timeoutMs = Math.max(1000, Math.floor(Number(input.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
  const contentType = (input.contentType || "image/webp").toString().trim() || "image/webp";
  const providedHeaders = input.headers && typeof input.headers === "object" ? input.headers : {};
  const requestHeaders = {};
  const lowercaseHeaderKeys = new Set();

  Object.entries(providedHeaders).forEach(([key, value]) => {
    const headerName = (key == null ? "" : String(key)).trim();
    if (!headerName) return;
    if (value == null) return;
    requestHeaders[headerName] = String(value);
    lowercaseHeaderKeys.add(headerName.toLowerCase());
  });

  if (!lowercaseHeaderKeys.has("content-type")) {
    requestHeaders["Content-Type"] = contentType;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response = null;
  let responseText = "";
  const uploadHost = (() => {
    try {
      return new URL(uploadUrl).host;
    } catch (_err) {
      return "";
    }
  })();

  try {
    response = await fetch(uploadUrl, {
      method: "PUT",
      headers: requestHeaders,
      body: buffer,
      redirect: "follow",
      signal: controller.signal
    });
    responseText = await response.text().catch(() => "");
  } catch (err) {
    const errorSummary = summarizeError(err);
    const errorCode = errorSummary && errorSummary.code ? String(errorSummary.code).trim() : "";
    const hostHint = uploadHost ? ` (${uploadHost})` : "";
    const codeHint = errorCode ? ` [${errorCode}]` : "";
    return {
      ok: false,
      status: response && Number.isFinite(Number(response.status)) ? Number(response.status) : 0,
      error: err && err.name === "AbortError"
        ? `Yêu cầu upload trực tiếp quá thời gian${hostHint}${codeHint}.`
        : `Không thể upload trực tiếp lên storage${hostHint}${codeHint}.`,
      debug: {
        stage: "fetch",
        uploadUrl,
        timeoutMs,
        error: errorSummary
      }
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      debug: {
        stage: "response",
        uploadUrl,
        timeoutMs,
        httpStatus: response.status,
        bodyPreview: responseText ? responseText.slice(0, 500) : ""
      }
    };
  }

  return {
    ok: true,
    status: response.status,
    data: {
      etag: (response.headers.get("etag") || "").toString().trim()
    }
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

ipcMain.handle("desktop:upload-presigned", async (_event, payload) => {
  return runPresignedUpload(payload);
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
