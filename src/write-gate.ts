export type WriteGateMode =
  | "read_only"
  | "write_ready"
  | "degraded"
  | "binding_conflict"
  | "account_mismatch";

export type WriteGateState = {
  mode: WriteGateMode;
  globalWriteReady: boolean;
  browserConnected: boolean;
  profileVerified: boolean;
  accountVerified: boolean;
  creatorCenterReady: boolean;
  ledgerWritable: boolean;
  unresolvedOperationIds: string[];
  blockedReasons: string[];
  checkedAt: string;
  // Compatibility fields for older clients. They are no longer used to
  // authorize a write and are always work-agnostic.
  workVerified: boolean;
  workId: null;
};

let state: WriteGateState = {
  mode: "read_only",
  globalWriteReady: false,
  browserConnected: false,
  profileVerified: false,
  accountVerified: false,
  creatorCenterReady: false,
  ledgerWritable: false,
  unresolvedOperationIds: [],
  blockedReasons: ["startup_self_check_required"],
  checkedAt: new Date(0).toISOString(),
  workVerified: false,
  workId: null,
};

export function setWriteGateState(next: WriteGateState): WriteGateState {
  state = {
    ...next,
    unresolvedOperationIds: [...next.unresolvedOperationIds],
    blockedReasons: [...next.blockedReasons],
    workId: null,
  };
  return getWriteGateState();
}

export function getWriteGateState(): WriteGateState {
  return {
    ...state,
    unresolvedOperationIds: [...state.unresolvedOperationIds],
    blockedReasons: [...state.blockedReasons],
  };
}

export function degradeWriteGate(reason: string): WriteGateState {
  const blockedReasons = state.blockedReasons.includes(reason)
    ? state.blockedReasons
    : [...state.blockedReasons, reason];
  return setWriteGateState({
    ...state,
    mode: "degraded",
    globalWriteReady: false,
    blockedReasons,
    checkedAt: new Date().toISOString(),
  });
}

export function assertWriteReady(): void {
  if (!state.globalWriteReady || state.mode !== "write_ready") {
    throw new Error(
      `WRITE_GATE_CLOSED:当前全局运行状态为 ${state.mode}；`
      + `blockedReasons=${state.blockedReasons.join(",") || "unknown"}。`
      + "请先调用 douyin_startup_self_check。",
    );
  }
}
