export const ansiKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];
export const coreColors = ['background', 'foreground', 'cursor', 'selectionBackground'];

function palette(background, foreground, cursor, selectionBackground, ansi) {
  return { background, foreground, cursor, selectionBackground,
    ...Object.fromEntries(ansiKeys.map((key, index) => [key, '#' + ansi.split(' ')[index]])) };
}

export const presets = {
  wind: palette('#1c1c1c', '#dadada', '#e8aa39', '#44455a', '242424 e06c75 93c757 e4bf64 5a8dce ed69b7 57c9d6 d4d4d4 747474 ff8794 b9df82 f6d88b 829bf3 f3a0d4 89e3ee ffffff'),
  ocean: palette('#172332', '#d9e6f2', '#66e0d4', '#354767', '222e3f e67486 94c990 dcc473 6d9dee b498f4 66d5d0 d9e6f2 657487 ff8f9d b6e7ad f7db88 8fb8ff d0b3ff 8ceee8 ffffff'),
  paper: palette('#f5f2eb', '#302b25', '#8d4a16', '#d6dfec', '302b25 9f333c 42692e 805b16 285593 863877 14636a 5a5144 675e51 a42d43 327044 7e5413 234e99 873785 176a7a 645a4f'),
};

export const fonts = {
  system: 'Menlo, Monaco, "PingFang SC", monospace',
  menlo: 'Menlo, "PingFang SC", monospace',
  monaco: 'Monaco, "PingFang SC", monospace',
  courier: '"Courier New", "PingFang SC", monospace',
};

const validColor = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
export function terminalAppearance(value = {}) {
  const preset = Object.hasOwn(presets, value?.preset) ? value.preset : 'wind';
  return {
    preset,
    colors: Object.fromEntries([...coreColors, ...ansiKeys].map(key => [
      key, validColor(value?.colors?.[key]) ? value.colors[key] : presets[preset][key],
    ])),
    font: Object.hasOwn(fonts, value?.font) ? value.font : 'system',
    size: Number.isFinite(value?.size) ? Math.min(30, Math.max(10, Math.round(value.size))) : 14,
    cursor: ['block', 'underline', 'bar'].includes(value?.cursor) ? value.cursor : 'block',
    blink: value?.blink !== false,
  };
}

export function terminalOptions(appearance) {
  return {
    theme: { ...appearance.colors, cursorAccent: appearance.colors.background },
    fontFamily: fonts[appearance.font], fontSize: appearance.size,
    cursorStyle: appearance.cursor, cursorBlink: appearance.blink,
  };
}
