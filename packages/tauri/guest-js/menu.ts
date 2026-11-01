import {
  consoleLogger,
  modifiers,
  type Logger,
  type MenuShortcut,
  type ModifierName,
  type Platform,
  type Shortcut,
  type ShortcutContext,
  type ShortcutRegistry,
} from '@shortcutkit/core';

export interface MenuBinding<A extends string = string> {
  readonly item: { setAccelerator(accelerator: string | null): Promise<void> };
  readonly context: ShortcutContext<A>;
  readonly action: A;
}

export type PredefinedMenuItemKind =
  | 'Copy'
  | 'Cut'
  | 'Paste'
  | 'Undo'
  | 'Redo'
  | 'SelectAll'
  | 'Minimize'
  | 'Hide'
  | 'HideOthers'
  | 'CloseWindow'
  | 'Quit'
  | 'Fullscreen';

const NAMED_CODES: ReadonlySet<string> = /* @__PURE__ */ new Set([
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Comma',
  'Period',
  'Slash',
  'Space',
  'Tab',
  'Enter',
  'Backspace',
  'Delete',
  'Escape',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadEnter',
]);

const F_KEY = /^F([1-9]|1\d|2[0-4])$/;

const PATTERNS: readonly RegExp[] = [/^Key[A-Z]$/, /^Digit\d$/, /^Numpad\d$/, F_KEY];

const isAllowedCode = (code: string): boolean =>
  NAMED_CODES.has(code) || PATTERNS.some((pattern) => pattern.test(code));

const BARE_CODES: ReadonlySet<string> = /* @__PURE__ */ new Set(['Escape']);
const isBareAllowed = (code: string): boolean => BARE_CODES.has(code) || F_KEY.test(code);

function metaName(platform: Platform): string | undefined {
  if (platform === 'mac') return 'Cmd';
  if (platform === 'linux') return 'Super';
  return undefined;
}

const MODIFIER_NAMES: readonly (readonly [ModifierName, string])[] = [
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
];

export function toAccelerator(shortcut: Shortcut, platform: Platform): string | undefined {
  const [step, ...rest] = shortcut.steps;
  if (step === undefined || rest.length > 0 || step.input.type !== 'key') return undefined;
  const { code } = step.input;
  if (!isAllowedCode(code)) return undefined;
  const names = MODIFIER_NAMES.filter(([key]) => step.modifiers[key]).map(([, name]) => name);
  if (step.modifiers.meta) {
    const meta = metaName(platform);
    if (meta === undefined) return undefined;
    names.push(meta);
  }
  if (names.length === 0 && !isBareAllowed(code)) return undefined;
  return [...names, code].join('+');
}

const firstAccelerator = (
  registry: Pick<ShortcutRegistry, 'shortcuts' | 'platform'>,
  { context, action }: MenuBinding,
): string | null => {
  const [first] = registry.shortcuts(context, action);
  return (first && toAccelerator(first, registry.platform)) ?? null;
};

interface ItemSync {
  wanted: string | null | undefined;
  sent: string | null | undefined;
  running: boolean;
}

export function syncMenuAccelerators(
  registry: Pick<ShortcutRegistry, 'subscribe' | 'shortcuts' | 'platform'>,
  bindings: readonly MenuBinding[],
  options: { readonly logger?: Pick<Logger, 'warn'> | undefined } = {},
): () => void {
  const logger = options.logger ?? consoleLogger;
  let stopped = false;
  const states = new Map<MenuBinding, ItemSync>(
    bindings.map((binding) => [binding, { wanted: undefined, sent: undefined, running: false }]),
  );

  const drain = async (binding: MenuBinding, state: ItemSync): Promise<void> => {
    state.running = true;
    while (!stopped && state.wanted !== undefined && state.wanted !== state.sent) {
      const value = state.wanted;
      try {
        await binding.item.setAccelerator(value);
        state.sent = value;
      } catch (error) {
        logger.warn(
          `ShortcutKit: setAccelerator failed for ${binding.context.id}.${binding.action}: ${String(error)}`,
        );
        if (state.wanted === value) break;
      }
    }
    state.running = false;
  };

  const update = (): void => {
    if (stopped) return;
    states.forEach((state, binding) => {
      state.wanted = firstAccelerator(registry, binding);
      if (!state.running && state.wanted !== state.sent) void drain(binding, state);
    });
  };

  const unsubscribe = registry.subscribe(update);
  update();
  return () => {
    stopped = true;
    unsubscribe();
  };
}

const PREDEFINED: Readonly<
  Record<
    PredefinedMenuItemKind,
    (macOS: boolean) => { code: string; mods: readonly ModifierName[] } | undefined
  >
> = {
  Copy: (mac) => ({ code: 'KeyC', mods: [primary(mac)] }),
  Cut: (mac) => ({ code: 'KeyX', mods: [primary(mac)] }),
  Paste: (mac) => ({ code: 'KeyV', mods: [primary(mac)] }),
  Undo: (mac) => ({ code: 'KeyZ', mods: [primary(mac)] }),
  Redo: (mac) =>
    mac ? { code: 'KeyZ', mods: ['shift', 'meta'] } : { code: 'KeyY', mods: ['ctrl'] },
  SelectAll: (mac) => ({ code: 'KeyA', mods: [primary(mac)] }),
  Minimize: (mac) => ({ code: 'KeyM', mods: [primary(mac)] }),
  Hide: (mac) => ({ code: 'KeyH', mods: [primary(mac)] }),
  HideOthers: (mac) => ({ code: 'KeyH', mods: ['alt', primary(mac)] }),
  CloseWindow: (mac) => (mac ? { code: 'KeyW', mods: ['meta'] } : { code: 'F4', mods: ['alt'] }),
  Quit: (mac) => (mac ? { code: 'KeyQ', mods: ['meta'] } : undefined),
  Fullscreen: (mac) => (mac ? { code: 'KeyF', mods: ['ctrl', 'meta'] } : undefined),
};

function primary(mac: boolean): ModifierName {
  return mac ? 'meta' : 'ctrl';
}

// muda creates these kinds disabled on the platform (tauri builds muda with gtk3 on Linux).
const DISABLED_KINDS: Readonly<Record<Platform, ReadonlySet<PredefinedMenuItemKind>>> = {
  mac: new Set(),
  other: new Set(),
  windows: new Set(['HideOthers']),
  linux: new Set(['Undo', 'Redo', 'Minimize', 'Hide', 'HideOthers', 'CloseWindow']),
};

export function predefinedMenuShortcuts(
  platform: Platform,
  items: readonly PredefinedMenuItemKind[],
): MenuShortcut[] {
  return items.flatMap((kind): MenuShortcut[] => {
    if (DISABLED_KINDS[platform].has(kind)) return [];
    const entry = PREDEFINED[kind](platform === 'mac');
    if (entry === undefined) return [];
    const step = {
      input: { type: 'key' as const, code: entry.code },
      modifiers: modifiers(entry.mods),
    };
    return [{ shortcut: { steps: [step] }, title: kind }];
  });
}
