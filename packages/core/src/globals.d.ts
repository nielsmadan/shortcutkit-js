// Core targets every JS host, so it declares the few timer and console globals it
// uses instead of pulling in DOM or Node types.
type TimerHandle = { readonly __timerHandle: unique symbol };

declare function setTimeout(callback: () => void, ms: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle | undefined): void;

declare const console: {
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
