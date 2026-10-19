export class Emitter<T> {
  private listeners: readonly ((value: T) => void)[] = [];

  get hasListeners(): boolean {
    return this.listeners.length > 0;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((other) => other !== listener);
    };
  }

  emit(value: T): void {
    this.listeners.forEach((listener) => listener(value));
  }
}
