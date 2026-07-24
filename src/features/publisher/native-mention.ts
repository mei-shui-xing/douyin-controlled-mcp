import { getBoundUser } from "../../action-config.js";

export type PublishMentionInput = {
  alias: "bound_user";
  placement: "caption_start" | "caption_end";
};

export type FrozenNativeMention = PublishMentionInput & {
  displayName: string;
  uid: string;
  secUid: string;
};

export type NativeMentionEvidence = FrozenNativeMention & {
  domPath: string;
  stableNodeEvidence: string;
};

export type NativeMentionInspection = {
  nativeMentions: NativeMentionEvidence[];
  plainTextMentions: string[];
  unresolvedMentions: Array<{
    displayName: string;
    uid: string | null;
    secUid: string | null;
    reason: string;
  }>;
};

export type NativeMentionCandidate = {
  displayName: string;
  uid: string | null;
  secUid: string | null;
  href: string | null;
  selectorToken: string;
};

export type NativeMentionDomFixture = {
  text: string;
  nodes: Array<{
    native: boolean;
    displayName: string;
    uid?: string | null;
    secUid?: string | null;
    href?: string | null;
    placement: "caption_start" | "caption_end";
    domPath?: string;
  }>;
};

export function resolveNativeMentions(
  mentions: PublishMentionInput[] = [],
): FrozenNativeMention[] {
  const seen = new Set<string>();
  return mentions.map(input => {
    if (input.alias !== "bound_user") throw new Error("NATIVE_MENTION_ALIAS_NOT_BOUND");
    const key = `${input.alias}:${input.placement}`;
    if (seen.has(key)) throw new Error("NATIVE_MENTION_DUPLICATE_PLACEMENT");
    seen.add(key);
    const bound = getBoundUser(input.alias);
    return {
      alias: "bound_user",
      placement: input.placement,
      displayName: bound.displayName,
      uid: bound.uid,
      secUid: bound.secUid,
    };
  });
}

export function chooseExactNativeMentionCandidate(
  candidates: NativeMentionCandidate[],
  expected: FrozenNativeMention,
): NativeMentionCandidate {
  const exact = candidates.filter(candidate => {
    if (candidate.displayName !== expected.displayName) return false;
    if (candidate.uid && candidate.uid !== expected.uid) return false;
    if (candidate.secUid && candidate.secUid !== expected.secUid) return false;
    const hrefIdentity = candidate.href?.match(/\/user\/([^?/#]+)/)?.[1] ?? null;
    if (hrefIdentity
      && hrefIdentity !== expected.secUid
      && hrefIdentity !== expected.uid
      && hrefIdentity !== encodeURIComponent(expected.secUid)) return false;
    const hrefMatches = Boolean(candidate.href && (
      candidate.href.includes(encodeURIComponent(expected.secUid))
      || candidate.href.includes(expected.secUid)
      || candidate.href.includes(expected.uid)
    ));
    return candidate.uid === expected.uid
      || candidate.secUid === expected.secUid
      || hrefMatches;
  });
  if (exact.length !== 1) {
    throw new Error(`NATIVE_MENTION_CANDIDATE_NOT_UNIQUE:${exact.length}`);
  }
  return exact[0];
}

export function nativeMentionsMatch(
  expected: FrozenNativeMention[] = [],
  inspection: NativeMentionInspection,
): boolean {
  if (inspection.plainTextMentions.length || inspection.unresolvedMentions.length) return false;
  if (inspection.nativeMentions.length !== expected.length) return false;
  return expected.every((mention, index) => {
    const actual = inspection.nativeMentions[index];
    return actual.alias === mention.alias
      && actual.displayName === mention.displayName
      && actual.uid === mention.uid
      && actual.secUid === mention.secUid
      && actual.placement === mention.placement
      && Boolean(actual.domPath || actual.stableNodeEvidence);
  });
}

export function inspectNativeMentionDomFixture(
  fixture: NativeMentionDomFixture,
): NativeMentionInspection {
  const nativeMentions: NativeMentionEvidence[] = [];
  const unresolvedMentions: NativeMentionInspection["unresolvedMentions"] = [];
  for (const node of fixture.nodes.filter(item => item.native)) {
    const hrefSecUid = node.href?.match(/\/user\/([^?/#]+)/)?.[1] ?? null;
    const secUid = node.secUid ?? hrefSecUid;
    if (!node.uid || !secUid) {
      unresolvedMentions.push({
        displayName: node.displayName,
        uid: node.uid ?? null,
        secUid,
        reason: "native_mention_stable_identity_missing",
      });
      continue;
    }
    nativeMentions.push({
      alias: "bound_user",
      displayName: node.displayName,
      uid: node.uid,
      secUid,
      placement: node.placement,
      domPath: node.domPath ?? "fixture:native-mention",
      stableNodeEvidence: node.href ? `href:${node.href}` : "fixture:stable-identity",
    });
  }
  const nativeNames = new Set(fixture.nodes.filter(item => item.native).map(item => item.displayName));
  const plainTextMentions = Array.from(fixture.text.matchAll(/(?:^|\s)@([^\s@#]+)/g))
    .map(match => match[1].trim())
    .filter(name => name && !nativeNames.has(name));
  return { nativeMentions, plainTextMentions, unresolvedMentions };
}

export function projectCaptionWithMentions(
  caption: string,
  mentions: FrozenNativeMention[] = [],
): string {
  const starts = mentions.filter(item => item.placement === "caption_start")
    .map(item => `@${item.displayName}`);
  const ends = mentions.filter(item => item.placement === "caption_end")
    .map(item => `@${item.displayName}`);
  return [...starts, caption, ...ends].filter(Boolean).join(" ").trim();
}
