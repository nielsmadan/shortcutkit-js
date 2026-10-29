import {
  consoleLogger,
  type ApplyResult,
  type Logger,
  type ShortcutRegistry,
  type ShortcutStore,
} from './registry';
import { decodeRawState, sameRawState } from './state';

export interface SyncedShortcutStore extends ShortcutStore {
  // Reports the store's current value after another tab or window wrote it, as load() would resolve it.
  onExternalChange(listener: (state: unknown) => void): () => void;
}

export interface SyncRegistryOptions {
  readonly onResult?: ((result: ApplyResult) => void) | undefined;
  readonly logger?: Pick<Logger, 'warn'> | undefined;
}

function isCurrent(registry: Pick<ShortcutRegistry, 'rawState'>, state: unknown): boolean {
  try {
    return sameRawState(decodeRawState(state), registry.rawState);
  } catch {
    return false;
  }
}

export function syncRegistry(
  registry: Pick<ShortcutRegistry, 'applyState' | 'flush' | 'rawState'>,
  store: Pick<SyncedShortcutStore, 'onExternalChange'>,
  options: SyncRegistryOptions = {},
): () => void {
  const logger = options.logger ?? consoleLogger;
  return store.onExternalChange((state) => {
    if (isCurrent(registry, state)) return;
    const result = registry.applyState(state);
    options.onResult?.(result);
    switch (result.type) {
      case 'applied':
        break;
      case 'pendingChanges':
        void registry.flush();
        break;
      case 'invalid':
      case 'migrationFailed':
        logger.warn(`external state ignored (${result.type}): ${String(result.error)}`);
        break;
      default: {
        const unreachable: never = result;
        return unreachable;
      }
    }
  });
}
