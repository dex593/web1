"use strict";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 400;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });

const normalizeHeaders = (headers) => {
  const normalized = {};
  if (!headers || typeof headers !== "object") return normalized;
  Object.keys(headers).forEach((key) => {
    const value = headers[key];
    if (value == null) return;
    normalized[String(key)] = String(value);
  });
  return normalized;
};

const readResponseBody = async (response) => {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  if (!text) {
    return {
      text: "",
      data: null,
      isJson: contentType.includes("application/json")
    };
  }

  if (!contentType.includes("application/json")) {
    return {
      text,
      data: null,
      isJson: false
    };
  }

  try {
    return {
      text,
      data: JSON.parse(text),
      isJson: true
    };
  } catch (_err) {
    return {
      text,
      data: null,
      isJson: true
    };
  }
};

const extractErrorMessage = (payload, fallback) => {
  if (!payload || typeof payload !== "object") return fallback;

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0];
    if (firstError && typeof firstError === "object") {
      if (firstError.detail) return String(firstError.detail);
      if (firstError.title) return String(firstError.title);
      if (firstError.error) return String(firstError.error);
      if (firstError.message) return String(firstError.message);
    }
    return String(payload.errors[0]);
  }

  if (payload.error) return String(payload.error);
  if (payload.message) return String(payload.message);
  if (payload.result && payload.result !== "ok") return String(payload.result);

  return fallback;
};

const isRetriableStatus = (statusCode) =>
  Number(statusCode) === 408
  || Number(statusCode) === 425
  || Number(statusCode) === 429
  || Number(statusCode) === 500
  || Number(statusCode) === 502
  || Number(statusCode) === 503
  || Number(statusCode) === 504;

const createHttpError = ({ message, statusCode, url, payload, bodyText, cause }) => {
  const err = new Error(message || "HTTP request failed");
  err.name = "HttpRequestError";
  err.statusCode = Number(statusCode) || 500;
  err.url = url || "";
  err.payload = payload == null ? null : payload;
  err.bodyText = bodyText == null ? "" : String(bodyText);
  if (cause) err.cause = cause;
  return err;
};

const requestJson = async (url, options = {}) => {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Math.floor(Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const retries = Number(options.retries) >= 0 ? Math.floor(Number(options.retries)) : DEFAULT_RETRIES;
  const retryDelayMs = Number(options.retryDelayMs) >= 0
    ? Math.floor(Number(options.retryDelayMs))
    : DEFAULT_RETRY_DELAY_MS;
  const method = String(options.method || "GET").toUpperCase();

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutToken = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: normalizeHeaders({
          Accept: "application/json",
          ...(options.headers || {})
        }),
        body: options.body,
        signal: controller.signal
      });

      const body = await readResponseBody(response);
      if (!response.ok) {
        const fallbackMessage = `Request failed with status ${response.status}`;
        const message = extractErrorMessage(body.data, fallbackMessage);
        const httpError = createHttpError({
          message,
          statusCode: response.status,
          url,
          payload: body.data,
          bodyText: body.text
        });
        if (attempt < retries && isRetriableStatus(response.status)) {
          lastError = httpError;
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : retryDelayMs * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        throw httpError;
      }

      return {
        statusCode: response.status,
        headers: response.headers,
        data: body.data,
        rawText: body.text,
        url
      };
    } catch (err) {
      const isAbort = err && err.name === "AbortError";
      const normalizedError = isAbort
        ? createHttpError({
            message: `Request timeout after ${timeoutMs}ms`,
            statusCode: 504,
            url,
            cause: err
          })
        : err;

      const hasHttpShape = normalizedError && normalizedError.name === "HttpRequestError";
      const wrappedNetworkError = !hasHttpShape
        ? createHttpError({
            message: `${String(normalizedError && normalizedError.message ? normalizedError.message : "Network request failed")}${normalizedError && normalizedError.cause && normalizedError.cause.code ? ` (${normalizedError.cause.code})` : normalizedError && normalizedError.code ? ` (${normalizedError.code})` : ""}`,
            statusCode: 502,
            url,
            cause: normalizedError
          })
        : normalizedError;

      const statusCode = Number(wrappedNetworkError && wrappedNetworkError.statusCode);
      const retriable = !Number.isFinite(statusCode) || isRetriableStatus(statusCode);

      if (attempt < retries && retriable) {
        lastError = wrappedNetworkError;
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw wrappedNetworkError;
    } finally {
      clearTimeout(timeoutToken);
    }
  }

  throw lastError || createHttpError({ message: "Request failed", statusCode: 500, url });
};

module.exports = {
  requestJson,
  createHttpError
};
