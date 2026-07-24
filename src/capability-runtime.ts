import { createHash, randomUUID } from "node:crypto";
import {
  CAPABILITY_PACK_NAMES,
  CAPABILITY_PACKS,
  type CapabilityPackName,
} from "./capability-packs.js";
import { getMetadata, setMetadata } from "./sqlite.js";
import { browserProfileId } from "./page-bindings.js";

const CAPABILITY_STATE_KEY = "capability_pack_runtime_v1";
const CAPABILITY_STATE_VERSION = 1;
const PROCESS_INSTANCE_ID = randomUUID();

export const CAPABILITY_REGISTRY_REVISION =
  `1.10.0-${createHash("sha256")
    .update(JSON.stringify(CAPABILITY_PACK_NAMES.map(name => ({
      name,
      dependencies: CAPABILITY_PACKS[name].dependencies,
      tools: CAPABILITY_PACKS[name].tools,
    }))))
    .digest("hex")
    .slice(0, 12)}`;

type PersistedCapabilityState = {
  version: number;
  selectedPacks: CapabilityPackName[];
  stateRevision: number;
  registryRevision: string;
  updatedAt: string;
};

export type CapabilityRuntimeSnapshot = {
  selectedPacks: CapabilityPackName[];
  stateRevision: number;
  registryRevision: string;
  runtimeInstanceId: string;
  sessionId: string | null;
  connectionId: string;
  browserProfileId: string;
  stateScope: "browser_profile";
};

function validPackNames(values: unknown): CapabilityPackName[] {
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value): value is CapabilityPackName =>
      typeof value === "string"
      && CAPABILITY_PACK_NAMES.includes(value as CapabilityPackName),
  );
}

function configuredInitialPacks(): CapabilityPackName[] {
  const configured = (process.env.DOUYIN_INITIAL_CAPABILITY_PACKS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const selected = new Set<CapabilityPackName>();
  for (const value of configured) {
    if (value === "all") {
      for (const name of CAPABILITY_PACK_NAMES) selected.add(name);
      continue;
    }
    if (!CAPABILITY_PACK_NAMES.includes(value as CapabilityPackName)) {
      throw new Error(`INVALID_CAPABILITY_PACK:${value}`);
    }
    selected.add(value as CapabilityPackName);
  }
  return [...selected];
}

export class CapabilityPackRuntime {
  private selected = new Set<CapabilityPackName>();
  private revision = 0;
  private persistChanges = true;

  constructor() {
    const saved = getMetadata(CAPABILITY_STATE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<PersistedCapabilityState>;
        if (parsed.version === CAPABILITY_STATE_VERSION) {
          this.selected = new Set(validPackNames(parsed.selectedPacks));
          this.revision = Number.isSafeInteger(parsed.stateRevision)
            ? Math.max(0, Number(parsed.stateRevision))
            : 0;
          return;
        }
      } catch {
        // Replace malformed state with a valid committed snapshot below.
      }
    }
    this.selected = new Set(configuredInitialPacks());
    this.persist(this.selected, 0);
  }

  selectedPacks(): Set<CapabilityPackName> {
    return new Set(this.selected);
  }

  snapshot(
    connectionId: string,
    sessionId?: string,
  ): CapabilityRuntimeSnapshot {
    return {
      selectedPacks: [...this.selected],
      stateRevision: this.revision,
      registryRevision: CAPABILITY_REGISTRY_REVISION,
      runtimeInstanceId: PROCESS_INSTANCE_ID,
      sessionId: sessionId ?? null,
      connectionId,
      browserProfileId,
      stateScope: "browser_profile",
    };
  }

  load(
    packs: Iterable<CapabilityPackName>,
    replace = false,
  ): CapabilityPackName[] {
    const next = replace
      ? new Set<CapabilityPackName>()
      : new Set(this.selected);
    for (const pack of packs) next.add(pack);
    this.commit(next);
    return [...this.selected];
  }

  unload(packs: Iterable<CapabilityPackName>): CapabilityPackName[] {
    const next = new Set(this.selected);
    for (const pack of packs) next.delete(pack);
    this.commit(next);
    return [...this.selected];
  }

  resetForTests(packs: Iterable<CapabilityPackName> = []): void {
    this.selected = new Set(packs);
    this.revision = 0;
    this.persistChanges = false;
  }

  private commit(next: Set<CapabilityPackName>): void {
    const unchanged = next.size === this.selected.size
      && [...next].every(pack => this.selected.has(pack));
    if (unchanged) return;
    const nextRevision = this.revision + 1;
    if (this.persistChanges) this.persist(next, nextRevision);
    // Mutate in-memory state only after SQLite has committed successfully.
    this.selected = next;
    this.revision = nextRevision;
  }

  private persist(
    selected: Set<CapabilityPackName>,
    stateRevision: number,
  ): void {
    const state: PersistedCapabilityState = {
      version: CAPABILITY_STATE_VERSION,
      selectedPacks: [...selected],
      stateRevision,
      registryRevision: CAPABILITY_REGISTRY_REVISION,
      updatedAt: new Date().toISOString(),
    };
    setMetadata(CAPABILITY_STATE_KEY, JSON.stringify(state));
  }
}

let sharedRuntime: CapabilityPackRuntime | null = null;

export function getCapabilityPackRuntime(): CapabilityPackRuntime {
  sharedRuntime ??= new CapabilityPackRuntime();
  return sharedRuntime;
}

export function resetCapabilityPackRuntimeForTests(
  packs: Iterable<CapabilityPackName> = [],
): void {
  getCapabilityPackRuntime().resetForTests(packs);
}
