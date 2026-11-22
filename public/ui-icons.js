// ICE RIOT - small inline SVG glyphs for the app shell (lobby, HUD, menu, final screen).
// Paths are copied from the Coqui frames ("Final · lobby" / "Final · in game"); each glyph is
// drawn in its frame's own box (14, 16, 18 ...) and strokes with currentColor, so CSS colours it.
// Never emoji or icon fonts.

const svg = (box, body, { size = box, sw = 1.36, cls = '', fill = false } = {}) =>
  `<svg class="ico${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}" aria-hidden="true" focusable="false" ` +
  (fill ? 'fill="currentColor" stroke="none"' : `fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`) +
  `>${body}</svg>`;
const t = (x, y, d, extra = '') => `<path transform="translate(${x} ${y})" d="${d}"${extra}/>`;

const RRECT7 = 'M1.4 0 L5.6 0 C6.37 0 7 0.63 7 1.4 L7 5.6 C7 6.37 6.37 7 5.6 7 L1.4 7 C0.63 7 0 6.37 0 5.6 L0 1.4 C0 0.63 0.63 0 1.4 0 Z';
const HEX = 'M5.2 0 L10.4 3 L10.4 9 L5.2 12 L0 9 L0 3 Z';

export const ICON = {
  pencil: (size = 14) => svg(14, t(2.8, 2.45, 'M6.65 0 L8.75 2.1 L2.1 8.75 L0 8.75 L0 6.65 Z'), { size, sw: 1.19 }),
  copy: (size = 14, sw = 1.19) => svg(14, t(4.9, 4.9, RRECT7) + t(2.8, 2.8, 'M6.3 0 L0.7 0 C0.31 0 0 0.31 0 0.7 L0 6.3'), { size, sw }),
  chevL: (size = 14) => svg(14, t(4.55, 2.8, 'M4.2 0 L0 4.2 L4.2 8.4'), { size, sw: 1.4 }),
  chevR: (size = 14) => svg(14, t(5.25, 2.8, 'M0 0 L4.2 4.2 L0 8.4'), { size, sw: 1.4 }),
  leaderboard: (size = 16) => svg(16, t(1.6, 4, 'M0 9.6 L12.8 9.6 M1.6 9.6 L1.6 4.8 L4.8 4.8 L4.8 9.6 M4.8 9.6 L4.8 0 L8 0 L8 9.6 M8 9.6 L8 3.2 L11.2 3.2 L11.2 9.6'), { size }),
  badge: (size = 16, sw = 1.36) => svg(16, t(2.8, 1.6, HEX) + t(6, 6.4, 'M0 1.6 L1.44 3.04 L4.4 0'), { size, sw }),
  puck: (size = 16) => svg(16,
    t(2.4, 4, 'M5.6 0 C8.69 0 11.2 1.07 11.2 2.4 C11.2 3.73 8.69 4.8 5.6 4.8 C2.51 4.8 0 3.73 0 2.4 C0 1.07 2.51 0 5.6 0 Z') +
    t(2.4, 6.4, 'M0 0 L0 3.2 C0 4.56 2.48 5.6 5.6 5.6 C8.72 5.6 11.2 4.56 11.2 3.2 L11.2 0'), { size }),
  sliders: (size = 16) => svg(16,
    t(2.4, 4.8, 'M0 0 L6.4 0 M9.6 0 L11.2 0 M0 6.4 L1.6 6.4 M4.8 6.4 L11.2 6.4') +
    '<circle cx="10.4" cy="4.8" r="1.6"/><circle cx="5.6" cy="11.2" r="1.6"/>', { size }),
  wifi: (size = 16) => svg(16, t(2.4, 4.11, 'M0 2.29 C3.11 -0.76 8.09 -0.76 11.2 2.29 M2 4.69 C4.01 2.76 7.19 2.76 9.2 4.69 M4 7.09 C4.91 6.27 6.29 6.27 7.2 7.09'), { size, sw: 1.44 }),
  wifiOff: (size = 16) => svg(16,
    t(2.4, 4.11, 'M0 2.29 C3.11 -0.76 8.09 -0.76 11.2 2.29 M2 4.69 C4.01 2.76 7.19 2.76 9.2 4.69 M4 7.09 C4.91 6.27 6.29 6.27 7.2 7.09') +
    t(2.4, 2.4, 'M0 0 L11.2 11.2'), { size, sw: 1.44 }),
  personPlus: (size = 16) => svg(16, '<circle cx="6.4" cy="5.6" r="2.4"/>' +
    t(2, 4.8, 'M0 8.8 C0.64 6.4 2.4 5.2 4.4 5.2 C6.4 5.2 8.16 6.4 8.8 8.8 M10.4 0 L10.4 4.8 M8 2.4 L12.8 2.4'), { size, sw: 1.44 }),
  personMinus: (size = 16) => svg(16, '<circle cx="6.4" cy="5.6" r="2.4"/>' +
    t(2, 7.2, 'M0 6.4 C0.64 4 2.4 2.8 4.4 2.8 C6.4 2.8 8.16 4 8.8 6.4 M8 0 L12.8 0'), { size, sw: 1.44 }),
  warn: (size = 16) => svg(16, t(1.6, 2, 'M6.4 0 L12.8 11.2 L0 11.2 Z') + t(7.5, 6.4, 'M0.5 0 L0.5 3.2 M0.5 5.2 L0.5 5.28'), { size, sw: 1.44 }),
  error: (size = 16) => svg(20, '<circle cx="10" cy="10" r="7.5"/>' + t(9.5, 6, 'M0.5 0 L0.5 4.5 M0.5 7.5 L0.5 7.6'), { size, sw: 1.8 }),
  info: (size = 16) => svg(20, '<circle cx="10" cy="10" r="7.5"/>' + t(9.5, 6.4, 'M0.5 0 L0.5 0.1 M0.5 3 L0.5 7.6'), { size, sw: 1.8 }),
  check: (size = 16) => svg(16, '<circle cx="8" cy="8" r="6"/>' + t(5.2, 5.9, 'M0 2.1 L1.9 4 L5.6 0'), { size, sw: 1.44 }),
  chip: (size = 14) => svg(14, t(3.5, 3.5, RRECT7) +
    t(1.4, 1.4, 'M4.2 0 L4.2 2.1 M7 0 L7 2.1 M4.2 9.1 L4.2 11.2 M7 9.1 L7 11.2 M0 4.2 L2.1 4.2 M0 7 L2.1 7 M9.1 4.2 L11.2 4.2 M9.1 7 L11.2 7'), { size, sw: 1.19 }),
  mask: (size = 14) => svg(14, t(2.8, 2.8, 'M0 0 L8.4 0 L8.4 4.2 C8.4 6.52 6.52 8.4 4.2 8.4 C1.88 8.4 0 6.52 0 4.2 Z') +
    t(2.8, 2.8, 'M0 3.5 L8.4 3.5 M4.2 0 L4.2 8.4'), { size, sw: 1.19 }),
  hourglass: (size = 18) => svg(18, t(4.5, 2.25, 'M0 0 L9 0 M0 13.5 L9 13.5 M0.9 0 C0.9 3.6 8.1 3.6 8.1 6.75 C8.1 9.9 0.9 9.9 0.9 13.5 M8.1 0 C8.1 3.6 0.9 3.6 0.9 6.75 C0.9 9.9 8.1 9.9 8.1 13.5'), { size, sw: 1.62 }),
  stands: (size = 16) => svg(16, t(1.6, 6.4, 'M0 7.2 L12.8 7.2 M1.6 7.2 L1.6 4.8 L11.2 4.8 L11.2 7.2 M3.2 4.8 L3.2 2.4 L9.6 2.4 L9.6 4.8 M4.8 2.4 L4.8 0 L8 0 L8 2.4'), { size }),
  gamepad: (size = 18) => svg(18, t(1.8, 5.4, 'M3.6 0 L10.8 0 C12.79 0 14.4 1.61 14.4 3.6 L14.4 4.95 C14.43 5.88 13.88 6.73 13.02 7.08 C12.16 7.44 11.17 7.24 10.53 6.57 L9.45 5.4 L4.95 5.4 L3.87 6.57 C3.23 7.24 2.24 7.44 1.38 7.08 C0.52 6.73 -0.02 5.88 0 4.95 L0 3.6 C0 1.61 1.61 0 3.6 0 Z') +
    t(4.05, 7.65, 'M1.35 0 L1.35 2.7 M0 1.35 L2.7 1.35'), { size, sw: 1.53 }),
  speaker: (size = 18, muted = false) => svg(18, t(2.7, 4.05, 'M0 3.15 L0 6.75 L2.7 6.75 L6.3 9.9 L6.3 0 L2.7 3.15 Z') +
    (muted ? t(11.7, 6.75, 'M0 0 L4.5 4.5 M4.5 0 L0 4.5')
      : t(12.15, 4.5, 'M0 2.25 C0.6 2.84 0.95 3.65 0.95 4.5 C0.95 5.35 0.6 6.16 0 6.75 M1.8 0 C3.01 1.18 3.69 2.81 3.69 4.5 C3.69 6.19 3.01 7.82 1.8 9')), { size, sw: 1.53 }),
  clock: (size = 16) => svg(16, '<circle cx="8" cy="8.8" r="5.2"/>' + t(6.4, 2, 'M1.6 4 L1.6 6.8 L3.6 8 M0 0 L3.2 0'), { size, sw: 1.44 }),
  burst: (size = 44) => svg(44, t(4.4, 4.4, 'M17.6 0 L17.6 8.8 M17.6 26.4 L17.6 35.2 M0 17.6 L8.8 17.6 M26.4 17.6 L35.2 17.6 M5.5 5.5 L11 11 M24.2 24.2 L29.7 29.7 M29.7 5.5 L24.2 11 M11 24.2 L5.5 29.7'), { size, sw: 4.4 }),
  glass: (size = 44) => svg(44,
    t(5.5, 5.5, 'M3.3 0 L29.7 0 C31.52 0 33 1.48 33 3.3 L33 29.7 C33 31.52 31.52 33 29.7 33 L3.3 33 C1.48 33 0 31.52 0 29.7 L0 3.3 C0 1.48 1.48 0 3.3 0 Z') +
    t(14.3, 5.5, 'M5.5 0 L8.8 11 L0 15.4 L11 22 L8.8 33 M8.8 11 L24.2 8.8 M11 22 L24.2 26.4'), { size, sw: 3.52 }),
  flame: (size = 48) => svg(48, t(12.48, 3.6, 'M11.52 0 C12.96 7.68 23.04 12 23.04 24 C23.04 30.36 17.88 35.52 11.52 35.52 C5.16 35.52 0 30.36 0 24 C0 18.72 2.88 15.36 5.52 12.96 C6 16.56 7.68 18.72 10.08 19.68 C9.12 13.68 9.12 6.72 11.52 0 Z'), { size, fill: true }),

  // ---- "Final · mobile" page (portrait phone lobby, held-portrait prompt)
  chevD: (size = 16) => svg(16, t(3.5, 6, 'M0 0 L4.5 4.5 L9 0'), { size, sw: 1.5 }),
  close: (size = 14) => svg(14, t(3, 3, 'M0 0 L8 8 M8 0 L0 8'), { size, sw: 1.4 }),
  hourglassSm: (size = 16) => svg(16, t(4, 2, 'M0 0 L8 0 M0 12 L8 12 M1 0 C1 3 4 3.6 4 6 C4 8.4 1 9 1 12 M7 0 C7 3 4 3.6 4 6 C4 8.4 7 9 7 12'), { size, sw: 1.4 }),
  // bottom tab bar, 24 px glyphs
  tabMatch: (size = 24) => svg(24, '<rect x="2.5" y="5.5" width="19" height="13" rx="4.5"/>' + t(11.5, 5.5, 'M0.5 0 L0.5 13') + '<circle cx="12" cy="12" r="2.4"/>', { size, sw: 1.7 }),
  tabChat: (size = 24) => svg(24, t(3, 5, 'M2 0 L16 0 C17.1 0 18 0.9 18 2 L18 10 C18 11.1 17.1 12 16 12 L8 12 L3.5 15.5 L3.5 12 L2 12 C0.9 12 0 11.1 0 10 L0 2 C0 0.9 0.9 0 2 0 Z'), { size, sw: 1.7 }),
  tabLeaders: (size = 24) => svg(24, t(2.4, 4.8, 'M0 14.4 L19.2 14.4 M2.4 14.4 L2.4 7.2 L7.2 7.2 L7.2 14.4 M7.2 14.4 L7.2 0 L12 0 L12 14.4 M12 14.4 L12 4.8 L16.8 4.8 L16.8 14.4'), { size, sw: 1.7 }),
  tabChallenges: (size = 24) => svg(24, t(4.2, 2.4, 'M7.8 0 L15.6 4.5 L15.6 13.5 L7.8 18 L0 13.5 L0 4.5 Z') + t(9, 9.4, 'M0 2.2 L2.2 4.4 L6.6 0'), { size, sw: 1.7 }),
  /** "Turn your phone sideways" glyph: phone in ink-2, turn arrows in ice. */
  rotatePhone: (size = 96) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false">` +
    '<g style="stroke:var(--ink-2,#A1ACC0)" stroke-width="3">' +
    t(34.5, 21, 'M6 0 L21 0 C24.31 0 27 2.69 27 6 L27 48 C27 51.31 24.31 54 21 54 L6 54 C2.69 54 0 51.31 0 48 L0 6 C0 2.69 2.69 0 6 0 Z') +
    t(43.5, 67, 'M0 0.5 L9 0.5', ' stroke-linecap="round"') + '</g>' +
    t(8.7, 16.8, 'M57.3 0 C65.58 4.77 71.62 12.64 74.1 21.86 C76.57 31.09 75.28 40.93 70.5 49.2 M78.6 45.45 L70.5 49.2 L69.75 40.2 M21.3 62.4 C13.02 57.63 6.98 49.76 4.5 40.54 C2.03 31.31 3.32 21.47 8.1 13.2 M0 16.95 L8.1 13.2 L8.85 22.2',
      ' style="stroke:var(--ice,#DCEAF6)" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"') + '</svg>',
};

/** Ping strength glyph: three bars, lit by quality ('good' 3, 'ok' 2, 'bad' 1, '' none). */
export function signalSVG(q, size = 14) {
  const lit = q === 'good' ? 3 : q === 'ok' ? 2 : q === 'bad' ? 1 : 0;
  const bar = (x, y, h, i) => `<rect x="${x}" y="${y}" width="3" height="${h}" rx="1" class="${i < lit ? 'on' : 'off'}"/>`;
  return `<svg class="ico sig" data-q="${q || 'none'}" width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true" focusable="false">` +
    bar(1, 9, 4, 0) + bar(5.5, 5, 8, 1) + bar(10, 1, 12, 2) + '</svg>';
}

/** Ping quality bucket used by every ping readout: green < 60 ms, amber < 130 ms, red otherwise. */
export const pingQuality = (ms) => (!(ms > 0) ? '' : ms < 60 ? 'good' : ms < 130 ? 'ok' : 'bad');
