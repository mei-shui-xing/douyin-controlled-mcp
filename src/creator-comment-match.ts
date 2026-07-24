export type CreatorCommentMatchMode = "exact" | "fuzzy";

export function normalizeCreatorCommentSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ");
}

export function normalizeCreatorReplyText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, "");
}

function bigrams(value: string): string[] {
  const points = [...value];
  if (points.length < 2) return points;
  return points.slice(0, -1).map((point, index) => `${point}${points[index + 1]}`);
}

function diceSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const leftBigrams = bigrams(left);
  const rightCounts = new Map<string, number>();
  for (const value of bigrams(right)) {
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }
  let overlap = 0;
  for (const value of leftBigrams) {
    const count = rightCounts.get(value) ?? 0;
    if (count <= 0) continue;
    overlap += 1;
    rightCounts.set(value, count - 1);
  }
  return (2 * overlap) / (leftBigrams.length + bigrams(right).length);
}

export function creatorCommentFieldMatchScore(
  candidateValue: string,
  queryValue: string,
  mode: CreatorCommentMatchMode,
): number {
  const candidate = normalizeCreatorCommentSearchText(candidateValue);
  const query = normalizeCreatorCommentSearchText(queryValue);
  if (!query) return 1;
  if (!candidate) return 0;
  if (candidate === query) return 1;
  if (mode === "exact") return 0;
  if (candidate.includes(query)) {
    return Math.min(0.99, 0.92 + 0.07 * (query.length / candidate.length));
  }
  const reverseContainmentRatio = candidate.length / query.length;
  if (candidate.length >= 2 && query.includes(candidate) && reverseContainmentRatio >= 0.6) {
    return Math.min(0.89, 0.72 + 0.17 * reverseContainmentRatio);
  }
  return Math.min(0.89, diceSimilarity(candidate, query));
}

export function creatorCommentMatchesQuery(
  candidateValue: string,
  queryValue: string | undefined,
  mode: CreatorCommentMatchMode,
): { matched: boolean; score: number } {
  if (!queryValue?.trim()) return { matched: true, score: 1 };
  const score = creatorCommentFieldMatchScore(candidateValue, queryValue, mode);
  return {
    matched: mode === "exact" ? score === 1 : score >= 0.6,
    score,
  };
}

export function creatorCommentCombinedMatchScore(scores: number[]): number {
  if (!scores.length) return 1;
  return Number((scores.reduce((total, score) => total + score, 0) / scores.length).toFixed(4));
}
