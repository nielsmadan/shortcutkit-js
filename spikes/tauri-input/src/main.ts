import { invoke } from '@tauri-apps/api/core';
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu';
import { isRegistered, register, unregisterAll } from '@tauri-apps/plugin-global-shortcut';

type Mode = 'pass' | 'prevent';
type Answer = 'yes' | 'no' | 'unsure';
type Source = 'page' | 'menu' | 'global' | 'note';

interface LogEntry {
  t: number;
  source: Source;
  type: string;
  mode: Mode;
  key: string;
  code: string;
  mods: string;
  flags: string[];
  target: string;
}

interface SpikeInfo {
  os: string;
  arch: string;
  smoke: boolean;
}

interface Step {
  id: string;
  text: string;
  question?: string;
  os?: string;
}

interface LayoutKeyboard {
  getLayoutMap?: () => Promise<Map<string, string>>;
}

const LAYOUT_CODES = [
  'KeyA',
  'KeyQ',
  'KeyY',
  'KeyZ',
  'Digit1',
  'Semicolon',
  'BracketLeft',
  'Backquote',
  'IntlBackslash',
  'Slash',
];

const STEPS: Step[] = [
  {
    id: 'beep-pass',
    text: 'Mode "Let through". Click the grey log area, then press A, J, 1, Escape, F5 and Ctrl+1.',
    question: 'Did macOS play the alert sound for any of these?',
  },
  {
    id: 'beep-prevent',
    text: 'Switch to "preventDefault on every key" and press the same keys in the log area.',
    question: 'Alert sound this time?',
  },
  {
    id: 'beep-field',
    text: 'Mode "Let through". Click into the input field and press Ctrl+1 and Cmd+1.',
    question: 'Alert sound?',
  },
  {
    id: 'menu',
    text: 'In both modes, press Cmd+Shift+U, F6 and Cmd+J, first with focus in the log area, then inside the input field. The log records whether the page saw the key, the menu item fired, or both.',
  },
  {
    id: 'menu-runtime',
    text: 'Click the "Change … to CmdOrCtrl+Shift+I" button, then press Cmd+Shift+I and Cmd+Shift+U.',
    question: 'Does the Shortcuts menu now show ⇧⌘I next to the item?',
  },
  {
    id: 'text',
    text: 'Mode "Let through". Type in each of the three fields, including Option+E then E (dead key, gives é). If you have a Japanese, Chinese or Korean input source, type a few composed characters too.',
  },
  {
    id: 'mouse',
    text: 'Over the log area, click the middle, back and forward mouse buttons if your mouse has them, and right-click once.',
  },
  {
    id: 'gestures',
    text: 'Optional, for later: pinch and rotate on the trackpad over the log area.',
  },
  {
    id: 'global',
    text: 'Click "Register global", switch to another app and press ⌘⌥⇧U. Then register ⌘Space (type CommandOrControl+Space) and a hotkey another app of yours already uses, and press each from another app.',
    question: 'Did ⌘Space still open Spotlight after registering it here?',
  },
  {
    id: 'windows-browser-keys',
    os: 'windows',
    text: 'In "Let through", press Ctrl+F, Ctrl+P, Ctrl+R, F5 and Ctrl+Plus. Then repeat in "preventDefault".',
    question:
      'Did a browser feature (find bar, print, reload, zoom) still appear in preventDefault mode?',
  },
];

const EDIT_ITEMS: PredefinedMenuItemOptions['item'][] = [
  'Undo',
  'Redo',
  'Separator',
  'Cut',
  'Copy',
  'Paste',
  'SelectAll',
];

const startedAt = performance.now();
const log: LogEntry[] = [];
const auto: Record<string, unknown> = {};
const answers: Record<string, Answer> = {};
let mode: Mode = 'pass';
let info: SpikeInfo = { os: 'unknown', arch: 'unknown', smoke: false };
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

function modifiers(event: KeyboardEvent | MouseEvent): string {
  return [
    event.ctrlKey && 'ctrl',
    event.altKey && 'alt',
    event.shiftKey && 'shift',
    event.metaKey && 'meta',
  ]
    .filter(Boolean)
    .join('+');
}

function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return String(target);
  const id = target.id ? `#${target.id}` : '';
  const editable = target.isContentEditable ? '[editable]' : '';
  return `${target.tagName.toLowerCase()}${id}${editable}`;
}

function keyFlags(event: KeyboardEvent): string[] {
  return [
    event.repeat ? 'repeat' : '',
    event.isComposing ? 'composing' : '',
    event.keyCode === 229 ? 'keyCode229' : '',
    event.getModifierState('AltGraph') ? 'altgraph' : '',
    event.location ? `location${event.location}` : '',
    event.defaultPrevented ? 'prevented' : '',
  ].filter(Boolean);
}

function report(line: string): void {
  void invoke('report', { line });
}

function record(entry: Partial<LogEntry> & Pick<LogEntry, 'source' | 'type'>): void {
  const full: LogEntry = {
    t: Math.round(performance.now() - startedAt),
    mode,
    key: '',
    code: '',
    mods: '',
    flags: [],
    target: '',
    ...entry,
  };
  log.push(full);
  renderRow(full);
  scheduleSave();
}

function note(text: string): void {
  record({ source: 'note', type: 'note', key: text });
  report(text);
}

function renderRow(entry: LogEntry): void {
  const row = document.createElement('tr');
  row.className = entry.source;
  const cells = [
    String(entry.t),
    entry.source,
    entry.type,
    entry.key,
    entry.code,
    entry.mods,
    entry.flags.join(' '),
    entry.target,
  ];
  row.append(
    ...cells.map((text) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      return cell;
    }),
  );
  const body = byId<HTMLTableSectionElement>('log');
  body.prepend(row);
  while (body.rows.length > 400) body.deleteRow(-1);
}

function results(): string {
  return JSON.stringify({ info, auto, answers, log }, null, 2);
}

async function save(kind: 'manual' | 'smoke'): Promise<void> {
  const path = await invoke<string>('save_results', { kind, json: results() });
  byId('saved').textContent = `saved ${new Date().toLocaleTimeString()} → ${path}`;
}

function scheduleSave(): void {
  if (info.smoke) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save('manual'), 1500);
}

function onKey(event: KeyboardEvent): void {
  if (mode === 'prevent') event.preventDefault();
  record({
    source: 'page',
    type: event.type,
    key: event.key,
    code: event.code,
    mods: modifiers(event),
    flags: keyFlags(event),
    target: describeTarget(event.target),
  });
}

function onMouse(event: MouseEvent): void {
  if (mode === 'prevent' && event.type !== 'mousedown') event.preventDefault();
  record({
    source: 'page',
    type: event.type,
    key: `button${event.button}`,
    code: `buttons=${event.buttons}`,
    mods: modifiers(event),
    target: describeTarget(event.target),
  });
}

let lastWheel = 0;
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey || event.timeStamp - lastWheel < 250) return;
  lastWheel = event.timeStamp;
  record({
    source: 'page',
    type: 'wheel+ctrlKey',
    key: `dy=${event.deltaY.toFixed(1)}`,
    code: `deltaMode=${event.deltaMode}`,
    mods: modifiers(event),
    target: describeTarget(event.target),
  });
}

function onGesture(event: Event): void {
  const gesture = event as Event & { scale?: number; rotation?: number };
  record({
    source: 'page',
    type: event.type,
    key: `scale=${gesture.scale?.toFixed(2)}`,
    code: `rotation=${gesture.rotation?.toFixed(1)}`,
  });
}

function onComposition(event: CompositionEvent): void {
  record({
    source: 'page',
    type: event.type,
    key: event.data,
    target: describeTarget(event.target),
  });
}

function installListeners(): void {
  window.addEventListener('keydown', onKey, { capture: true });
  window.addEventListener('keyup', onKey, { capture: true });
  ['mousedown', 'auxclick', 'contextmenu'].forEach((type) =>
    window.addEventListener(type, (event) => onMouse(event as MouseEvent), { capture: true }),
  );
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  ['gesturestart', 'gestureend'].forEach((type) =>
    window.addEventListener(type, onGesture, { capture: true }),
  );
  ['compositionstart', 'compositionend'].forEach((type) =>
    window.addEventListener(type, (event) => onComposition(event as CompositionEvent), {
      capture: true,
    }),
  );
  window.addEventListener('error', (event) => report(`error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) =>
    report(`unhandled rejection: ${String(event.reason)}`),
  );
}

function renderSteps(): void {
  const list = byId<HTMLOListElement>('steps');
  STEPS.filter((step) => !step.os || step.os === info.os).forEach((step) => {
    const item = document.createElement('li');
    item.append(step.text);
    if (step.question) {
      const question = document.createElement('div');
      question.className = 'answers';
      question.append(`${step.question} `);
      const choices: Answer[] = ['yes', 'no', 'unsure'];
      const buttons = choices.map((choice) => {
        const button = document.createElement('button');
        button.textContent = choice;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          answers[step.id] = choice;
          buttons.forEach((other) =>
            other.setAttribute('aria-pressed', String(other.textContent === choice)),
          );
          note(`answer ${step.id}: ${choice}`);
        });
        return button;
      });
      question.append(...buttons);
      item.append(question);
    }
    list.append(item);
  });
}

async function buildMenu(): Promise<MenuItem> {
  const onMenu = (id: string) => record({ source: 'menu', type: 'menu-action', key: id });
  const commandU = await MenuItem.new({
    id: 'cmd-shift-u',
    text: 'Cmd+Shift+U item',
    accelerator: 'CmdOrCtrl+Shift+U',
    action: onMenu,
  });
  const bareF6 = await MenuItem.new({
    id: 'bare-f6',
    text: 'Bare F6 item',
    accelerator: 'F6',
    action: onMenu,
  });
  const commandJ = await MenuItem.new({
    id: 'cmd-j',
    text: 'Cmd+J item',
    accelerator: 'CmdOrCtrl+J',
    action: onMenu,
  });
  const appMenu = await Submenu.new({
    text: 'Spike',
    items: [await PredefinedMenuItem.new({ item: 'Quit' })],
  });
  const edit = await Submenu.new({
    text: 'Edit',
    items: await Promise.all(EDIT_ITEMS.map((item) => PredefinedMenuItem.new({ item }))),
  });
  const shortcuts = await Submenu.new({ text: 'Shortcuts', items: [commandU, bareF6, commandJ] });
  const menu = await Menu.new({ items: [appMenu, edit, shortcuts] });
  await menu.setAsAppMenu();
  return commandU;
}

async function registerGlobal(accelerator: string): Promise<Record<string, unknown>> {
  try {
    await register(accelerator, (event) =>
      record({
        source: 'global',
        type: `global-${event.state.toLowerCase()}`,
        key: event.shortcut,
      }),
    );
    const registered = await isRegistered(accelerator);
    note(`register ${accelerator}: ok, isRegistered=${registered}`);
    return { accelerator, ok: true, isRegistered: registered };
  } catch (error) {
    note(`register ${accelerator}: error ${String(error)}`);
    return { accelerator, ok: false, error: String(error) };
  }
}

async function checkLayout(): Promise<Record<string, unknown>> {
  const keyboard = (navigator as Navigator & { keyboard?: LayoutKeyboard }).keyboard;
  if (!keyboard?.getLayoutMap) {
    return { navigatorKeyboard: keyboard !== undefined, getLayoutMap: false };
  }
  try {
    const map = await keyboard.getLayoutMap();
    return {
      navigatorKeyboard: true,
      getLayoutMap: true,
      size: map.size,
      sample: Object.fromEntries(LAYOUT_CODES.map((code) => [code, map.get(code) ?? null])),
    };
  } catch (error) {
    return { navigatorKeyboard: true, getLayoutMap: true, error: String(error) };
  }
}

async function runAutomaticChecks(): Promise<MenuItem | undefined> {
  auto.userAgent = navigator.userAgent;
  auto.layout = await checkLayout();
  note(`layout: ${JSON.stringify(auto.layout)}`);

  let commandU: MenuItem | undefined;
  try {
    commandU = await buildMenu();
    auto.menu = { ok: true };
  } catch (error) {
    auto.menu = { ok: false, error: String(error) };
  }
  note(`menu: ${JSON.stringify(auto.menu)}`);

  auto.global = [
    await registerGlobal('CommandOrControl+Alt+Shift+F11'),
    await registerGlobal('CommandOrControl+Space'),
    await registerGlobal('Hyper+Nope'),
  ];
  await unregisterAll();
  return commandU;
}

function wireControls(commandU: MenuItem | undefined): void {
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      mode = radio.value as Mode;
      note(`mode ${mode}`);
    }),
  );
  byId('save').addEventListener('click', () => void save('manual'));
  byId('change-accelerator').addEventListener('click', async () => {
    if (!commandU) return note('menu missing, cannot change accelerator');
    try {
      await commandU.setAccelerator('CmdOrCtrl+Shift+I');
      note('setAccelerator CmdOrCtrl+Shift+I: ok');
    } catch (error) {
      note(`setAccelerator error: ${String(error)}`);
    }
  });
  byId('global-register').addEventListener(
    'click',
    () => void registerGlobal(byId<HTMLInputElement>('global-input').value.trim()),
  );
  byId('global-unregister').addEventListener('click', async () => {
    await unregisterAll();
    note('unregisterAll');
  });
}

async function main(): Promise<void> {
  installListeners();
  info = await invoke<SpikeInfo>('spike_info');
  byId('info').textContent = `${info.os} ${info.arch}${info.smoke ? ' (smoke run)' : ''}`;
  renderSteps();
  const commandU = await runAutomaticChecks();
  if (info.smoke) {
    await save('smoke');
    return;
  }
  wireControls(commandU);
  byId('log-section').focus();
}

main().catch((error: unknown) => report(`main failed: ${String(error)}`));
