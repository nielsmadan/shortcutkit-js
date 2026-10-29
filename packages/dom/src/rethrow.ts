export function rethrowAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}
