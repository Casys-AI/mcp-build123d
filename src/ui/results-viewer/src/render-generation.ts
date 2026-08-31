/**
 * Monotonic ownership token for asynchronous whole-view renders. A completion
 * may mutate the view only while its token is still the latest generation.
 */
export interface LatestRenderGate {
  next(): number;
  isCurrent(generation: number): boolean;
  dispose(): void;
}

export interface LatestRenderCommit<T> {
  readonly gate: LatestRenderGate;
  readonly generation: number;
  load(): Promise<T>;
  commit(value: T): void;
  discard(value: T): void | Promise<void>;
}

export interface LatestStagedRenderCommit<TStage, TValue> {
  readonly gate: LatestRenderGate;
  readonly generation: number;
  createStage(): TStage;
  load(stage: TStage): Promise<TValue>;
  commit(stage: TStage, value: TValue): void;
  discard(stage: TStage, value: TValue): void | Promise<void>;
}

export function createLatestRenderGate(): LatestRenderGate {
  let current = 0;
  let active = true;

  return {
    next(): number {
      return ++current;
    },
    isCurrent(generation): boolean {
      return active && generation === current;
    },
    dispose(): void {
      if (!active) return;
      active = false;
      current += 1;
    },
  };
}

/**
 * Await one mount and commit it only if its generation still owns the view.
 * A replacement generation that arrives during `load()` deterministically
 * disposes the completed stale mount instead of exposing it.
 */
export async function commitLatestRender<T>(
  options: LatestRenderCommit<T>,
): Promise<boolean> {
  if (!options.gate.isCurrent(options.generation)) return false;
  const value = await options.load();
  if (!options.gate.isCurrent(options.generation)) {
    await options.discard(value);
    return false;
  }
  options.commit(value);
  return true;
}

/**
 * Variant for renderers whose loader mutates its target before resolving.
 * All eager mutations are confined to a fresh staging target; the caller may
 * expose that target only from `commit`, after the latest-generation check.
 */
export async function commitLatestStagedRender<TStage, TValue>(
  options: LatestStagedRenderCommit<TStage, TValue>,
): Promise<boolean> {
  if (!options.gate.isCurrent(options.generation)) return false;
  const stage = options.createStage();
  const value = await options.load(stage);
  if (!options.gate.isCurrent(options.generation)) {
    await options.discard(stage, value);
    return false;
  }
  options.commit(stage, value);
  return true;
}
