import { isModifierKeyCode, producesNoText } from './keys';
import { type Modifiers, type Shortcut, type Step, sameModifiers } from './shortcut';

export type ShortcutInput =
  | {
      readonly type: 'key';
      readonly code: string;
      readonly modifiers: Modifiers;
      readonly repeat?: boolean | undefined;
      readonly editingText?: boolean | undefined;
    }
  | {
      readonly type: 'mouse';
      readonly button: number;
      readonly modifiers: Modifiers;
    };

// `advanced` and `fired` both mean the input belongs to a shortcut and the caller
// should consume it; `ignored` leaves it to the page.
export type MatchResult = 'ignored' | 'advanced' | 'fired';

export const DEFAULT_STEP_TIMEOUT_MS = 1000;

export function stepMatches(step: Step, input: ShortcutInput): boolean {
  if (!sameModifiers(step.modifiers, input.modifiers)) return false;
  if (step.input.type === 'key') return input.type === 'key' && input.code === step.input.code;
  return input.type === 'mouse' && input.button === step.input.button;
}

export function stepFromInput(input: ShortcutInput): Step {
  return input.type === 'key'
    ? { input: { type: 'key', code: input.code }, modifiers: input.modifiers }
    : { input: { type: 'mouse', button: input.button }, modifiers: input.modifiers };
}

// A bare key or a shift/alt-only combination is something the user could be
// typing, so the first step of such a shortcut yields to a focused text field.
function yieldsToTextInput(step: Step, input: ShortcutInput): boolean {
  if (input.type !== 'key' || !input.editingText || step.input.type !== 'key') return false;
  if (producesNoText(step.input.code)) return false;
  return !step.modifiers.ctrl && !step.modifiers.meta;
}

export interface SequenceMatcherOptions {
  readonly stepTimeoutMs?: number | undefined;
  readonly onTrackingChange?: ((tracking: boolean) => void) | undefined;
}

export class SequenceMatcher {
  readonly shortcut: Shortcut;
  private readonly stepTimeoutMs: number;
  private readonly onTrackingChange: ((tracking: boolean) => void) | undefined;
  private step = 0;
  private timer: TimerHandle | undefined;

  constructor(shortcut: Shortcut, options: SequenceMatcherOptions = {}) {
    this.shortcut = shortcut;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.onTrackingChange = options.onTrackingChange;
  }

  get currentStep(): number {
    return this.step;
  }

  get isTracking(): boolean {
    return this.step > 0;
  }

  handle(input: ShortcutInput): MatchResult {
    if (input.type === 'key' && isModifierKeyCode(input.code)) return 'ignored';
    const step = this.shortcut.steps[this.step];
    if (!step || !stepMatches(step, input)) {
      this.reset();
      return 'ignored';
    }
    if (this.step === 0 && yieldsToTextInput(step, input)) return 'ignored';
    if (this.step === this.shortcut.steps.length - 1) {
      this.reset();
      return 'fired';
    }
    this.setStep(this.step + 1);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reset(), this.stepTimeoutMs);
    return 'advanced';
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.setStep(0);
  }

  private setStep(next: number): void {
    const wasTracking = this.isTracking;
    this.step = next;
    if (wasTracking !== this.isTracking) this.onTrackingChange?.(this.isTracking);
  }
}
