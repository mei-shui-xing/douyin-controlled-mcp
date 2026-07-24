import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.js";
import { browserProfileId } from "./page-bindings.js";

const profileDir = path.join(CONFIG.runtimeDir, "browser-profile");

function browserCandidates(): string[] {
  const values = [
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"]!, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"]!, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
  ];
  return values.filter(candidate => candidate && fs.existsSync(candidate));
}

async function cdpConnected(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIG.cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

export async function ensureDedicatedBrowserConnected(
  allowLaunch: boolean,
): Promise<{
  connected: true;
  launched: boolean;
  profileDir: string;
  profileId: string;
}> {
  if (await cdpConnected()) {
    return {
      connected: true,
      launched: false,
      profileDir,
      profileId: browserProfileId,
    };
  }
  if (!allowLaunch) {
    throw new Error("BROWSER_DISCONNECTED:专用浏览器未连接，且 allow_browser_launch=false。");
  }
  if (!fs.existsSync(profileDir)
    || !fs.existsSync(path.join(CONFIG.runtimeDir, "PRIVATE_BROWSER_PROFILE.txt"))) {
    throw new Error(
      "FIXED_PROFILE_MISSING:固定 Operator 浏览器用户目录或其标识文件不存在；"
      + "禁止创建临时空白用户目录。",
    );
  }
  const executable = browserCandidates()[0];
  if (!executable) {
    throw new Error("BROWSER_NOT_FOUND:没有找到已安装的 Chrome 或 Edge。");
  }
  const child = spawn(executable, [
    "--remote-debugging-port=9222",
    "--remote-allow-origins=http://127.0.0.1:9222,http://localhost:9222",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://www.douyin.com/",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await cdpConnected()) {
      return {
        connected: true,
        launched: true,
        profileDir,
        profileId: browserProfileId,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `BROWSER_LAUNCH_FAILED:已使用固定 profile=${profileDir} 启动浏览器，`
    + "但 25 秒内未连接到 CDP。",
  );
}
