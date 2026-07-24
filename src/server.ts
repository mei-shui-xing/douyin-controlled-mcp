import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import express, { type Request, type Response } from "express";
import {
  McpServer,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CONFIG } from "./config.js";
import { DouyinBrowser } from "./browser.js";
import { describeSafety } from "./safety.js";
import { log } from "./logger.js";
import { asAppError } from "./app/errors.js";
import type { LightweightScrollResult, Observation, TranscriptRecord } from "./types.js";
import {
  listTranscripts,
  loadTranscript,
  resolvePublicDouyinVideo,
  transcribePublicLinkLocal,
} from "./transcript.js";
import { loadActionSettings, RESERVED_DISABLED_MESSAGE } from "./action-config.js";
import { readActionLog } from "./action-log.js";
import { renderHtmlCarousel } from "./carousel-renderer.js";
import {
  CAPABILITY_PACK_NAMES,
  CAPABILITY_PACKS,
  CORE_TOOL_NAMES,
  INTERNAL_PUBLISHER_TOOL_NAMES,
  expandCapabilityPacks,
  packsForTool,
  type CapabilityPackName,
} from "./capability-packs.js";
import {
  CAPABILITY_REGISTRY_REVISION,
  getCapabilityPackRuntime,
} from "./capability-runtime.js";
import {
  accessTokenFingerprint,
  applyCors,
  enforceRequestRate,
  requireMcpAuthentication,
} from "./http-security.js";
import { acquireProcessLock, releaseProcessLock } from "./process-lock.js";
import { decideSessionCapacity, resolveObservationOwner } from "./mcp-session-policy.js";
import {
  applyInitialSetup,
  describeDetectedAccount,
  getSetupStatus,
  validateSetup,
} from "./setup-config.js";

const browser = new DouyinBrowser();

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const SAFE_ACTION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const;

const LOCAL_STATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_ACTION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

// Every successful tool result already exposes an object through
// structuredContent. Declaring a permissive object schema at the MCP boundary
// makes that contract discoverable to clients while preserving the
// tool-specific fields that each handler returns.
const DEFAULT_TOOL_OUTPUT_SCHEMA = z.object({}).catchall(z.unknown());

function observationText(observation: Observation): string {
  const elements = observation.elements
    .map(element => {
      const href = element.href ? ` href=${element.href}` : "";
      return `${element.id} | ${element.kind} | ${element.label || "未命名"} | box=(${element.box.x},${element.box.y},${element.box.width},${element.box.height})${href}`;
    })
    .join("\n");

  return [
    observation.note ? `操作结果：${observation.note}` : null,
    `页面类型：${observation.pageKind}`,
    `标题：${observation.title}`,
    `网址：${observation.url}`,
    `视口：${observation.viewport.width}×${observation.viewport.height}`,
    observation.viewportDiagnostics
      ? `真实 CSS 视口：${observation.viewportDiagnostics.css.width}×${observation.viewportDiagnostics.css.height}；比例=${observation.viewportDiagnostics.widthRatio.toFixed(3)}×${observation.viewportDiagnostics.heightRatio.toFixed(3)}${observation.viewportDiagnostics.mismatch ? "；⚠ 视口口径不一致" : ""}`
      : null,
    `时间：${observation.capturedAt}`,
    observation.observationId ? `观察快照：${observation.observationId}` : null,
    observation.snapshotHash ? `快照哈希：${observation.snapshotHash}` : null,
    observation.expiresAt ? `快照有效期：${observation.expiresAt}` : null,
    "可点击元素（使用 douyin_click 的 element_id）：",
    elements || "当前没有识别到可安全点击的元素。",
    "提示：先看随附截图，再根据元素编号决定点击、滚动指定区域、返回或采样视频。",
  ].filter(Boolean).join("\n");
}

function observationResult(observation: Observation) {
  return {
    content: [
      { type: "text" as const, text: observationText(observation) },
      { type: "image" as const, data: observation.screenshotBase64, mimeType: "image/jpeg" },
    ],
    structuredContent: {
      url: observation.url,
      title: observation.title,
      pageKind: observation.pageKind,
      viewport: observation.viewport,
      viewportDiagnostics: observation.viewportDiagnostics ?? null,
      capturedAt: observation.capturedAt,
      elements: observation.elements,
      note: observation.note ?? null,
      observationId: observation.observationId ?? null,
      pageId: observation.pageId ?? null,
      pageTargetId: observation.pageTargetId ?? null,
      snapshotHash: observation.snapshotHash ?? null,
      expiresAt: observation.expiresAt ?? null,
    },
  };
}

function lightweightScrollResult(result: LightweightScrollResult) {
  return {
    content: [{
      type: "text" as const,
      text: [
        result.note,
        `页面：${result.title}`,
        `网址：${result.url}`,
        `耗时：${result.elapsedMs} ms`,
        "本次未生成截图；需要视觉确认时调用 douyin_observe，轻量读取时调用 douyin_observe_fast。",
      ].join("\n"),
    }],
    structuredContent: result,
  };
}


function formatSeconds(value: number): string {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function transcriptSummary(record: TranscriptRecord) {
  const preview = record.segments.slice(0, 18)
    .map(segment => `[${formatSeconds(segment.start)}] ${segment.text}`)
    .join("\n");
  return {
    content: [{
      type: "text" as const,
      text: [
        "本地字幕已生成（或命中缓存）。",
        `字幕 ID：${record.transcriptId}`,
        `作品：${record.title || record.workId}`,
        `时长：${record.durationSeconds == null ? "未知" : formatSeconds(record.durationSeconds)}`,
        `语言：${record.language ?? "自动识别"}`,
        `模型：${record.model}`,
        `方式：${record.method}`,
        `缓存命中：${Boolean(record.cacheHit)}`,
        `片段数：${record.segments.length}`,
        "前 18 个片段：",
        preview || "没有文字片段。",
        "需要继续细看时，调用 douyin_read_transcript；要找特定内容时，调用 douyin_search_transcript。",
      ].join("\n"),
    }],
    structuredContent: {
      transcriptId: record.transcriptId,
      workId: record.workId,
      title: record.title,
      author: record.author ?? null,
      durationSeconds: record.durationSeconds,
      language: record.language,
      model: record.model,
      method: record.method,
      cacheHit: Boolean(record.cacheHit),
      segmentCount: record.segments.length,
      previewSegments: record.segments.slice(0, 18),
    },
  };
}

function errorResult(error: unknown, details: Record<string, unknown> = {}) {
  const resolved = asAppError(error);
  const safeDetails = { ...resolved.safeDetails, ...details };
  log("tool_error", {
    message: resolved.message,
    code: resolved.code,
    retryable: resolved.retryable,
    sideEffectStage: resolved.sideEffectStage,
    ...safeDetails,
  });
  return {
    isError: true,
    content: [{ type: "text" as const, text: resolved.message }],
    structuredContent: {
      ok: false,
      code: resolved.code,
      message: resolved.message,
      retryable: resolved.retryable,
      sideEffectStage: resolved.sideEffectStage,
      ...safeDetails,
    },
  };
}

function omitScreenshotBase64(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitScreenshotBase64);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "screenshotBase64")
    .map(([key, item]) => [key, omitScreenshotBase64(item)]));
}

function compactArtifactResult<T>(
  result: T,
  text: string,
  includeScreenshotBase64: boolean,
  mimeType = "image/png",
) {
  const record = result && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  const screenshotBase64 = typeof record.screenshotBase64 === "string"
    ? record.screenshotBase64
    : null;
  return {
    content: [
      { type: "text" as const, text },
      ...(includeScreenshotBase64 && screenshotBase64
        ? [{ type: "image" as const, data: screenshotBase64, mimeType }]
        : []),
    ],
    structuredContent: includeScreenshotBase64
      ? result
      : omitScreenshotBase64(result) as Record<string, unknown>,
  };
}

function screenshotPathOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.screenshotPath === "string") return record.screenshotPath;
  if (record.diagnostics && typeof record.diagnostics === "object") {
    const nested = record.diagnostics as Record<string, unknown>;
    if (typeof nested.screenshotPath === "string") return nested.screenshotPath;
  }
  return "";
}

export function createMcpServer(connectionId = randomUUID()): McpServer {
  const server = new McpServer({
    name: CONFIG.name,
    version: CONFIG.version,
  });
  type ToolDefinition = {
    handle: RegisteredTool;
    config: Record<string, any>;
    callback: (...args: any[]) => any;
  };
  const toolDefinitions = new Map<string, ToolDefinition>();
  const capabilityRuntime = getCapabilityPackRuntime();
  const connectionSelectedPacks = new Set<CapabilityPackName>();
  const refreshPackSelection = (): void => {
    connectionSelectedPacks.clear();
    for (const pack of capabilityRuntime.selectedPacks()) connectionSelectedPacks.add(pack);
  };
  refreshPackSelection();
  const selectedPacks = (): Set<CapabilityPackName> => {
    refreshPackSelection();
    return new Set(connectionSelectedPacks);
  };
  type CapabilityExtra = {
    sessionId?: string;
    requestId?: string | number;
    __douyinCompatibilityGateway?: boolean;
    [key: string]: unknown;
  };
  const runtimeMetadata = (extra?: CapabilityExtra) => {
    refreshPackSelection();
    return capabilityRuntime.snapshot(connectionId, extra?.sessionId);
  };
  const compatibilityGatewayExtra = (extra: unknown): CapabilityExtra => ({
    ...(extra && typeof extra === "object" ? extra as Record<string, unknown> : {}),
    __douyinCompatibilityGateway: true,
  });
  const observationOwner = (extra?: CapabilityExtra) => resolveObservationOwner({
    sessionId: extra?.sessionId,
    connectionId,
    compatibilityGateway: extra?.__douyinCompatibilityGateway === true,
    accessTokenFingerprint: accessTokenFingerprint(),
  });

  const activePacks = (): Set<CapabilityPackName> =>
    expandCapabilityPacks(selectedPacks());
  const activeToolNames = (): Set<string> => {
    const names = new Set(CORE_TOOL_NAMES);
    for (const packName of activePacks()) {
      for (const toolName of CAPABILITY_PACKS[packName].tools) names.add(toolName);
    }
    return names;
  };
  const applyCapabilityVisibility = (
    notify = true,
    relatedRequestId?: string | number,
  ): string[] => {
    const enabled = activeToolNames();
    if (notify && server.isConnected()) {
      const notification = relatedRequestId === undefined
        ? server.server.sendToolListChanged()
        : server.server.notification(
          { method: "notifications/tools/list_changed" },
          { relatedRequestId },
        );
      void notification.catch(error => {
        log("tools_list_changed_notification_failed", {
          error: String(error),
          relatedRequestId,
        });
      });
    }
    return [...enabled].filter(name => toolDefinitions.has(name)).sort();
  };
  const jsonSchemaForTool = (
    toolName: string,
    schemaKey: "inputSchema" | "outputSchema",
  ): Record<string, unknown> => {
    const schema = toolDefinitions.get(toolName)?.config[schemaKey];
    if (!schema) {
      return {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
    }
    try {
      return z.toJSONSchema(schema) as Record<string, unknown>;
    } catch {
      return {
        type: "object",
        description: "Schema is available through tools/list after this pack is loaded.",
      };
    }
  };
  const inputSchemaForTool = (toolName: string): Record<string, unknown> =>
    jsonSchemaForTool(toolName, "inputSchema");
  const outputSchemaForTool = (toolName: string): Record<string, unknown> =>
    jsonSchemaForTool(toolName, "outputSchema");
  const describeVisibleTool = (toolName: string) => {
    const definition = toolDefinitions.get(toolName);
    if (!definition) return null;
    return {
      name: toolName,
      title: definition.config.title,
      description: definition.config.description,
      inputSchema: inputSchemaForTool(toolName),
      outputSchema: outputSchemaForTool(toolName),
      annotations: definition.config.annotations,
      _meta: definition.config._meta,
    };
  };
  const describePackTools = (packName: CapabilityPackName) =>
    CAPABILITY_PACKS[packName].tools.map(toolName => {
      const definition = toolDefinitions.get(toolName);
      return {
        name: toolName,
        title: definition?.config.title ?? toolName,
        description: definition?.config.description ?? "",
        inputSchema: inputSchemaForTool(toolName),
      };
    });
  const invokeToolDefinition = async (
    toolName: string,
    toolArguments: Record<string, unknown>,
    extra: unknown,
  ) => {
    const definition = toolDefinitions.get(toolName);
    if (!definition || typeof definition.callback !== "function") {
      return errorResult(new Error(`CAPABILITY_UNAVAILABLE:${toolName}`));
    }
    const schema = definition.config.inputSchema;
    let validatedArguments: unknown = toolArguments;
    if (schema && typeof schema.safeParseAsync === "function") {
      const parsed = await schema.safeParseAsync(toolArguments);
      if (!parsed.success) {
        return errorResult(new Error(
          `CAPABILITY_ARGUMENTS_INVALID:${toolName}:${parsed.error.message}`,
        ));
      }
      validatedArguments = parsed.data;
    }
    return schema
      ? definition.callback(validatedArguments, extra)
      : definition.callback(extra);
  };
  const addPackSelection = (
    packName: CapabilityPackName,
    relatedRequestId?: string | number,
  ): string[] => {
    capabilityRuntime.load([packName]);
    refreshPackSelection();
    return applyCapabilityVisibility(true, relatedRequestId);
  };
  const replacePackSelection = (packs: Iterable<CapabilityPackName>): void => {
    capabilityRuntime.load(packs, true);
    refreshPackSelection();
  };
  const removePackSelection = (packs: Iterable<CapabilityPackName>): void => {
    capabilityRuntime.unload(packs);
    refreshPackSelection();
  };
  const packNotLoadedError = (
    packNames: CapabilityPackName[],
    toolName: string,
    extra?: { sessionId?: string },
  ) => errorResult(new Error(
    `capability_pack_not_loaded: ${packNames.join("|")}; tool=${toolName}; `
    + "call douyin_load_capability_pack or use the matching capability gateway with auto_load=true",
  ), runtimeMetadata(extra));

  const registerRawTool = server.registerTool.bind(server);
  const registerTool = ((
    name: string,
    config: Record<string, unknown>,
    callback: (...args: any[]) => any,
  ) => {
    const normalizedConfig = {
      ...config,
      outputSchema: config.outputSchema ?? DEFAULT_TOOL_OUTPUT_SCHEMA,
    };
    const wrappedCallback = async (...args: any[]) => {
      const result = await callback(...args);
      if (result?.isError || result?.structuredContent || !Array.isArray(result?.content)) {
        return result;
      }
      const message = result.content
        .filter((item: any) => item?.type === "text" && typeof item.text === "string")
        .map((item: any) => item.text)
        .join("\n");
      return {
        ...result,
        structuredContent: {
          message: message || "工具已成功执行。",
        },
      };
    };
    const handle = (registerRawTool as any)(
      name,
      normalizedConfig,
      wrappedCallback,
    ) as RegisteredTool;
    toolDefinitions.set(name, {
      handle,
      config: normalizedConfig,
      callback: wrappedCallback,
    });
    return handle;
  }) as McpServer["registerTool"];

  registerTool(
    "douyin_get_setup_status",
    {
      title: "Check first-run configuration",
      description: "Checks whether the three private runtime configuration files exist and validate. It never returns uid, sec_uid, cookies, tokens, or file contents.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = getSetupStatus();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_detect_current_account",
    {
      title: "Detect the signed-in account",
      description: "Read-only first-run detection from the currently signed-in Douyin or Creator Center page. Stable IDs are masked and are never returned in full.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const account = await browser.detectCurrentAccountForSetup();
        const result = describeDetectedAccount(account);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const initialSetupSchema = z.object({
    operator_alias: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/)
      .default("operator")
      .describe("Owner-approved local alias; this is not a Douyin display name."),
    enable_public_comment: z.boolean().default(false),
    enable_comment_reply: z.boolean().default(false),
    enable_publish_video: z.boolean().default(false),
    enable_publish_article: z.boolean().default(false),
    max_writes_per_minute: z.number().int().min(1).max(20).default(4),
    share_cooldown_minutes: z.number().int().min(1).max(1_440).default(10),
    min_delay_ms: z.number().int().min(500).max(15_000).default(900),
    max_delay_ms: z.number().int().min(500).max(15_000).default(1_600),
    confirm_apply: z.literal(true).describe("Set only after the owner confirms alias and permissions."),
  }).refine(input => input.max_delay_ms >= input.min_delay_ms, {
    message: "max_delay_ms must be greater than or equal to min_delay_ms",
    path: ["max_delay_ms"],
  });

  registerTool(
    "douyin_configure_initial_setup",
    {
      title: "Write the initial private configuration",
      description: "After the AI has asked the owner for an alias and explicit write permissions, re-detects the signed-in account and atomically creates private runtime configuration. Existing configuration is never overwritten. Do not guess answers or request raw stable IDs.",
      inputSchema: initialSetupSchema,
      annotations: LOCAL_STATE_ANNOTATIONS,
    },
    async ({
      operator_alias,
      enable_public_comment,
      enable_comment_reply,
      enable_publish_video,
      enable_publish_article,
      max_writes_per_minute,
      share_cooldown_minutes,
      min_delay_ms,
      max_delay_ms,
    }) => {
      try {
        const account = await browser.detectCurrentAccountForSetup();
        const result = await applyInitialSetup(account, {
          operatorAlias: operator_alias,
          publicComment: enable_public_comment,
          commentReply: enable_comment_reply,
          publishVideo: enable_publish_video,
          publishArticle: enable_publish_article,
          maxWritesPerMinute: max_writes_per_minute,
          shareCooldownMinutes: share_cooldown_minutes,
          minDelayMs: min_delay_ms,
          maxDelayMs: max_delay_ms,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_validate_setup",
    {
      title: "Validate private configuration",
      description: "Validates local configuration and optionally confirms that the current signed-in account matches it. Full stable IDs are never returned.",
      inputSchema: z.object({
        verify_current_login: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ verify_current_login }) => {
      try {
        const validation = validateSetup();
        let currentLogin: Record<string, unknown> | null = null;
        if (verify_current_login && validation.valid) {
          const detected = await browser.detectCurrentAccountForSetup();
          const operator = loadActionSettings().operator;
          currentLogin = {
            verified: detected.uid === operator.uid && detected.secUid === operator.secUid,
            detected: describeDetectedAccount(detected),
          };
        }
        const result = { ...validation, currentLogin };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_link",
    {
      title: "打开抖音分享链接",
      description: "在独立 codex_test 页面打开用户提供的 douyin.com 或 www.douyin.com 作品长链接，并返回页面截图。不会执行点赞、关注等写操作。",
      inputSchema: z.object({
        url: z.string().url().describe("抖音分享链接"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ url }) => {
      try {
        return observationResult(await browser.openLink(url));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_extract_article",
    {
      title: "提取抖音文章或图文正文",
      description: "从当前抖音文章/图文页面直接提取正文文字。适合人机恋长文、清单、教程文章；不需要语音转写，也不会产生费用。普通视频不要用这个工具。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.extractArticleText();
        return {
          content: [{
            type: "text" as const,
            text: [
              `标题：${result.title}`,
              `作者：${result.author ?? "未识别"}`,
              `发布时间：${result.publishedAt ?? "未识别"}`,
              `作品 ID：${result.workId}`,
              `网址：${result.url}`,
              `可信来源：${result.sourceSelector}（${result.sourceType}）`,
              `标题关联验证：${result.headingMatched}`,
              `排除区域数量：${result.excludedRegionCount}`,
              `自然段数量：${result.paragraphCount}`,
              `隐私过滤：${result.privacyFiltered}`,
              `正文字符数：${result.characterCount}`,
              "正文：",
              result.text,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_probe_content",
    {
      title: "判断当前内容适合怎么看",
      description: "读取当前作品的原生类型、图文页数、时长和可见标题，用来决定：图文返回原图；文章提正文；短视频抽帧；长知识视频转写。不会自动执行后续动作。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const probe = await browser.probeMedia();
        const knowledgeHint = /教程|知识|解析|攻略|报告|科普|论文|skill|工具|怎么|为什么|复盘|测评|开发|建模|记忆|总结|课程|讲解/i.test(`${probe.title} ${probe.visibleText.slice(0, 1000)}`);
        const recommendation = /\/article\//.test(probe.url)
          ? "article"
          : probe.galleryAvailable
            ? "gallery"
          : probe.chaptersAvailable
            ? "chapters"
            : probe.durationSeconds != null && (probe.durationSeconds >= 75 || knowledgeHint)
              ? "transcript"
              : "timeline";
        const recommendationLabel = {
          article: "文章正文",
          gallery: `原生图文/相册（${probe.galleryImageCount} 页）`,
          chapters: "抖音原生章节",
          transcript: "本地字幕（知识/长视频）",
          timeline: "完整时间轴抽帧（短视频/视觉内容）",
        }[recommendation];
        return {
          content: [{
            type: "text" as const,
            text: [
              `当前网址：${probe.url}`,
              `标题：${probe.title}`,
              `作品 ID：${probe.workId}`,
              `视频时长：${probe.durationSeconds == null ? "未检测到" : formatSeconds(probe.durationSeconds)}`,
              `原生图文：${probe.galleryAvailable ? `可用（${probe.galleryImageCount} 页）` : "不可用"}`,
              `原生章节：${probe.chaptersAvailable ? `可用（${probe.chapterCount} 章）` : "不可用"}`,
              `建议模式：${recommendationLabel}`,
              "图文优先 douyin_read_current_gallery；原生章节足够时优先 douyin_read_chapters；需要完整语音内容时使用本地 faster-whisper。",
            ].join("\n"),
          }],
          structuredContent: {
            url: probe.url,
            title: probe.title,
            workId: probe.workId,
            durationSeconds: probe.durationSeconds,
            currentTimeSeconds: probe.currentTimeSeconds,
            paused: probe.paused,
            mediaCandidateCount: probe.mediaCandidates.length,
            visibleText: probe.visibleText,
            textSource: probe.textSource,
            characterCount: probe.characterCount,
            truncated: probe.truncated,
            chaptersAvailable: probe.chaptersAvailable,
            chapterCount: probe.chapterCount,
            galleryAvailable: probe.galleryAvailable,
            galleryImageCount: probe.galleryImageCount,
            knowledgeHint,
            recommendation,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_current_gallery",
    {
      title: "完整读取当前图文或相册",
      description: "从当前锁定作品的抖音原生元数据中读取图文/相册，按原顺序去重并返回每张原图，同时返回作者、文案、话题、发布时间、音乐和互动数。图片会直接交给模型阅读；不会下载到用户目录或修改账号数据。",
      inputSchema: z.object({
        max_images: z.number().int().min(1).max(20).default(10),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ max_images }) => {
      try {
        const result = await browser.readCurrentGallery(max_images);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `作品 ID：${result.workId}`,
                `作者：${result.author || "未识别"}`,
                `发布时间：${result.publishedAt ?? "未识别"}`,
                `文案：${result.description || "无"}`,
                `话题：${result.hashtags.length ? result.hashtags.map(tag => `#${tag}`).join(" ") : "无"}`,
                `音乐：${result.musicTitle ?? "未识别"}`,
                `互动：赞 ${result.stats.diggCount} / 评论 ${result.stats.commentCount} / 收藏 ${result.stats.collectCount} / 分享 ${result.stats.shareCount}`,
                `图文：共 ${result.totalImageCount} 页，返回 ${result.returnedImageCount} 页${result.truncated ? "（有截断或读取失败）" : ""}`,
                "以下图片已按原顺序返回，请直接阅读图片中的文字与画面。",
              ].join("\n"),
            },
            ...result.images.map(image => ({
              type: "image" as const,
              data: image.imageBase64,
              mimeType: image.mimeType,
            })),
          ],
          structuredContent: {
            url: result.url,
            title: result.title,
            workId: result.workId,
            author: result.author,
            description: result.description,
            hashtags: result.hashtags,
            publishedAt: result.publishedAt,
            musicTitle: result.musicTitle,
            stats: result.stats,
            totalImageCount: result.totalImageCount,
            returnedImageCount: result.returnedImageCount,
            truncated: result.truncated,
            source: result.source,
            privacyFiltered: result.privacyFiltered,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_resolve_video",
    {
      title: "稳定解析抖音视频",
      description: "不切换浏览器标签页，直接从抖音公开分享页解析作品 ID、标题、作者、时长、封面和可下载视频地址。用于页面媒体地址缺失或过期时的只读兜底。",
      inputSchema: z.object({
        url: z.string().url().describe("抖音作品链接或 v.douyin.com 分享链接"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ url }) => {
      try {
        const result = await resolvePublicDouyinVideo(url);
        return {
          content: [{
            type: "text" as const,
            text: [
              `作品 ID：${result.workId}`,
              `标题：${result.title || "未识别"}`,
              `作者：${result.author ?? "未识别"}`,
              `时长：${result.durationSeconds == null ? "未识别" : formatSeconds(result.durationSeconds)}`,
              `解析来源：${result.source}`,
              `可用视频地址：${result.videoCandidates.length} 个`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_understand_current",
    {
      title: "统一理解当前作品",
      description: "自动判断当前作品类型。browse 使用轻量时间轴；deep 按原生图文/文章、原生章节、本地 faster-whisper、时间轴抽帧的顺序理解内容，不访问第三方转录服务。",
      inputSchema: z.object({
        depth: z.enum(["browse", "deep"]).default("browse").describe("browse=低延迟浏览；deep=完整理解并允许转录"),
        include_comments: z.boolean().default(false),
        comment_limit: z.number().int().min(1).max(50).default(10),
        transcript_model: z.enum(["tiny", "base", "small", "medium", "turbo"]).default("small"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ depth, include_comments, comment_limit, transcript_model }) => {
      try {
        return await browser.runExclusive(async () => {
          const probe = await browser.probeMedia();
          let contentType = "video";
          let author: string | null = null;
          let description = probe.visibleText;
          let coreContent = probe.visibleText;
          let complete = false;
          const keyMoments: Array<{ timestamp: string; seconds: number; label: string }> = [];
          const images: Array<{ data: string; mimeType: "image/jpeg" | "image/png" | "image/webp" }> = [];
          let method = "timeline";
          let transcriptSource: string | null = null;
          let transcriptSegmentCount = 0;
          let transcriptCharacterCount = 0;
          let transcriptReused = false;
          let visualFramesUsed = 0;
          let fallbackReason: string | null = null;

          if (probe.galleryAvailable) {
            const gallery = await browser.readCurrentGallery(Math.max(1, probe.galleryImageCount));
            contentType = "gallery";
            author = gallery.author;
            description = gallery.description;
            coreContent = [
              gallery.description,
              gallery.hashtags.map(tag => `#${tag}`).join(" "),
              gallery.musicTitle ? `音乐：${gallery.musicTitle}` : "",
            ].filter(Boolean).join("\n");
            images.push(...gallery.images.map(image => ({ data: image.imageBase64, mimeType: image.mimeType })));
            complete = !gallery.truncated && gallery.returnedImageCount === gallery.totalImageCount;
            method = "native-gallery";
          } else if (/\/(?:article|note)\//.test(probe.url)) {
            try {
              const article = await browser.extractArticleText();
              contentType = "article";
              author = article.author;
              description = article.title;
              coreContent = article.text;
              complete = true;
              method = "article-extraction";
            } catch (firstError) {
              if (/\/article\//.test(probe.url)) {
                await new Promise(resolve => setTimeout(resolve, 1_000));
                const article = await browser.extractArticleText().catch(() => {
                  throw firstError;
                });
                contentType = "article";
                author = article.author;
                description = article.title;
                coreContent = article.text;
                complete = true;
                method = "article-extraction";
              } else {
                contentType = "video";
              }
            }
          }

          if (contentType === "video") {
            const duration = probe.durationSeconds ?? 0;
            const speechHint = `${probe.title}\n${probe.visibleText}`;
            const likelySpeechLed = duration >= 20
              && !probe.chaptersAvailable
              && (
                duration >= 180
                || /ChatGPT|AI\s*对话|AI语音|语音|聊天|访谈|采访|讲解|教程|播客|对话|直播通话/i.test(speechHint)
                || probe.characterCount < 120
              );
            if (probe.chaptersAvailable && duration >= 120) {
              const chapters = await browser.readChapters();
              contentType = "knowledge_video";
              coreContent = [chapters.summary, ...chapters.chapters.map(chapter =>
                `${chapter.timestamp} ${chapter.title}：${chapter.summary}`)].filter(Boolean).join("\n");
              keyMoments.push(...chapters.chapters.map(chapter => ({
                timestamp: chapter.timestamp,
                seconds: chapter.seconds,
                label: chapter.title,
              })));
              complete = true;
              method = "native-chapters";
            } else if (depth === "browse") {
              const timeline = await browser.inspectTimeline({ mode: "fast" });
              images.push(...timeline.frames.map(frame => ({ data: frame.imageBase64, mimeType: "image/jpeg" as const })));
              visualFramesUsed = timeline.frames.length;
              keyMoments.push(...timeline.frames.map(frame => ({
                timestamp: frame.timestamp,
                seconds: frame.timeSeconds,
                label: `快速关键帧 ${frame.timestamp}`,
              })));
              coreContent = timeline.visibleText;
              complete = false;
              method = "timeline-fast";
              if (likelySpeechLed) {
                fallbackReason = "browse 模式为避免卡顿未自动启动本地 faster-whisper；需要完整语音内容时用 depth=deep。";
              }
            } else if (likelySpeechLed) {
              const local = await browser.transcribeCurrent(transcript_model).catch(error => {
                fallbackReason = `本地 faster-whisper 未就绪或转录失败：${error instanceof Error ? error.message : String(error)}`;
                return null;
              });
              if (local && local.segments.length >= 1 && local.text.length >= 1) {
                contentType = duration >= 120 ? "knowledge_video" : "video";
                description = local.title || description;
                coreContent = local.text;
                transcriptSource = `local-faster-whisper-${local.model}`;
                transcriptSegmentCount = local.segments.length;
                transcriptCharacterCount = local.text.length;
                transcriptReused = Boolean(local.cacheHit);
                keyMoments.push(...local.segments.slice(0, 40).map(segment => ({
                  timestamp: formatSeconds(segment.start),
                  seconds: segment.start,
                  label: segment.text.slice(0, 120),
                })));
                complete = true;
                method = "local-faster-whisper";
              } else {
                const timeline = await browser.inspectTimeline({ mode: "full" });
                images.push(...timeline.frames.map(frame => ({ data: frame.imageBase64, mimeType: "image/jpeg" as const })));
                visualFramesUsed = timeline.frames.length;
                coreContent = timeline.visibleText;
                keyMoments.push(...timeline.frames.map(frame => ({
                  timestamp: frame.timestamp,
                  seconds: frame.timeSeconds,
                  label: `时间轴关键帧 ${frame.timestamp}`,
                })));
                complete = false;
                method = "timeline-sampling";
              }
            } else if (duration > 0 && duration <= 15) {
              const frames = await browser.videoFrames(4, 900);
              images.push(...frames.frames.map(data => ({ data, mimeType: "image/jpeg" as const })));
              visualFramesUsed = frames.frames.length;
              coreContent = frames.visibleText;
              complete = true;
              method = "continuous-keyframes";
            } else {
              const timeline = await browser.inspectTimeline({ mode: "full" });
              images.push(...timeline.frames.map(frame => ({ data: frame.imageBase64, mimeType: "image/jpeg" as const })));
              visualFramesUsed = timeline.frames.length;
              keyMoments.push(...timeline.frames.map(frame => ({
                timestamp: frame.timestamp,
                seconds: frame.timeSeconds,
                label: `时间轴关键帧 ${frame.timestamp}`,
              })));
              coreContent = timeline.visibleText;
              complete = timeline.frames.length >= 5;
              method = "timeline-sampling";
            }
          }

          let comments: Awaited<ReturnType<typeof browser.readComments>>["comments"] = [];
          if (include_comments) {
            comments = await browser.readComments("hot", comment_limit, false, 0)
              .then(result => result.comments)
              .catch(() => []);
          }
          const structuredContent = {
            depth,
            contentType,
            author,
            description,
            coreContent,
            keyMoments,
            commentHighlights: comments.map(comment => ({
              commentId: comment.commentId,
              author: comment.author,
              text: comment.text,
              likeCount: comment.likeCount,
            })),
            workUrl: probe.url,
            workId: probe.workId,
            fullyRead: complete,
            method,
            returnedImageCount: images.length,
            transcriptSource,
            transcriptSegmentCount,
            transcriptCharacterCount,
            transcriptReused,
            visualFramesUsed,
            fallbackReason,
            privacyFiltered: true,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `内容类型：${contentType}`,
                  `理解深度：${depth}`,
                  `作品：${probe.workId}`,
                  `作者：${author ?? "页面未单独识别"}`,
                  `读取方法：${method}`,
                  `是否完整读取：${complete ? "是" : "否，返回代表性采样"}`,
                  transcriptSource ? `语音转录：${transcriptSource}，${transcriptSegmentCount} 段，${transcriptCharacterCount} 字符，复用=${transcriptReused}` : "",
                  fallbackReason ? `回退原因：${fallbackReason}` : "",
                  `核心内容：${coreContent || "没有可提取文字，请结合后续图片理解"}`,
                  keyMoments.length ? `关键时间点：${keyMoments.map(moment => `${moment.timestamp} ${moment.label}`).join("；")}` : "",
                  comments.length ? `评论亮点：${comments.map(comment => `${comment.author}：${comment.text}`).join("；")}` : "",
                ].filter(Boolean).join("\n"),
              },
              ...images.map(image => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ],
            structuredContent,
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_chapters",
    {
      title: "读取抖音原生章节",
      description: "只从当前活跃作品区域读取抖音原生章节要点、时间戳、章节标题和简述。不会读取评论、推荐区或整个页面。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.readChapters();
        return {
          content: [{
            type: "text" as const,
            text: [
              `作品 ID：${result.workId}`,
              `章节摘要：${result.summary || "无独立摘要"}`,
              `章节数：${result.chapterCount}`,
              ...result.chapters.map(chapter =>
                `${chapter.timestamp} | ${chapter.title}${chapter.summary ? ` | ${chapter.summary}` : ""}`),
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_transcribe_current",
    {
      title: "本地转写当前知识视频",
      description: "把当前正在播放的抖音视频下载到临时目录，并用本机 faster-whisper 生成带时间戳字幕。适合长教程、知识讲解和仅靠抽帧看不懂的内容；不调用付费字幕 API。首次使用前需双击 INSTALL_TRANSCRIPT.cmd。",
      inputSchema: z.object({
        model: z.enum(["tiny", "base", "small", "medium", "large-v3", "turbo"]).default("small").describe("默认 small，提高中文和技术术语准确率；可按机器性能显式覆盖"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ model }) => {
      try {
        return transcriptSummary(await browser.transcribeCurrent(model));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_transcribe_link_local",
    {
      title: "按抖音链接本地转写",
      description: "解析公开抖音作品链接，下载临时媒体并仅调用本机 faster-whisper。媒体无论成功或失败都会清理；同一 work_id 和模型命中缓存时直接复用。",
      inputSchema: z.object({
        url: z.string().url(),
        model: z.enum(["tiny", "base", "small", "medium", "large-v3", "turbo"]).default("small"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ url, model }) => {
      try {
        return transcriptSummary(await transcribePublicLinkLocal(url, model));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_transcript",
    {
      title: "分段读取本地字幕",
      description: "读取已经生成的字幕片段，避免一次把长视频全文塞进上下文。",
      inputSchema: z.object({
        transcript_id: z.string().min(1),
        start_segment: z.number().int().min(0).default(0),
        segment_count: z.number().int().min(1).max(60).default(25),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ transcript_id, start_segment, segment_count }) => {
      try {
        const record = await loadTranscript(transcript_id);
        const selected = record.segments.slice(start_segment, start_segment + segment_count);
        return {
          content: [{
            type: "text" as const,
            text: [
              `字幕 ID：${record.transcriptId}`,
              `作品：${record.title || record.workId}`,
              `片段范围：${start_segment}–${Math.max(start_segment, start_segment + selected.length - 1)} / ${record.segments.length - 1}`,
              selected.map(segment => `[${formatSeconds(segment.start)}–${formatSeconds(segment.end)}] ${segment.text}`).join("\n") || "该范围没有字幕片段。",
            ].join("\n"),
          }],
          structuredContent: {
            transcriptId: record.transcriptId,
            title: record.title,
            totalSegments: record.segments.length,
            startSegment: start_segment,
            segments: selected,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_search_transcript",
    {
      title: "搜索本地字幕",
      description: "在已转写的长视频中按关键词查找相关时间点，适合定位某个概念、工具名或结论。",
      inputSchema: z.object({
        transcript_id: z.string().min(1),
        query: z.string().min(1).max(100),
        max_results: z.number().int().min(1).max(30).default(12),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ transcript_id, query, max_results }) => {
      try {
        const record = await loadTranscript(transcript_id);
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = record.segments
          .map(segment => ({
            segment,
            score: terms.reduce((sum, term) => sum + (segment.text.toLowerCase().includes(term) ? 1 : 0), 0),
          }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score || a.segment.start - b.segment.start)
          .slice(0, max_results)
          .map(item => item.segment);
        return {
          content: [{
            type: "text" as const,
            text: [
              `搜索：${query}`,
              `作品：${record.title || record.workId}`,
              hits.map(segment => `[${formatSeconds(segment.start)}] ${segment.text}`).join("\n") || "没有找到包含这些关键词的字幕。",
            ].join("\n"),
          }],
          structuredContent: { transcriptId: record.transcriptId, query, hits },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_transcripts",
    {
      title: "列出本地 faster-whisper 转录缓存",
      description: "只列出本机 faster-whisper 已经生成的转录缓存；同一作品和模型再次本地转写会复用缓存。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const items = await listTranscripts();
        return {
          content: [{
            type: "text" as const,
            text: items.length
              ? items.map(item => `${item.transcriptId} | ${item.title || item.workId} | ${item.durationSeconds == null ? "未知时长" : formatSeconds(item.durationSeconds)}`).join("\n")
              : "还没有本地字幕缓存。",
          }],
          structuredContent: { items },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "browser_list_allowed_tabs",
    {
      title: "列出允许域名标签页",
      description: "只列出 douyin.com、www.douyin.com 和 creator.douyin.com 标签页；不会暴露其他私人网站。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const tabs = await browser.listAllowedTabs();
        return {
          content: [{
            type: "text" as const,
            text: tabs.length
              ? tabs.map(tab => `${tab.pageId} | target=${tab.targetId} | role=${tab.role ?? "unbound"} | ${tab.host} | ${tab.title} | ${tab.url}`).join("\n")
              : "没有找到允许域名标签页。",
          }],
          structuredContent: { tabs, count: tabs.length },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_bind_page",
    {
      title: "绑定稳定用途标签页",
      description: "把已存在的 page_id 绑定为固定用途，并持久化浏览器 target_id。不会新建或导航标签页；正式发布页和 Operator 主页会校验登录账号。",
      inputSchema: z.object({
        page_id: z.string().min(1),
        role: z.enum([
          "operator_home",
          "bound_messages",
          "codex_test",
          "publisher",
          "creator_center",
        ]),
        confirm_binding: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ page_id, role, confirm_binding }) => {
      try {
        const result = await browser.bindAllowedTab(page_id, role, confirm_binding);
        return {
          content: [{
            type: "text" as const,
            text: `已绑定 ${result.role}：${result.pageId}\ntarget_id：${result.targetId}\n${result.url}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "browser_switch_allowed_tab",
    {
      title: "切换到允许域名标签页",
      description: "只能切换到 browser_list_allowed_tabs 返回的抖音或创作者中心标签页，其他域名一律拒绝。",
      inputSchema: z.object({
        page_id: z.string().min(1),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_id }) => {
      try {
        const tab = await browser.switchAllowedTab(page_id);
        return {
          content: [{ type: "text" as const, text: `已切换：${tab.title}\n${tab.url}` }],
          structuredContent: tab,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_status",
    {
      title: "检查抖音受控桥",
      description: "检查专用 Chrome/Edge 是否已启动并连接。不会操作页面。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const status = await browser.health();
      return {
        content: [{
          type: "text" as const,
          text: `${status.message}\n安全规则：${describeSafety()}${status.url ? `\n当前网址：${status.url}` : ""}`,
        }],
        structuredContent: status,
      };
    },
  );

  registerTool(
    "douyin_observe",
    {
      title: "查看当前允许页面",
      description: "纯读取返回已存在页面的截图、URL、页面类型、DOM 状态和可点击元素编号。不会导航、刷新、切换、填充、保存或提交；可用 page_id 明确观察某一页。",
      inputSchema: z.object({
        page_id: z.string().min(1).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_id }, extra) => {
      try {
        return observationResult(await browser.observe(
          undefined,
          page_id,
          observationOwner(extra),
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_observe_fast",
    {
      title: "轻量查看当前允许页面",
      description: "纯读取返回 URL、页面类型和最多 36 个可点击元素，不截图、不传图片。连续刷视频或只需判断页面状态时优先使用；需要视觉细节时再用 douyin_observe。",
      inputSchema: z.object({
        page_id: z.string().min(1).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_id }, extra) => {
      try {
        const result = await browser.observeFast(page_id, observationOwner(extra));
        return {
          content: [{
            type: "text" as const,
            text: [
              `页面类型：${result.pageKind}`,
              `标题：${result.title}`,
              `网址：${result.url}`,
              `元素数：${result.elements.length}`,
              `耗时：${result.elapsedMs} ms`,
              result.elements.map(element => `${element.id} | ${element.kind} | ${element.label}`).join("\n"),
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_probe_visual_point",
    {
      title: "探测页面中的一个位置",
      description: "基于同一 MCP 会话最近一次冻结观察，在标准化坐标处只读分析元素堆叠、实际可点击祖先、附近文字和风险；能截到时附局部放大图，截图超时不会阻断探测。不会点击。",
      inputSchema: z.object({
        observation_id: z.string().uuid(),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
        x_ratio: z.number().min(0).max(1).describe("从左到右的相对坐标，0–1"),
        y_ratio: z.number().min(0).max(1).describe("从上到下的相对坐标，0–1"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ observation_id, snapshot_hash, x_ratio, y_ratio }, extra) => {
      try {
        const result = await browser.probeVisualPoint({
          ownerId: observationOwner(extra),
          observationId: observation_id,
          snapshotHash: snapshot_hash,
          xRatio: x_ratio,
          yRatio: y_ratio,
        });
        const { cropBase64: _crop, ...structuredContent } = result;
        const target = result.inspection.target;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `页面：${result.url}`,
                `探测点：(${result.inspection.point.x.toFixed(1)}, ${result.inspection.point.y.toFixed(1)})`,
                target
                  ? `目标：${target.kind} | ${target.label || "无文字"} | role=${target.role || "-"} | box=(${Math.round(target.box.x)},${Math.round(target.box.y)},${Math.round(target.box.width)},${Math.round(target.box.height)})`
                  : "该位置没有检测到可交互目标。",
                result.decision
                  ? `风险：${result.decision.risk} | ${result.decision.reason}`
                  : "风险：无目标",
                result.inspection.stack.length
                  ? `元素堆叠：${result.inspection.stack.map(item => `${item.tag}/${item.role || "-"}/${item.label || "-"}`).join(" <- ")}`
                  : "元素堆叠：无",
                result.cropBase64
                  ? `局部截图：${result.cropSource}`
                  : "局部截图：不可用，已保留 DOM 探测结果。",
              ].join("\n"),
            },
            ...(result.cropBase64
              ? [{
                  type: "image" as const,
                  data: result.cropBase64,
                  mimeType: result.cropMimeType,
                }]
              : []),
          ],
          structuredContent: {
            ...structuredContent,
            cropAvailable: Boolean(result.cropBase64),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_click_visual_interface",
    {
      title: "确认后视觉点击允许页面控件",
      description: "高自由度兜底写工具。基于冻结观察快照点击一次可逆界面控件；interface 可用于已绑定抖音页面中的菜单、标签、返回、展开和发布类型入口。音乐、预览与发布仍只允许在 page-publisher，发布还要求 preview_id 与 confirm_publish=true。支付、删除、账号安全、评论、私信等不会绕过专用门禁。",
      inputSchema: z.object({
        observation_id: z.string().uuid(),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
        element_id: z.string().regex(/^e\d+$/).optional(),
        x_ratio: z.number().min(0).max(1).optional(),
        y_ratio: z.number().min(0).max(1).optional(),
        offset_x: z.number().min(0).max(1).default(0.5).describe("element_id 模式内的横向落点"),
        offset_y: z.number().min(0).max(1).default(0.5).describe("element_id 模式内的纵向落点"),
        intent: z.string().min(1).max(200).describe("本次点击要完成的具体界面目的"),
        write_action: z.enum(["interface", "close_popup", "select_music", "preview", "publish"]),
        preview_id: z.string().uuid().optional(),
        confirm_interface_write: z.literal(true),
        confirm_publish: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({
      observation_id,
      snapshot_hash,
      element_id,
      x_ratio,
      y_ratio,
      offset_x,
      offset_y,
      intent,
      write_action,
      preview_id,
      confirm_publish,
      include_screenshot_base64,
    }, extra) => {
      try {
        if (write_action === "publish" && confirm_publish !== true) {
          throw new Error("FINAL_CONFIRMATION_REQUIRED:视觉点击发布必须提供 confirm_publish=true。");
        }
        const result = await browser.clickVisualInterface({
          ownerId: observationOwner(extra),
          observationId: observation_id,
          snapshotHash: snapshot_hash,
          elementId: element_id,
          xRatio: x_ratio,
          yRatio: y_ratio,
          offsetX: offset_x,
          offsetY: offset_y,
          intent,
          writeAction: write_action,
          previewId: preview_id,
        });
        const rendered = {
          content: [{
            type: "text" as const,
            text: [
              result.observation.note,
              `页面类型：${result.observation.pageKind}`,
              `标题：${result.observation.title}`,
              `网址：${result.observation.url}`,
              `观察快照：${result.observation.observationId ?? "未生成"}`,
              `快照哈希：${result.observation.snapshotHash ?? "未生成"}`,
              `元素数：${result.observation.elements.length}`,
              include_screenshot_base64
                ? "本次为轻量动作回读；创作者中心截图不会阻断结果。"
                : "本次使用轻量动作回读，未生成截图。",
              result.observation.elements
                .map(element => `${element.id} | ${element.kind} | ${element.label || "未命名"}`)
                .join("\n"),
            ].filter(Boolean).join("\n"),
          }],
          structuredContent: result.observation,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `已点击：${result.target.label || "无文字控件"}`,
                `落点：(${result.clickedPoint.x.toFixed(1)}, ${result.clickedPoint.y.toFixed(1)})`,
                `风险判断：${result.decision.risk}`,
                `效果：${result.effect.effect}；${result.effect.reason}`,
                `URL 变化：${result.urlChanged}；DOM 变化：${result.domChanged}`,
                `账号写请求：${result.mutatingRequestCount}；账号写响应：${result.mutatingResponseCount}`,
                `后台配置/埋点请求：${result.backgroundRequestCount}；响应：${result.backgroundResponseCount}`,
                `动作回读：${JSON.stringify(result.actionReadback)}`,
              ].join("\n"),
            },
            ...rendered.content,
          ],
          structuredContent: {
            ...rendered.structuredContent,
            clickedPoint: result.clickedPoint,
            target: result.target,
            decision: result.decision,
            effect: result.effect,
            mutatingRequestCount: result.mutatingRequestCount,
            mutatingResponseCount: result.mutatingResponseCount,
            backgroundRequestCount: result.backgroundRequestCount,
            backgroundResponseCount: result.backgroundResponseCount,
            urlChanged: result.urlChanged,
            domChanged: result.domChanged,
            actionReadback: result.actionReadback,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_section",
    {
      title: "打开抖音只读区域",
      description: "在专用浏览器中打开首页、个人主页、喜欢列表或收藏列表；只改变当前浏览位置，不修改账号数据。",
      inputSchema: z.object({
        section: z.enum(["home", "profile", "likes", "favorites"]).describe("要打开的区域"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ section }) => {
      try {
        return observationResult(await browser.openSection(section));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_scroll",
    {
      title: "智能滚动当前页面",
      description: "自动寻找当前抖音列表、评论区或页面内列表并滚动；默认使用无截图轻量结果，适合连续刷。只有确实需要看图和完整元素列表时才把 response_mode 设为 full。",
      inputSchema: z.object({
        direction: z.enum(["down", "up"]),
        amount: z.number().int().min(200).max(1600).default(800).describe("滚动像素，推荐 700–1000"),
        response_mode: z.enum(["fast", "full"]).default("fast").describe("fast 不截图且快速返回；full 等待页面稳定后返回完整截图"),
        wait_after_ms: z.number().int().min(0).max(1000).default(80).describe("fast 模式滚动后的短等待时间"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ direction, amount, response_mode, wait_after_ms }) => {
      try {
        const result = await browser.scroll(direction, amount, {
          observeAfter: response_mode === "full",
          waitAfterMs: wait_after_ms,
        });
        return "screenshotBase64" in result
          ? observationResult(result)
          : lightweightScrollResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_scroll_region",
    {
      title: "滚动指定内部区域",
      description: "围绕一个已编号元素，滚动它最近的可滚动祖先。适合评论区、侧栏和网页内嵌列表；比普通滚动更精确。",
      inputSchema: z.object({
        observation_id: z.string().uuid(),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
        element_id: z.string().regex(/^e\d+$/).describe("选一个位于目标滚动框内部的元素，例如某条字幕旁的按钮"),
        direction: z.enum(["down", "up"]),
        amount: z.number().int().min(120).max(2400).default(700).describe("内部滚动像素"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ observation_id, snapshot_hash, element_id, direction, amount }, extra) => {
      try {
        return observationResult(await browser.scrollRegion({
          ownerId: observationOwner(extra),
          observationId: observation_id,
          snapshotHash: snapshot_hash,
          elementId: element_id,
          direction,
          amount,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_region",
    {
      title: "读取完整文字区域",
      description: "读取指定已绑定页面中的完整文字区域。必须通过 page_id，或 observation_id + snapshot_hash 锁定页面；不会自动回退到精选页。element_id 只能与冻结观察快照一起使用。",
      inputSchema: z.object({
        page_id: z.string().min(1).optional().describe("目标已绑定页面，例如 page-publisher"),
        observation_id: z.string().uuid().optional(),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        element_id: z.string().regex(/^e\d+$/).optional().describe("可选：位于目标文字区域内部的元素编号"),
        max_chars: z.number().int().min(500).max(120000).default(50000).describe("最多返回字符数"),
      }).superRefine((value, ctx) => {
        const hasObservation = Boolean(value.observation_id || value.snapshot_hash);
        if (!value.page_id && !hasObservation) {
          ctx.addIssue({ code: "custom", message: "必须提供 page_id，或 observation_id + snapshot_hash。" });
        }
        if (value.page_id && hasObservation) {
          ctx.addIssue({ code: "custom", message: "page_id 与 observation 快照只能选择一种。" });
        }
        if (hasObservation && (!value.observation_id || !value.snapshot_hash)) {
          ctx.addIssue({ code: "custom", message: "observation_id 与 snapshot_hash 必须同时提供。" });
        }
        if (value.element_id && !hasObservation) {
          ctx.addIssue({ code: "custom", message: "element_id 必须与 observation_id + snapshot_hash 一起提供。" });
        }
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_id, observation_id, snapshot_hash, element_id, max_chars }, extra) => {
      try {
        const result = await browser.readRegion({
          ownerId: observationOwner(extra),
          pageId: page_id,
          observationId: observation_id,
          snapshotHash: snapshot_hash,
          elementId: element_id,
          maxChars: max_chars,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `页面：${result.title}`,
              `网址：${result.url}`,
              `来源：${result.source}${result.elementId ? `（锚点 ${result.elementId}）` : ""}`,
              `文字字符数：${result.characterCount}`,
              `滚动位置：${result.scrollTop} / ${Math.max(0, result.scrollHeight - result.clientHeight)}`,
              "区域文字：",
              result.text,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_click",
    {
      title: "点击安全元素",
      description: "点击最近一次 douyin_observe/动作结果中的 element_id。工具会再次检查目标，拒绝点赞、收藏、关注、评论、私信、购物等写操作。",
      inputSchema: z.object({
        observation_id: z.string().uuid(),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
        element_id: z.string().regex(/^e\d+$/).describe("例如 e12；必须来自最新截图的元素列表"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ observation_id, snapshot_hash, element_id }, extra) => {
      try {
        return observationResult(await browser.clickElement({
          ownerId: observationOwner(extra),
          observationId: observation_id,
          snapshotHash: snapshot_hash,
          elementId: element_id,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_toggle_play",
    {
      title: "播放或暂停当前视频",
      description: "播放或暂停当前页面中面积最大的可见视频，并返回新截图。只影响本地播放状态。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        return observationResult(await browser.togglePlay());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_inspect_video",
    {
      title: "连续查看当前视频",
      description: "从当前可见视频中按时间间隔截取多帧，供模型理解动态内容；同时返回页面截图和可见文字。打开一条作品后使用。",
      inputSchema: z.object({
        frame_count: z.number().int().min(2).max(6).default(4),
        interval_ms: z.number().int().min(600).max(2500).default(1200),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ frame_count, interval_ms }) => {
      try {
        const result = await browser.videoFrames(frame_count, interval_ms);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `已查看当前视频 ${result.frames.length} 帧。`,
                `页面：${result.observation.title}`,
                `网址：${result.observation.url}`,
                `作品 ID：${result.workId}`,
                `文字来源：${result.textSource}`,
                `文字字符数：${result.characterCount}`,
                `文字已截断：${result.truncated}`,
                `当前作品文字：${result.visibleText || "无"}`,
                "以下图片按时间先后排列；看完可自行决定打开评论、返回或继续浏览。",
              ].join("\n"),
            },
            ...result.frames.map(frame => ({
              type: "image" as const,
              data: frame,
              mimeType: "image/jpeg" as const,
            })),
            {
              type: "image" as const,
              data: result.observation.screenshotBase64,
              mimeType: "image/jpeg" as const,
            },
          ],
          structuredContent: {
            url: result.observation.url,
            title: result.observation.title,
            workId: result.workId,
            frameCount: result.frames.length,
            visibleText: result.visibleText,
            textSource: result.textSource,
            characterCount: result.characterCount,
            truncated: result.truncated,
            elements: result.observation.elements,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_inspect_timeline",
    {
      title: "完整时间轴抽帧",
      description: "默认 fast 只截当前 1 帧且不跳时间轴，适合连续刷；balanced 取前/中/后 3 帧；full 才取完整 7 帧。需要跳时间轴的模式会恢复原播放位置、播放状态和静音状态。",
      inputSchema: z.object({
        mode: z.enum(["fast", "balanced", "full"]).default("fast").describe("fast=当前 1 帧；balanced=3 帧；full=7 帧"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ mode }) => {
      try {
        const result = await browser.inspectTimeline({ mode });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `作品 ID：${result.workId}`,
                `视频时长：${formatSeconds(result.duration)}`,
                `抽帧模式：${mode}（${result.frames.length} 帧）`,
                `采样时间：${result.frames.map(frame => frame.timestamp).join(", ")}`,
                `恢复状态：time=${result.restoredState.currentTime}, paused=${result.restoredState.paused}, muted=${result.restoredState.muted}`,
                `文字来源：${result.textSource}`,
                `当前作品文字：${result.visibleText || "无"}`,
              ].join("\n"),
            },
            ...result.frames.map(frame => ({
              type: "image" as const,
              data: frame.imageBase64,
              mimeType: "image/jpeg" as const,
            })),
          ],
          structuredContent: {
            url: result.url,
            title: result.title,
            workId: result.workId,
            duration: result.duration,
            sampledTimes: result.sampledTimes,
            restoredState: result.restoredState,
            visibleText: result.visibleText,
            textSource: result.textSource,
            characterCount: result.characterCount,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_back",
    {
      title: "关闭浮层或返回",
      description: "关闭当前评论/作品浮层，或者返回浏览器上一页，并返回新截图。优先用 escape 关闭浮层；确定是独立页面时用 history。",
      inputSchema: z.object({
        mode: z.enum(["escape", "history"]).default("escape"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ mode }) => {
      try {
        return observationResult(await browser.back(mode === "escape"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_wait",
    {
      title: "在指定页面等待并回读",
      description: "等待短暂时间后只回读同一个已绑定页面。必须通过 page_id，或 observation_id + snapshot_hash 锁定页面；默认 fast 不截图，避免创作者中心截图阻塞。",
      inputSchema: z.object({
        seconds: z.number().min(0.5).max(8).default(2),
        page_id: z.string().min(1).optional().describe("目标已绑定页面，例如 page-publisher"),
        observation_id: z.string().uuid().optional(),
        snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        response_mode: z.enum(["fast", "full"]).default("fast"),
      }).superRefine((value, ctx) => {
        const hasObservation = Boolean(value.observation_id || value.snapshot_hash);
        if (!value.page_id && !hasObservation) {
          ctx.addIssue({ code: "custom", message: "必须提供 page_id，或 observation_id + snapshot_hash。" });
        }
        if (value.page_id && hasObservation) {
          ctx.addIssue({ code: "custom", message: "page_id 与 observation 快照只能选择一种。" });
        }
        if (hasObservation && (!value.observation_id || !value.snapshot_hash)) {
          ctx.addIssue({ code: "custom", message: "observation_id 与 snapshot_hash 必须同时提供。" });
        }
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ seconds, page_id, observation_id, snapshot_hash, response_mode }, extra) => {
      try {
        const result = await browser.wait({
          seconds,
          ownerId: observationOwner(extra),
          pageId: page_id,
          observationId: observation_id,
          snapshotHash: snapshot_hash,
          responseMode: response_mode,
        });
        if ("screenshotBase64" in result) return observationResult(result);
        return {
          content: [{
            type: "text" as const,
            text: [
              result.note,
              `页面类型：${result.pageKind}`,
              `标题：${result.title}`,
              `网址：${result.url}`,
              `元素数：${result.elements.length}`,
              `耗时：${result.elapsedMs} ms`,
              result.elements.map(element => `${element.id} | ${element.kind} | ${element.label}`).join("\n"),
            ].filter(Boolean).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_like_post",
    {
      title: "按 work_id 点赞或取消点赞作品",
      description: "显式解析并锁定 own_post、bound_user_post 或 external_post 目标；最多点击一次。只有匹配 work_id 的成功服务端响应或重新加载后的持久状态才能返回 success=true，DOM 乐观变色不会被当成成功。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        action: z.enum(["like", "unlike"]),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]).default("external_post"),
        alias: z.string().min(1).max(50).optional(),
        dry_run: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, action, scope, alias, dry_run }) => {
      try {
        const result = await browser.likePost({ workId: work_id, action, scope, alias, dryRun: dry_run });
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_favorite_post",
    {
      title: "按 work_id 收藏或取消收藏作品",
      description: "显式解析并锁定作品目标，不依赖浏览器焦点；最多点击一次，且仅接受服务端确认或重新加载后的持久状态。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        action: z.enum(["favorite", "unfavorite"]),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]).default("external_post"),
        alias: z.string().min(1).max(50).optional(),
        dry_run: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, action, scope, alias, dry_run }) => {
      try {
        const result = await browser.favoritePost({ workId: work_id, action, scope, alias, dryRun: dry_run });
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_follow_post_author",
    {
      title: "按 work_id 关注或取消关注作品作者",
      description: "先按显式 work_id 解析作品及作者，不依赖当前浏览器焦点；最多点击一次，关注端点无法按作品 ID 校验时必须重新加载同一作品确认持久状态。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        action: z.enum(["follow", "unfollow"]),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]).default("external_post"),
        alias: z.string().min(1).max(50).optional(),
        dry_run: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, action, scope, alias, dry_run }) => {
      try {
        const result = await browser.followPostAuthor({ workId: work_id, action, scope, alias, dryRun: dry_run });
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_like_current",
    {
      title: "点赞或取消点赞当前作品",
      description: "兼容包装器：只读取当前已锁定作品的 work_id/scope，然后调用 douyin_like_post 的统一核心；DOM 乐观状态不会判定成功。新调用应优先使用显式 work_id 工具。",
      inputSchema: z.object({
        action: z.enum(["like", "unlike"]).describe("like=点赞，unlike=取消点赞"),
        dry_run: z.boolean().default(false).describe("只读取并验证当前点赞状态，不点击"),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ action, dry_run }) => {
      try {
        const result = await browser.setCurrentWorkReaction("like", action === "like" ? "add" : "remove", { dryRun: dry_run });
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_favorite_current",
    {
      title: "收藏或取消收藏当前作品",
      description: "兼容包装器：只读取当前已锁定作品 ID 后调用 douyin_favorite_post；不使用浏览器焦点作为核心目标，收藏夹不唯一时停止。",
      inputSchema: z.object({
        action: z.enum(["favorite", "unfavorite"]).describe("favorite=收藏，unfavorite=取消收藏"),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ action }) => {
      try {
        const result = await browser.setCurrentWorkReaction("favorite", action === "favorite" ? "add" : "remove");
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_follow_current_author",
    {
      title: "关注或取消关注当前作品作者",
      description: "兼容包装器：只读取当前已锁定作品 ID 后调用 douyin_follow_post_author；不会按昵称搜索账号或使用当前焦点直接选择作者。",
      inputSchema: z.object({
        action: z.enum(["follow", "unfollow"]),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ action }) => {
      try {
        const result = await browser.setCurrentAuthorFollow(action);
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_bound_user",
    {
      title: "核验本地绑定用户",
      description: "按本地别名读取并在线核验稳定主页 URL、uid/sec_uid 和互关状态；结果不会返回原始 uid/sec_uid。",
      inputSchema: z.object({
        alias: z.string().min(1).max(40).default("bound_user"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias }) => {
      try {
        const result = await browser.getBoundUserPublic(alias);
        return {
          content: [{
            type: "text" as const,
            text: `已核验绑定用户：${result.displayName}（${result.alias}），互关：${result.mutualFollow ? "是" : "否"}。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_profile_recommendations",
    {
      title: "列出冰冰主页推荐",
      description: "通过本地绑定的 Bound User 稳定主页 ID 打开“推荐”标签，滚动收集稳定作品 ID；支持分页和持久未看过滤，不依赖昵称定位主页。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        limit: z.number().int().min(1).max(100).default(30),
        cursor: z.string().min(1).max(100).optional(),
        unseen_only: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias, limit, cursor, unseen_only }) => {
      try {
        const result = await browser.listProfileRecommendations(alias, limit, cursor, unseen_only);
        return {
          content: [{
            type: "text" as const,
            text: [
              ...result.items.map((item, index) =>
                `${index} | ${item.viewed ? "已看" : "未看"} | ${item.contentType} | ${item.workId} | ${item.safeId} | ${item.author} | ${item.title}`),
              `本页 ${result.count} / 下一游标 ${result.nextCursor ?? "无"}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_bound_user_posts",
    {
      title: "列出绑定用户发布作品",
      description: "通过本地稳定 uid/sec_uid 打开绑定用户主页，严格进入“作品 > 作品”而非推荐/喜欢，按页面发布顺序返回稳定 work_id，并支持游标和持久已看状态。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(100).optional(),
        unseen_only: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias, limit, cursor, unseen_only }) => {
      try {
        const result = await browser.listBoundUserPosts(alias, limit, cursor, unseen_only);
        return {
          content: [{
            type: "text" as const,
            text: [
              ...result.items.map(item =>
                `${item.viewed ? "已看" : "未看"} | ${item.contentType} | ${item.workId} | ${item.safeId} | ${item.author} | ${item.title ?? ""}`),
              `本页 ${result.count} / 下一游标 ${result.nextCursor ?? "无"} / 标签 ${result.profileTab}>${result.profileSubTab}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_bound_user_post",
    {
      title: "在 Operator 正式页打开绑定用户作品",
      description: "按稳定 work_id 或 safe_id 使用已绑定的 operator_home 标签页打开作品，校验 Operator 登录态、绑定作者 uid/sec_uid 和作品 ID，并建立写操作锁。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        work_id: z.string().regex(/^\d{16,20}$/).optional(),
        safe_id: z.string().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias, work_id, safe_id }) => {
      try {
        if ((work_id == null) === (safe_id == null)) throw new Error("work_id 与 safe_id 必须且只能提供一个。");
        const result = await browser.openBoundUserPost(alias, work_id, safe_id);
        return {
          content: [{
            type: "text" as const,
            text: `已在 Operator 正式页锁定 ${result.author} 的作品 ${result.workId}；作者、登录和作品锁均已验证。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_latest_bound_user_post",
    {
      title: "打开绑定用户最新发布作品",
      description: "列出绑定用户“作品”标签中的最新一条，并在 Operator 正式页打开、校验和锁定。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias }) => {
      try {
        const result = await browser.openLatestBoundUserPost(alias);
        return {
          content: [{ type: "text" as const, text: `已锁定最新作品：${result.title ?? ""}（${result.workId}）。` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_current_work_context",
    {
      title: "读取稳定作品上下文",
      description: "只读检查指定绑定页的登录账号、work_id、作者归属、作品锁、自动播放锁和评论区状态，用于诊断点赞或评论为何不能执行。",
      inputSchema: z.object({
        page_role: z.enum(["operator_home", "codex_test"]).default("operator_home"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_role }) => {
      try {
        const result = await browser.getCurrentWorkContext(page_role);
        return {
          content: [{
            type: "text" as const,
            text: `页面：${result.pageRole}\n账号：${result.loggedInAccount ?? "未验证"}\n作品：${result.workId ?? "无"}\n作者：${result.authorName ?? "无"}\n已锁定：${result.workLocked}\n评论区：${result.commentPanelOpen ? "已打开" : "未打开"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_like_bound_user_post",
    {
      title: "按 work_id 点赞绑定用户作品",
      description: "兼容包装器：把 alias/work_id 映射为 bound_user_post 后调用 douyin_like_post 的统一核心；默认 dry_run，只接受服务端或 reload 持久态确认。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        work_id: z.string().regex(/^\d{16,20}$/),
        action: z.enum(["like", "unlike"]),
        dry_run: z.boolean().default(true),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ alias, work_id, action, dry_run }) => {
      try {
        const result = await browser.likeBoundUserPost({ alias, workId: work_id, action, dryRun: dry_run });
        return {
          content: [{ type: "text" as const, text: result.message }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_comment_bound_user_post",
    {
      title: "按 work_id 评论绑定用户作品",
      description: "在 Operator 正式页打开、校验并锁定绑定用户作品。默认 preview 不发送；只有 action=send 且 confirm_send=true 才发送并回读真实 comment_id。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        work_id: z.string().regex(/^\d{16,20}$/),
        text: z.string().min(1).max(500),
        action: z.enum(["preview", "send"]).default("preview"),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ alias, work_id, text, action, confirm_send }) => {
      try {
        const result = await browser.commentBoundUserPost({
          alias,
          workId: work_id,
          text,
          action,
          confirmSend: confirm_send,
        });
        return {
          content: [{
            type: "text" as const,
            text: `动作：${result.action}\n作品：${result.targetWorkId}\n作者：${result.author}\n已发送：${result.sent}\ncomment_id：${result.commentId ?? "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reply_comment_on_bound_user_post",
    {
      title: "回复绑定用户作品中的指定评论",
      description: "验证 bound_user/Bound User 稳定绑定、Operator 登录态、精确 work_id、稳定 comment_id 和页面锁；内部统一执行 prepare→SQLite→commit→回读。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        work_id: z.string().regex(/^\d{16,20}$/),
        comment_id: z.string().regex(/^\d{8,}$/),
        text: z.string().min(1).max(500),
        action: z.enum(["preview", "send"]).default("preview"),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ alias, work_id, comment_id, text, action, confirm_send }) => {
      try {
        const result = await browser.replyCommentOnBoundUserPost({
          alias,
          workId: work_id,
          commentId: comment_id,
          text,
          action,
          confirmSend: confirm_send,
        });
        return {
          content: [{
            type: "text" as const,
            text: `动作：${result.action}\n作品：${result.targetWorkId}\n目标：${result.targetCommentId}`
              + `\noperation_id：${result.operation_id ?? "无"}\n已发送：${result.sent}`
              + `\n新 comment_id：${result.commentId ?? "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_probe_comment_composer",
    {
      title: "只读探测作品页主评论编辑器",
      description: "按冻结作品与 scope 激活评论面板并检查主评论 composer；返回全部候选诊断，不填写文字、不点击发送。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]),
        alias: z.string().min(1).max(50).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id, scope, alias }) => {
      try {
        if (scope === "bound_user_post" && !alias) {
          throw new Error("VALIDATION_FAILED:bound_user_post 必须提供 alias。");
        }
        const result = await browser.probeCommentComposer({
          workId: work_id,
          scope,
          alias,
        });
        return {
          content: [{
            type: "text" as const,
            text: `主评论 composer：${result.reason}`
              + `\n作品：${result.workId}`
              + `\n页面角色：${result.pageRole}`
              + `\n评论区域：${result.visibleCommentSurfaceCount}`
              + `\n候选数：${result.candidates.length}`
              + "\n未填写、未发送。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_diagnose_root_comment_submit",
    {
      title: "诊断独立电脑端根评论提交",
      description:
        "只使用 operator_root_comment_clean 独立 profile。inspect 可启动浏览器并检查扫码登录、冻结作品和 composer；submit 必须提供 operation_id 与 confirm_send=true，脱敏记录评论提交 endpoint、HTTP status、code/message、真实 comment_id、输入框和乐观 DOM 状态。不会记录 Cookie、Token、完整请求头或请求正文。",
      inputSchema: z.object({
        operation_id: z.string().uuid().optional(),
        action: z.enum(["inspect", "submit"]).default("inspect"),
        confirm_send: z.boolean().default(false),
        allow_browser_launch: z.boolean().default(true),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({
      operation_id,
      action,
      confirm_send,
      allow_browser_launch,
    }) => {
      try {
        const result = await browser.diagnoseRootCommentSubmit({
          operationId: operation_id,
          action,
          confirmSend: confirm_send,
          allowBrowserLaunch: allow_browser_launch,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `classification=${result.classification ?? "inspection_only"}`,
              `accountVerified=${"accountVerified" in result
                ? result.accountVerified
                : "n/a"}`,
              `sent=${result.sent}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_readback_exact_root_comment",
    {
      title: "绕过乐观缓存回查根评论",
      description:
        "根据持久事务冻结的 operation_id、work_id、author 与 exact_text_hash，清除独立 profile 页面缓存并重新加载，再使用另一只读浏览器会话交叉确认。只有服务器返回的 comment_id 在两边都唯一存在时才写 confirmed；绝不点击发送。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        work_id: z.string().regex(/^\d{16,20}$/),
        author: z.string().min(1).max(100),
        exact_text_hash: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      operation_id,
      work_id,
      author,
      exact_text_hash,
    }) => {
      try {
        const result = await browser.readbackExactRootComment({
          operationId: operation_id,
          workId: work_id,
          author,
          exactTextHash: exact_text_hash.toLowerCase(),
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `classification=${result.classification}`,
              `confirmed=${result.deliveryConfirmed}`,
              `comment_id=${result.resultingCommentId ?? "none"}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_preview_comment_on_post",
    {
      title: "把冻结主评论写入 composer 并预览",
      description: "只接受 prepared 主评论事务。重新核验账号、作品、作者和唯一可见 composer，将事务中冻结的原文写入并回读校验；不点击发送。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        input_strategy: z.enum(["fill", "keyboard", "react_events"])
          .default("react_events"),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, input_strategy }) => {
      try {
        const result = await browser.previewCommentOnPost(
          operation_id,
          input_strategy,
        );
        return {
          content: [{
            type: "text" as const,
            text: `preview 已写入并回读：${result.composerVerified}\n未发送：${!result.sent}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_inspect_comment_composer",
    {
      title: "检查冻结事务的评论 composer",
      description: "只在冻结主评论事务内检查唯一可见 composer、原文哈希、按钮状态和 adaptive readiness；不提交。",
      inputSchema: z.object({ operation_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id }) => {
      try {
        const result = await browser.adaptiveInspectCommentComposer(operation_id);
        return {
          content: [{
            type: "text" as const,
            text: `state=${result.state}\nadaptiveReady=${result.adaptiveReady}\nsent=${result.sent}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_clear_and_fill_comment",
    {
      title: "重新触发评论输入事件并写入冻结原文",
      description: "仅在 click_no_effect 且无任何提交信号时使用。不能传入或修改文案，只会清空唯一冻结 composer 并写回事务原文。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        input_strategy: z.enum(["fill", "keyboard", "react_events"])
          .default("react_events"),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, input_strategy }) => {
      try {
        const result = await browser.adaptiveClearAndFillComment(
          operation_id,
          input_strategy,
        );
        return {
          content: [{
            type: "text" as const,
            text: `冻结文案回读：${result.fill.normalizedTextMatched}\n未发送：${!result.sent}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_inspect_submit_candidates",
    {
      title: "检查冻结 composer 的发送候选",
      description: "返回唯一发送候选的 DOM 路径、文字、尺寸、disabled/loading、pointer-events、遮挡节点和 composer 归属；不点击。",
      inputSchema: z.object({ operation_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id }) => {
      try {
        const result = await browser.adaptiveInspectSubmitCandidates(operation_id);
        return {
          content: [{
            type: "text" as const,
            text: `候选数=${result.candidates.length}\nselected=${result.selectedCandidateIndex}\nsent=${result.sent}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_click_submit_candidate",
    {
      title: "在冻结事务内尝试发送候选",
      description: "仅在严格 click_no_effect 状态点击唯一候选。尝试前先持久记账；一旦出现请求、loading、composer 清空、toast 或新评论，立即禁止再次交互。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        candidate_index: z.literal(0).default(0),
        method: z.enum(["normal", "coordinate"]).default("coordinate"),
        confirm_submit: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, candidate_index, method, confirm_submit }) => {
      try {
        const result = await browser.adaptiveClickSubmitCandidate({
          operationId: operation_id,
          candidateIndex: candidate_index,
          method,
          confirmSubmit: confirm_submit,
        });
        return {
          content: [{
            type: "text" as const,
            text: `state=${result.operationState}\nsent=${result.sent}\ndeliveryConfirmed=${result.deliveryConfirmed}\nretryAllowed=${result.retryAllowed}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_press_comment_submit_key",
    {
      title: "在冻结 composer 内尝试提交按键",
      description: "仅允许 Enter 或 Control+Enter，且焦点必须在冻结 composer。与鼠标尝试共用最多三次总尝试和一次提交效果门禁。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        key: z.enum(["Enter", "Control+Enter"]),
        confirm_submit: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, key, confirm_submit }) => {
      try {
        const result = await browser.adaptivePressCommentSubmitKey({
          operationId: operation_id,
          key,
          confirmSubmit: confirm_submit,
        });
        return {
          content: [{
            type: "text" as const,
            text: `state=${result.operationState}\nsent=${result.sent}\ndeliveryConfirmed=${result.deliveryConfirmed}\nretryAllowed=${result.retryAllowed}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_observe_submit_effect",
    {
      title: "只读观察评论提交效果",
      description: "等待后按冻结账号、作品和完整原文回读。click_attempted 或 click_effect_confirmed 无法确认时转 unknown_after_submit，绝不再次提交。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        settle_ms: z.number().int().min(0).max(5_000).default(1_500),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id, settle_ms }) => {
      try {
        const result = await browser.adaptiveObserveSubmitEffect(
          operation_id,
          settle_ms,
        );
        return {
          content: [{
            type: "text" as const,
            text: `state=${result.operationState}\nsent=${result.sent}\ncomment_id=${result.resultingCommentId ?? "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_readback_exact_root_comment",
    {
      title: "精确回读冻结主评论",
      description: "按 work_id、Operator 和冻结完整文本唯一回读真实 comment_id；只读页面，不执行点击或按键。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        settle_ms: z.number().int().min(0).max(5_000).default(0),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id, settle_ms }) => {
      try {
        const result = await browser.adaptiveReadbackExactRootComment(
          operation_id,
          settle_ms,
        );
        return {
          content: [{
            type: "text" as const,
            text: `matches=${result.exactMatchCount}\nsent=${result.sent}\ncomment_id=${result.resultingCommentId ?? "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_adaptive_get_audit",
    {
      title: "读取 adaptive 评论事务审计",
      description: "返回冻结事务的每一步观察、策略、结果、证据、截图和诊断路径；不操作页面。",
      inputSchema: z.object({ operation_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id }) => {
      try {
        const result = await browser.adaptiveGetAudit(operation_id);
        return {
          content: [{
            type: "text" as const,
            text: `state=${result.state}\nsteps=${result.steps.length}\nsent=${result.sent}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_archive_unresolved_comment_operation",
    {
      title: "归档无法确认的历史根评论事务",
      description:
        "仅归档本地 SQLite 中仍为 unknown_after_submit 的根评论事务；不猜测成功、不清除历史、不允许重发，也不执行任何抖音页面写操作。必须显式 confirm_archive=true。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        reason: z.string().min(3).max(300),
        confirm_archive: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, reason, confirm_archive }) => {
      try {
        const result = await browser.archiveUnresolvedCommentOperation({
          operationId: operation_id,
          reason,
          confirmArchive: confirm_archive,
        });
        return {
          content: [{
            type: "text" as const,
            text: "operation_id=" + result.operation_id
              + "\nresolution=" + result.resolution
              + "\nretry_allowed=false",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_abort_comment_operation",
    {
      title: "确认未发送并解除主评论事务",
      description: "仅用于卡在 click_no_effect/click_attempted/unknown_after_submit 的主评论事务。重新核验作品、composer 原文哈希、评论列表无重复且未捕获提交响应后，标记 aborted_no_submit；绝不点击发送。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        confirm_unsent: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, confirm_unsent }) => {
      try {
        const result = await browser.abortCommentOperation({
          operationId: operation_id,
          confirmUnsent: confirm_unsent,
        });
        return {
          content: [{
            type: "text" as const,
            text: `事务：${result.operation_id}`
              + `\n状态：${result.previousState} -> ${result.state}`
              + `\ncomposer 哈希一致：${result.composerTextHashMatched}`
              + `\n相同评论：${result.duplicateCommentCount}`
              + `\nglobal_write_ready：${result.globalWriteReady}`
              + "\n未点击、未发送。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_prepare_comment_on_post",
    {
      title: "准备在指定作品发表评论",
      description: "建立 own/bound/external 短期目标门禁并将 prepared 事务持久化到 SQLite；不会打开发送按钮或发送。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        text: z.string().min(1).max(500),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]),
        alias: z.string().min(1).max(50).optional(),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, text, scope, alias }) => {
      try {
        if (scope === "bound_user_post" && !alias) {
          throw new Error("VALIDATION_FAILED:bound_user_post 必须提供 alias。");
        }
        const result = await browser.prepareCommentOnPost({
          workId: work_id,
          text,
          scope,
          alias,
        });
        return {
          content: [{
            type: "text" as const,
            text: `PREPARED（未发送）\ntoken：${result.token}`
              + `\noperation_id：${result.operation_id}\nscope：${result.scope}`
              + `\n作品：${result.workId}\n作者：${result.workAuthor}`
              + `\n过期时间：${result.expiresAt}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_commit_comment_on_post",
    {
      title: "提交已准备的作品评论",
      description: "要求 confirm_send=true；点击前原子写入 click_attempted，只有 composer 清空、按钮提交态、提交响应或新评论回读任一证据成立才写 click_effect_confirmed。无效果则写 click_no_effect，不锁全局门禁；随后回读真实 comment_id。",
      inputSchema: z.object({
        token: z.string().uuid().optional(),
        operation_id: z.string().uuid().optional(),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ token, operation_id, confirm_send }) => {
      try {
        const reference = token ?? operation_id;
        if (!reference) throw new Error("VALIDATION_FAILED:必须提供 token 或 operation_id。");
        const result = await browser.commitCommentOnPost(reference, confirm_send);
        return {
          content: [{
            type: "text" as const,
            text: `状态：${result.status}\noperation_id：${result.operation_id}`
              + `\nclicked：${result.clicked}`
              + `\nresulting_comment_id：${result.resultingCommentId ?? "待确认"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_prepare_reply_to_comment",
    {
      title: "准备回复指定作品评论",
      description: "按 scope 验证 work_id、稳定 comment_id、作者、正文哈希、父/根线程和页面角色；唯一目标才持久化 prepared，绝不发送。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        comment_id: z.string().regex(/^\d{8,}$/),
        text: z.string().min(1).max(500),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]),
        alias: z.string().min(1).max(50).optional(),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, comment_id, text, scope, alias }) => {
      try {
        if (scope === "bound_user_post" && !alias) {
          throw new Error("VALIDATION_FAILED:bound_user_post 必须提供 alias。");
        }
        const result = await browser.prepareReplyToComment({
          workId: work_id,
          commentId: comment_id,
          text,
          scope,
          alias,
        });
        return {
          content: [{
            type: "text" as const,
            text: `PREPARED（未发送）\ntoken：${result.token}`
              + `\noperation_id：${result.operation_id}\nscope：${result.scope}`
              + `\n作品：${result.workId}\n目标：${result.commentId}`
              + `\n作者：${result.commentAuthor}\n原文：${result.originalText}`
              + `\n父评论：${result.parentCommentId ?? "无"}`
              + `\n根评论：${result.rootCommentId ?? "无"}`
              + `\n过期时间：${result.expiresAt}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_commit_reply_to_comment",
    {
      title: "提交已准备的评论回复",
      description: "兼容 creator_center 与普通详情页事务；要求 confirm_send=true，最多一次发送点击，状态不明只读恢复。",
      inputSchema: z.object({
        token: z.string().uuid().optional(),
        operation_id: z.string().uuid().optional(),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ token, operation_id, confirm_send }) => {
      try {
        const reference = token ?? operation_id;
        if (!reference) throw new Error("VALIDATION_FAILED:必须提供 token 或 operation_id。");
        const result = await browser.commitReplyToComment(reference, confirm_send);
        const resultingId = "replyCommentId" in result
          ? result.replyCommentId
          : result.resultingCommentId;
        return {
          content: [{
            type: "text" as const,
            text: `状态：${result.status}\noperation_id：${result.operation_id}`
              + `\nclicked：${result.clicked}`
              + `\nresulting_comment_id：${resultingId ?? "待确认"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_own_posts",
    {
      title: "列出 Operator 自己的作品",
      description: "只使用绑定的 operator_home 正式页，校验 Operator 登录态并进入“作品 > 作品”标签，返回自己发布的 article/note/video。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(100).optional(),
        unseen_only: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, cursor, unseen_only }) => {
      try {
        const result = await browser.listOwnPosts(limit, cursor, unseen_only);
        return {
          content: [{
            type: "text" as const,
            text: result.items.map(item =>
              `${item.contentType} | ${item.workId} | ${item.safeId} | ${item.title ?? ""}`).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_own_post",
    {
      title: "在正式页打开自己的作品",
      description: "在 operator_home 按稳定 work_id 打开 Operator 自己的作品，验证作者、登录账号、work_id，并建立评论回复所需的作品锁。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id }) => {
      try {
        const result = await browser.openOwnPost(work_id);
        return {
          content: [{ type: "text" as const, text: `已在 Operator 正式页锁定自有作品 ${result.workId}。` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_own_post_comments",
    {
      title: "读取指定自有作品评论",
      description: "在 Operator 正式页打开并校验指定自有作品，只读取该作品的主评论和回复，返回稳定 comment_id。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        sort: z.enum(["latest", "hot"]).default("hot"),
        limit: z.number().int().min(1).max(100).default(30),
        include_replies: z.boolean().default(true),
        replies_per_comment: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id, sort, limit, include_replies, replies_per_comment }) => {
      try {
        const result = await browser.readOwnPostComments({
          workId: work_id,
          sort,
          limit,
          includeReplies: include_replies,
          repliesPerComment: replies_per_comment,
        });
        return {
          content: [{
            type: "text" as const,
            text: result.comments.map(comment =>
              `${comment.commentId} | ${comment.author} | ${comment.text}\n${
                (comment.replies ?? []).map(reply => `  ↳ ${reply.commentId} | ${reply.author} | ${reply.text}`).join("\n")
              }`).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_comment_on_own_post",
    {
      title: "在自己的作品下发布新主评论",
      description:
        "只允许 Operator 自有作品。内部固定 scope=own_post，创建新的根评论而不是回复任何人；preview 只写入并回读 composer，send 仍要求 confirm_send=true，并沿用根评论 SQLite 事务、单次提交效果和服务端回读门禁。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        text: z.string().min(1).max(500),
        action: z.enum(["preview", "send"]).default("preview"),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, text, action, confirm_send }) => {
      try {
        const prepared = await browser.prepareCommentOnPost({
          workId: work_id,
          text,
          scope: "own_post",
        });
        if (prepared.status === "already_confirmed") {
          return {
            content: [{
              type: "text" as const,
              text: `该主评论事务已确认完成：${prepared.operation_id}`,
            }],
            structuredContent: {
              ...prepared,
              action,
              sent: true,
              deliveryConfirmed: true,
              rootComment: true,
              repliedToComment: false,
            },
          };
        }
        if (action === "preview") {
          const preview = await browser.previewCommentOnPost(
            prepared.operationId,
            "react_events",
          );
          return {
            content: [{
              type: "text" as const,
              text: `已在自己的作品下预览新主评论。\noperation_id：${prepared.operation_id}`
                + "\n未回复任何人，未点击发送。",
            }],
            structuredContent: {
              ...prepared,
              action,
              preview,
              sent: false,
              deliveryConfirmed: false,
              rootComment: true,
              repliedToComment: false,
            },
          };
        }
        const committed = await browser.commitCommentOnPost(
          prepared.operationId,
          confirm_send,
        );
        return {
          content: [{
            type: "text" as const,
            text: `状态：${committed.status}\noperation_id：${committed.operation_id}`
              + `\n新主评论 ID：${committed.resultingCommentId ?? "待确认"}`,
          }],
          structuredContent: {
            ...committed,
            action,
            rootComment: true,
            repliedToComment: false,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_prepare_delete_comment",
    {
      title: "准备删除自己作品下的指定评论",
      description:
        "通过 creator API 全量扫描唯一冻结 work_id/comment_id/作者/原文哈希/父根线程，并写入 SQLite 删除事务；只准备，不打开删除确认、不点击。是否属于恶意评论由模型或用户判断，工具绝不根据关键词自动删除。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        comment_id: z.string().regex(/^\d{8,}$/),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ work_id, comment_id }) => {
      try {
        const result = await browser.prepareDeleteCreatorComment({
          workId: work_id,
          commentId: comment_id,
        });
        return {
          content: [{
            type: "text" as const,
            text: `DELETE PREPARED（尚未删除）\noperation_id：${result.operation_id}`
              + `\n作者：${result.targetAuthor}\n原文：${result.targetText}`
              + `\n过期时间：${result.expiresAt}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_commit_delete_comment",
    {
      title: "确认删除自己作品下的指定评论",
      description:
        "必须 confirm_delete=true。提交前重新核验账号、作品、comment_id、作者、原文哈希和线程；只点击目标行的删除入口及唯一确认按钮。确认后由 creator API 全量回读评论确已消失；状态不明时禁止再次点击。",
      inputSchema: z.object({
        token: z.string().uuid().optional(),
        operation_id: z.string().uuid().optional(),
        confirm_delete: z.boolean().default(false),
      }),
      annotations: DESTRUCTIVE_ACTION_ANNOTATIONS,
    },
    async ({ token, operation_id, confirm_delete }) => {
      try {
        const reference = token ?? operation_id;
        if (!reference) {
          throw new Error("VALIDATION_FAILED:必须提供 token 或 operation_id。");
        }
        const result = await browser.commitDeleteCreatorComment(
          reference,
          confirm_delete,
        );
        return {
          content: [{
            type: "text" as const,
            text: `删除状态：${result.state}\noperation_id：${result.operation_id}`
              + `\ncomment_id：${result.comment_id}\n已确认删除：${result.deleted}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_get_delete_comment_status",
    {
      title: "只读回查评论删除事务",
      description:
        "对 delete_started/unknown_after_submit 仅通过 creator API 全量回读目标 comment_id；目标确已消失才更新 confirmed，仍存在或无法完整确认时绝不再次点击。",
      inputSchema: z.object({
        token: z.string().uuid().optional(),
        operation_id: z.string().uuid().optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ token, operation_id }) => {
      try {
        const reference = token ?? operation_id;
        if (!reference) {
          throw new Error("VALIDATION_FAILED:必须提供 token 或 operation_id。");
        }
        const result = await browser.getCreatorCommentDeleteStatus(reference);
        return {
          content: [{
            type: "text" as const,
            text: `删除状态：${result.state}\ncomment_id：${result.comment_id}`
              + `\n已确认删除：${result.deleted}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_check_own_comment_updates",
    {
      title: "检查自己作品的新增评论",
      description: "扫描 Operator 自己的作品，以持久 comment_id 去重，只返回相对上次检查新增的主评论或回复。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      try {
        const result = await browser.checkOwnCommentUpdates(limit);
        return {
          content: [{
            type: "text" as const,
            text: result.items.map(item =>
              `${item.isReply ? "回复" : "主评论"} | ${item.workId} | ${item.commentId} | ${item.author} | ${item.text}`).join("\n")
              || "没有检测到新增评论。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_verify_account",
    {
      title: "验证当前创作者中心账号",
      description: "读取 creator_center 的稳定 uid/sec_uid，并只接受 operator 或 douyin_bound_users.json 中 allow_creator_center=true 的账号。可用 alias 强制要求当前正是指定账号；纯只读，不回复、不切换账号。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias }) => {
      try {
        const result = await browser.verifyCreatorCenterAccount(alias);
        return {
          content: [{
            type: "text" as const,
            text: `创作者账号已验证：${result.alias}/${result.displayName}`
              + `\nuid：${result.uid}\nsec_uid：${result.secUid}`
              + `\nwrite_account_ready：${result.writeAccountReady}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_open_comment_manager",
    {
      title: "打开创作者中心评论管理",
      description: "自动恢复 creator_center 绑定：唯一已有页面会重新绑定，没有页面会安全打开；多个候选才报冲突。账号必须是 operator 或显式 allow_creator_center 的绑定账号，不打开普通抖音详情页。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id }) => {
      try {
        const result = await browser.openCreatorCommentManager(work_id);
        return {
          content: [{
            type: "text" as const,
            text: `评论管理已就绪：${result.commentManagerReady}\n作品：${result.workId ?? "未选择"}\n账号已校验：${result.accountVerified}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_list_comments",
    {
      title: "列出创作者中心评论",
      description: "从当前已授权创作者账号的评论管理记录读取稳定 comment_id、主评论和回复；支持作品、排序、回复状态和虚拟游标。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/).optional(),
        sort: z.enum(["latest", "hot"]).default("latest"),
        status: z.enum(["all", "unreplied", "replied"]).default("all"),
        limit: z.number().int().min(1).max(100).default(30),
        cursor: z.string().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id, sort, status, limit, cursor }) => {
      try {
        const result = await browser.listCreatorComments({
          workId: work_id,
          sort,
          status,
          limit,
          cursor,
        });
        return {
          content: [{
            type: "text" as const,
            text: result.items.map(item =>
              `${item.isReply ? "回复" : "主评论"} | ${item.workId} | ${item.commentId} | ${item.author} | ${item.text}`,
            ).join("\n") || "当前筛选没有评论。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_read_current_filtered_comments",
    {
      title: "读取创作者中心当前筛选评论",
      description: "只读读取 creator_center 当前手动搜索结果中的稳定 comment_id。不会清空搜索框、刷新页面、切换作品、滚动或改变筛选；React 数据源、可见评论和 work_id 无法严格互证时失败关闭。默认要求筛选结果唯一。",
      inputSchema: z.object({
        expected_work_id: z.string().regex(/^\d{16,20}$/).optional(),
        require_unique: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ expected_work_id, require_unique }) => {
      try {
        const result = await browser.readCurrentFilteredCreatorComments({
          expectedWorkId: expected_work_id,
          requireUnique: require_unique,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `当前搜索：${result.keyword}`,
              `作品：${result.workId} | ${result.workTitle ?? ""}`,
              `结果数：${result.count} | 唯一：${result.unique}`,
              ...result.items.map(item =>
                `${item.commentId} | ${item.author} | ${item.text}`
                + ` | hasReplied=${item.hasReplied}`),
              "筛选状态保持不变：true",
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_find_comments",
    {
      title: "按作者和正文查找创作者中心评论",
      description: "通过 creator_center 稳定只读接口建立完整评论索引，不依赖页面搜索框。支持作者、正文、回复状态、主评论/楼中楼和精确/模糊匹配；分页覆盖全部评论。不会刷新、滚动、清空搜索词、切换作品或改变页面筛选。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        author_query: z.string().min(1).max(100).optional(),
        text_query: z.string().min(1).max(500).optional(),
        status: z.enum(["all", "unreplied", "replied"]).default("all"),
        root_only: z.boolean().default(false),
        match_mode: z.enum(["exact", "fuzzy"]).default("fuzzy"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      work_id,
      author_query,
      text_query,
      status,
      root_only,
      match_mode,
      limit,
    }) => {
      try {
        const result = await browser.findCreatorComments({
          workId: work_id,
          authorQuery: author_query,
          textQuery: text_query,
          status,
          rootOnly: root_only,
          matchMode: match_mode,
          limit,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `完整扫描：${result.complete} | 主评论：${result.scannedRootCount}`
                + ` | 全部评论：${result.scannedCommentCount}`,
              `匹配：${result.totalMatched} | 返回：${result.count}`,
              ...result.items.map(item =>
                `${item.commentId} | score=${item.matchScore} | ${item.author} | ${item.text}`
                + ` | parent=${item.parentCommentId ?? "-"} | root=${item.rootCommentId}`
                + ` | hasReplied=${item.hasReplied} | matchToken=${item.matchToken}`),
              "页面状态保持不变：true",
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_open_comment_by_id",
    {
      title: "按稳定 ID 定位创作者中心评论",
      description: "先通过 creator API 全量校验 work_id/comment_id/作者/原文，再自动选择作品、按根评论正文定位页面并在需要时展开楼中楼，最后用 React/DOM 互证稳定 comment_id。不会打开回复编辑器，不会发送。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        comment_id: z.string().regex(/^\d{8,}$/),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id, comment_id }) => {
      try {
        const result = await browser.openCreatorCommentById(work_id, comment_id);
        return {
          content: [{
            type: "text" as const,
            text: [
              `作品：${result.workId}`,
              `comment_id：${result.commentId}`,
              `作者：${result.author}`,
              `原文：${result.text}`,
              `根评论：${result.rootCommentId}`,
              `页面已定位：${result.targetVisible}`,
              `线程已展开：${result.threadExpanded}`,
              "API 与 DOM 已互证；未打开编辑器；未发送。",
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_scan_comments",
    {
      title: "精简扫描创作者中心评论",
      description: "高层评论发现与筛选。compact 模式不重复返回 workId/workTitle，并用快照游标严格分页；无需预先打开或绑定 creator_center。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        status: z.enum(["all", "unreplied", "replied"]).default("all"),
        scope: z.enum(["all", "new"]).default("all"),
        root_only: z.boolean().default(false),
        question_only: z.boolean().default(false),
        query: z.array(z.string().min(1).max(100)).max(20).default([]),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(200).optional(),
        include_thread_context: z.boolean().default(false),
        response_mode: z.enum(["compact", "full"]).default("compact"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      work_id,
      status,
      scope,
      root_only,
      question_only,
      query,
      limit,
      cursor,
      include_thread_context,
      response_mode,
    }) => {
      try {
        const result = await browser.scanCreatorComments({
          workId: work_id,
          status,
          scope,
          rootOnly: root_only,
          questionOnly: question_only,
          query,
          limit,
          cursor,
          includeThreadContext: include_thread_context,
          responseMode: response_mode,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `作品：${result.workId} | ${result.workTitle ?? ""}`,
              `匹配：${result.totalMatched} | 本页：${result.count}`,
              ...result.items.map(item =>
                `${item.commentId} | parent=${item.parentCommentId ?? "-"} | root=${item.rootCommentId}`
                + ` | depth=${item.depth} | ${item.author} | ${item.text}`),
              result.nextCursor ? `nextCursor=${result.nextCursor}` : "nextCursor=无",
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_prepare_reply_from_match",
    {
      title: "按唯一匹配准备创作者中心回复",
      description: "输入作品、作者/正文查询和回复文案，内部只读完成全量查找。只有唯一高置信匹配才冻结目标并返回 token/operation_id；多条、零条或低置信匹配只返回候选，绝不猜测、绝不发送。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/),
        author_query: z.string().min(1).max(100).optional(),
        text_query: z.string().min(1).max(500).optional(),
        reply_text: z.string().min(1).max(500),
        status: z.enum(["all", "unreplied", "replied"]).default("unreplied"),
        root_only: z.boolean().default(false),
        match_mode: z.enum(["exact", "fuzzy"]).default("fuzzy"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      work_id,
      author_query,
      text_query,
      reply_text,
      status,
      root_only,
      match_mode,
    }) => {
      try {
        const result = await browser.prepareCreatorReplyFromMatch({
          workId: work_id,
          authorQuery: author_query,
          textQuery: text_query,
          replyText: reply_text,
          status,
          rootOnly: root_only,
          matchMode: match_mode,
        });
        const prepared = result.matchStatus === "prepared";
        return {
          content: [{
            type: "text" as const,
            text: prepared
              ? [
                  "PREPARED（未发送）",
                  `token：${result.token}`,
                  `operation_id：${result.operation_id}`,
                  `目标：${result.targetCommentId}`,
                  `作者：${result.targetAuthor}`,
                  `原文：${result.targetText}`,
                  `拟回复：${result.replyText}`,
                  `过期时间：${result.expiresAt}`,
                ].join("\n")
              : [
                  `匹配状态：${result.matchStatus}`,
                  `候选数：${result.candidateCount}`,
                  ...result.candidates.map(item =>
                    `${item.commentId} | score=${item.matchScore} | ${item.author} | ${item.text}`),
                  "未创建发送计划；未发送。",
                ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_prepare_reply",
    {
      title: "准备创作者中心评论回复",
      description: "按 comment_id + target_work_id + text 完成目标读取、preview 与冻结。优先使用创作者中心；评论未被创作者中心索引时，回退到自有作品详情页精确验证。不会点击发送。",
      inputSchema: z.object({
        target_work_id: z.string().regex(/^\d{16,20}$/).optional(),
        work_id: z.string().regex(/^\d{16,20}$/).optional()
          .describe("兼容字段；推荐使用 target_work_id"),
        comment_id: z.string().regex(/^\d{8,}$/),
        text: z.string().min(1).max(500),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ target_work_id, work_id, comment_id, text }) => {
      try {
        const targetWorkId = target_work_id ?? work_id;
        if (!targetWorkId) {
          throw new Error("VALIDATION_FAILED:必须提供 target_work_id。");
        }
        const result = await browser.prepareCreatorReply({
          workId: targetWorkId,
          commentId: comment_id,
          text,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              "PREPARED（未发送）",
              `token：${result.token}`,
              `operation_id：${result.operation_id}`,
              `replyPlanId：${result.replyPlanId}`,
              `作品：${result.workId}`,
              `目标：${result.targetCommentId}`,
              `父评论：${result.parentCommentId ?? "无"}`,
              `根评论：${result.rootCommentId}`,
              `作者：${result.targetAuthor}`,
              `原文：${result.targetText}`,
              `拟回复：${result.replyText}`,
              `过期时间：${result.expiresAt}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_commit_reply",
    {
      title: "提交已冻结的创作者中心回复",
      description: "接受 prepare 返回的 token 或 operation_id，并要求 confirm_send=true。按冻结事务自动选择创作者中心或自有作品详情页提交；同一幂等事务最多点击一次，状态不明绝不重试。",
      inputSchema: z.object({
        token: z.string().uuid().optional(),
        operation_id: z.string().uuid().optional(),
        reply_plan_id: z.string().uuid().optional()
          .describe("兼容字段；推荐使用 token"),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ token, operation_id, reply_plan_id, confirm_send }) => {
      try {
        const reference = token ?? operation_id ?? reply_plan_id;
        if (!reference) {
          throw new Error("VALIDATION_FAILED:必须提供 prepare 返回的 token 或 operation_id。");
        }
        const result = await browser.commitReplyToComment(reference, confirm_send);
        const targetCommentId = "targetCommentId" in result
          ? result.targetCommentId
          : result.commentId;
        const replyCommentId = "replyCommentId" in result
          ? result.replyCommentId
          : result.resultingCommentId;
        const transactionId = "transactionId" in result
          ? result.transactionId
          : result.operationId;
        const clicked = result.clicked;
        const verified = "verifiedInCreatorCenter" in result
          ? result.verifiedInCreatorCenter
          : result.deliveryConfirmed;
        const blockedReason = "blockedReason" in result
          ? result.blockedReason
          : result.lastError;
        return {
          content: [{
            type: "text" as const,
            text: [
              `状态：${result.status}`,
              `token：${result.token}`,
              `operation_id：${result.operation_id}`,
              `transactionId：${transactionId}`,
              `作品：${result.workId}`,
              `目标：${targetCommentId}`,
              `clicked：${clicked}`,
              `replyCommentId：${replyCommentId ?? "待验证"}`,
              `已验证：${verified}`,
              blockedReason ? `原因：${blockedReason}` : null,
            ].filter(Boolean).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_get_reply_status",
    {
      title: "查询创作者中心回复事务状态",
      description: "只读查询 unknown_after_submit 事务并回读 creator_center；绝不重新点击发送。",
      inputSchema: z.object({
        operation_id: z.string().uuid().optional(),
        transaction_id: z.string().uuid().optional()
          .describe("兼容字段；推荐使用 operation_id"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id, transaction_id }) => {
      try {
        const reference = operation_id ?? transaction_id;
        if (!reference) {
          throw new Error("VALIDATION_FAILED:必须提供 operation_id。");
        }
        const result = await browser.getCreatorReplyStatus(reference);
        return {
          content: [{
            type: "text" as const,
            text: `状态：${result.status}\ntransactionId：${result.transactionId}\nclicked：${result.clicked}`
              + `\nreplyCommentId：${result.replyCommentId ?? "待验证"}`
              + `\n创作者中心已验证：${result.verifiedInCreatorCenter}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_reply_comment",
    {
      title: "在创作者中心预览或回复评论",
      description: "兼容 preview 工具。真实发送已迁移到 prepare_reply → commit_reply 事务流程；本工具 action=send 会安全拒绝。",
      inputSchema: z.object({
        comment_id: z.string().regex(/^\d{8,}$/),
        target_work_id: z.string().regex(/^\d{16,20}$/),
        text: z.string().min(1).max(500),
        action: z.enum(["preview", "send"]).default("preview"),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ comment_id, target_work_id, text, action, confirm_send }) => {
      try {
        const result = await browser.replyCreatorComment({
          commentId: comment_id,
          targetWorkId: target_work_id,
          text,
          action,
          confirmSend: confirm_send,
        });
        return {
          content: [{
            type: "text" as const,
            text: result.preview
              ? `PREVIEW\n作品：${result.workId}\n目标：${result.targetCommentId}\n作者：${result.targetAuthor}\n原文：${result.targetText}\n拟回复：${result.replyText}\n未发送`
              : `状态：${result.status}\n作品：${result.workId}\n目标：${result.targetCommentId}\nreplyCommentId：${result.replyCommentId ?? "未知"}\n已验证：${result.verifiedInCreatorCenter}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_creator_check_comment_updates",
    {
      title: "检查创作者中心新增评论",
      description: "从 creator_center 评论记录扫描并使用持久 comment_id 去重，不依赖通知中心或私信。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      try {
        const result = await browser.checkCreatorCommentUpdates(limit);
        return {
          content: [{
            type: "text" as const,
            text: result.items.map(item =>
              `${item.workId} | ${item.commentId} | ${item.author} | ${item.text}`,
            ).join("\n") || "没有检测到新增评论。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_startup_self_check",
    {
      title: "恢复并验证 Douyin MCP 运行状态",
      description: "枚举并恢复固定 Operator 浏览器 profile 的页面绑定、SQLite 去重与回复事务；仅在全部写前置校验通过后开启全局写门禁。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/).optional(),
        allow_browser_launch: z.boolean().default(true),
        reconcile_pending_operations: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id, allow_browser_launch, reconcile_pending_operations }) => {
      try {
        const result = await browser.startupSelfCheck({
          workId: work_id,
          allowBrowserLaunch: allow_browser_launch,
          reconcilePendingOperations: reconcile_pending_operations,
        });
        return {
          content: [{
            type: "text" as const,
            text: [
              `global_write_ready=${result.globalWriteReady}`,
              `mode=${result.mode}`,
              `browser_connected=${result.browserConnected}`,
              `account_verified=${result.accountVerified}`,
              `creator_center_ready=${result.creatorCenterReady}`,
              `work_verified=${result.workVerified}`,
              `pending=${result.pendingOperations.length}`,
              `reconciled=${result.reconciledOperations.length}`,
              `blocked=${result.blockedReasons.join(" | ") || "none"}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reconcile_reply_operations",
    {
      title: "只读恢复未完成回复事务",
      description: "读取 SQLite 中 prepared/click_started/unknown_after_submit 事务。过期 prepared 标记 expired；提交不确定事务只读回查 creator_center，绝不点击或发送。",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.reconcileReplyOperations();
        return {
          content: [{
            type: "text" as const,
            text: [
              `checked=${result.operations.length}`,
              `unresolved=${result.unresolvedOperationIds.length}`,
              ...result.operations.map(operation =>
                `${operation.operationId} | ${operation.previousState} -> ${operation.state} | ${operation.result}`),
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_healthcheck",
    {
      title: "检查 Douyin MCP 工作流健康状态",
      description: "返回页面绑定、Operator 账号校验、当前作品锁以及扫描、事务回复和评论点赞能力状态。",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.healthcheck();
        return {
          content: [{
            type: "text" as const,
            text: [
              `版本：${result.version}`,
              ...Object.entries(result.capabilities)
                .map(([name, capability]) =>
                  `${name}=${capability.status}${capability.reason ? ` (${capability.reason})` : ""}`),
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_profile_recommendation",
    {
      title: "打开冰冰主页推荐作品",
      description: "按稳定 work_id 或工具返回的安全内部 ID，在 codex_test 标签页打开 Bound User 主页推荐作品，并持久标记已看。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
        work_id: z.string().regex(/^\d{16,20}$/).optional(),
        safe_id: z.string().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias, work_id, safe_id }) => {
      try {
        if ((work_id == null) === (safe_id == null)) {
          throw new Error("work_id 与 safe_id 必须且只能提供一个。");
        }
        const result = await browser.openProfileRecommendation(alias, work_id, safe_id);
        return {
          content: [{
            type: "text" as const,
            text: `已在 ${result.pageId} 打开主页推荐“${result.item.title}”（${result.item.workId}）。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_next_profile_recommendation",
    {
      title: "打开冰冰下一条未看推荐",
      description: "从 Bound User 稳定主页推荐中打开下一条持久状态为未看的作品，使用 codex_test 标签页。",
      inputSchema: z.object({
        alias: z.string().min(1).max(50).default("bound_user"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ alias }) => {
      try {
        const result = await browser.openNextProfileRecommendation(alias);
        return {
          content: [{
            type: "text" as const,
            text: `已打开下一条未看推荐“${result.item.title}”（${result.item.workId}）。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_search_content",
    {
      title: "搜索抖音内容",
      description: "在独立 codex_test 标签页搜索内容，返回稳定作品 ID、安全内部 ID、作者、标题、内容类型和持久已看状态；不会导航 Operator 正式页。",
      inputSchema: z.object({
        query: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, limit, cursor }) => {
      try {
        const result = await browser.searchContent(query, limit, cursor);
        return {
          content: [{
            type: "text" as const,
            text: result.items.map((item, index) =>
              `${index} | ${item.viewed ? "已看" : "未看"} | ${item.contentType} | ${item.workId} | ${item.safeId} | ${item.author} | ${item.title}`).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_current_feed",
    {
      title: "列出当前推荐流",
      description: "在独立 codex_test 标签页列出抖音精选推荐流，返回稳定作品 ID、安全内部 ID 与持久已看状态。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, cursor }) => {
      try {
        const result = await browser.listCurrentFeed(limit, cursor);
        return {
          content: [{
            type: "text" as const,
            text: result.items.map((item, index) =>
              `${index} | ${item.viewed ? "已看" : "未看"} | ${item.contentType} | ${item.workId} | ${item.safeId} | ${item.author} | ${item.title}`).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_feed_item",
    {
      title: "按 ID 打开推荐流作品",
      description: "按稳定 work_id 或工具返回的安全内部 ID，在 codex_test 标签页打开搜索结果或推荐流作品并持久标记已看。",
      inputSchema: z.object({
        work_id: z.string().regex(/^\d{16,20}$/).optional(),
        safe_id: z.string().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ work_id, safe_id }) => {
      try {
        if ((work_id == null) === (safe_id == null)) throw new Error("work_id 与 safe_id 必须且只能提供一个。");
        const result = await browser.openFeedItem(work_id, safe_id);
        return {
          content: [{ type: "text" as const, text: `已打开 ${result.item.workId}：${result.item.title}` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_next_video",
    {
      title: "打开推荐流下一条",
      description: "按当前稳定推荐流顺序在 codex_test 标签页打开下一条作品，并持久标记已看。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.moveFeed("next");
        return {
          content: [{ type: "text" as const, text: `已打开下一条 ${result.item.workId}：${result.item.title}` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_previous_video",
    {
      title: "打开推荐流上一条",
      description: "按当前稳定推荐流顺序在 codex_test 标签页打开上一条作品，并持久标记已看。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.moveFeed("previous");
        return {
          content: [{ type: "text" as const, text: `已打开上一条 ${result.item.workId}：${result.item.title}` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_share_current_to_bound_user",
    {
      title: "把当前作品单独分享给冰冰",
      description: "只允许分享给本地稳定 uid/sec_uid 绑定的 bound_user。不会读取或返回其他联系人，不会复制链接或分享到外部平台。",
      inputSchema: z.object({
        note: z.string().max(200).optional().describe("可选短附言；会作为紧随分享后的单独私信发送"),
        confirm_recipient: z.literal("bound_user").default("bound_user"),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ note, confirm_recipient }) => {
      try {
        const result = await browser.shareCurrentToBound(confirm_recipient, note);
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_messages_from_bound_user",
    {
      title: "读取冰冰私信",
      description: "从经过标题与稳定 sec_uid 双重验证的 bound_user 单人会话读取最近消息；只扫描到满足数量为止，操作结束恢复原私信位置，不枚举或返回其他会话。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10),
        unread_only: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, unread_only }) => {
      try {
        const result = await browser.listMessagesFromBound("bound_user", limit, unread_only);
        return {
          content: [{
            type: "text" as const,
            text: result.messages.map((message, index) =>
              `${index} | ${message.direction} | ${message.messageType}${message.openable ? `（可打开：${message.workId}）` : ""} | ${message.createdAt ?? message.time ?? "时间未知"} | ${message.text}`,
            ).join("\n") || "绑定会话中没有匹配消息。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_message_from_bound_user",
    {
      title: "打开冰冰的一条私信",
      description: "按真实 message_id 或当前列表索引读取绑定会话中的一条消息；遇到表情包或图片会直接返回对应画面，不会截取其他联系人或整张私信页。",
      inputSchema: z.object({
        message_id: z.string().min(1).max(200).optional(),
        message_index: z.number().int().min(0).max(99).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ message_id, message_index }) => {
      try {
        if ((message_id == null) === (message_index == null)) {
          throw new Error("message_id 与 message_index 必须且只能提供一个。");
        }
        const result = await browser.openMessageFromBound("bound_user", message_id, message_index);
        const message = result.message;
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }
        > = [{
          type: "text",
          text: `${message.direction} | ${message.messageType}${message.openable ? "（可打开）" : ""} | ${message.createdAt ?? message.time ?? "时间未知"} | ${message.text}`,
        }];
        if (result.visualImageBase64 && result.visualMimeType) {
          content.push({
            type: "image",
            data: result.visualImageBase64,
            mimeType: result.visualMimeType,
          });
        }
        const { visualImageBase64: _image, ...structuredContent } = result;
        return { content, structuredContent };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_message_media_from_bound_user",
    {
      title: "沉浸打开冰冰发来的作品",
      description: "在绑定 bound_user 的单人会话中定位作品卡片，并把它打开到当前抖音浏览标签页的沉浸式作品视图。默认打开最近一条可打开的来信作品；也可指定 message_id 或列表索引。只改变浏览位置，不点赞、不收藏、不发送消息。",
      inputSchema: z.object({
        message_id: z.string().min(1).max(200).optional(),
        message_index: z.number().int().min(0).max(99).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ message_id, message_index }) => {
      try {
        if (message_id != null && message_index != null) {
          throw new Error("message_id 与 message_index 不能同时提供。");
        }
        const result = await browser.openMessageMediaFromBound("bound_user", message_id, message_index);
        return {
          content: [{
            type: "text" as const,
            text: `已在沉浸式作品页打开 ${result.displayName} 发来的“${result.message.text}”（作品 ${result.workId}）${result.autoplayLocked ? "，并锁定当前作品，避免自动连播跳走" : ""}。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_message_media_queue_from_bound_user",
    {
      title: "查看冰冰发来的作品队列",
      description: "只在稳定绑定的 bound_user 单人会话中列出收到的可打开作品卡片，并标记本次 MCP 运行期间是否已经打开；不读取其他会话。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.listBoundMediaQueue("bound_user");
        return {
          content: [{
            type: "text" as const,
            text: result.items.map((item, index) =>
              `${index} | ${item.opened ? "已看" : "未看"} | ${item.message.mediaKind ?? "unknown"} | ${item.message.workId ?? "无作品ID"} | ${item.message.messageId} | ${item.message.time ?? "时间未知"} | ${item.message.text}`,
            ).join("\n") || "绑定会话中暂时没有可打开的来信作品卡片。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_check_bound_user_updates",
    {
      title: "检查冰冰的新消息",
      description: "使用真实 serverId 增量检查 Bound User 来信；遇到上次 checkpoint 即停止，首次升级只建立基线而不把历史误报成新消息。分别统计文字、作品分享、表情包/图片、评论分享和互动邀请；不读取其他联系人。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.checkBoundUpdates("bound_user");
        return {
          content: [{
            type: "text" as const,
            text: [
              `新增 ${result.newSinceLastCheckCount} 条：文字 ${result.newTextCount} / 作品分享 ${result.newShareCount} / 表情包或图片 ${result.newVisualCount} / 评论分享 ${result.newCommentShareCount} / 邀请 ${result.newInviteCount}`,
              `当前页面未读标记：${result.unreadCount}`,
              ...result.newMessages.map(message =>
                `${message.messageId} | ${message.messageType} | ${message.mediaKind ?? "-"} | ${message.text}`),
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_all_message_media_from_bound_user",
    {
      title: "分页列出冰冰全部分享",
      description: "在 Bound User 完整私信页滚动扫描历史，按稳定作品 ID、链接、卡片 DOM、数据属性和封面结构识别视频、图文、文章、商品、直播和小游戏卡；支持游标分页并使用持久已看状态。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(30),
        cursor: z.string().min(1).max(100).optional(),
        unseen_only: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, cursor, unseen_only }) => {
      try {
        const result = await browser.listAllBoundMedia("bound_user", limit, cursor, unseen_only);
        return {
          content: [{
            type: "text" as const,
            text: [
              ...result.items.map((item, index) =>
                `${index} | ${item.opened ? "已看" : "未看"} | ${item.message.mediaKind ?? "unknown"} | ${item.message.workId ?? "无作品ID"} | ${item.message.messageId} | ${item.message.text}`),
              `本页 ${result.count} / 总计 ${result.totalCount} / 未看 ${result.unseenCount} / 下一游标 ${result.nextCursor ?? "无"}`,
            ].join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_next_message_media_from_bound_user",
    {
      title: "打开冰冰发来的下一条作品",
      description: "从稳定绑定的 bound_user 来信作品队列中打开下一条本次运行期间尚未看过的作品，并锁定作品防止自动连播跳走。只改变浏览位置。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.openNextBoundMedia("bound_user");
        return {
          content: [{
            type: "text" as const,
            text: `已打开下一条未看作品“${result.message.text}”（${result.workId}）${result.autoplayLocked ? "，并锁定当前作品" : ""}。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_next_unseen_media_from_bound_user",
    {
      title: "打开冰冰下一条未看内容",
      description: "使用持久已看状态，从 Bound User 完整私信历史中打开下一条未看的可观看内容；MCP 重启后仍保留已看状态。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.openNextBoundMedia("bound_user");
        return {
          content: [{
            type: "text" as const,
            text: `已打开下一条未看内容“${result.message.text}”（${result.workId}）。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_check_bound_user_updates_and_watch_all",
    {
      title: "检查冰冰更新并看完未看作品",
      description: "组合执行完整私信链路：进入 Bound User 全屏私信、检查新消息、列出未看作品、逐条在 codex_test 标签页打开并理解，成功后持久标记已看，最后返回全屏私信并报告失败与剩余项。",
      inputSchema: z.object({
        max_items: z.number().int().min(1).max(50).default(20),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ max_items }) => {
      try {
        const result = await browser.checkBoundUpdatesAndWatchAll("bound_user", max_items);
        return {
          content: [{
            type: "text" as const,
            text: [
              `本轮看完 ${result.watched.length} 条，失败 ${result.failed.length} 条，仍未处理 ${result.remaining.length} 条。`,
              ...result.watched.map(item =>
                `${item.message.messageId} | ${item.understanding.contentType} | ${item.understanding.workId} | ${item.understanding.method} | ${item.understanding.coreContent.slice(0, 240)}`),
              ...result.failed.map(item => `失败 ${item.message.messageId}：${item.error}`),
              result.returnedToConversation ? "已返回 Bound User 全屏私信。" : "",
            ].filter(Boolean).join("\n"),
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_bound_user_conversation_fullscreen",
    {
      title: "全屏打开冰冰私信",
      description: "打开稳定绑定的 bound_user 私信浮窗，点击顶部“进入完整私信页”图标，并校验独立 /chat 私信视图中的会话标题为 Bound User。不会发送消息。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.openBoundConversationForViewing("bound_user");
        return {
          content: [{
            type: "text" as const,
            text: `已进入 ${result.displayName} 的完整私信页。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_return_to_bound_user_conversation",
    {
      title: "看完返回冰冰私信",
      description: "看完作品后返回稳定绑定的 bound_user 会话，并默认点击顶部入口进入完整 /chat 私信页，而不是停留在右侧浮窗；不会自动发送消息。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.openBoundConversationForViewing("bound_user");
        return {
          content: [{
            type: "text" as const,
            text: `已返回 ${result.displayName} 的完整私信页。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reply_to_bound_user",
    {
      title: "回复冰冰私信",
      description: "只允许向本地绑定 bound_user 单人会话发送一条消息；不会群发，不会切换到其他会话。",
      inputSchema: z.object({
        text: z.string().min(1).max(500),
        reply_to_message_id: z.string().min(1).max(200).optional(),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ text, reply_to_message_id }) => {
      try {
        const result = await browser.replyToBound("bound_user", text, reply_to_message_id);
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reply_to_bound_user_media",
    {
      title: "针对冰冰的一条分享回复",
      description: "按 message_id 严格校验 Bound User 单人会话中的来信作品分享，通过该消息的右键回复入口激活抖音原生引用卡片，验证 composer 中的引用预览后再发送正文。原生引用入口或预览不唯一时失败关闭，不再降级成普通文字前缀。",
      inputSchema: z.object({
        message_id: z.string().min(1).max(200),
        text: z.string().min(1).max(500),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ message_id, text }) => {
      try {
        const result = await browser.replyToBoundMedia("bound_user", message_id, text);
        return {
          content: [{
            type: "text" as const,
            text: `已针对作品 ${result.workId} 的分享发送抖音原生引用回复。`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_comments",
    {
      title: "读取当前作品评论",
      description: "只读取当前锁定作品的评论内容、时间、地区、点赞数、作者/置顶标记和可选回复；不会进入评论者主页。",
      inputSchema: z.object({
        sort: z.enum(["hot", "latest"]).default("hot"),
        limit: z.number().int().min(1).max(100).default(20),
        include_replies: z.boolean().default(false),
        replies_per_comment: z.number().int().min(0).max(20).default(3),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sort, limit, include_replies, replies_per_comment }) => {
      try {
        const result = await browser.readComments(sort, limit, include_replies, replies_per_comment);
        return {
          content: [{
            type: "text" as const,
            text: result.comments.map(comment =>
              `${comment.commentId} | ${comment.author} | ${comment.time ?? ""} ${comment.location ?? ""} | 赞 ${comment.likeCount ?? "0"} | ${comment.text}`,
            ).join("\n") || "当前作品暂未读取到评论。",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_comment_thread",
    {
      title: "读取一条评论及回复",
      description: "按当前作品内的稳定 comment_id 展开并读取该评论线程，不会跳转评论者主页。",
      inputSchema: z.object({
        comment_id: z.string().regex(/^\d{8,}$/),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ comment_id, limit }) => {
      try {
        const result = await browser.readCommentThread(comment_id, limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.comments[0], null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_action_log",
    {
      title: "读取动作审计日志",
      description: "读取本地脱敏动作日志；日志不保存私信正文、分享附言、Cookie、手机号或联系人列表。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(30),
        action_type: z.string().min(1).max(80).optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, action_type }) => {
      try {
        const entries = readActionLog(limit, action_type);
        return {
          content: [{ type: "text" as const, text: entries.map(entry => JSON.stringify(entry)).join("\n") || "暂无动作日志。" }],
          structuredContent: { entries, count: entries.length },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_safe_social_actions",
    {
      title: "列出当前可用的安全社交小功能",
      description: "只检查本地配置白名单里的精确动作，不会返回其他联系人、任意按钮或危险功能。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const actions = await browser.listSafeSocialActions();
        return {
          content: [{
            type: "text" as const,
            text: actions.map(action =>
              `${action.actionKey} | ${action.label} | ${action.available ? "当前可用" : "当前未出现"}`,
            ).join("\n") || "当前没有启用安全社交动作。",
          }],
          structuredContent: { actions, count: actions.length },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_click_safe_social_action",
    {
      title: "执行一个已配置的安全社交小功能",
      description: "按 action_key 执行本地动态白名单中的精确动作。目标标签和上下文必须同时匹配；支付、购物、发布、删除、账号设置等标签无法加入此白名单。",
      inputSchema: z.object({
        action_key: z.string().regex(/^[a-z0-9_]{3,80}$/),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ action_key }) => {
      try {
        const result = await browser.clickSafeSocialAction(action_key);
        return { content: [{ type: "text" as const, text: result.message }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const disabledFeature = (key: keyof ReturnType<typeof loadActionSettings>["features"]) => {
    if (!loadActionSettings().features[key]) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: RESERVED_DISABLED_MESSAGE }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: "该能力已在配置中启用，但当前版本尚未实现执行路径。" }],
    };
  };

  registerTool(
    "douyin_comment_current",
    {
      title: "预览或评论当前正式页作品",
      description: "只操作已绑定的 Operator 正式页。默认 preview 不发送；真正发送必须同时 action=send 且 confirm_send=true，发送后重新读取并返回真实 comment_id。",
      inputSchema: z.object({
        text: z.string().min(1).max(500),
        target_work_id: z.string().regex(/^\d{16,20}$/).optional(),
        action: z.enum(["preview", "send"]).default("preview"),
        confirm_send: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ text, target_work_id, action, confirm_send }) => {
      try {
        const result = await browser.commentCurrent({
          text,
          targetWorkId: target_work_id,
          action,
          confirmSend: confirm_send,
        });
        return {
          content: [{
            type: "text" as const,
            text: `动作：${result.action}\n已发送：${result.sent}\n作品：${result.targetWorkId}\ncomment_id：${result.commentId ?? "无"}\n已验证：${result.verified}\n截图：${result.screenshotPath}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reply_comment",
    {
      title: "预览或事务式回复指定评论",
      description: "兼容入口。根据 scope 内部迁移到 target gate→prepare→SQLite→commit；action=send 仍要求 confirm_send=true。",
      inputSchema: z.object({
        comment_id: z.string().regex(/^\d{8,}$/),
        text: z.string().min(1).max(500),
        target_work_id: z.string().regex(/^\d{16,20}$/),
        action: z.enum(["preview", "send"]).default("preview"),
        confirm_send: z.boolean().default(false),
        scope: z.enum(["own_post", "bound_user_post", "external_post"]).default("own_post"),
        alias: z.string().min(1).max(50).optional(),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ comment_id, text, target_work_id, action, confirm_send, scope, alias }) => {
      try {
        const result = await browser.replyComment({
          commentId: comment_id,
          text,
          targetWorkId: target_work_id,
          action,
          confirmSend: confirm_send,
          scope,
          alias,
        });
        return {
          content: [{
            type: "text" as const,
            text: `动作：${result.action}\n已发送：${result.sent}\n作品：${result.targetWorkId}\n目标评论：${result.targetCommentId}\n原作者：${result.targetAuthor ?? "未识别"}\n原文：${result.targetText ?? "未识别"}\n拟回复：${result.text}\n新 comment_id：${result.commentId ?? "无"}\n已验证：${result.verified}\n截图：${result.screenshotPath}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  for (const [toolName, liked] of [
    ["douyin_like_comment", true],
    ["douyin_unlike_comment", false],
  ] as const) {
    registerTool(
      toolName,
      {
        title: liked ? "点赞指定评论" : "取消点赞指定评论",
        description: "优先通过 creator_center 行内入口操作；提供 work_id 时无需打开普通详情页。按 article/note/video 适配，状态不可验证时立即 capability_unavailable 且不重复点击。",
        inputSchema: z.object({
          comment_id: z.string().regex(/^\d{8,}$/),
          work_id: z.string().regex(/^\d{16,20}$/).optional(),
          scope: z.enum(["own_post", "bound_user_post", "external_post"]).optional(),
          alias: z.string().min(1).max(50).optional(),
        }),
        annotations: SAFE_ACTION_ANNOTATIONS,
      },
      async ({ comment_id, work_id, scope, alias }) => {
        try {
          const result = await browser.setCommentLike(comment_id, liked, work_id, scope, alias);
          return {
            content: [{
              type: "text" as const,
              text: `comment_id：${comment_id}\n操作前：${result.beforeLiked}\n操作后：${result.afterLiked}\n已验证：${result.verified}`,
            }],
            structuredContent: result,
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  registerTool(
    "douyin_create_post_draft",
    {
      title: "创建持久图集草稿",
      description: "在 SQLite 中创建 Operator 图集发布草稿并返回 draft_id；不会打开编辑器、上传或发布。",
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.createPostDraft();
        return {
          content: [{
            type: "text" as const,
            text: `draft_id：${result.draftId}\n状态：${result.state}\n图片：${result.imageCount}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_post_draft",
    {
      title: "读取持久图集草稿",
      description: "按 draft_id 纯读取图片顺序、文案、音乐、封面、页面同步和发布状态。",
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ draft_id }) => {
      try {
        const result = await browser.getPostDraft(draft_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_post_drafts",
    {
      title: "列出持久发布草稿",
      description: "纯读取 SQLite 中未完成草稿；可显式包含已确认或归档记录。",
      inputSchema: z.object({ include_terminal: z.boolean().default(false) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ include_terminal }) => {
      try {
        const result = await browser.listPostDrafts(include_terminal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.items, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_add_post_images",
    {
      title: "向图集草稿追加图片",
      description: "校验本地绝对路径和内容哈希后按输入顺序追加到 SQLite 草稿；不会上传或重排。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        image_paths: z.array(z.string()).min(1).max(35),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, image_paths }) => {
      try {
        const result = await browser.addPostImages(draft_id, image_paths);
        return {
          content: [{
            type: "text" as const,
            text: `图片数：${result.imageCount}\n顺序：${result.media.map(item => `${item.order}:${item.fileName}`).join(" → ")}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_insert_post_image",
    {
      title: "在指定位置插入图片",
      description: "按 0 基索引把图片插入持久草稿；不会上传。索引可等于当前图片数。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        index: z.number().int().min(0).max(35),
        image_path: z.string(),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, index, image_path }) => {
      try {
        const result = await browser.insertPostImage(draft_id, index, image_path);
        return {
          content: [{ type: "text" as const, text: `已插入到索引 ${index}；当前 ${result.imageCount} 张。` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reorder_post_images",
    {
      title: "重排图集草稿图片",
      description: "按 0 基索引完整排列重排；必须恰好包含每个当前索引一次，不允许遗漏、重复或自动决定顺序。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        ordered_indexes: z.array(z.number().int().min(0).max(34)).min(1).max(35),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, ordered_indexes }) => {
      try {
        const result = await browser.reorderPostImages(draft_id, ordered_indexes);
        return {
          content: [{
            type: "text" as const,
            text: `最终顺序：${result.media.map(item => `${item.order}:${item.fileName}`).join(" → ")}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_replace_post_image",
    {
      title: "替换图集草稿中的图片",
      description: "按 0 基索引替换一张持久草稿图片，其他顺序不变；不会上传。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        index: z.number().int().min(0).max(34),
        image_path: z.string(),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, index, image_path }) => {
      try {
        const result = await browser.replacePostImage(draft_id, index, image_path);
        return {
          content: [{ type: "text" as const, text: `已替换索引 ${index}：${result.media[index]?.fileName}` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_remove_post_image",
    {
      title: "删除图集草稿中的图片",
      description: "按 0 基索引从持久草稿删除一张图片；不会操作页面或其他图片。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        index: z.number().int().min(0).max(34),
        confirm_remove: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, index, confirm_remove }) => {
      try {
        if (!confirm_remove) throw new Error("POST_IMAGE_REMOVE_CONFIRMATION_REQUIRED");
        const result = await browser.removePostImage(draft_id, index);
        return {
          content: [{ type: "text" as const, text: `已删除索引 ${index}；剩余 ${result.imageCount} 张。` }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_set_post_caption",
    {
      title: "设置图集标题和文案",
      description: "把标题或文案写入持久草稿并回读；不会立即写页面，后续 preview 会统一同步。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        caption: z.string().max(1000).optional(),
        title: z.string().max(20).optional(),
      }).refine(value => value.caption !== undefined || value.title !== undefined, {
        message: "caption 与 title 至少提供一项。",
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, caption, title }) => {
      try {
        const result = await browser.setPostCaption(draft_id, { caption, title });
        return {
          content: [{
            type: "text" as const,
            text: `标题：${result.title || "无"}\n文案：${result.caption || "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_post_caption",
    {
      title: "读取图集标题和文案",
      description: "按 draft_id 纯读取 SQLite 中的标题、文案和页面同步状态。",
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ draft_id }) => {
      try {
        const result = await browser.getPostDraft(draft_id);
        return {
          content: [{
            type: "text" as const,
            text: `标题：${result.title || "无"}\n文案：${result.caption || "无"}\n页面已同步：${result.pageSynced}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_set_post_cover_index",
    {
      title: "设置图集封面索引",
      description: "按 0 基索引选择封面；图集网页以首图为封面，因此工具会把该图片稳定移动到索引 0 并回读最终顺序。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        index: z.number().int().min(0).max(34),
        confirm_reorder: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, index, confirm_reorder }) => {
      try {
        if (index !== 0 && !confirm_reorder) {
          throw new Error("POST_COVER_REORDER_CONFIRMATION_REQUIRED");
        }
        const result = await browser.setPostCoverIndex(draft_id, index);
        return {
          content: [{
            type: "text" as const,
            text: `封面索引：${result.coverIndex}\n最终顺序：${result.media.map(item => item.fileName).join(" → ")}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_post_cover_index",
    {
      title: "读取图集封面索引",
      description: "纯读取持久草稿的封面索引和首图。",
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ draft_id }) => {
      try {
        const result = await browser.getPostDraft(draft_id);
        return {
          content: [{
            type: "text" as const,
            text: `封面索引：${result.coverIndex ?? "未显式选择"}\n首图：${result.media[0]?.fileName ?? "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_music_picker",
    {
      title: "打开当前发布页音乐选择器",
      description: "支持持久图集和原生文字作品。图集提供 draft_id 时先安全认领草稿；文字作品不要求 draft_id。只打开并读取候选，不自动选歌或发布。",
      inputSchema: z.object({
        draft_id: z.string().uuid().optional(),
        confirm_replace_page_draft: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, confirm_replace_page_draft, include_screenshot_base64 }) => {
      try {
        const result = draft_id
          ? await browser.openPostMusicPicker(draft_id, confirm_replace_page_draft)
          : await browser.openMusicPicker();
        return compactArtifactResult(
          result,
          JSON.stringify({ items: result.items, selected: result.selected }, null, 2),
          include_screenshot_base64,
        );
      } catch (error) {
        const diagnostics = await browser.debugPostMusicPicker(draft_id)
          .catch(() => null);
        return errorResult(error, diagnostics
          ? {
              diagnostics: include_screenshot_base64
                ? diagnostics
                : omitScreenshotBase64(diagnostics),
            }
          : {});
      }
    },
  );

  registerTool(
    "douyin_close_music_picker",
    {
      title: "关闭音乐选择器",
      description: "关闭当前 publisher 音乐弹窗并回读确认弹窗已消失；不会改变已选音乐。必须走写能力网关。",
      inputSchema: z.object({ confirm_close: z.literal(true) }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await browser.closeMusicPicker();
        return {
          content: [{
            type: "text" as const,
            text: `弹窗已关闭：${result.closed}\n当前音乐：${result.selected?.title ?? "无"}`,
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_debug_music_picker",
    {
      title: "诊断 publisher 音乐选择器",
      description: "纯读取并硬绑定 publisher/page-publisher，返回发布页、编辑器、扩展信息、音乐入口、弹层、搜索框、候选列表与截图诊断；不点击、不改草稿、不发布。",
      inputSchema: z.object({
        draft_id: z.string().uuid().optional(),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ draft_id, include_screenshot_base64 }) => {
      try {
        const result = await browser.debugPostMusicPicker(draft_id);
        return compactArtifactResult(
          result,
          JSON.stringify({
              code: result.code,
              publisherUrl: result.publisherUrl,
              draftPageVerified: result.draftPageVerified,
              pickerOpen: result.pickerOpen,
              musicEntryFound: result.musicEntryFound,
              candidateCount: result.candidateCount,
              screenshotPath: result.screenshotPath,
          }, null, 2),
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_selected_music",
    {
      title: "读取图集草稿已选音乐",
      description: "按 draft_id 纯读取已持久化并经页面回读的音乐；不会打开选择器。",
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ draft_id }) => {
      try {
        const result = await browser.getSelectedPostMusic(draft_id);
        return {
          content: [{
            type: "text" as const,
            text: result.selected ? JSON.stringify(result.selected, null, 2) : "未选择音乐",
          }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_preview_post",
    {
      title: "同步并预览持久图集草稿",
      description: "按 draft_id 将完整图片顺序、标题、文案和音乐同步到发布页，逐项回读并持久化 prepared operation_id。不会点击发布。存在旧页面草稿时默认失败关闭。",
      inputSchema: z.object({
        draft_id: z.string().uuid(),
        confirm_replace_page_draft: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, confirm_replace_page_draft, include_screenshot_base64 }) => {
      try {
        const result = await browser.previewPost(
          draft_id,
          confirm_replace_page_draft,
        );
        return compactArtifactResult(result, [
                `draft_id：${result.draftId}`,
                `operation_id：${result.operationId}`,
                `图片：${result.imageCount}`,
                `顺序：${result.imageOrder.join(" → ")}`,
                `标题：${result.title || "无"}`,
                `文案：${result.caption || "无"}`,
                `音乐：${result.music?.title ?? "未选择"}`,
                `封面索引：${result.coverIndex ?? "首图"}`,
                `可发布：${result.readyToPublish}`,
                `页面：${result.pageUrl}`,
                `截图：${result.screenshotPath}`,
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_publish_post",
    {
      title: "提交已预览图集",
      description: "只接受 preview 返回的 operation_id。点击前先以 SQLite 原子写 publish_clicked，整个事务最多点击一次；不确定时进入 unknown_after_submit，绝不自动重复发布。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        confirm_publish: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, confirm_publish, include_screenshot_base64 }) => {
      try {
        const result = await browser.publishPost(operation_id, confirm_publish);
        return compactArtifactResult(result, [
                `状态：${result.state}`,
                `已点击：${result.clicked}`,
                `点击次数：${result.clickCount}`,
                `已确认发布：${result.published}`,
                `可能已提交：${result.possibleSubmit}`,
                `响应：${result.responseStatus ?? "无"} / ${result.responseCode ?? "无"}`,
                `work_id：${result.resultingWorkId ?? "无"}`,
                `work_url：${result.resultingWorkUrl ?? "无"}`,
                `错误：${result.lastError ?? "无"}`,
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const notificationFilterSchema = z.enum([
    "all", "mentions", "comments", "followers", "likes", "recommendations",
  ]);

  registerTool(
    "douyin_list_notifications",
    {
      title: "读取通知中心",
      description: "从通知中心 React 稳定字段读取并按 notice_id 去重；DOM 文本只作展示兜底。不会推进本地 checkpoint。打开通知面板可能被网页标记已读，结果会明确返回 uiMayMarkSeen=true。",
      inputSchema: z.object({
        filter: notificationFilterSchema.default("all"),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).optional(),
        response_mode: z.enum(["compact", "full"]).default("compact"),
        include_unavailable: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ filter, limit, cursor, response_mode, include_unavailable }) => {
      try {
        const result = await browser.listNotifications({
          filter,
          limit,
          cursor,
          responseMode: response_mode,
          includeUnavailable: include_unavailable,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_check_notification_updates",
    {
      title: "检查本地 checkpoint 后的新通知",
      description: "按稳定 notice_id 对比本地 SQLite checkpoint；只返回候选，不自动确认，也不改变抖音网页已读状态。",
      inputSchema: z.object({
        filter: notificationFilterSchema.default("all"),
        limit: z.number().int().min(1).max(100).default(20),
        response_mode: z.enum(["compact", "full"]).default("compact"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ filter, limit, response_mode }) => {
      try {
        const result = await browser.checkNotificationUpdates({
          filter,
          limit,
          responseMode: response_mode,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_ack_notification_checkpoint",
    {
      title: "确认本地通知 checkpoint",
      description: "仅幂等更新本地 SQLite checkpoint，不操作抖音网页已读状态。只能确认已成功解析的 notice_id 或检查工具返回的候选。",
      inputSchema: z.object({
        checkpoint_candidate: z.string().uuid().optional(),
        notice_ids: z.array(z.string().regex(/^\d{8,24}$/)).max(100).optional(),
        confirm_ack: z.literal(true),
      }).refine(value => Boolean(value.checkpoint_candidate || value.notice_ids?.length), {
        message: "checkpoint_candidate 或 notice_ids 至少提供一个",
      }),
      annotations: LOCAL_STATE_ANNOTATIONS,
    },
    async ({ checkpoint_candidate, notice_ids, confirm_ack }) => {
      try {
        const result = browser.acknowledgeNotificationCheckpoint({
          checkpointCandidate: checkpoint_candidate,
          noticeIds: notice_ids,
          confirmAck: confirm_ack,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_notification",
    {
      title: "按 notice_id 精确回读通知",
      description: "按稳定 notice_id 重新扫描通知中心，不依赖当前排序、数组位置或虚拟列表索引。",
      inputSchema: z.object({ notice_id: z.string().regex(/^\d{8,24}$/) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ notice_id }) => {
      try {
        const item = await browser.getNotification(notice_id);
        const result = { canonicalPack: "notifications", item, uiMayMarkSeen: true };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_open_notification_target",
    {
      title: "打开并互证通知精确目标",
      description: "只导航独立 notification_target 页面，按冻结 notice_id、interact_type、work_id 和 comment_id 互证，不执行任何社交写入。",
      inputSchema: z.object({ notice_id: z.string().regex(/^\d{8,24}$/) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ notice_id }) => {
      try {
        const result = await browser.openNotificationTarget(notice_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_prepare_reply_from_notification",
    {
      title: "从精确通知准备回复事务",
      description: "仅 prepare：评论通知冻结 work_id+comment_id；作品 @ 通知冻结 work_id 并准备根评论。点赞、关注和推荐返回 not_replyable。绝不自动 commit。",
      inputSchema: z.object({
        notice_id: z.string().regex(/^\d{8,24}$/),
        text: z.string().min(1).max(500),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ notice_id, text }) => {
      try {
        const result = await browser.prepareReplyFromNotification({ noticeId: notice_id, text });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const publisherMusicSchema = z.object({
    id: z.string().min(1),
    pageId: z.string().nullable().optional(),
    idSource: z.enum(["page", "derived"]).optional(),
    title: z.string().min(1),
    author: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    duration: z.string().nullable().default(null),
  });

  registerTool(
    "douyin_publish_content",
    {
      title: "统一准备或发布作品",
      description: "Publisher V2 唯一写入口。content_type 明确路由；内部完成持久化、正确页面切换、上传、语义核验、最多一次点击和独立回查。当前稳定支持 carousel；其他类型会明确返回不支持，绝不误路由到文章。",
      inputSchema: z.object({
        content_type: z.enum(["text", "carousel", "article", "video"]),
        title: z.string().max(100).default(""),
        caption: z.string().max(8_000).default(""),
        images: z.array(z.string().min(1)).max(35).default([]),
        hashtags: z.array(z.string().min(1).max(50)).max(10).default([]),
        mentions: z.array(z.object({
          alias: z.literal("bound_user"),
          placement: z.enum(["caption_start", "caption_end"]),
        })).max(2).default([]).describe(
          "仅允许已绑定 bound_user/Bound User；uid/sec_uid 由本地配置解析并冻结，不接受调用方提供。",
        ),
        music: publisherMusicSchema.nullable().optional(),
        visibility: z.enum(["public", "friends", "private"]).default("public"),
        scheduled_at: z.string().datetime().nullable().default(null),
        action: z.enum(["prepare", "publish"]).default("prepare"),
        confirm_publish: z.boolean().default(false),
        replace_existing_page_draft: z.boolean().default(false)
          .describe("仅在确认覆盖当前网页图文草稿时启用；错误类型页面的路由切换不需要此开关。"),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ content_type, title, caption, images, hashtags, mentions, music, visibility, scheduled_at,
      action, confirm_publish, replace_existing_page_draft, include_screenshot_base64 }) => {
      try {
        const result = await browser.publishContentV2({
          contentType: content_type,
          title,
          caption,
          imagePaths: images,
          hashtags,
          mentions,
          music: music ?? null,
          visibility,
          scheduledAt: scheduled_at,
          action,
          confirmPublish: confirm_publish,
          replaceExistingPageDraft: replace_existing_page_draft,
        });
        return compactArtifactResult(
          result,
          JSON.stringify({ ...result, screenshot_base64: undefined }, null, 2),
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_get_publish_status",
    {
      title: "回查发布状态",
      description: "读取 Publisher V2 事务；对可能已提交的操作使用独立只读页稳定回查，不依赖共享主页标签。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        reconcile: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operation_id, reconcile }) => {
      try {
        const result = await browser.getPublishStatusV2(operation_id, reconcile);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_recover_publish",
    {
      title: "恢复发布事务",
      description: "回查、确认未发送、恢复或终止发布事务。legacy 操作在独立回查与编辑器证据确认未发送后，可用 resume 迁移到 Publisher V2；迁移后旧事务标记 superseded 并退出 pending。",
      inputSchema: z.object({
        operation_id: z.string().uuid(),
        action: z.enum(["reconcile", "confirm_not_sent", "abort", "resume"]).default("reconcile"),
        confirm: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ operation_id, action, confirm }) => {
      try {
        const result = await browser.recoverPublishV2(operation_id, action, confirm);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_publish_operations",
    {
      title: "列出发布事务",
      description: "统一列出最近的 Publisher V2 与 legacy 发布操作，以 storage 和 legacy_operation 标明来源，避免启动自检与事务列表口径不一致。",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      try {
        const result = browser.listPublishOperationsV2(limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  for (const toolName of ["douyin_upload_article_cover", "douyin_select_article_cover"] as const) {
    registerTool(
      toolName,
      {
        title: toolName.includes("upload") ? "上传文章封面" : "选择文章封面",
        description: "校验本地图片存在、格式和大小，上传到已绑定的当前文章编辑器并等待真实缩略图出现；不导航或重开发布页。",
        inputSchema: z.object({
          cover_path: z.string().min(1),
          include_screenshot_base64: z.boolean().default(false),
        }),
        annotations: SAFE_ACTION_ANNOTATIONS,
      },
      async ({ cover_path, include_screenshot_base64 }) => {
        try {
          const result = await browser.uploadArticleCover(cover_path);
          return compactArtifactResult(
            result,
            `封面已选择：${result.selected}\n缩略图：${result.thumbnailCount}\n来源：${result.source ?? "未知"}\n截图：${result.screenshotPath}`,
            include_screenshot_base64,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  registerTool(
    "douyin_verify_article_cover",
    {
      title: "核验文章封面",
      description: "纯读取核验当前绑定文章编辑器是否真实显示封面缩略图。",
      inputSchema: z.object({ include_screenshot_base64: z.boolean().default(false) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ include_screenshot_base64 }) => {
      try {
        const result = await browser.verifyArticleCover();
        return compactArtifactResult(
          result,
          `封面已选择：${result.selected}\n缩略图：${result.thumbnailCount}\n截图：${result.screenshotPath}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_remove_article_cover",
    {
      title: "移除当前文章封面",
      description: "只移除当前绑定编辑器的文章封面，并核验缩略图消失；不影响正文、话题或音乐。",
      inputSchema: z.object({
        confirm_remove: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ confirm_remove, include_screenshot_base64 }) => {
      try {
        if (!confirm_remove) throw new Error("移除封面必须提供 confirm_remove=true。");
        const result = await browser.removeArticleCover();
        return compactArtifactResult(
          result,
          `封面已选择：${result.selected}\n截图：${result.screenshotPath}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_inspect_current_draft",
    {
      title: "检查当前文章草稿",
      description: "纯读取当前绑定发布页状态：标题/正文完整性、标签、封面、当前音乐、弹窗、预览、发布状态与不确定状态。默认只返回截图路径；显式要求才返回 Base64。",
      inputSchema: z.object({
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ include_screenshot_base64 }) => {
      try {
        const result = await browser.inspectCurrentDraft();
        return compactArtifactResult(result, [
          `标题完整：${result.titleComplete}`,
          `正文完整：${result.textComplete}`,
          `标签：${result.hashtags.join("、") || "无"}`,
          `封面：${result.coverCount > 0}`,
          `当前音乐：${result.currentMusic?.title ?? "无"}`,
          `有弹窗：${result.hasPopup}`,
          `已到预览：${result.previewReached}`,
          `已发布：${result.published}`,
          `状态不明：${result.uncertain}`,
          `work_id：${result.workId ?? "无"}`,
          `work_url：${result.workUrl ?? "无"}`,
          `截图：${result.screenshotPath}`,
          `警告：${result.warnings.join("；") || "无"}`,
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_fill_text_draft",
    {
      title: "只填写当前文字草稿",
      description: "可续跑 fill_text 步骤。只填写并回读标题、正文和标签；已有内容完全一致时不重复填写，不选择音乐、不点预览、不发布。",
      inputSchema: z.object({
        text: z.string().min(1).max(8000),
        title: z.string().min(1).max(30).optional(),
        hashtags: z.array(z.string().min(1).max(50)).max(5).default([]),
        confirm_fill: z.literal(true),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ text, title, hashtags, include_screenshot_base64 }) => {
      try {
        const result = await browser.fillTextDraft({ text, title, hashtags });
        return compactArtifactResult(result, [
          `状态：${result.status}`,
          `标题校验：${result.verifiedTitle}`,
          `正文校验：${result.verifiedText}`,
          `仅完成步骤：fill_text`,
          `截图：${result.screenshotPath}`,
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_preview_text_draft",
    {
      title: "只预览当前文字草稿",
      description: "可续跑 preview 步骤。只在当前标题、正文和标签与预期完全一致时进入并回读预览；不会重新填写。成功必须返回 preview_id。音乐默认可选。",
      inputSchema: z.object({
        text: z.string().min(1).max(8000),
        title: z.string().min(1).max(30).optional(),
        hashtags: z.array(z.string().min(1).max(50)).max(5).default([]),
        music_required: z.boolean().default(false),
        confirm_preview: z.literal(true),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ text, title, hashtags, music_required, include_screenshot_base64 }) => {
      try {
        const result = await browser.previewTextDraft({
          text,
          title,
          hashtags,
          musicRequired: music_required,
        });
        return compactArtifactResult(result, [
          `状态：${result.status}`,
          `预览回读：${result.previewReached}`,
          `本次点击预览：${result.previewClicked ?? false}`,
          `preview_id：${result.previewId ?? "无"}`,
          `截图：${result.screenshotPath}`,
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_verify_text_publish",
    {
      title: "回查文字作品发布结果",
      description: "可续跑 verify_publish 步骤。只读回查主页和作品详情；只有同时取得 work_id、work_url 与内容证据时才返回 published=true。不会重复点击发布。",
      inputSchema: z.object({
        preview_id: z.string().uuid(),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ preview_id, include_screenshot_base64 }) => {
      try {
        const result = await browser.verifyTextPublish(preview_id);
        return compactArtifactResult(result, [
          `状态：${result.status}`,
          `published：${result.published}`,
          `uncertain：${result.uncertain ?? false}`,
          `work_id：${result.work_id ?? "无"}`,
          `work_url：${result.work_url ?? "无"}`,
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_publish_text_draft",
    {
      title: "只发布已预览文字草稿",
      description: "可续跑 publish 步骤。只接受 preview 返回的 preview_id；发布前重新核验当前草稿和锁定快照，不重新填写。点击前即锁定为已尝试，结果不明时返回 uncertain 并禁止盲目重试。",
      inputSchema: z.object({
        text: z.string().min(1).max(8000),
        title: z.string().min(1).max(30).optional(),
        hashtags: z.array(z.string().min(1).max(50)).max(5).default([]),
        preview_id: z.string().uuid(),
        confirm_publish: z.literal(true),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ text, title, hashtags, preview_id, include_screenshot_base64 }) => {
      try {
        const result = await browser.publishText({
          text,
          title,
          hashtags,
          previewId: preview_id,
          action: "publish",
          confirmPublish: true,
        });
        return compactArtifactResult(result, [
          `状态：${result.status}`,
          `published：${result.published}`,
          `uncertain：${result.uncertain ?? false}`,
          `work_id：${result.work_id ?? "无"}`,
          `work_url：${result.work_url ?? "无"}`,
          result.uncertain ? "禁止重复点击；下一步调用 douyin_verify_text_publish。" : "发布结果已完成回读。",
        ].join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_reset_current_draft",
    {
      title: "安全重置当前文章草稿",
      description: "仅清空已绑定当前编辑器中的标题、正文、图片、封面、话题、音乐和发布设置。不会删除已发布作品；必须 confirm_reset=true。",
      inputSchema: z.object({
        confirm_reset: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ confirm_reset, include_screenshot_base64 }) => {
      try {
        const result = await browser.resetCurrentDraft(confirm_reset);
        return compactArtifactResult(
          result,
          `重置后污染：${result.contaminated}\n截图：${result.screenshotPath}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_recommended_music",
    {
      title: "列出推荐音乐",
      description: "纯读取当前发布页的推荐音乐，返回稳定 music_id、歌名、作者、版本、时长和选中状态；不会自动选择。",
      inputSchema: z.object({ include_screenshot_base64: z.boolean().default(false) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ include_screenshot_base64 }) => {
      try {
        const result = await browser.listRecommendedMusic();
        return compactArtifactResult(result, JSON.stringify(result.items, null, 2), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_search_music",
    {
      title: "搜索音乐",
      description: "搜索音乐并返回候选；提供 draft_id 时使用持久图集工作流，不提供时兼容旧的当前页面工作流。不会自动选择。",
      inputSchema: z.object({
        query: z.string().min(1).max(100),
        draft_id: z.string().uuid().optional(),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ query, draft_id, include_screenshot_base64 }) => {
      try {
        const result = draft_id
          ? await browser.searchPostMusic(draft_id, query)
          : await browser.searchMusic(query);
        return compactArtifactResult(result, JSON.stringify({
          query,
          candidateCount: result.items.length,
          items: result.items,
          selected: result.selected,
          screenshotPath: screenshotPathOf(result),
        }, null, 2), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_preview_music",
    {
      title: "试听指定音乐",
      description: "按稳定 music_id 试听，不选择音乐。",
      inputSchema: z.object({
        music_id: z.string().min(1),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ music_id, include_screenshot_base64 }) => {
      try {
        const result = await browser.previewMusic(music_id);
        return compactArtifactResult(
          result,
          `已试听 ${music_id}，当前选中：${result.selected?.id ?? "无"}\n截图：${result.screenshotPath}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_select_music",
    {
      title: "选择指定音乐",
      description: "按稳定 music_id 选择并回读；提供 draft_id 时同步写入持久图集草稿，不提供时兼容旧的当前页面工作流。",
      inputSchema: z.object({
        music_id: z.string().min(1).optional(),
        candidate_index: z.number().int().min(0).optional(),
        title: z.string().min(1).max(200).optional(),
        author: z.string().min(1).max(200).optional(),
        duration: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
        draft_id: z.string().uuid().optional(),
        confirm_select: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }).refine(value => value.music_id != null
        || value.candidate_index != null
        || value.title != null
        || value.author != null
        || value.duration != null, {
        message: "music_id, candidate_index, or title/author/duration is required",
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ music_id, candidate_index, title, author, duration, draft_id, confirm_select, include_screenshot_base64 }) => {
      try {
        if (!confirm_select) throw new Error("选择音乐必须提供 confirm_select=true。");
        const selector = {
          id: music_id,
          index: candidate_index,
          title,
          author,
          duration,
        };
        const result = draft_id
          ? await browser.selectPostMusic(draft_id, selector)
          : await browser.selectMusic(selector);
        return compactArtifactResult(
          result,
          `已选中：${result.selected?.title ?? "未核验"}\n页面真实 ID：${result.selected?.pageId ?? result.selected?.id ?? "无"}\n截图：${screenshotPathOf(result)}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_remove_music",
    {
      title: "移除当前音乐",
      description: "移除当前 publisher 草稿音乐并核验不再选中；提供 draft_id 时同步更新持久图集草稿。",
      inputSchema: z.object({
        draft_id: z.string().uuid().optional(),
        confirm_remove: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ draft_id, confirm_remove, include_screenshot_base64 }) => {
      try {
        if (!confirm_remove) throw new Error("移除音乐必须提供 confirm_remove=true。");
        const result = draft_id
          ? await browser.removePostMusic(draft_id)
          : await browser.removeMusic();
        return compactArtifactResult(
          result,
          `当前选中：${result.selected?.id ?? "无"}\n截图：${screenshotPathOf(result)}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_verify_music",
    {
      title: "核验当前音乐",
      description: "纯读取核验当前作品挂载的音乐。",
      inputSchema: z.object({ include_screenshot_base64: z.boolean().default(false) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ include_screenshot_base64 }) => {
      try {
        const result = await browser.verifyMusic();
        return compactArtifactResult(
          result,
          `当前选中：${result.selected ? JSON.stringify(result.selected) : "无"}\n截图：${result.screenshotPath}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_render_html_carousel",
    {
      title: "将 HTML 渲染为抖音图片图集",
      description: "在隔离的无头浏览器中把每个 data-slide 元素渲染成独立 PNG，并生成联系表。默认禁用脚本和外部网络；此工具不会连接抖音或上传文件。",
      inputSchema: z.object({
        html: z.string().max(1_500_000).optional(),
        html_path: z.string().optional().describe("本地 HTML 文件绝对路径"),
        output_dir: z.string().optional().describe("输出父目录绝对路径；每次创建独立子目录"),
        slide_selector: z.string().min(1).max(500).default("[data-slide]"),
        width: z.number().int().min(320).max(4096).default(1080),
        height: z.number().int().min(320).max(4096).default(1440),
        device_scale_factor: z.number().min(0.5).max(4).default(1),
        allow_scripts: z.boolean().default(false),
        wait_timeout_ms: z.number().int().min(1000).max(60000).default(15000),
      }).refine(value => Boolean(value.html) !== Boolean(value.html_path), {
        message: "html 与 html_path 必须且只能提供一个。",
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({
      html,
      html_path,
      output_dir,
      slide_selector,
      width,
      height,
      device_scale_factor,
      allow_scripts,
      wait_timeout_ms,
    }) => {
      try {
        const result = await renderHtmlCarousel({
          html,
          htmlPath: html_path,
          outputDir: output_dir,
          slideSelector: slide_selector,
          width,
          height,
          deviceScaleFactor: device_scale_factor,
          allowScripts: allow_scripts,
          waitTimeoutMs: wait_timeout_ms,
        });
        const preview = await fs.readFile(result.previewContactSheetPath);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `页数：${result.pageCount}`,
                `尺寸：${result.width}×${result.height}`,
                `输出目录：${result.outputDir}`,
                `原始 HTML：${result.sourceHtmlPath}`,
                `图片：\n${result.imagePaths.join("\n")}`,
                `联系表：${result.previewContactSheetPath}`,
                `诊断：${result.diagnosticsPath}`,
                result.warnings.length ? `警告：\n${result.warnings.join("\n")}` : "警告：无",
              ].join("\n"),
            },
            { type: "image" as const, data: preview.toString("base64"), mimeType: "image/png" as const },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_publish_text",
    {
      title: "准备或发布原生文字作品",
      description: "兼容编排入口。会识别并保留已校验草稿，不重复填写。music_query 只搜索并返回当前候选，music_id 只接受本次页面候选 ID；音乐默认可选，失败不阻断预览。建议优先使用 inspect_current_draft → fill_text_draft → select_music → preview_text_draft → publish → verify_text_publish。",
      inputSchema: z.object({
        text: z.string().min(1).max(8000),
        title: z.string().min(1).max(30).optional(),
        hashtags: z.array(z.string().min(1).max(50)).max(5).default([]),
        cover_path: z.string().optional().describe("可选的本地封面图片绝对路径"),
        music_query: z.string().min(1).max(100).optional()
          .describe("preview 可选：搜索并仅在歌名唯一精确匹配时选择"),
        music_id: z.string().min(1).optional()
          .describe("preview 可选：从当前页面搜索结果中精确选择候选真实 ID"),
        music_required: z.boolean().default(false)
          .describe("默认 false；音乐未找到或未选择时仍允许继续预览"),
        preview_id: z.string().uuid().optional().describe("preview 阶段返回的锁定快照 ID"),
        action: z.enum(["preview", "publish"]).default("preview"),
        confirm_publish: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ text, title, hashtags, cover_path, music_query, music_id, music_required, preview_id, action, confirm_publish, include_screenshot_base64 }) => {
      try {
        const result = await browser.publishText({
          text,
          title,
          hashtags,
          coverPath: cover_path,
          musicQuery: music_query,
          musicId: music_id,
          musicRequired: music_required,
          previewId: preview_id,
          action,
          confirmPublish: confirm_publish,
        });
        return compactArtifactResult(result, [
                `状态：${result.status}`,
                `页面：${result.pageUrl}`,
                `入口：${result.detectedEntry ?? "未检测到"}`,
                `找到入口：${result.entryFound}`,
                `找到编辑器：${result.editorFound}`,
                `填入成功：${result.contentFilled}`,
                `到达预览：${result.previewReached}`,
                `标题：${result.title ?? "页面无独立标题"}`,
                `正文校验：${result.verifiedText}`,
                `标题校验：${result.verifiedTitle}`,
                `已公开发布：${result.published}`,
                `状态不明：${result.uncertain ?? false}`,
                `preview_id：${result.previewId ?? "无"}`,
                `绑定 page_id：${result.pageId ?? "无"}`,
                `绑定 target_id：${result.pageTargetId ?? "无"}`,
                `缺失项：${result.missing?.join(", ") || "无"}`,
                `work_id：${result.work_id ?? "无"}`,
                `work_url：${result.work_url ?? "无"}`,
                `音乐步骤：${result.musicSelectionStatus ?? "not_requested"}`,
                `音乐候选：${result.musicCandidates?.length ?? 0}`,
                `音乐错误：${result.musicError ?? "无"}`,
                `截图：${result.screenshotPath}`,
                `诊断：${result.diagnosticsPath}`,
                `错误码：${result.errorCode ?? "无"}`,
                result.errorMessage ? `错误步骤：${result.errorStep}\n错误：${result.errorMessage}` : "",
        ].filter(Boolean).join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_publish_carousel",
    {
      title: "准备或发布图片图集",
      description: "按输入顺序校验并上传本地图片到“发布图文”，核对数量和顺序，填写标题/描述/话题。默认 preview；公开发布必须同时 action=publish 且 confirm_publish=true。",
      inputSchema: z.object({
        image_paths: z.array(z.string()).min(1).max(35),
        caption: z.string().max(2000).optional(),
        title: z.string().max(100).optional(),
        hashtags: z.array(z.string().min(1).max(50)).max(5).default([]),
        action: z.enum(["preview", "publish"]).default("preview"),
        confirm_publish: z.boolean().default(false),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ image_paths, caption, title, hashtags, action, confirm_publish, include_screenshot_base64 }) => {
      try {
        const result = await browser.publishCarousel({
          imagePaths: image_paths,
          caption,
          title,
          hashtags,
          action,
          confirmPublish: confirm_publish,
        });
        return compactArtifactResult(result, [
                `状态：${result.status}`,
                `页面：${result.pageUrl}`,
                `上传数量：${result.pageImageCount}/${result.expectedCount}`,
                `页面数量文字：${result.addedCountText ?? "未识别"}`,
                `上传缩略图卡片：${result.thumbnailCount}`,
                `验证信号：${result.verificationSignals.join("；") || "无"}`,
                `顺序校验：${result.orderVerified}`,
                `最终顺序：${result.finalOrder.join(" → ") || "未验证"}`,
                `已公开发布：${result.published}`,
                `截图：${result.screenshotPath}`,
                `诊断：${result.diagnosticsPath}`,
                `错误码：${result.errorCode ?? "无"}`,
                result.errorMessage ? `错误步骤：${result.errorStep}\n错误：${result.errorMessage}` : "",
        ].filter(Boolean).join("\n"), include_screenshot_base64);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_publish_video",
    {
      title: "预留：发布视频",
      description: "预留能力，默认关闭。",
      inputSchema: z.object({ file_path: z.string(), caption: z.string().max(2_000).optional() }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async () => disabledFeature("publishVideo"),
  );

  registerTool(
    "douyin_publish_article",
    {
      title: "兼容：准备文字或图文发布预览",
      description: "兼容旧调用，始终只进入预览：有 image_paths 时调用图片图集预览，否则调用原生文字作品预览。不会公开发布。",
      inputSchema: z.object({
        title: z.string(),
        text: z.string(),
        image_paths: z.array(z.string()).optional(),
        include_screenshot_base64: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ title, text, image_paths, include_screenshot_base64 }) => {
      try {
        if (image_paths?.length) {
          const result = await browser.publishCarousel({
            imagePaths: image_paths,
            title,
            caption: text,
            action: "preview",
            confirmPublish: false,
          });
          return compactArtifactResult(
            { deprecated: true, replacement: "douyin_publish_carousel", ...result },
            `兼容层已调用 douyin_publish_carousel，状态：${result.status}\n不会公开发布。\n截图：${result.screenshotPath}`,
            include_screenshot_base64,
          );
        }
        const result = await browser.publishText({
          title,
          text,
          action: "preview",
          confirmPublish: false,
        });
        return compactArtifactResult(
          { deprecated: true, replacement: "douyin_publish_text", ...result },
          `兼容层已调用 douyin_publish_text，状态：${result.status}\n不会公开发布。\n截图：${result.screenshotPath}`,
          include_screenshot_base64,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_read_own_work_comments",
    {
      title: "读取自己的作品评论",
      description: "只读取已绑定 Operator 正式页上、作者校验为 Operator 的当前作品评论。",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      try {
        const result = await browser.readOwnWorkComments(limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.comments, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_unread_comments",
    {
      title: "列出未读评论",
      description: "读取已绑定 Operator 正式页当前自己作品的未读评论提示。无法可靠识别未读标记时返回空列表，不猜测。",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      try {
        const result = await browser.listUnreadComments(limit);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.comments, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "douyin_list_capability_packs",
    {
      title: "列出按需功能包",
      description: "只返回功能包目录、用途、依赖和工具数量。模型可根据当前任务自行选择并加载，不预设行为条件。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (extra) => {
      const packs = CAPABILITY_PACK_NAMES.map(name => ({
        name,
        title: CAPABILITY_PACKS[name].title,
        description: CAPABILITY_PACKS[name].description,
        dependencies: CAPABILITY_PACKS[name].dependencies,
        toolCount: CAPABILITY_PACKS[name].tools.length,
        selected: selectedPacks().has(name),
        active: activePacks().has(name),
      }));
      return {
        content: [{
          type: "text" as const,
          text: packs.map(pack =>
            `${pack.name}（${pack.toolCount}）：${pack.description}`).join("\n"),
        }],
        structuredContent: {
          packs,
          activePacks: [...activePacks()],
          ...runtimeMetadata(extra),
          note: "功能包选择按当前私有浏览器配置持久化，并在新的 MCP 连接中恢复。调用 load 后会发送 tools/list_changed；只读兼容调用使用 douyin_call_capability_tool，写操作使用显式确认的 douyin_call_write_capability_tool。隐藏工具不会被直接调用自动加载。",
        },
      };
    },
  );

  registerTool(
    "douyin_load_capability_pack",
    {
      title: "按需加载功能包",
      description: "加载一个或多个功能包及其依赖。默认只返回工具名以减少上下文；include_schemas=true 时才返回完整说明和 JSON Schema。replace=true 会先卸载其他非核心包。",
      inputSchema: z.object({
        packs: z.array(z.enum(CAPABILITY_PACK_NAMES)).min(1),
        replace: z.boolean().default(false),
        include_schemas: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ packs, replace, include_schemas }, extra) => {
      try {
        capabilityRuntime.load(packs, replace);
        refreshPackSelection();
        const enabledTools = applyCapabilityVisibility(true, extra.requestId);
        const active = [...activePacks()];
        return {
          content: [{
            type: "text" as const,
            text: `已加载：${active.join(", ")}\n当前可见工具：${enabledTools.length}`,
          }],
          structuredContent: {
            activePacks: active,
            enabledToolCount: enabledTools.length,
            enabledTools,
            ...(include_schemas
              ? {
                  packTools: Object.fromEntries(active.map(name => [
                    name,
                    describePackTools(name),
                  ])),
                }
              : {}),
            schemasIncluded: include_schemas,
            toolListChanged: true,
            fallbackTool: "douyin_call_capability_tool",
            ...runtimeMetadata(extra),
          },
        };
      } catch (error) {
        return errorResult(error, runtimeMetadata(extra));
      }
    },
  );

  registerTool(
    "douyin_unload_capability_pack",
    {
      title: "卸载功能包",
      description: "从当前 MCP 会话移除一个或多个已选择功能包；仍被其他包依赖的功能会继续可用。",
      inputSchema: z.object({
        packs: z.array(z.enum(CAPABILITY_PACK_NAMES)).min(1),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async ({ packs }, extra) => {
      try {
        removePackSelection(packs);
        const enabledTools = applyCapabilityVisibility(true, extra.requestId);
        return {
          content: [{
            type: "text" as const,
            text: `当前功能包：${[...activePacks()].join(", ") || "仅核心"}`,
          }],
          structuredContent: {
            activePacks: [...activePacks()],
            enabledToolCount: enabledTools.length,
            enabledTools,
            toolListChanged: true,
            ...runtimeMetadata(extra),
          },
        };
      } catch (error) {
        return errorResult(error, runtimeMetadata(extra));
      }
    },
  );

  registerTool(
    "douyin_capability_pack_status",
    {
      title: "查看功能包状态",
      description: "查看当前 MCP 会话已选择、已激活和实际可见的功能包与工具。",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (extra) => {
      const enabledTools = [...toolDefinitions]
        .filter(([name]) => activeToolNames().has(name))
        .map(([name]) => name)
        .sort();
      return {
        content: [{
          type: "text" as const,
          text: `已激活：${[...activePacks()].join(", ") || "仅核心"}\n可见工具：${enabledTools.length}`,
        }],
        structuredContent: {
          activePacks: [...activePacks()],
          enabledToolCount: enabledTools.length,
          enabledTools,
          ...runtimeMetadata(extra),
        },
      };
    },
  );

  registerTool(
    "douyin_invoke_capability",
    {
      title: "调用已加载功能",
      description: "兼容未响应 tools/list_changed 的客户端。只允许调用当前会话已经加载的工具，并使用该工具原始 Zod schema 校验参数。",
      inputSchema: z.object({
        tool_name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ tool_name, arguments: toolArguments }, extra) => {
      if (CORE_TOOL_NAMES.has(tool_name)
        || tool_name === "douyin_invoke_capability") {
        return errorResult(
          new Error("CAPABILITY_INVOKE_REJECTED:核心工具请直接调用。"),
          runtimeMetadata(extra),
        );
      }
      const definition = toolDefinitions.get(tool_name);
      if (!definition) {
        return errorResult(
          new Error(`CAPABILITY_UNAVAILABLE:${tool_name}`),
          runtimeMetadata(extra),
        );
      }
      const requiredPacks = packsForTool(tool_name);
      if (!activeToolNames().has(tool_name)) {
        return packNotLoadedError(requiredPacks, tool_name, extra);
      }
      if (definition.config.annotations?.readOnlyHint !== true) {
        return errorResult(
          new Error("WRITE_CAPABILITY_REQUIRES_TYPED_GATEWAY:请使用 douyin_call_write_capability_tool。"),
          runtimeMetadata(extra),
        );
      }
      const result = await invokeToolDefinition(tool_name, toolArguments, extra);
      return {
        ...result,
        structuredContent: {
          ...(result?.structuredContent ?? {}),
          ...runtimeMetadata(extra),
        },
      };
    },
  );

  registerTool(
    "douyin_call_capability_tool",
    {
      title: "固定能力网关",
      description: "不依赖客户端动态刷新工具目录的只读网关。只允许代理 readOnlyHint=true 的工具；写操作必须使用独立写网关。",
      inputSchema: z.object({
        pack: z.enum(CAPABILITY_PACK_NAMES),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        auto_load: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      pack,
      tool,
      arguments: toolArguments,
      auto_load,
    }, extra) => {
      if (CORE_TOOL_NAMES.has(tool)) {
        return errorResult(new Error(
          "CAPABILITY_GATEWAY_REJECTED:核心工具请直接调用。",
        ), runtimeMetadata(extra));
      }
      const expanded = expandCapabilityPacks([pack]);
      const allowedTools = new Set(
        [...expanded].flatMap(name => CAPABILITY_PACKS[name].tools),
      );
      if (!allowedTools.has(tool)) {
        return errorResult(new Error(
          `CAPABILITY_PACK_TOOL_MISMATCH:${pack}:${tool}`,
        ), runtimeMetadata(extra));
      }
      const definition = toolDefinitions.get(tool);
      if (!definition) {
        return errorResult(new Error(`CAPABILITY_UNAVAILABLE:${tool}`), runtimeMetadata(extra));
      }
      if (definition.config.annotations?.readOnlyHint !== true) {
        return errorResult(
          new Error("WRITE_CAPABILITY_REQUIRES_TYPED_GATEWAY:只读网关拒绝代理写工具。"),
          runtimeMetadata(extra),
        );
      }
      if (!activePacks().has(pack)) {
        if (!auto_load) return packNotLoadedError([pack], tool, extra);
        try {
          addPackSelection(pack, extra.requestId);
        } catch (error) {
          return errorResult(error, runtimeMetadata(extra));
        }
      }
      const result = await invokeToolDefinition(
        tool,
        toolArguments,
        compatibilityGatewayExtra(extra),
      );
      return {
        ...result,
        structuredContent: {
          ...(result?.structuredContent ?? {}),
          capabilityGateway: true,
          requestedPack: pack,
          activePacks: [...activePacks()],
          ...runtimeMetadata(extra),
        },
      };
    },
  );

  registerTool(
    "douyin_call_write_capability_tool",
    {
      title: "显式调用写能力",
      description: "供不支持稳定 MCP connection 或动态 tools/list 的客户端调用写工具。默认在本次已确认的网关调用内加载指定功能包；必须显式确认网关调用，原工具自身的 confirm_send/confirm_delete/confirm_publish 等门禁仍然生效。",
      inputSchema: z.object({
        pack: z.enum(CAPABILITY_PACK_NAMES),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        auto_load: z.boolean().default(true),
        confirm_gateway_write: z.literal(true),
      }),
      annotations: DESTRUCTIVE_ACTION_ANNOTATIONS,
    },
    async ({ pack, tool, arguments: toolArguments, auto_load }, extra) => {
      if (CORE_TOOL_NAMES.has(tool)) {
        return errorResult(new Error(
          "CAPABILITY_GATEWAY_REJECTED:核心工具请直接调用。",
        ), runtimeMetadata(extra));
      }
      const expanded = expandCapabilityPacks([pack]);
      const allowedTools = new Set(
        [...expanded].flatMap(name => CAPABILITY_PACKS[name].tools),
      );
      if (!allowedTools.has(tool)) {
        return errorResult(new Error(
          `CAPABILITY_PACK_TOOL_MISMATCH:${pack}:${tool}`,
        ), runtimeMetadata(extra));
      }
      const definition = toolDefinitions.get(tool);
      if (!definition) {
        return errorResult(new Error(`CAPABILITY_UNAVAILABLE:${tool}`), runtimeMetadata(extra));
      }
      if (definition.config.annotations?.readOnlyHint === true) {
        return errorResult(new Error(
          "READ_ONLY_CAPABILITY_USE_READ_GATEWAY:请使用 douyin_call_capability_tool。",
        ), runtimeMetadata(extra));
      }
      let autoLoadedPack = false;
      if (!activePacks().has(pack)) {
        if (!auto_load) return packNotLoadedError([pack], tool, extra);
        try {
          addPackSelection(pack, extra.requestId);
          autoLoadedPack = true;
        } catch (error) {
          return errorResult(error, runtimeMetadata(extra));
        }
      }
      const result = await invokeToolDefinition(
        tool,
        toolArguments,
        compatibilityGatewayExtra(extra),
      );
      return {
        ...result,
        structuredContent: {
          ...(result?.structuredContent ?? {}),
          capabilityGateway: "write",
          requestedPack: pack,
          autoLoadedPack,
          activePacks: [...activePacks()],
          ...runtimeMetadata(extra),
        },
      };
    },
  );

  // Versioned core aliases force clients that cache older core schemas to
  // fetch a fresh pack enum without weakening the original gateway contracts.
  registerTool(
    "douyin_load_capability_pack_v1_9_1",
    {
      title: "Load capability pack (v1.9.1 schema)",
      description: "Versioned alias for douyin_load_capability_pack with the v1.9.1 pack catalog.",
      inputSchema: z.object({
        packs: z.array(z.enum(CAPABILITY_PACK_NAMES)).min(1),
        replace: z.boolean().default(false),
        include_schemas: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_load_capability_pack",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_unload_capability_pack_v1_9_1",
    {
      title: "Unload capability pack (v1.9.1 schema)",
      description: "Versioned alias for douyin_unload_capability_pack with the v1.9.1 pack catalog.",
      inputSchema: z.object({ packs: z.array(z.enum(CAPABILITY_PACK_NAMES)).min(1) }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_unload_capability_pack",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_call_capability_tool_v1_9_1",
    {
      title: "Read capability gateway (v1.9.1 schema)",
      description: "Versioned alias for the read-only capability gateway with notifications in the pack enum.",
      inputSchema: z.object({
        pack: z.enum(CAPABILITY_PACK_NAMES),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        auto_load: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_call_capability_tool",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_call_write_capability_tool_v1_9_1",
    {
      title: "Write capability gateway (v1.9.1 schema)",
      description: "Versioned alias for the confirmation-gated write capability gateway with notifications in the pack enum.",
      inputSchema: z.object({
        pack: z.enum(CAPABILITY_PACK_NAMES),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        auto_load: z.boolean().default(true),
        confirm_gateway_write: z.literal(true),
      }),
      annotations: DESTRUCTIVE_ACTION_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_call_write_capability_tool",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_load_capability_pack_v1_10_0",
    {
      title: "Load capability pack (v1.10.0 schema)",
      description: "Versioned alias for douyin_load_capability_pack with the v1.10.0 pack catalog.",
      inputSchema: z.object({
        packs: z.array(z.enum(CAPABILITY_PACK_NAMES)).min(1),
        replace: z.boolean().default(false),
        include_schemas: z.boolean().default(false),
      }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_load_capability_pack",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_unload_capability_pack_v1_10_0",
    {
      title: "Unload capability pack (v1.10.0 schema)",
      description: "Versioned alias for douyin_unload_capability_pack with the v1.10.0 pack catalog.",
      inputSchema: z.object({ packs: z.array(z.enum(CAPABILITY_PACK_NAMES)).min(1) }),
      annotations: SAFE_ACTION_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_unload_capability_pack",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_call_capability_tool_v1_10_0",
    {
      title: "Read capability gateway (v1.10.0 schema)",
      description: "Versioned alias for the read-only capability gateway with the v1.10.0 pack catalog.",
      inputSchema: z.object({
        pack: z.enum(CAPABILITY_PACK_NAMES),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        auto_load: z.boolean().default(true),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_call_capability_tool",
      argumentsValue,
      extra,
    ),
  );

  registerTool(
    "douyin_call_write_capability_tool_v1_10_0",
    {
      title: "Write capability gateway (v1.10.0 schema)",
      description: "Versioned alias for the confirmation-gated write capability gateway with the v1.10.0 pack catalog.",
      inputSchema: z.object({
        pack: z.enum(CAPABILITY_PACK_NAMES),
        tool: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        auto_load: z.boolean().default(true),
        confirm_gateway_write: z.literal(true),
      }),
      annotations: DESTRUCTIVE_ACTION_ANNOTATIONS,
    },
    async (argumentsValue, extra) => invokeToolDefinition(
      "douyin_call_write_capability_tool",
      argumentsValue,
      extra,
    ),
  );

  const missingDefinitions = CAPABILITY_PACK_NAMES.flatMap(name =>
    CAPABILITY_PACKS[name].tools
      .filter(toolName => !toolDefinitions.has(toolName))
      .map(toolName => `${name}:${toolName}`));
  const unassignedTools = [...toolDefinitions.keys()]
    .filter(toolName =>
      !CORE_TOOL_NAMES.has(toolName)
      && !INTERNAL_PUBLISHER_TOOL_NAMES.has(toolName)
      && packsForTool(toolName).length === 0);
  if (missingDefinitions.length > 0 || unassignedTools.length > 0) {
    throw new Error(
      "CAPABILITY_PACK_COVERAGE_FAILED:"
      + JSON.stringify({ missingDefinitions, unassignedTools }),
    );
  }
  applyCapabilityVisibility(false);

  // The SDK couples a tool's tools/list visibility to tools/call reachability
  // through one `enabled` flag. ChatGPT may keep an older manifest even after
  // reconnecting, so a cached direct call must remain reachable while a fresh
  // tools/list still returns only the selected packs. Replace the SDK handlers
  // with separate visibility and invocation policies.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...activeToolNames()]
      .map(describeVisibleTool)
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const definition = toolDefinitions.get(toolName);
    if (!definition) {
      return errorResult(new Error(`CAPABILITY_UNAVAILABLE:${toolName}`));
    }

    if (!activeToolNames().has(toolName)) {
      const candidatePacks = packsForTool(toolName);
      if (candidatePacks.length === 0) {
        return errorResult(new Error(`CAPABILITY_UNAVAILABLE:${toolName}`));
      }
      return packNotLoadedError(candidatePacks, toolName, extra);
    }

    try {
      const result = await invokeToolDefinition(
        toolName,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        extra,
      );
      return result;
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
  lastSeenAt: number;
};

export async function startHttpServer(port = CONFIG.httpPort): Promise<void> {
  if (process.env.DOUYIN_TEST_MODE === "1") {
    throw new Error("TEST_MODE_HTTP_FORBIDDEN:DOUYIN_TEST_MODE cannot be used with HTTP/tunnel mode.");
  }
  acquireProcessLock();
  const app = express();
  const sessions = new Map<string, SessionEntry>();
  let pendingInitializations = 0;
  type BrowserHealth = Awaited<ReturnType<DouyinBrowser["health"]>>;
  let lastBrowserHealth: BrowserHealth | null = null;
  let browserHealthProbe: Promise<BrowserHealth> | null = null;

  const browserHealthWithDeadline = async (): Promise<{
    status: BrowserHealth;
    timedOut: boolean;
  }> => {
    if (!browserHealthProbe) {
      browserHealthProbe = browser.health()
        .then(status => {
          lastBrowserHealth = status;
          return status;
        })
        .finally(() => {
          browserHealthProbe = null;
        });
    }
    const timeoutMarker = Symbol("browser_health_timeout");
    const result = await Promise.race([
      browserHealthProbe,
      new Promise<typeof timeoutMarker>(resolve => {
        const timer = setTimeout(() => resolve(timeoutMarker), 1_500);
        timer.unref();
      }),
    ]);
    if (result !== timeoutMarker) return { status: result, timedOut: false };
    return {
      status: lastBrowserHealth ?? {
        connected: false,
        message: "Browser health probe is still running; MCP HTTP service is available.",
      },
      timedOut: true,
    };
  };

  const closeSession = async (id: string, reason: string): Promise<void> => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    await entry.transport.close().catch(() => undefined);
    await entry.server.close().catch(() => undefined);
    log("mcp_session_closed", { sessionId: id, reason });
  };

  const ensureSessionCapacity = async (now: number): Promise<boolean> => {
    const decision = decideSessionCapacity({
      sessions: Array.from(sessions, ([id, entry]) => ({
        id,
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
      })),
      now,
      ttlMs: CONFIG.sessionTtlMs,
      idleEvictionMs: CONFIG.sessionIdleEvictionMs,
      maxSessions: CONFIG.maxSessions,
      pendingInitializations,
    });
    for (const id of decision.expiredIds) {
      await closeSession(id, "expired_before_initialize");
    }
    if (decision.evictId) {
      await closeSession(decision.evictId, "idle_lru_capacity_replacement");
    }
    return decision.capacityAvailable;
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(applyCors);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, mcp: true, version: CONFIG.version });
  });

  app.use(requireMcpAuthentication);
  app.use(enforceRequestRate);

  app.get("/healthz/details", async (_req, res) => {
    const browserProbe = await browserHealthWithDeadline();
    res.status(200).json({
      ok: true,
      mcp: true,
      version: CONFIG.version,
      authentication: "required",
      accessTokenFingerprint: accessTokenFingerprint(),
      activeSessions: sessions.size,
      pendingInitializations,
      maxSessions: CONFIG.maxSessions,
      sessionTtlSeconds: Math.floor(CONFIG.sessionTtlMs / 1_000),
      browserProbeTimedOut: browserProbe.timedOut,
      browser: browserProbe.status,
    });
  });

  const sendStatusPage = async (_req: Request, res: Response) => {
    const { status } = await browserHealthWithDeadline();
    res.type("html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>抖音受控桥</title><style>body{font-family:system-ui;margin:40px;max-width:780px;line-height:1.7}code{background:#f3f3f3;padding:2px 6px;border-radius:5px}.ok{color:#087f23}.bad{color:#b42318}</style><h1>抖音受控桥</h1><p class="${status.connected ? "ok" : "bad"}">${status.message}</p><p>MCP 地址：<code>http://127.0.0.1:${port}/mcp</code></p><p>${describeSafety()}</p></html>`);
  };
  app.get("/status", sendStatusPage);

  const handlePost = async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        if (Date.now() - entry.lastSeenAt > CONFIG.sessionTtlMs) {
          await closeSession(sessionId, "expired_on_post");
        } else {
          entry.lastSeenAt = Date.now();
          await entry.transport.handleRequest(req, res, req.body);
          return;
        }
      }

      if (isInitializeRequest(req.body)) {
        const capacityAvailable = await ensureSessionCapacity(Date.now());
        if (!capacityAvailable) {
          log("mcp_session_capacity_rejected", {
            activeSessions: sessions.size,
            pendingInitializations,
            maxSessions: CONFIG.maxSessions,
          });
          res.setHeader("Retry-After", "5");
          res.status(429).json({
            jsonrpc: "2.0",
            error: { code: -32002, message: "MCP session capacity reached." },
            id: req.body?.id ?? null,
          });
          return;
        }
        pendingInitializations += 1;
        try {
          if (sessionId && !sessions.has(sessionId)) {
            delete req.headers["mcp-session-id"];
          }
          let transport!: StreamableHTTPServerTransport;
          const server = createMcpServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: false,
            onsessioninitialized: id => {
              const now = Date.now();
              sessions.set(id, { transport, server, createdAt: now, lastSeenAt: now });
              log("mcp_session_initialized", { sessionId: id });
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) sessions.delete(id);
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } finally {
          pendingInitializations = Math.max(0, pendingInitializations - 1);
        }
        return;
      }

      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Resource not found: MCP session expired; initialize a new session.",
        },
        id: null,
      });
    } catch (error) {
      log("mcp_http_error", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      }
    }
  };

  const handleGet = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).send("Resource not found: missing or expired MCP session ID");
      return;
    }
    if (Date.now() - entry.lastSeenAt > CONFIG.sessionTtlMs) {
      await closeSession(sessionId!, "expired_on_get");
      res.status(404).send("Resource not found: expired MCP session ID");
      return;
    }
    entry.lastSeenAt = Date.now();
    await entry.transport.handleRequest(req, res);
  };
  const handleDelete = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).send("Resource not found: missing or expired MCP session ID");
      return;
    }
    entry.lastSeenAt = Date.now();
    await entry.transport.handleRequest(req, res);
    if (sessions.has(sessionId!)) await closeSession(sessionId!, "client_delete");
    else await entry.server.close().catch(() => undefined);
  };

  app.post("/mcp", handlePost);
  app.get("/mcp", handleGet);
  app.delete("/mcp", handleDelete);
  app.post("/", handlePost);
  app.get("/", async (req, res) => {
    if (req.headers["mcp-session-id"] || req.headers.accept?.includes("text/event-stream")) {
      await handleGet(req, res);
      return;
    }
    await sendStatusPage(req, res);
  });
  app.delete("/", handleDelete);

  const cleanupExpiredSessions = setInterval(() => {
    const cutoff = Date.now() - CONFIG.sessionTtlMs;
    for (const [id, entry] of sessions) {
      if (entry.lastSeenAt >= cutoff) continue;
      void closeSession(id, "periodic_expiry");
    }
  }, Math.min(60_000, Math.max(10_000, Math.floor(CONFIG.sessionTtlMs / 4))));
  cleanupExpiredSessions.unref();

  const httpServer = app.listen(port, CONFIG.httpHost, () => {
    log("http_server_started", {
      port,
      host: CONFIG.httpHost,
      authentication: "required",
      accessTokenFingerprint: accessTokenFingerprint(),
    });
    console.error(`抖音受控 MCP 已启动：http://${CONFIG.httpHost}:${port}/mcp（需要访问令牌）`);
    void browser.startupSelfCheck({
      workId: process.env.DOUYIN_DEFAULT_CREATOR_WORK_ID?.trim() || undefined,
      allowBrowserLaunch: true,
      reconcilePendingOperations: true,
    }).then(result => {
      log("startup_self_check_completed", result);
    }).catch(error => {
      log("startup_self_check_failed", { error: String(error) });
    });
  });

  const shutdown = async () => {
    clearInterval(cleanupExpiredSessions);
    for (const entry of sessions.values()) {
      await entry.transport.close().catch(() => undefined);
      await entry.server.close().catch(() => undefined);
    }
    httpServer.close(() => {
      releaseProcessLock();
      process.exit(0);
    });
  };
  httpServer.on("close", releaseProcessLock);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("stdio_server_started");
  void browser.startupSelfCheck({
    workId: process.env.DOUYIN_DEFAULT_CREATOR_WORK_ID?.trim() || undefined,
    allowBrowserLaunch: true,
    reconcilePendingOperations: true,
  }).then(result => {
    log("startup_self_check_completed", result);
  }).catch(error => {
    log("startup_self_check_failed", { error: String(error) });
  });
}
