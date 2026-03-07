"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { ipcRenderer } = require("electron");

const fsp = fs.promises;
const collator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_PAGES_PER_CHAPTER = 220;
const PAGE_UPLOAD_PARALLELISM = 3;
const MIN_INTEGER_INPUT = 2;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_DELAY_MS = 900;
const STORAGE_ENDPOINT_KEY = "desktop_api_endpoint";

const state = {
  endpoint: "https://api.moetruyen.net",
  apiKey: "",
  authenticated: false,
  account: null,
  mangaList: [],
  mangaSearch: "",
  mangaLoading: false,
  selectedManga: null,
  existingChapterMap: new Map(),
  parentFolder: "",
  configPath: "",
  chapterRows: [],
  chapterTableLoading: false,
  uploadRunning: false,
  authBusy: false,
  saveConfigTimer: null
};

const el = {
  authOverlay: document.querySelector("[data-auth-overlay]"),
  authForm: document.querySelector("[data-auth-form]"),
  authEndpoint: document.querySelector("[data-auth-endpoint]"),
  authKey: document.querySelector("[data-auth-key]"),
  authMessage: document.querySelector("[data-auth-message]"),
  authSubmit: document.querySelector("[data-auth-submit]"),

  helpOpenBtn: document.querySelector("[data-help-open]"),
  helpModal: document.querySelector("[data-help-modal]"),
  helpCloseBtn: document.querySelector("[data-help-close]"),

  hardRefreshBtn: document.querySelector("[data-hard-refresh]"),
  switchAuthBtn: document.querySelector("[data-switch-auth]"),
  serverLabel: document.querySelector("[data-server-label]"),

  accountName: document.querySelector("[data-account-name]"),
  accountSub: document.querySelector("[data-account-sub]"),

  mangaSearch: document.querySelector("[data-manga-search]"),
  mangaGrid: document.querySelector("[data-manga-grid]"),
  mangaEmpty: document.querySelector("[data-manga-empty]"),

  selectedMangaLabel: document.querySelector("[data-selected-manga-label]"),
  selectAllBtn: document.querySelector("[data-select-all]"),
  pickFolderBtn: document.querySelector("[data-pick-folder]"),
  reloadFolderBtn: document.querySelector("[data-reload-folder]"),
  saveConfigBtn: document.querySelector("[data-save-config]"),
  parentFolder: document.querySelector("[data-parent-folder]"),
  tableWrap: document.querySelector("[data-table-wrap]"),
  chapterTableBody: document.querySelector("[data-chapter-table]"),
  tableLoading: document.querySelector("[data-table-loading]"),
  tableLoadingText: document.querySelector("[data-table-loading-text]"),

  retryCount: document.querySelector("[data-retry-count]"),
  delayMs: document.querySelector("[data-delay-ms]"),
  startUploadBtn: document.querySelector("[data-start-upload]"),

  overallLabel: document.querySelector("[data-overall-label]"),
  overallStats: document.querySelector("[data-overall-stats]"),
  overallPercent: document.querySelector("[data-overall-percent]"),
  overallSuccess: document.querySelector("[data-overall-success]"),
  overallFailed: document.querySelector("[data-overall-failed]"),
  overallSkipped: document.querySelector("[data-overall-skipped]"),
  overallBar: document.querySelector("[data-overall-bar]"),
  logBox: document.querySelector("[data-log-box]")
};

function setAuthMessage(text, isError = false) {
  if (!el.authMessage) return;
  const safeText = (text || "").toString();
  el.authMessage.hidden = !safeText;
  el.authMessage.textContent = safeText;
  el.authMessage.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function logLine(text, isError = false) {
  if (!el.logBox) return;
  const line = document.createElement("p");
  line.className = `log-line${isError ? " error" : ""}`;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  line.textContent = `[${hh}:${mm}:${ss}] ${text}`;
  el.logBox.appendChild(line);
  el.logBox.scrollTop = el.logBox.scrollHeight;
}

function sleep(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function normalizeEndpoint(value) {
  const raw = (value || "").toString().trim();
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
      return tryParse(direct.replace(/^http:\/\//i, "https://")) || direct;
    }
    return direct;
  }

  return tryParse(`https://${raw}`);
}

function parseChapterNumber(value) {
  const raw = (value == null ? "" : String(value)).trim();
  if (!raw) return null;
  const normalized = raw.replace(/,/g, ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.round(parsed * 1000) / 1000;
}

function formatChapterNumber(number) {
  const value = Number(number);
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value - Math.round(value)) < 1e-9) {
    return String(Math.round(value));
  }
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function chapterNumberKey(number) {
  const value = Number(number);
  if (!Number.isFinite(value)) return "";
  return value.toFixed(3);
}

function escapeHtml(value) {
  return (value == null ? "" : String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setButtonLabel(button, iconClass, label) {
  if (!button) return;
  const safeLabel = escapeHtml((label || "").toString());
  const iconHtml = iconClass
    ? `<i class="${escapeHtml(iconClass)}" aria-hidden="true"></i>`
    : "";
  button.innerHTML = `${iconHtml}<span>${safeLabel}</span>`;
}

function toBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null) return Boolean(fallback);
  const text = String(value).trim().toLowerCase();
  if (!text) return Boolean(fallback);
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return Boolean(fallback);
}

function normalizeIntegerInputValue(value, fallback, maxValue) {
  const safeFallback = Math.max(MIN_INTEGER_INPUT, Math.floor(Number(fallback) || MIN_INTEGER_INPUT));
  const cleanText = (value == null ? "" : String(value)).replace(/[^0-9]/g, "");
  const parsed = Number.parseInt(cleanText, 10);

  let nextValue = Number.isFinite(parsed) ? Math.floor(parsed) : safeFallback;
  if (nextValue < MIN_INTEGER_INPUT) {
    nextValue = MIN_INTEGER_INPUT;
  }

  const safeMax = Number(maxValue);
  if (Number.isFinite(safeMax) && safeMax > 0) {
    nextValue = Math.min(nextValue, Math.floor(safeMax));
  }

  if (nextValue < MIN_INTEGER_INPUT) {
    nextValue = MIN_INTEGER_INPUT;
  }

  return nextValue;
}

function readIntegerInputValue(input, fallback) {
  if (!input) return Math.max(MIN_INTEGER_INPUT, Math.floor(Number(fallback) || MIN_INTEGER_INPUT));
  const maxAttr = input.getAttribute("max");
  const maxValue = maxAttr ? Number(maxAttr) : Number.NaN;
  const normalized = normalizeIntegerInputValue(input.value, fallback, maxValue);
  input.value = String(normalized);
  return normalized;
}

function bindStrictIntegerInput(input, fallback) {
  if (!input) return;

  input.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );

  input.addEventListener("keydown", (event) => {
    if (!event || !event.key) return;
    if (["e", "E", "+", "-", ".", ","].includes(event.key)) {
      event.preventDefault();
    }
  });

  input.addEventListener("input", () => {
    const onlyDigits = (input.value || "").replace(/[^0-9]/g, "");
    if (onlyDigits !== input.value) {
      input.value = onlyDigits;
    }
  });

  input.addEventListener("blur", () => {
    readIntegerInputValue(input, fallback);
  });

  readIntegerInputValue(input, fallback);
}

function getSelectableRows() {
  return state.chapterRows.filter((row) => row && !row.exceedsLimit);
}

function hasCheckedChapters() {
  return state.chapterRows.some((row) => row && row.enabled && !row.exceedsLimit);
}

function updateSelectAllButtonState() {
  if (!el.selectAllBtn) return;

  const selectableRows = getSelectableRows();
  const selectedCount = selectableRows.filter((row) => row.enabled).length;
  const hasRows = selectableRows.length > 0;
  const allSelected = hasRows && selectedCount === selectableRows.length;

  setButtonLabel(
    el.selectAllBtn,
    allSelected ? "fa-solid fa-square-minus" : "fa-solid fa-square-check",
    allSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"
  );
  el.selectAllBtn.disabled =
    !state.authenticated ||
    state.uploadRunning ||
    state.authBusy ||
    !hasRows;
}

function updateStartUploadButtonState() {
  if (!el.startUploadBtn) return;
  const shouldDisable =
    !state.authenticated ||
    state.uploadRunning ||
    state.authBusy ||
    !hasCheckedChapters();
  el.startUploadBtn.disabled = shouldDisable;

  updateSelectAllButtonState();
}

function setControlsDisabled(disabled) {
  const flag = Boolean(disabled);
  const elements = [
    el.hardRefreshBtn,
    el.selectAllBtn,
    el.pickFolderBtn,
    el.reloadFolderBtn,
    el.saveConfigBtn,
    el.retryCount,
    el.delayMs,
    el.mangaSearch,
    el.switchAuthBtn
  ];
  elements.forEach((node) => {
    if (!node) return;
    node.disabled = flag;
  });

  updateStartUploadButtonState();
}

function setAuthOverlayVisible(visible) {
  if (!el.authOverlay) return;
  el.authOverlay.hidden = !visible;
}

function setHelpModalVisible(visible) {
  if (!el.helpModal) return;
  const show = Boolean(visible);
  el.helpModal.hidden = !show;

  if (show && el.helpCloseBtn) {
    setTimeout(() => {
      el.helpCloseBtn.focus();
    }, 0);
  }
}

function setChapterTableLoading(loading, labelText = "") {
  state.chapterTableLoading = Boolean(loading);

  if (el.tableWrap) {
    el.tableWrap.classList.toggle("is-loading", state.chapterTableLoading);
  }

  if (el.tableLoading) {
    el.tableLoading.hidden = !state.chapterTableLoading;
  }

  if (el.tableLoadingText && labelText) {
    el.tableLoadingText.textContent = labelText;
  }
}

function setOverallProgress(done, total, labelText) {
  const safeDone = Math.max(0, Number(done) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  if (el.overallLabel) {
    el.overallLabel.textContent = (labelText || "").toString() || "Sẵn sàng";
  }
  if (el.overallStats) {
    el.overallStats.textContent = `${safeDone}/${safeTotal}`;
  }
  const pct = safeTotal > 0 ? Math.min(100, Math.max(0, Math.round((safeDone / safeTotal) * 100))) : 0;
  if (el.overallPercent) {
    el.overallPercent.textContent = `${pct}%`;
  }
  if (el.overallBar) {
    el.overallBar.style.width = `${pct}%`;
  }
}

function setOverallBreakdown({ success = 0, failed = 0, skipped = 0 } = {}) {
  const okCount = Math.max(0, Number(success) || 0);
  const failedCount = Math.max(0, Number(failed) || 0);
  const skippedCount = Math.max(0, Number(skipped) || 0);

  if (el.overallSuccess) {
    el.overallSuccess.textContent = `Thành công: ${okCount}`;
  }
  if (el.overallFailed) {
    el.overallFailed.textContent = `Thất bại: ${failedCount}`;
  }
  if (el.overallSkipped) {
    el.overallSkipped.textContent = `Bỏ qua: ${skippedCount}`;
  }
}

function updateServerLabel() {
  if (!el.serverLabel) return;
  if (!state.authenticated) {
    el.serverLabel.textContent = "API: chưa kết nối";
    return;
  }
  const keyPrefix = state.account && state.account.keyPrefix ? String(state.account.keyPrefix).trim() : "";
  el.serverLabel.textContent = `API: ${state.endpoint}${keyPrefix ? ` | key ${keyPrefix}` : ""}`;
}

function renderAccount() {
  const account = state.account;
  if (!account) {
    if (el.accountName) el.accountName.textContent = "Chưa đăng nhập";
    if (el.accountSub) el.accountSub.textContent = "Nhập API key để tiếp tục";
    return;
  }

  const displayName =
    (account.displayName || "").toString().trim() ||
    (account.username || "").toString().trim() ||
    "User";

  if (el.accountName) {
    el.accountName.textContent = displayName;
  }

  const subParts = [];
  if (account.username) {
    subParts.push(`@${account.username}`);
  }
  if (el.accountSub) {
    el.accountSub.textContent = subParts.join(" | ") || "Đã xác thực API key";
  }
}

function getVisibleMangaList() {
  const query = state.mangaSearch.trim().toLowerCase();
  const list = Array.isArray(state.mangaList) ? state.mangaList : [];
  if (!query) return list;
  return list.filter((item) => {
    const haystack = [item.title, item.slug, item.author, item.groupName]
      .map((value) => (value == null ? "" : String(value)).toLowerCase())
      .join(" ");
    return haystack.includes(query);
  });
}

function renderMangaList() {
  if (!el.mangaGrid) return;
  const sourceList = getVisibleMangaList();
  const list = sourceList
    .slice()
    .sort((a, b) => (a && a.title ? String(a.title) : "").localeCompare(b && b.title ? String(b.title) : "", "vi"));
  const selectedId = state.selectedManga && state.selectedManga.id ? Number(state.selectedManga.id) : 0;

  if (state.mangaLoading && !state.mangaList.length) {
    el.mangaGrid.innerHTML = Array.from({ length: 8 }, () => {
      return `
        <article class="manga-card loading" aria-hidden="true">
          <div class="manga-skeleton-line"></div>
          <div class="manga-skeleton-line short"></div>
        </article>
      `;
    }).join("");

    if (el.mangaEmpty) {
      el.mangaEmpty.hidden = true;
    }
    return;
  }

  el.mangaGrid.innerHTML = list
    .map((manga) => {
      const mangaId = Number(manga.id) || 0;
      const activeClass = mangaId && mangaId === selectedId ? " active" : "";
      const title = (manga.title || "").toString();
      const author = (manga.author || "").toString().trim();
      const groupName = (manga.groupName || "").toString().trim();
      const compactMeta = `Tác giả: ${author || "?"} | Nhóm: ${groupName || "-"}`;
      return `
        <article class="manga-card${activeClass}" data-manga-id="${mangaId}">
          <div class="manga-card__head">
            <h3 class="manga-title">${escapeHtml(title)}</h3>
          </div>
          <p class="manga-meta" title="${escapeHtml(compactMeta)}">${escapeHtml(compactMeta)}</p>
        </article>
      `;
    })
    .join("");

  if (el.mangaEmpty) {
    el.mangaEmpty.hidden = list.length > 0;
  }
}

function updateSelectedMangaLabel() {
  if (!el.selectedMangaLabel) return;
  if (!state.selectedManga) {
    el.selectedMangaLabel.textContent = "Chưa chọn truyện.";
    return;
  }
  const item = state.selectedManga;
  const title = escapeHtml(item.title || "");
  const latestText = item.latestChapterNumberText
    ? `Mới nhất: ${escapeHtml(String(item.latestChapterNumberText))}`
    : "";
  const metaParts = [`ID: ${escapeHtml(String(item.id || ""))}`];
  if (latestText) {
    metaParts.push(latestText);
  }

  el.selectedMangaLabel.innerHTML = `
    <span class="selected-manga-label__title">${title}</span>
    <span class="selected-manga-label__meta">${metaParts.join(" • ")}</span>
  `;
}

function renderChapterTable() {
  if (!el.chapterTableBody) return;
  const rows = Array.isArray(state.chapterRows) ? state.chapterRows : [];

  el.chapterTableBody.innerHTML = rows
    .map((row) => {
      const rowClasses = [];
      if (row.conflict) rowClasses.push("conflict");

      const isPendingSkip =
        row.conflict &&
        row.action === "skip" &&
        !row.isUploading &&
        !row.isDone &&
        !row.isFailed &&
        !row.isSkipped;
      const isPendingOverwrite =
        row.conflict &&
        row.action === "overwrite" &&
        !row.isUploading &&
        !row.isDone &&
        !row.isFailed &&
        !row.isSkipped;
      const isPendingNew =
        !row.conflict &&
        !row.isUploading &&
        !row.isDone &&
        !row.isFailed &&
        !row.isSkipped;

      if (row.isFailed) rowClasses.push("failed");
      if (row.isDone) rowClasses.push("done");
      if (row.isSkipped || isPendingSkip) rowClasses.push("skipped");
      if (isPendingOverwrite) rowClasses.push("overwrite");
      if (isPendingNew) rowClasses.push("new");
      const rowClass = rowClasses.join(" ");
      const disabledAttr = state.uploadRunning ? " disabled" : "";
      const totalCount = Math.max(0, Number(row.totalCount || row.imagePaths.length) || 0);
      const uploadedRaw = Number(row.uploadedCount || 0);
      const uploadedCount = Math.max(0, Math.min(totalCount, Number.isFinite(uploadedRaw) ? uploadedRaw : 0));

      let statusText = "Mới";
      let statusClass = "new";
      let statusIconClass = "fa-solid fa-wand-sparkles";
      if (row.isUploading) {
        statusText = `${uploadedCount}/${totalCount}`;
        statusClass = "uploading";
        statusIconClass = "fa-solid fa-cloud-arrow-up";
      } else if (row.isDone) {
        statusText = "Hoàn thành";
        statusClass = "done";
        statusIconClass = "fa-solid fa-circle-check";
      } else if (row.isFailed) {
        statusText = row.exceedsLimit ? "Vượt giới hạn ảnh" : "Thất bại";
        statusClass = "failed";
        statusIconClass = "fa-solid fa-circle-xmark";
      } else if (row.isSkipped || isPendingSkip) {
        statusText = "Bỏ qua";
        statusClass = "skipped";
        statusIconClass = "fa-solid fa-forward";
      } else if (isPendingOverwrite) {
        statusText = "Up đè";
        statusClass = "overwrite";
        statusIconClass = "fa-solid fa-arrows-rotate";
      }

      const spinnerHtml = row.isUploading
        ? "<span class=\"chapter-spinner spinning\" aria-hidden=\"true\"></span>"
        : "";

      const actionCell = row.conflict
        ? `
            <select data-row-action="1"${disabledAttr}>
              <option value="skip"${row.action === "skip" ? " selected" : ""}>Bỏ qua</option>
              <option value="overwrite"${row.action === "overwrite" ? " selected" : ""}>Up đè</option>
            </select>
          `
        : `<span class="hint">Mới</span>`;

      return `
        <tr class="${rowClass}" data-row-id="${escapeHtml(row.id)}">
          <td><input type="checkbox" data-row-enabled="1"${row.enabled ? " checked" : ""}${disabledAttr} /></td>
          <td>${escapeHtml(row.chapterNumberText)}</td>
          <td title="${escapeHtml(row.folderPath)}">${escapeHtml(row.folderName)}</td>
          <td>${row.imagePaths.length}</td>
          <td>
            <input
              type="text"
              data-row-title="1"
              value="${escapeHtml(row.title || "")}"${disabledAttr}
              maxlength="140"
            />
          </td>
          <td>${actionCell}</td>
          <td>
            <div class="chapter-progress-wrap">
              <span class="chapter-state ${statusClass}">
                <i class="${escapeHtml(statusIconClass)}" aria-hidden="true"></i>
                <span>${escapeHtml(statusText)}</span>
              </span>
              ${spinnerHtml}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  updateStartUploadButtonState();
}

function updateRowUploadState(rowId, patch, shouldRender = true) {
  const row = state.chapterRows.find((item) => item.id === rowId);
  if (!row) return;
  const next = patch && typeof patch === "object" ? patch : {};

  if (Object.prototype.hasOwnProperty.call(next, "uploadedCount")) {
    const parsed = Number(next.uploadedCount);
    row.uploadedCount = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  if (Object.prototype.hasOwnProperty.call(next, "totalCount")) {
    const parsed = Number(next.totalCount);
    row.totalCount = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : row.totalCount;
  }
  if (Object.prototype.hasOwnProperty.call(next, "isUploading")) {
    row.isUploading = Boolean(next.isUploading);
  }
  if (Object.prototype.hasOwnProperty.call(next, "isFailed")) {
    row.isFailed = Boolean(next.isFailed);
  }
  if (Object.prototype.hasOwnProperty.call(next, "isDone")) {
    row.isDone = Boolean(next.isDone);
  }
  if (Object.prototype.hasOwnProperty.call(next, "isSkipped")) {
    row.isSkipped = Boolean(next.isSkipped);
  }
  if (Object.prototype.hasOwnProperty.call(next, "enabled")) {
    row.enabled = Boolean(next.enabled);
  }

  if (shouldRender) {
    renderChapterTable();
  }
}

function updateFolderPathLabel() {
  if (!el.parentFolder) return;
  const folderText = state.parentFolder || "Chưa chọn thư mục.";

  if ("value" in el.parentFolder) {
    el.parentFolder.value = folderText;
    return;
  }

  if (!state.parentFolder) {
    el.parentFolder.textContent = folderText;
    return;
  }
  el.parentFolder.textContent = folderText;
}

function scheduleSaveConfig() {
  if (state.saveConfigTimer) {
    clearTimeout(state.saveConfigTimer);
    state.saveConfigTimer = null;
  }

  state.saveConfigTimer = setTimeout(() => {
    saveConfigToDisk(false).catch((err) => {
      logLine(`Lưu config thất bại: ${(err && err.message) || "không rõ"}`, true);
    });
  }, 300);
}

async function saveConfigToDisk(manual) {
  if (!state.parentFolder || !state.configPath) {
    if (manual) {
      logLine("Chưa có thư mục để lưu config.", true);
    }
    return;
  }

  const payload = {
    version: 1,
    mangaId: state.selectedManga && state.selectedManga.id ? Number(state.selectedManga.id) : 0,
    mangaSlug: state.selectedManga && state.selectedManga.slug ? String(state.selectedManga.slug) : "",
    mangaTitle: state.selectedManga && state.selectedManga.title ? String(state.selectedManga.title) : "",
    updatedAt: new Date().toISOString(),
    chapters: state.chapterRows.map((row) => ({
      folder: row.folderName,
      chapterNumber: row.chapterNumber,
      title: row.title || "",
      enabled: Boolean(row.enabled),
      action: row.action || (row.conflict ? "skip" : "new")
    }))
  };

  await fsp.writeFile(state.configPath, JSON.stringify(payload, null, 2), "utf8");
  if (manual) {
    logLine(`Đã lưu config: ${state.configPath}`);
  }
}

async function loadConfigFromDisk(parentFolder) {
  const configPath = path.join(parentFolder, "config.json");
  state.configPath = configPath;

  try {
    const text = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_err) {
    return null;
  }
}

async function listImageFiles(folderPath) {
  const items = await fsp.readdir(folderPath, { withFileTypes: true });
  const files = items
    .filter((item) => item && item.isFile())
    .map((item) => item.name)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => collator.compare(a, b))
    .map((name) => path.join(folderPath, name));
  return files;
}

function applyConflictState() {
  const map = state.existingChapterMap;
  state.chapterRows.forEach((row) => {
    const key = chapterNumberKey(row.chapterNumber);
    const existing = key ? map.get(key) : null;
    row.conflict = Boolean(existing);
    row.existingChapter = existing || null;

    if (row.conflict) {
      if (row.action !== "overwrite" && row.action !== "skip") {
        row.action = "skip";
      }
    } else {
      row.action = "new";
    }

    row.totalCount = Math.max(0, Number(row.imagePaths.length) || 0);
    row.uploadedCount = Math.max(0, Number(row.uploadedCount || 0) || 0);
    row.isUploading = false;
    row.isDone = false;
    row.isFailed = Boolean(row.exceedsLimit);
    row.isSkipped = false;
  });
}

async function loadRowsFromParentFolder(parentFolder) {
  const entries = await fsp.readdir(parentFolder, { withFileTypes: true });
  const chapterFolders = entries.filter((entry) => entry && entry.isDirectory());

  const config = await loadConfigFromDisk(parentFolder);
  const configMap = new Map();
  if (config && Array.isArray(config.chapters)) {
    config.chapters.forEach((item) => {
      const folder = (item && item.folder ? String(item.folder) : "").trim();
      if (!folder) return;
      configMap.set(folder, item);
    });
  }

  const rows = [];
  for (const folder of chapterFolders) {
    const folderName = (folder.name || "").toString().trim();
    if (!folderName) continue;

    const chapterNumber = parseChapterNumber(folderName);
    if (chapterNumber == null) {
      continue;
    }

    const folderPath = path.join(parentFolder, folderName);
    const imagePaths = await listImageFiles(folderPath);
    if (!imagePaths.length) {
      continue;
    }

    const saved = configMap.get(folderName) || {};
    const rowId = cryptoRandomId();
    rows.push({
      id: rowId,
      folderName,
      folderPath,
      chapterNumber,
      chapterNumberText: formatChapterNumber(chapterNumber),
      imagePaths,
      title: saved && saved.title ? String(saved.title) : "",
      enabled:
        imagePaths.length > MAX_PAGES_PER_CHAPTER
          ? false
          : toBoolean(saved && saved.enabled, true),
      action: saved && saved.action ? String(saved.action) : "new",
      exceedsLimit: imagePaths.length > MAX_PAGES_PER_CHAPTER,
      conflict: false,
      existingChapter: null,
      uploadedCount: 0,
      totalCount: imagePaths.length,
      isUploading: false,
      isDone: false,
      isFailed: imagePaths.length > MAX_PAGES_PER_CHAPTER,
      isSkipped: false
    });
  }

  rows.sort((a, b) => {
    const diff = Number(a.chapterNumber) - Number(b.chapterNumber);
    if (Math.abs(diff) > 1e-9) return diff;
    return collator.compare(a.folderName, b.folderName);
  });

  state.chapterRows = rows;
  applyConflictState();
  renderChapterTable();
  await saveConfigToDisk(false);
  logLine(`Đã nạp ${rows.length} chapter từ thư mục.`);
}

async function loadExistingChaptersForSelectedManga(loadingText = "") {
  const label = (loadingText || "Đang tải dữ liệu chapter...").toString();
  setChapterTableLoading(true, label);

  try {
    state.existingChapterMap = new Map();
    if (!state.selectedManga) {
      applyConflictState();
      renderChapterTable();
      return;
    }

    const response = await apiRequest(`/v1/manga/${encodeURIComponent(String(state.selectedManga.id))}/chapters`, {
      method: "GET"
    });

    const map = new Map();
    const chapters = Array.isArray(response.chapters) ? response.chapters : [];
    chapters.forEach((chapter) => {
      const number = chapter && chapter.number != null ? Number(chapter.number) : NaN;
      if (!Number.isFinite(number)) return;
      map.set(chapterNumberKey(number), chapter);
    });
    state.existingChapterMap = map;

    applyConflictState();
    renderChapterTable();
  } finally {
    setChapterTableLoading(false);
  }
}

async function selectMangaById(mangaId) {
  const id = Number(mangaId);
  const manga = state.mangaList.find((item) => Number(item.id) === id) || null;
  state.selectedManga = manga;
  renderMangaList();
  updateSelectedMangaLabel();

  if (!manga) {
    state.existingChapterMap = new Map();
    applyConflictState();
    renderChapterTable();
    setChapterTableLoading(false);
    return;
  }

  logLine(`Đang lấy dữ liệu truyện ${manga.title}...`);
  await loadExistingChaptersForSelectedManga(`Đang tải chapter của ${manga.title}...`);
  logLine(`Đã lấy dữ liệu truyện ${manga.title} (${state.existingChapterMap.size} chapter trên server).`);
  if (state.chapterRows.length) {
    const conflictCount = state.chapterRows.filter((row) => row && row.conflict).length;
    logLine(`Đã đối chiếu ${state.chapterRows.length} chapter trong thư mục (trùng: ${conflictCount}).`);
  }
  await saveConfigToDisk(false).catch(() => null);
}

async function apiRequest(route, options = {}) {
  if (!state.endpoint) {
    throw new Error("Endpoint API đang để trống");
  }

  const method = (options.method || "GET").toString().toUpperCase();
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 120000));
  const requestPayload = {
    endpoint: state.endpoint,
    route,
    method,
    timeoutMs,
    apiKey: state.apiKey
  };

  if (options.jsonBody && typeof options.jsonBody === "object") {
    requestPayload.jsonBody = options.jsonBody;
  }

  if (options.pageUpload && typeof options.pageUpload === "object") {
    const pageUpload = options.pageUpload;
    const pageBuffer = pageUpload.buffer;
    if (!pageBuffer) {
      throw new Error("Thiếu dữ liệu ảnh để upload");
    }

    requestPayload.pageUpload = {
      pageIndex: pageUpload.pageIndex,
      fileName: pageUpload.fileName || "page.webp",
      fileBase64: Buffer.from(pageBuffer).toString("base64")
    };
  }

  const result = await ipcRenderer.invoke("desktop:api-request", requestPayload).catch(() => null);
  if (!result || result.ok !== true || !result.data || result.data.ok !== true) {
    const message =
      (result && result.error ? String(result.error) : "").trim() ||
      "Không thể kết nối API server";
    const error = new Error(message);
    error.statusCode = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 0;
    error.payload = result && result.data ? result.data : null;
    throw error;
  }

  return result.data;
}

async function withRetry(task, retries, onRetry) {
  const maxRetries = Math.max(0, Math.floor(Number(retries) || 0));
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;
      if (typeof onRetry === "function") {
        onRetry(attempt + 1, err);
      }
      await sleep(280 * (attempt + 1));
    }
  }
  throw lastError || new Error("Tác vụ thất bại");
}

async function authenticate(endpoint, apiKey) {
  state.endpoint = endpoint;
  state.apiKey = apiKey;

  state.mangaLoading = true;
  renderMangaList();

  try {
    const payload = await apiRequest("/v1/bootstrap", { method: "GET", timeoutMs: 30000 });
    state.account = payload.account || null;
    state.mangaList = Array.isArray(payload.manga) ? payload.manga : [];
    state.authenticated = true;
  } finally {
    state.mangaLoading = false;
  }

  renderAccount();
  renderMangaList();
  updateServerLabel();

  if (!state.selectedManga || !state.mangaList.some((item) => Number(item.id) === Number(state.selectedManga.id))) {
    if (state.mangaList.length) {
      await selectMangaById(state.mangaList[0].id);
    } else {
      state.selectedManga = null;
      updateSelectedMangaLabel();
      state.existingChapterMap = new Map();
      applyConflictState();
      renderChapterTable();
    }
  }
}

function resetAuthState() {
  state.apiKey = "";
  state.authenticated = false;
  state.account = null;
  state.mangaList = [];
  state.mangaLoading = false;
  state.selectedManga = null;
  state.existingChapterMap = new Map();
  state.chapterRows = [];
  state.chapterTableLoading = false;

  renderAccount();
  renderMangaList();
  updateSelectedMangaLabel();
  renderChapterTable();
  setChapterTableLoading(false);
  updateServerLabel();
  setOverallProgress(0, 0, "Chưa upload.");
  setOverallBreakdown({ success: 0, failed: 0, skipped: 0 });
}

async function compressImageToWebp(filePath) {
  const inputBuffer = await fsp.readFile(filePath);
  return sharp(inputBuffer)
    .rotate()
    .resize({
      height: 1800,
      withoutEnlargement: true
    })
    .webp({ quality: 77, effort: 6 })
    .toBuffer();
}

async function uploadChapterRow({ row, retryCount, totalRows, rowIndex }) {
  const mangaId = Number(state.selectedManga && state.selectedManga.id);
  if (!Number.isFinite(mangaId) || mangaId <= 0) {
    throw new Error("Chưa chọn truyện");
  }

  const totalImages = row.imagePaths.length;
  if (!totalImages) {
    throw new Error("Thư mục chapter không có ảnh");
  }

  updateRowUploadState(row.id, {
    totalCount: totalImages,
    uploadedCount: 0,
    isUploading: true,
    isFailed: false,
    isDone: false,
    isSkipped: false
  });
  const startPayload = await withRetry(
    () =>
      apiRequest("/v1/uploads/start", {
        method: "POST",
        jsonBody: {
          mangaId,
          chapterNumber: row.chapterNumber,
          title: row.title || "",
          overwrite: row.action === "overwrite",
          totalPages: totalImages
        },
        timeoutMs: 30000
      }),
    retryCount,
    (attempt, err) => {
      logLine(
        `Chapter ${row.chapterNumberText}: thử lại khởi tạo lần ${attempt} (${(err && err.message) || "lỗi"})`,
        true
      );
    }
  );

  const sessionId = String(startPayload.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Mã phiên upload không hợp lệ");
  }

  try {
    const workerCount = Math.max(1, Math.min(PAGE_UPLOAD_PARALLELISM, totalImages));
    let nextImageIndex = 0;
    let uploadedCount = 0;
    let workerError = null;

    const uploadWorker = async (workerNo) => {
      while (true) {
        if (workerError) return;

        const currentIndex = nextImageIndex;
        nextImageIndex += 1;
        if (currentIndex >= totalImages) return;

        const pageNumber = currentIndex + 1;
        const sourceFilePath = row.imagePaths[currentIndex];

        try {
          const compressed = await withRetry(
            () => compressImageToWebp(sourceFilePath),
            retryCount,
            (attempt, err) => {
              logLine(
                `Chapter ${row.chapterNumberText}: thử lại nén ảnh ${pageNumber}/${totalImages} (luồng ${workerNo}) lần ${attempt} (${(err && err.message) || "lỗi"})`,
                true
              );
            }
          );

          if (workerError) return;

          await withRetry(
            async () => {
              await apiRequest(`/v1/uploads/${encodeURIComponent(sessionId)}/pages`, {
                method: "POST",
                pageUpload: {
                  pageIndex: pageNumber,
                  fileName: `${pageNumber}.webp`,
                  buffer: compressed
                },
                timeoutMs: 180000
              });
            },
            retryCount,
            (attempt, err) => {
              logLine(
                `Chapter ${row.chapterNumberText}: thử lại upload ảnh ${pageNumber}/${totalImages} (luồng ${workerNo}) lần ${attempt} (${(err && err.message) || "lỗi"})`,
                true
              );
            }
          );

          uploadedCount += 1;
          updateRowUploadState(row.id, {
            uploadedCount,
            totalCount: totalImages,
            isUploading: true,
            isFailed: false,
            isDone: false,
            isSkipped: false
          });
        } catch (err) {
          if (!workerError) {
            workerError = err instanceof Error ? err : new Error("Upload ảnh thất bại");
          }
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, (_value, index) => uploadWorker(index + 1))
    );

    if (workerError) {
      throw workerError;
    }

    const donePayload = await withRetry(
      () =>
        apiRequest(`/v1/uploads/${encodeURIComponent(sessionId)}/complete`, {
          method: "POST",
          jsonBody: {},
          timeoutMs: 180000
        }),
      retryCount,
      (attempt, err) => {
        logLine(
          `Chapter ${row.chapterNumberText}: thử lại hoàn tất lần ${attempt} (${(err && err.message) || "lỗi"})`,
          true
        );
      }
    );

    updateRowUploadState(row.id, {
      uploadedCount: totalImages,
      totalCount: totalImages,
      isUploading: false,
      isFailed: false,
      isDone: true,
      isSkipped: false,
      enabled: false
    });
    const chapter = donePayload && donePayload.chapter ? donePayload.chapter : null;
    if (chapter && chapter.number != null) {
      state.existingChapterMap.set(chapterNumberKey(Number(chapter.number)), chapter);
    }

    setOverallProgress(
      rowIndex,
      totalRows,
      `Đã xử lý ${rowIndex}/${totalRows} chapter`
    );
    return { ok: true };
  } catch (err) {
    await apiRequest(`/v1/uploads/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      jsonBody: {}
    }).catch(() => null);
    throw err;
  }
}

async function startBulkUpload() {
  if (state.uploadRunning || state.authBusy) return;
  if (!state.selectedManga) {
    logLine("Hãy chọn truyện trước khi upload.", true);
    return;
  }
  if (!state.parentFolder) {
    logLine("Hãy chọn thư mục mẹ trước khi upload.", true);
    return;
  }

  const retryCount = readIntegerInputValue(el.retryCount, DEFAULT_RETRY_COUNT);
  const delayMs = readIntegerInputValue(el.delayMs, DEFAULT_DELAY_MS);

  state.chapterRows.forEach((row) => {
    row.totalCount = Math.max(0, Number(row.imagePaths && row.imagePaths.length) || 0);
    row.uploadedCount = 0;
    row.isUploading = false;
    row.isDone = false;
    row.isSkipped = false;
    row.isFailed = Boolean(row.exceedsLimit);
  });

  const queue = state.chapterRows.filter((row) => {
    if (!row.enabled) return false;
    if (!Array.isArray(row.imagePaths) || !row.imagePaths.length) return false;
    if (row.exceedsLimit) return false;
    if (row.conflict && row.action !== "overwrite") return false;
    return true;
  });

  const skippedByConflict = state.chapterRows.filter((row) => row.enabled && row.conflict && row.action === "skip");
  skippedByConflict.forEach((row) => {
    row.isSkipped = true;
    row.isUploading = false;
    row.isDone = false;
    row.isFailed = false;
    row.uploadedCount = 0;
  });
  renderChapterTable();

  if (!queue.length) {
    logLine("Không có chapter hợp lệ để upload.", true);
    setOverallProgress(0, 0, "Không có chapter để upload");
    setOverallBreakdown({ success: 0, failed: 0, skipped: skippedByConflict.length });
    return;
  }

  state.uploadRunning = true;
  setControlsDisabled(true);
  setOverallProgress(0, queue.length, "Đang bắt đầu upload...");
  setOverallBreakdown({ success: 0, failed: 0, skipped: skippedByConflict.length });

  let successCount = 0;
  let failedCount = 0;

  try {
    for (let index = 0; index < queue.length; index += 1) {
      const row = queue[index];
      const chapterOrder = index + 1;
      logLine(`Bắt đầu chapter ${row.chapterNumberText} (${chapterOrder}/${queue.length})`);

      try {
        await uploadChapterRow({
          row,
          retryCount,
          totalRows: queue.length,
          rowIndex: chapterOrder
        });
        successCount += 1;
        logLine(`Chapter ${row.chapterNumberText}: thành công`);
        setOverallBreakdown({
          success: successCount,
          failed: failedCount,
          skipped: skippedByConflict.length
        });
      } catch (err) {
        failedCount += 1;
        const message = (err && err.message) || "upload thất bại";
        updateRowUploadState(row.id, {
          isUploading: false,
          isFailed: true,
          isDone: false,
          isSkipped: false
        });
        setOverallProgress(chapterOrder, queue.length, `Đã xử lý ${chapterOrder}/${queue.length} chapter`);
        logLine(`Chapter ${row.chapterNumberText}: thất bại - ${message}`, true);
        setOverallBreakdown({
          success: successCount,
          failed: failedCount,
          skipped: skippedByConflict.length
        });
      }

      if (chapterOrder < queue.length && delayMs > 0) {
        setOverallProgress(chapterOrder, queue.length, `Chờ ${delayMs}ms trước chapter tiếp theo...`);
        await sleep(delayMs);
      }
    }

    const summary = `Xong: ${successCount} thành công, ${failedCount} thất bại, ${skippedByConflict.length} bỏ qua.`;
    logLine(summary, failedCount > 0);
    setOverallProgress(queue.length, queue.length, summary);
    setOverallBreakdown({
      success: successCount,
      failed: failedCount,
      skipped: skippedByConflict.length
    });
    await saveConfigToDisk(false).catch(() => null);
  } finally {
    state.uploadRunning = false;
    setControlsDisabled(false);
    renderChapterTable();
  }
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function handlePickParentFolder() {
  if (!state.authenticated || state.uploadRunning || state.authBusy) return;
  const picked = await ipcRenderer.invoke("desktop:pick-parent-folder").catch(() => "");
  const folder = (picked || "").toString().trim();
  if (!folder) return;

  state.parentFolder = folder;
  updateFolderPathLabel();

  try {
    await loadRowsFromParentFolder(folder);
    if (state.selectedManga) {
      await loadExistingChaptersForSelectedManga(`Đang cập nhật chapter của ${state.selectedManga.title}...`);
      logLine(`Đã đồng bộ chapter của ${state.selectedManga.title} sau khi chọn thư mục.`);
    }
  } catch (err) {
    logLine(`Không thể đọc thư mục: ${(err && err.message) || "không rõ"}`, true);
  }
}

async function handleReloadParentFolder() {
  if (!state.parentFolder) {
    logLine("Chưa có thư mục để tải lại.", true);
    return;
  }
  try {
    await loadRowsFromParentFolder(state.parentFolder);
    if (state.selectedManga) {
      await loadExistingChaptersForSelectedManga(`Đang cập nhật chapter của ${state.selectedManga.title}...`);
      logLine(`Đã cập nhật lại chapter của ${state.selectedManga.title}.`);
    }
  } catch (err) {
    logLine(`Tải lại thư mục thất bại: ${(err && err.message) || "không rõ"}`, true);
  }
}

function clearLogBox() {
  if (!el.logBox) return;
  el.logBox.innerHTML = "";
}

function readLocalStorageText(key) {
  try {
    return (localStorage.getItem(key) || "").toString();
  } catch (_err) {
    return "";
  }
}

function writeLocalStorageText(key, value) {
  try {
    localStorage.setItem(key, (value == null ? "" : String(value)).trim());
  } catch (_err) {
    // ignore storage write errors
  }
}

function fillAuthInputsFromLocalStorage() {
  const cachedEndpoint = normalizeEndpoint(readLocalStorageText(STORAGE_ENDPOINT_KEY));
  const endpointValue = cachedEndpoint || state.endpoint;
  if (el.authEndpoint) {
    el.authEndpoint.value = endpointValue;
  }
}

async function handleHardRefresh() {
  if (!state.authenticated || state.uploadRunning || state.authBusy) return;

  state.authBusy = true;
  setControlsDisabled(true);
  if (el.hardRefreshBtn) {
    setButtonLabel(el.hardRefreshBtn, "fa-solid fa-spinner fa-spin", "Đang làm mới...");
  }

  try {
    clearLogBox();

    state.parentFolder = "";
    state.configPath = "";
    state.chapterRows = [];
    state.existingChapterMap = new Map();
    state.selectedManga = null;
    state.mangaList = [];
    state.mangaLoading = true;
    state.mangaSearch = "";

    if (el.mangaSearch) {
      el.mangaSearch.value = "";
    }

    updateFolderPathLabel();
    renderChapterTable();
    renderMangaList();
    updateSelectedMangaLabel();
    setOverallProgress(0, 0, "Đang làm mới dữ liệu...");
    setOverallBreakdown({ success: 0, failed: 0, skipped: 0 });

    await authenticate(state.endpoint, state.apiKey);

    setOverallProgress(0, 0, "Đã làm mới dữ liệu.");
    setOverallBreakdown({ success: 0, failed: 0, skipped: 0 });
    logLine("Đã làm mới danh sách truyện, bảng upload và nhật ký.");
  } catch (err) {
    const message = (err && err.message) || "không rõ";
    logLine(`Làm mới thất bại: ${message}`, true);
  } finally {
    state.authBusy = false;
    setControlsDisabled(false);
    if (el.hardRefreshBtn) {
      setButtonLabel(el.hardRefreshBtn, "fa-solid fa-rotate-right", "Làm mới");
    }
  }
}

function bindEvents() {
  fillAuthInputsFromLocalStorage();
  bindStrictIntegerInput(el.retryCount, DEFAULT_RETRY_COUNT);
  bindStrictIntegerInput(el.delayMs, DEFAULT_DELAY_MS);

  if (el.helpOpenBtn) {
    el.helpOpenBtn.addEventListener("click", () => {
      setHelpModalVisible(true);
    });
  }

  if (el.helpCloseBtn) {
    el.helpCloseBtn.addEventListener("click", () => {
      setHelpModalVisible(false);
    });
  }

  if (el.helpModal) {
    el.helpModal.addEventListener("click", (event) => {
      if (event.target === el.helpModal) {
        setHelpModalVisible(false);
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!event || event.key !== "Escape") return;
    if (el.helpModal && !el.helpModal.hidden) {
      setHelpModalVisible(false);
    }
  });

  if (el.authForm) {
    el.authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.authBusy || state.uploadRunning) return;

      const endpointInput = el.authEndpoint ? el.authEndpoint.value : "";
      const apiKeyInput = el.authKey ? el.authKey.value : "";

      const endpoint = normalizeEndpoint(endpointInput);
      const apiKey = (apiKeyInput || "").toString().trim();

      if (!endpoint) {
        setAuthMessage("Endpoint không hợp lệ.", true);
        return;
      }
      if (!apiKey) {
        setAuthMessage("API key không được để trống.", true);
        return;
      }

      if (el.authEndpoint) {
        el.authEndpoint.value = endpoint;
      }

      state.authBusy = true;
      if (el.authSubmit) {
        el.authSubmit.disabled = true;
        setButtonLabel(el.authSubmit, "fa-solid fa-spinner fa-spin", "Đang kết nối...");
      }
      setAuthMessage("Đang xác thực API key...");

      try {
        await authenticate(endpoint, apiKey);
        writeLocalStorageText(STORAGE_ENDPOINT_KEY, endpoint);
        if (el.authKey) {
          el.authKey.value = "";
        }
        setAuthOverlayVisible(false);
        setAuthMessage("Kết nối thành công.");
        logLine(`Đăng nhập thành công vào ${endpoint}`);
      } catch (err) {
        resetAuthState();
        const message = (err && err.message) || "Không thể xác thực API key.";
        setAuthMessage(message, true);
        logLine(`Xác thực thất bại: ${message}`, true);
      } finally {
        state.authBusy = false;
        if (el.authSubmit) {
          el.authSubmit.disabled = false;
          setButtonLabel(el.authSubmit, "fa-solid fa-plug", "Kết nối");
        }
      }
    });
  }

  if (el.switchAuthBtn) {
    el.switchAuthBtn.addEventListener("click", () => {
      if (state.uploadRunning) return;
      resetAuthState();
      if (el.authKey) {
        el.authKey.value = "";
      }
      fillAuthInputsFromLocalStorage();
      setAuthOverlayVisible(true);
      setAuthMessage("");
    });
  }

  if (el.hardRefreshBtn) {
    el.hardRefreshBtn.addEventListener("click", () => {
      handleHardRefresh().catch((err) => {
        logLine(`Làm mới thất bại: ${(err && err.message) || "không rõ"}`, true);
      });
    });
  }

  if (el.selectAllBtn) {
    el.selectAllBtn.addEventListener("click", () => {
      if (state.uploadRunning || state.authBusy) return;

      const rows = getSelectableRows();
      if (!rows.length) return;

      const allSelected = rows.every((row) => row.enabled);
      rows.forEach((row) => {
        row.enabled = !allSelected;
      });

      renderChapterTable();
      scheduleSaveConfig();
    });
  }

  if (el.mangaSearch) {
    el.mangaSearch.addEventListener("input", () => {
      state.mangaSearch = (el.mangaSearch.value || "").toString();
      renderMangaList();
    });
  }

  if (el.mangaGrid) {
    el.mangaGrid.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const card = target.closest("[data-manga-id]");
      if (!card) return;
      if (state.uploadRunning || state.authBusy) return;
      const mangaId = Number(card.getAttribute("data-manga-id") || 0);
      if (!Number.isFinite(mangaId) || mangaId <= 0) return;
      selectMangaById(mangaId).catch((err) => {
        logLine(`Không thể tải chapter list: ${(err && err.message) || "không rõ"}`, true);
      });
    });
  }

  if (el.pickFolderBtn) {
    el.pickFolderBtn.addEventListener("click", () => {
      handlePickParentFolder().catch((err) => {
        logLine(`Chọn thư mục thất bại: ${(err && err.message) || "không rõ"}`, true);
      });
    });
  }

  if (el.reloadFolderBtn) {
    el.reloadFolderBtn.addEventListener("click", () => {
      handleReloadParentFolder().catch((err) => {
        logLine(`Tải lại thư mục thất bại: ${(err && err.message) || "không rõ"}`, true);
      });
    });
  }

  if (el.saveConfigBtn) {
    el.saveConfigBtn.addEventListener("click", () => {
      saveConfigToDisk(true).catch((err) => {
        logLine(`Lưu config thất bại: ${(err && err.message) || "không rõ"}`, true);
      });
    });
  }

  if (el.startUploadBtn) {
    el.startUploadBtn.addEventListener("click", () => {
      startBulkUpload().catch((err) => {
        logLine(`Upload bulk thất bại: ${(err && err.message) || "không rõ"}`, true);
      });
    });
  }

  if (el.chapterTableBody) {
    el.chapterTableBody.addEventListener("input", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (!target.matches("[data-row-title]")) return;

      const rowNode = target.closest("[data-row-id]");
      if (!rowNode) return;
      const rowId = rowNode.getAttribute("data-row-id");
      const row = state.chapterRows.find((item) => item.id === rowId);
      if (!row) return;

      row.title = (target.value || "").toString();
      scheduleSaveConfig();
    });

    el.chapterTableBody.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const rowNode = target.closest("[data-row-id]");
      if (!rowNode) return;
      const rowId = rowNode.getAttribute("data-row-id");
      const row = state.chapterRows.find((item) => item.id === rowId);
      if (!row) return;

      if (target.matches("[data-row-enabled]")) {
        row.enabled = Boolean(target.checked);
        updateStartUploadButtonState();
        scheduleSaveConfig();
        return;
      }

      if (target.matches("[data-row-action]")) {
        row.action = String(target.value || "skip");
        scheduleSaveConfig();
        return;
      }
    });
  }
}

function init() {
  bindEvents();
  setHelpModalVisible(false);
  resetAuthState();
  updateFolderPathLabel();
  setOverallProgress(0, 0, "Chưa upload.");
  setOverallBreakdown({ success: 0, failed: 0, skipped: 0 });
  setAuthOverlayVisible(true);
  setAuthMessage("");
}

init();
