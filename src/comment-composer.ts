export type RootCommentComposerCandidate = {
  index: number;
  domPath: string;
  placeholder: string;
  ariaLabel: string;
  dataE2e: string;
  visible: boolean;
  editable: boolean;
  width: number;
  height: number;
  intersectionRatio: number;
  inCommentSurface: boolean;
  inCommentItem: boolean;
  inReplyContainer: boolean;
  nearestWorkId: string | null;
  sendCandidateCount: number;
};

export type RootCommentComposerDecision = {
  selectedIndex: number | null;
  eligibleIndexes: number[];
  reason: "unique" | "not_found" | "ambiguous";
};

function normalizedHint(candidate: RootCommentComposerCandidate): string {
  return [
    candidate.placeholder,
    candidate.ariaLabel,
    candidate.dataE2e,
  ].join(" ").replace(/\s+/gu, "").toLowerCase();
}

export function chooseRootCommentComposer(
  candidates: RootCommentComposerCandidate[],
  expectedWorkId: string,
): RootCommentComposerDecision {
  const eligible = candidates.filter(candidate => {
    const hint = normalizedHint(candidate);
    const semanticComment = hint.includes("评论")
      || hint.includes("comment")
      || hint.includes("留下你的精彩");
    const excluded = hint.includes("搜索")
      || hint.includes("search")
      || hint.includes("问问chatgpt")
      || hint.includes("回复@")
      || hint.includes("reply@");
    const workMatches = candidate.nearestWorkId == null
      || candidate.nearestWorkId === expectedWorkId;
    return candidate.visible
      && candidate.editable
      && candidate.width > 0
      && candidate.height > 0
      && candidate.inCommentSurface
      && !candidate.inCommentItem
      && !candidate.inReplyContainer
      && workMatches
      && (semanticComment || candidate.inCommentSurface)
      && !excluded
      && candidate.sendCandidateCount === 1;
  });
  if (eligible.length === 1) {
    return {
      selectedIndex: eligible[0].index,
      eligibleIndexes: [eligible[0].index],
      reason: "unique",
    };
  }
  return {
    selectedIndex: null,
    eligibleIndexes: eligible.map(candidate => candidate.index),
    reason: eligible.length === 0 ? "not_found" : "ambiguous",
  };
}
