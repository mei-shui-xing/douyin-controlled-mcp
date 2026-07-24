export type LowRiskPostActionKind = "like" | "favorite" | "follow";
export type LowRiskPostScope = "own_post" | "bound_user_post" | "external_post";
export const LOW_RISK_MAX_CLICK_ATTEMPTS = 1;

export function pageRoleForPostScope(scope: LowRiskPostScope): "operator_home" | "codex_test" {
  return scope === "external_post" ? "codex_test" : "operator_home";
}

export type LowRiskVerificationLevel =
  | "server_confirmed"
  | "reload_confirmed"
  | "optimistic_only"
  | "unknown_after_submit"
  | "failed";

export type LowRiskVerification = {
  level: LowRiskVerificationLevel;
  requestSeen: boolean;
  responseSeen: boolean;
  responseStatus: number | null;
  responseCode: string | number | null;
  persistedAfterReload: boolean;
};

export type LowRiskNetworkObservation = {
  requestSeen: boolean;
  responseSeen: boolean;
  responseStatus: number | null;
  responseCode: string | number | null;
  businessSucceeded: boolean;
  targetMismatch: boolean;
};

const ENDPOINTS: Record<LowRiskPostActionKind, RegExp> = {
  like: /\/(?:aweme\/v\d+\/web\/)?(?:commit\/item\/digg|aweme\/digg|digg)(?:\/|$)/i,
  favorite: /\/(?:aweme\/v\d+\/web\/)?(?:aweme\/collect|collect|favorite)(?:\/|$)/i,
  follow: /\/(?:aweme\/v\d+\/web\/)?(?:commit\/follow\/user|relation\/(?:follow|unfollow)|follow\/user)(?:\/|$)/i,
};

function collectScalarValues(value: unknown, output: string[]): void {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScalarValues(item, output);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:aweme_id|item_id|group_id|work_id|target_work_id)$/i.test(key)) {
        collectScalarValues(child, output);
      } else if (child && typeof child === "object") {
        collectScalarValues(child, output);
      }
    }
  }
}

function requestValues(url: string, postData: string | null): string[] {
  const values: string[] = [];
  try {
    const parsed = new URL(url);
    for (const key of ["aweme_id", "item_id", "group_id", "work_id", "target_work_id"]) {
      const value = parsed.searchParams.get(key);
      if (value) values.push(value);
    }
  } catch {
    // The endpoint matcher will reject malformed URLs.
  }
  if (!postData) return values;
  try {
    collectScalarValues(JSON.parse(postData), values);
  } catch {
    const params = new URLSearchParams(postData);
    for (const key of ["aweme_id", "item_id", "group_id", "work_id", "target_work_id"]) {
      const value = params.get(key);
      if (value) values.push(value);
    }
  }
  return values;
}

export function inspectLowRiskMutationRequest(input: {
  kind: LowRiskPostActionKind;
  url: string;
  postData: string | null;
  workId: string;
}): { relevant: boolean; targetMatched: boolean | null } {
  let pathname = "";
  try {
    pathname = new URL(input.url).pathname;
  } catch {
    return { relevant: false, targetMatched: null };
  }
  if (!ENDPOINTS[input.kind].test(pathname)) return { relevant: false, targetMatched: null };
  const values = requestValues(input.url, input.postData);
  if (input.kind === "follow" && values.length === 0) {
    // Follow endpoints target an author UID rather than the post ID. They can
    // only be confirmed by reopening the explicitly resolved post.
    return { relevant: true, targetMatched: null };
  }
  return { relevant: true, targetMatched: values.includes(input.workId) };
}

export function responseBusinessCode(body: unknown): string | number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["status_code", "statusCode", "code", "err_no", "errno"]) {
    const value = record[key];
    if (typeof value === "number" || typeof value === "string") return value;
  }
  const data = record.data;
  if (data && typeof data === "object") return responseBusinessCode(data);
  return null;
}

export function businessCodeSucceeded(code: string | number | null): boolean {
  return code === 0 || code === "0" || code === "success" || code === "SUCCESS";
}

export function classifyLowRiskVerification(input: {
  network: LowRiskNetworkObservation;
  optimisticTargetState: boolean;
  reloadCompleted: boolean;
  persistedAfterReload: boolean;
}): LowRiskVerification {
  const base = {
    requestSeen: input.network.requestSeen,
    responseSeen: input.network.responseSeen,
    responseStatus: input.network.responseStatus,
    responseCode: input.network.responseCode,
    persistedAfterReload: input.persistedAfterReload,
  };
  if (input.network.targetMismatch) return { level: "failed", ...base };
  // A completed reload is newer and stronger evidence than an earlier HTTP
  // acknowledgement. Some platform responses acknowledge a mutation even
  // though the account state is subsequently rolled back.
  if (input.reloadCompleted && !input.persistedAfterReload) {
    return { level: input.optimisticTargetState ? "optimistic_only" : "failed", ...base };
  }
  if (input.network.responseSeen) {
    if (input.network.responseStatus != null
      && input.network.responseStatus >= 200
      && input.network.responseStatus < 300
      && input.network.businessSucceeded) {
      return { level: "server_confirmed", ...base };
    }
    return { level: "failed", ...base };
  }
  if (input.reloadCompleted && input.persistedAfterReload) {
    return { level: "reload_confirmed", ...base };
  }
  if (input.reloadCompleted && input.optimisticTargetState) {
    return { level: "optimistic_only", ...base };
  }
  if (input.network.requestSeen || !input.reloadCompleted) {
    return { level: "unknown_after_submit", ...base };
  }
  return { level: "failed", ...base };
}

export function verificationIsSuccess(verification: LowRiskVerification): boolean {
  return verification.level === "server_confirmed" || verification.level === "reload_confirmed";
}
