export type SessionAgeRecord = {
  id: string;
  createdAt: number;
  lastSeenAt: number;
};

export type SessionCapacityDecision = {
  expiredIds: string[];
  evictId: string | null;
  capacityAvailable: boolean;
};

/**
 * Decide capacity without mutating live transports. Expired sessions are
 * always removed first. At capacity, one sufficiently idle LRU session may be
 * replaced so reconnecting clients cannot permanently exhaust the bridge.
 */
export function decideSessionCapacity(input: {
  sessions: SessionAgeRecord[];
  now: number;
  ttlMs: number;
  idleEvictionMs: number;
  maxSessions: number;
  pendingInitializations?: number;
}): SessionCapacityDecision {
  const expiredIds = input.sessions
    .filter(entry => input.now - entry.lastSeenAt >= input.ttlMs)
    .map(entry => entry.id);
  const expired = new Set(expiredIds);
  const retained = input.sessions.filter(entry => !expired.has(entry.id));
  const pending = Math.max(0, input.pendingInitializations ?? 0);
  if (retained.length + pending < input.maxSessions) {
    return { expiredIds, evictId: null, capacityAvailable: true };
  }
  const evictable = retained
    .filter(entry => input.now - entry.lastSeenAt >= input.idleEvictionMs)
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt
      || left.createdAt - right.createdAt);
  const evictId = evictable[0]?.id ?? null;
  return {
    expiredIds,
    evictId,
    capacityAvailable: Boolean(evictId),
  };
}

export function resolveObservationOwner(input: {
  sessionId?: string | null;
  connectionId: string;
  compatibilityGateway?: boolean;
  accessTokenFingerprint?: string | null;
}): string {
  if (input.compatibilityGateway && input.accessTokenFingerprint) {
    return `authenticated-gateway:${input.accessTokenFingerprint}`;
  }
  return input.sessionId || input.connectionId;
}
