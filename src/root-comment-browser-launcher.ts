import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.js";

export const rootCommentProfileDir = path.join(
  CONFIG.runtimeDir,
  "operator_root_comment_clean",
);
const markerFile = path.join(
  CONFIG.runtimeDir,
  "ROOT_COMMENT_CLEAN_PROFILE.txt",
);
export const rootCommentProfileId = crypto.createHash("sha256")
  .update(path.resolve(rootCommentProfileDir).toLocaleLowerCase(), "utf8")
  .digest("hex")
  .slice(0, 24);

function browserCandidates(): string[] {
  const values = [
    process.env.ProgramFiles
      ? path.join(
        process.env.ProgramFiles,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      )
      : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(
        process.env["ProgramFiles(x86)"]!,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      )
      : "",
    process.env.LOCALAPPDATA
      ? path.join(
        process.env.LOCALAPPDATA,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      )
      : "",
    process.env.ProgramFiles
      ? path.join(
        process.env.ProgramFiles,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      )
      : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(
        process.env["ProgramFiles(x86)"]!,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      )
      : "",
  ];
  return values.filter(candidate => candidate && fs.existsSync(candidate));
}

async function cdpConnected(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIG.rootCommentCdpUrl}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

function provisionPersistentProfile(): void {
  fs.mkdirSync(rootCommentProfileDir, { recursive: true });
  if (!fs.existsSync(markerFile)) {
    fs.writeFileSync(
      markerFile,
      [
        "Dedicated persistent Douyin profile for creating root comments only.",
        `profile_id=${rootCommentProfileId}`,
        "Cookies are not copied from any other browser profile.",
        "The first login must be completed manually by QR scan.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

export async function ensureRootCommentBrowserConnected(
  allowLaunch: boolean,
): Promise<{
  connected: true;
  launched: boolean;
  profileDir: string;
  profileId: string;
  cdpUrl: string;
}> {
  if (await cdpConnected()) {
    return {
      connected: true,
      launched: false,
      profileDir: rootCommentProfileDir,
      profileId: rootCommentProfileId,
      cdpUrl: CONFIG.rootCommentCdpUrl,
    };
  }
  if (!allowLaunch) {
    throw new Error(
      "ROOT_COMMENT_BROWSER_DISCONNECTED:"
      + "operator_root_comment_clean 未连接，且 allow_browser_launch=false。",
    );
  }
  provisionPersistentProfile();
  const executable = browserCandidates()[0];
  if (!executable) {
    throw new Error("BROWSER_NOT_FOUND:没有找到已安装的 Chrome 或 Edge。");
  }
  const port = new URL(CONFIG.rootCommentCdpUrl).port || "9223";
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=http://127.0.0.1:9223,http://localhost:9223",
    `--user-data-dir=${rootCommentProfileDir}`,
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
        profileDir: rootCommentProfileDir,
        profileId: rootCommentProfileId,
        cdpUrl: CONFIG.rootCommentCdpUrl,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `ROOT_COMMENT_BROWSER_LAUNCH_FAILED:已使用固定 profile=${rootCommentProfileDir} `
    + "启动浏览器，但 25 秒内未连接到 CDP。",
  );
}

export async function rootCommentBrowserConnected(): Promise<boolean> {
  return cdpConnected();
}
