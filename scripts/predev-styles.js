#!/usr/bin/env node

"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");

const resolveNpmInvocation = (args = []) => {
  const npmExecPath = String(process.env.npm_execpath || "").trim();

  // When running through Bun, npm_execpath can point at bun.exe.
  // Do not invoke it as: node bun.exe
  if (npmExecPath && /bun(?:\.exe)?$/i.test(npmExecPath)) {
    return {
      command: npmExecPath,
      args,
      shell: false
    };
  }

  if (process.env.BUN_INSTALL) {
    return {
      command: process.platform === "win32"
        ? path.join(process.env.BUN_INSTALL, "bin", "bun.exe")
        : path.join(process.env.BUN_INSTALL, "bin", "bun"),
      args,
      shell: false
    };
  }

  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args],
      shell: false
    };
  }

  return {
    command: "npm",
    args,
    shell: process.platform === "win32"
  };
};

const isTruthyEnvValue = (value) => {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return false;
  return ["1", "true", "yes", "on"].includes(text);
};

const npmLifecycleEvent = String(process.env.npm_lifecycle_event || "").trim().toLowerCase();
const forcePredevSpinner = isTruthyEnvValue(
  process.env.FORCE_PREDEV_SPINNER || process.env.FORCE_ORA
);

const loadOraFactory = async () => {
  try {
    const oraModule = await import("ora");
    return oraModule && typeof oraModule.default === "function"
      ? oraModule.default
      : null;
  } catch (_error) {
    return null;
  }
};

const trimOutput = (text) => {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "";
  return raw;
};

const runAssetsBuild = ({ showLogs }) => {
  return new Promise((resolve, reject) => {
    const invocation = resolveNpmInvocation(["run", "assets:build"]);
    const stdoutParts = [];
    const stderrParts = [];

    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      env: process.env,
      shell: invocation.shell,
      stdio: showLogs ? "inherit" : ["ignore", "pipe", "pipe"]
    });

    child.on("error", (error) => {
      reject(error);
    });

    if (!showLogs && child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutParts.push(String(chunk || ""));
      });
    }

    if (!showLogs && child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrParts.push(String(chunk || ""));
      });
    }

    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`assets:build terminated by signal ${signal}`));
        return;
      }

      if (typeof code === "number" && code !== 0) {
        const stdoutText = trimOutput(stdoutParts.join(""));
        const stderrText = trimOutput(stderrParts.join(""));
        const detail = stderrText || stdoutText;
        reject(new Error(detail || `assets:build exited with status ${code}`));
        return;
      }

      resolve();
    });
  });
};

const main = async () => {
  const showLogs = isTruthyEnvValue(process.env.SHOW_ASSET_BUILD_LOGS || process.env.SHOW_STYLE_BUILD_LOGS);
  const oraFactory = await loadOraFactory();
  const shouldUseSpinner = Boolean(
    !showLogs
      && oraFactory
      && (
        forcePredevSpinner
        || npmLifecycleEvent === "predev"
        || (process.stdout && process.stdout.isTTY)
      )
  );

  const spinner = shouldUseSpinner
    ? oraFactory({
      text: "Building Vite web assets...",
      color: "cyan",
      spinner: "dots",
      isEnabled: forcePredevSpinner || npmLifecycleEvent === "predev" ? true : undefined
    }).start()
    : null;

  try {
    await runAssetsBuild({ showLogs });
    if (spinner) {
      spinner.succeed("Vite web assets built.");
    }
  } catch (error) {
    if (spinner) {
      spinner.fail("assets:build failed.");
    }
    if (error && error.message) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
};

main();
