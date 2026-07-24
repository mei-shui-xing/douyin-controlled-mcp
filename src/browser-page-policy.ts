export function rootCommentWorkIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get("modal_id")
      ?? url.searchParams.get("aweme_id")
      ?? url.searchParams.get("vid")
      ?? url.pathname.match(/\/(?:video|note|article)\/(\d{16,20})/)?.[1]
      ?? null;
  } catch {
    return null;
  }
}

export function rootCommentPagePreference(rawUrl: string): number {
  try {
    const url = new URL(rawUrl);
    if (/\/(?:video|note|article)\/\d{16,20}/.test(url.pathname)) return 3;
    if (url.searchParams.has("modal_id") || url.searchParams.has("aweme_id")) return 2;
    if (url.searchParams.has("vid")) return 1;
    return 0;
  } catch {
    return 0;
  }
}

export function disposableDuplicatePageKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!["douyin.com", "www.douyin.com"].includes(host)) return null;
    if (!url.pathname.startsWith("/user/")) return null;

    // Profile tabs are read-only navigation surfaces. Tracking and entry-point
    // parameters do not make them distinct working documents.
    const retained = new URLSearchParams();
    for (const key of ["modal_id", "aweme_id", "vid"]) {
      const value = url.searchParams.get(key);
      if (value) retained.set(key, value);
    }
    const query = retained.toString();
    return `${host}${url.pathname.replace(/\/$/, "")}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

export type CanonicalPageRole =
  | "operator_home"
  | "codex_test"
  | "bound_messages"
  | "creator_center"
  | "publisher"
  | "notifications"
  | "notification_target";

export function canonicalPageRoleReference(reference: string): CanonicalPageRole | null {
  const normalized = reference.trim().toLocaleLowerCase()
    .replace(/^page-/, "")
    .replaceAll("-", "_");
  return ([
    "operator_home", "codex_test", "bound_messages", "creator_center", "publisher",
    "notifications", "notification_target",
  ] as CanonicalPageRole[]).find(role => role === normalized) ?? null;
}

export function pageReferenceAliases(role: CanonicalPageRole, targetId: string): string[] {
  return [role, `page-${role.replaceAll("_", "-")}`, targetId];
}
