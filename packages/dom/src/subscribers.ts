import { rethrowAsync } from './rethrow';

export interface Subscribers {
  readonly subscribe: (listener: () => void) => () => void;
  readonly notify: () => void;
}

export interface SubscriberHooks {
  readonly onFirst?: (() => void) | undefined;
  readonly onLast?: (() => void) | undefined;
}

export function createSubscribers(hooks: SubscriberHooks = {}): Subscribers {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) hooks.onFirst?.();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) hooks.onLast?.();
      };
    },
    notify: () => {
      [...listeners].forEach((listener) => {
        try {
          listener();
        } catch (error) {
          rethrowAsync(error);
        }
      });
    },
  };
}
