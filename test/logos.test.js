// Tests for public/logos.js (owner: Agent LOGOS). Run: node test/logos.test.js  (exit 1 on failure)
import { TEAMS, GAME_NAME } from '../shared/constants.js';
import { teamLogoSVG, gameLogoSVG, svgToDataURI, faviconDataURI, svgToCanvas } from '../public/logos.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// --- minimal XML well-formedness checker -------------------------------------------------
// Balanced/nested tags, exactly one root <svg>, quoted unique attributes, legal entities,
// no stray '<' / '>' / '&' in text or attribute values.
function checkXML(src) {
  const stack = [];
  let i = 0, roots = 0, rootName = null;
  const NAME = /[A-Za-z_][\w:.-]*/y;
  const ATTR = /\s+([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/y;
  const badText = (t, where) => {
    if (/[<>]/.test(t)) throw new Error(`raw < or > in ${where}: ${t.slice(0, 40)}`);
    const amp = t.match(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/);
    if (amp) throw new Error(`bare & in ${where}`);
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const text = lt < 0 ? src.slice(i) : src.slice(i, lt);
    if (text.trim()) {
      if (!stack.length) throw new Error(`text outside root: ${text.slice(0, 40)}`);
      badText(text, 'text');
    }
    if (lt < 0) break;
    i = lt + 1;
    if (src[i] === '!' || src[i] === '?') throw new Error('unexpected comment/PI/doctype');
    const closing = src[i] === '/';
    if (closing) i++;
    NAME.lastIndex = i;
    const nm = NAME.exec(src);
    if (!nm) throw new Error(`bad tag name at ${lt}`);
    const name = nm[0];
    i = NAME.lastIndex;
    if (closing) {
      const m = /\s*>/y; m.lastIndex = i;
      if (!m.exec(src)) throw new Error(`bad closing tag </${name}`);
      i = m.lastIndex;
      const open = stack.pop();
      if (open !== name) throw new Error(`mismatched </${name}>, expected </${open}>`);
      continue;
    }
    const seen = new Set();
    for (;;) {
      ATTR.lastIndex = i;
      const a = ATTR.exec(src);
      if (!a) break;
      if (seen.has(a[1])) throw new Error(`duplicate attribute ${a[1]} on <${name}>`);
      seen.add(a[1]);
      badText(a[2], `attribute ${a[1]}`);
      i = ATTR.lastIndex;
    }
    const end = /\s*(\/?)>/y; end.lastIndex = i;
    const e = end.exec(src);
    if (!e) throw new Error(`malformed tag <${name} near: ${src.slice(i, i + 30)}`);
    i = end.lastIndex;
    if (!stack.length) { roots++; rootName = name; }
    if (!e[1]) stack.push(name);
  }
  if (stack.length) throw new Error(`unclosed tags: ${stack.join(',')}`);
  if (roots !== 1 || rootName !== 'svg') throw new Error(`expected one <svg> root, got ${roots} (${rootName})`);
  return true;
}

function checkSVG(svg, label) {
  assert(typeof svg === 'string' && svg.startsWith('<svg ') && svg.endsWith('</svg>'), `${label}: not an <svg> string`);
  assert(!/NaN|undefined|Infinity|null|\[object/.test(svg), `${label}: contains NaN/undefined/null/Infinity`);
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'), `${label}: missing xmlns`);
  checkXML(svg);
  // every url(#id) reference must resolve to an id defined in the same document
  for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) {
    assert(svg.includes(`id="${ref}"`), `${label}: dangling reference #${ref}`);
  }
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert(new Set(ids).size === ids.length, `${label}: duplicate ids`);
}

const colorsIn = (svg) => [...svg.matchAll(/(?:fill|stroke|stop-color)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1].toLowerCase());
const expand = (c) => (c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c);
// a "neutral" is pure grey/black/white or a near-black outline (max channel <= 0x24)
function isNeutral(c) {
  c = expand(c);
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  return (r === g && g === b) || Math.max(r, g, b) <= 0x24;
}

const VARIANTS = ['full', 'mark', 'mono'];

// --- team crests ---------------------------------------------------------------------------
test('TEAMS has a crest for every team', () => assert(TEAMS.length === 6, `expected 6 teams, got ${TEAMS.length}`));

for (let t = 0; t < TEAMS.length; t++) {
  for (const variant of VARIANTS) {
    for (const size of [24, 28, 128, 512]) {
      test(`team ${t} ${variant} ${size}px well-formed`, () => {
        const svg = teamLogoSVG(t, { size, variant });
        checkSVG(svg, `team ${t} ${variant}`);
        assert(svg.includes(`width="${size}" height="${size}"`), 'size not applied');
        assert(svg.includes('viewBox="0 0 100 100"'), 'viewBox must be 0 0 100 100');
      });
    }
    test(`team ${t} ${variant} deterministic`, () => {
      const a = teamLogoSVG(t, { variant, size: 96 });
      teamLogoSVG((t + 1) % TEAMS.length, { variant }); // interleave other calls
      const b = teamLogoSVG(t, { variant, size: 96 });
      assert(a === b, 'two calls produced different markup');
    });
  }

  test(`team ${t} full uses its TEAMS colors (and only neutrals besides)`, () => {
    const svg = teamLogoSVG(t);
    const { primary, secondary, accent } = TEAMS[t].colors;
    const teamCols = [primary, secondary, accent].map(hex);
    for (const c of teamCols) assert(colorsIn(svg).includes(c), `missing team color ${c}`);
    for (const c of colorsIn(svg)) {
      assert(teamCols.includes(c) || isNeutral(c), `color ${c} is neither a TEAMS color nor neutral`);
    }
  });

  test(`team ${t} mark uses its TEAMS colors and no text plate`, () => {
    const full = teamLogoSVG(t), mark = teamLogoSVG(t, { variant: 'mark' });
    const teamCols = Object.values(TEAMS[t].colors).map(hex);
    const used = colorsIn(mark);
    assert(used.includes(hex(TEAMS[t].colors.primary)), 'mark must use the primary color');
    for (const c of used) assert(teamCols.includes(c) || isNeutral(c), `mark color ${c} not from TEAMS`);
    assert(mark.length < full.length, 'mark should be a subset of the full crest');
    assert(/<g transform="translate\([^)]+\) scale\([^)]+\)">/.test(mark), 'mark should be scaled to fill the viewBox');
  });

  test(`team ${t} mono is single-color`, () => {
    const svg = teamLogoSVG(t, { variant: 'mono', mono: '#123456' });
    const team = Object.values(TEAMS[t].colors).map(hex);
    const used = new Set(colorsIn(svg));
    assert(used.has('#123456'), 'mono color not used');
    for (const c of used) assert(c === '#123456' || c === '#000' || c === '#fff', `unexpected color ${c} in mono`);
    for (const c of team) assert(!used.has(c), `team color ${c} leaked into mono`);
    assert(!/opacity=/.test(svg), 'mono must not contain partial-opacity shading');
    // the painted rect references the mask; exactly one paint element outside <defs>
    const outside = svg.replace(/<defs>.*<\/defs>/, '');
    assert((outside.match(/<rect /g) || []).length === 1, 'mono should paint a single masked rect');
  });
}

test('mono accepts numeric colors and default is white', () => {
  assert(teamLogoSVG(0, { variant: 'mono' }).includes('fill="#ffffff" mask='), 'default mono should be #ffffff');
  assert(teamLogoSVG(0, { variant: 'mono', mono: 0xff6a13 }).includes('fill="#ff6a13" mask='), 'numeric mono color');
});

test('mono color is sanitized (no markup injection)', () => {
  const svg = teamLogoSVG(2, { variant: 'mono', mono: '"/><script>alert(1)</script>' });
  checkSVG(svg, 'injected mono');
  assert(!svg.includes('<script'), 'script tag leaked');
  assert(svg.includes('fill="#ffffff" mask='), 'should fall back to white');
});

test('crests differ between teams and variants', () => {
  const all = new Set();
  for (let t = 0; t < TEAMS.length; t++) for (const v of VARIANTS) all.add(teamLogoSVG(t, { variant: v }));
  assert(all.size === TEAMS.length * VARIANTS.length, 'some crests are identical');
});

test('full crest carries an accessible label with the team name', () => {
  for (let t = 0; t < TEAMS.length; t++) {
    assert(teamLogoSVG(t).includes(`aria-label="${TEAMS[t].city} ${TEAMS[t].name} crest"`), `team ${t} label`);
  }
});

test('mono masks have per-team ids (safe to inline many in one page)', () => {
  const ids = TEAMS.map((_, t) => teamLogoSVG(t, { variant: 'mono' }).match(/<mask id="([^"]+)"/)[1]);
  assert(new Set(ids).size === TEAMS.length, `mask ids collide: ${ids}`);
  assert(!/\sid=/.test(teamLogoSVG(0)) && !/\sid=/.test(teamLogoSVG(0, { variant: 'mark' })), 'full/mark should not use ids');
});

test('bad arguments', () => {
  for (const bad of [-1, 6, 1.5, '0', null, undefined, NaN]) {
    let threw = false;
    try { teamLogoSVG(bad); } catch (e) { threw = e instanceof RangeError; }
    assert(threw, `teamIndex ${String(bad)} should throw RangeError`);
  }
  let threw = false;
  try { teamLogoSVG(0, { variant: 'sparkly' }); } catch (e) { threw = e instanceof RangeError; }
  assert(threw, 'unknown variant should throw RangeError');
  // nonsense sizes fall back to 128
  assert(teamLogoSVG(0, { size: -5 }).includes('width="128"'), 'negative size fallback');
  assert(teamLogoSVG(0, { size: 'abc' }).includes('width="128"'), 'NaN size fallback');
  assert(teamLogoSVG(0, { size: 37.5 }).includes('width="37.5"'), 'fractional size kept');
});

// --- wordmark / favicon / data URIs ---------------------------------------------------------
for (const theme of ['dark', 'light']) {
  test(`wordmark ${theme} well-formed + deterministic`, () => {
    const a = gameLogoSVG({ theme });
    checkSVG(a, `wordmark ${theme}`);
    assert(a === gameLogoSVG({ theme }), 'not deterministic');
    assert(a.includes(`aria-label="${GAME_NAME}"`), 'missing aria-label');
    assert(a.includes('width="480"'), 'default width 480');
  });
}
test('wordmark width / aspect', () => {
  const s = gameLogoSVG({ width: 800 });
  const w = +s.match(/width="([\d.]+)"/)[1], h = +s.match(/height="([\d.]+)"/)[1];
  assert(w === 800 && Math.abs(w / h - 400 / 132) < 0.01, `bad size ${w}x${h}`);
  assert(gameLogoSVG({ theme: 'dark' }) !== gameLogoSVG({ theme: 'light' }), 'themes should differ');
  assert(gameLogoSVG({ theme: 'bogus' }) === gameLogoSVG({ theme: 'dark' }), 'unknown theme -> dark');
});

test('svgToDataURI round-trips and is fully escaped', () => {
  const samples = [teamLogoSVG(0), teamLogoSVG(5, { variant: 'mono', mono: '#00a6a6' }), gameLogoSVG(), '<svg a="#1 50% (x) \'q\' & é"></svg>'];
  for (const svg of samples) {
    const uri = svgToDataURI(svg);
    assert(uri.startsWith('data:image/svg+xml;utf8,'), 'prefix');
    const body = uri.slice('data:image/svg+xml;utf8,'.length);
    assert(/^[A-Za-z0-9\-_.~%]*$/.test(body), `unescaped characters: ${body.replace(/[A-Za-z0-9\-_.~%]/g, '').slice(0, 20)}`);
    assert(decodeURIComponent(body) === svg, 'round-trip mismatch');
  }
});

test('faviconDataURI decodes to a well-formed 64x64 svg', () => {
  const uri = faviconDataURI();
  assert(uri === faviconDataURI(), 'favicon not deterministic');
  const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
  checkSVG(svg, 'favicon');
  assert(svg.includes('viewBox="0 0 64 64"'), 'favicon viewBox');
});

// --- browser-only API ------------------------------------------------------------------------
let asyncDone = (async () => {
  try {
    await svgToCanvas(teamLogoSVG(0), 64, 64);
    failed++; console.error('FAIL svgToCanvas should reject without a DOM');
  } catch (e) {
    if (/browser/i.test(e.message)) passed++;
    else { failed++; console.error(`FAIL svgToCanvas error message: ${e.message}`); }
  }
})();

// --- the checker itself must reject broken markup ---------------------------------------------
test('XML checker rejects malformed markup', () => {
  for (const bad of ['<svg><g></svg>', '<svg a="1" a="2"></svg>', '<svg><path d="M0 0"></svg>', '<svg>&</svg>',
    '<svg a=1></svg>', '<svg></svg><svg></svg>', '<svg><g></g>']) {
    let threw = false;
    try { checkXML(bad); } catch { threw = true; }
    assert(threw, `accepted malformed: ${bad}`);
  }
  assert(checkXML('<svg a="1"><g><path d="M0 0"/></g>&amp;</svg>'), 'rejected valid markup');
});

await asyncDone;
console.log(`logos: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
