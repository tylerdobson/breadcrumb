import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Render only the fictional transcript produced by capture-demo.mjs.
// These are documentation illustrations, never desktop screenshots.
const directory = new URL('../docs/images/', import.meta.url);
const { panels } = JSON.parse(readFileSync(new URL('demo-session.json', directory), 'utf8'));
const colors = {
  text: '#dce5ef', muted: '#93a7ba', cyan: '#7bdcf5', green: '#ade49a',
  yellow: '#f5d17a', magenta: '#dca5f2', red: '#ff9e9e',
};
const ansiColors = { 31: colors.red, 32: colors.green, 33: colors.yellow, 35: colors.magenta, 36: colors.cyan };
const width = 1280;
const fontSize = 22;
const lineHeight = 31;
const maxColumns = 84;
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plain = text => stripVTControlCharacters(text);

function styledCharacters(line) {
  let color = colors.text;
  let bold = false;
  const characters = [];
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith('\x1b[')) {
      for (const code of part.slice(2, -1).split(';').map(Number)) {
        if (code === 0) { color = colors.text; bold = false; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 39) color = colors.text;
        else if (ansiColors[code]) color = ansiColors[code];
        else throw new Error(`Unsupported ANSI style: ${code}`);
      }
    } else {
      for (const char of part) characters.push({ char, color, bold });
    }
  }
  return characters;
}

function wrap(characters) {
  const remaining = [...characters];
  const lines = [];
  while (remaining.length > maxColumns) {
    let end = maxColumns;
    while (end > maxColumns / 2 && remaining[end]?.char !== ' ') end--;
    if (end <= maxColumns / 2) end = maxColumns;
    lines.push(remaining.splice(0, end));
    if (remaining[0]?.char === ' ') remaining.shift();
  }
  lines.push(remaining);
  return lines;
}

function spans(characters) {
  const groups = [];
  for (const character of characters) {
    const last = groups.at(-1);
    if (last && last.color === character.color && last.bold === character.bold) last.text += character.char;
    else groups.push({ text: character.char, color: character.color, bold: character.bold });
  }
  return groups.map(group => `<tspan fill="${group.color}" font-weight="${group.bold ? 700 : 400}">${xml(group.text)}</tspan>`).join('');
}

const manifest = { description: 'Fictional Pausepin terminal illustrations, rendered from isolated CLI output.', assets: [] };
const transcript = [];
assert.deepEqual(panels.map(panel => panel.id), ['focus', 'resume', 'finish']);
for (const [index, panel] of panels.entries()) {
  const content = [];
  let y = 242;
  transcript.push(`${index + 1}. ${panel.title}`, panel.subtitle, '');
  const draw = (line, overrideColor) => {
    const characters = styledCharacters(line);
    if (overrideColor) for (const character of characters) character.color = overrideColor;
    for (const row of wrap(characters)) {
      content.push(`<text x="64" y="${y}" xml:space="preserve">${spans(row)}</text>`);
      y += lineHeight;
    }
  };
  for (const [entryIndex, entry] of panel.entries.entries()) {
    assert.ok(entry.command[0].startsWith('demo@laptop ~/projects/weather-widget $ '));
    const firstCommand = entry.command[0].split(' $ ');
    if (entryIndex > 0) y += 22;
    draw(firstCommand[0], colors.muted);
    draw(`$ ${firstCommand.slice(1).join(' $ ')}`);
    for (const continuation of entry.command.slice(1)) draw(continuation);
    y += 7;
    for (const line of entry.output.trimEnd().split('\n')) draw(line);
    transcript.push(...entry.command, plain(entry.output).trimEnd(), '');
  }
  const terminalBottom = y + 15;
  const height = terminalBottom + 68;
  const description = `${panel.subtitle} Fictional demo account and project. Commands and output come from an isolated Pausepin session.`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${xml(panel.title)} — Pausepin example</title>
  <desc id="description">${xml(description)}</desc>
  <defs>
    <linearGradient id="canvas" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#152632"/>
      <stop offset="1" stop-color="#0b1119"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="22" fill="url(#canvas)"/>
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="40" y="42" font-size="16" letter-spacing="2" fill="${colors.cyan}">PAUSEPIN / EXAMPLE SESSION</text>
    <text x="40" y="94" font-size="42" font-weight="700" fill="${colors.text}">${String(index + 1).padStart(2, '0')}  ${xml(panel.title)}</text>
    <text x="40" y="131" font-size="20" fill="${colors.muted}">${xml(panel.subtitle)}</text>
  </g>
  <rect x="32" y="164" width="1216" height="${terminalBottom - 164}" rx="14" fill="#101820" stroke="#344958"/>
  <path d="M46 164 H1234 Q1248 164 1248 178 V212 H32 V178 Q32 164 46 164Z" fill="#1c2934"/>
  <circle cx="58" cy="188" r="6" fill="#e98484"/>
  <circle cx="80" cy="188" r="6" fill="#dfc178"/>
  <circle cx="102" cy="188" r="6" fill="#94c791"/>
  <text x="640" y="194" text-anchor="middle" fill="${colors.muted}" font-family="Arial, Helvetica, sans-serif" font-size="16">demo@laptop — weather-widget</text>
  <g font-family="'DejaVu Sans Mono', 'Liberation Mono', Menlo, Consolas, monospace" font-size="${fontSize}">
    ${content.join('\n    ')}
  </g>
  <text x="40" y="${height - 28}" fill="${colors.muted}" font-family="Arial, Helvetica, sans-serif" font-size="15" letter-spacing="1">FICTIONAL DEMO · NO PERSONAL FILES OR DATA</text>
</svg>
`;
  assert.doesNotMatch(svg, /\x1b|\/Users\/|\/private\/|\/tmp\/|file:\/\/|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  const filename = `pausepin-${panel.id}.svg`;
  writeFileSync(new URL(filename, directory), svg);
  manifest.assets.push({ file: filename, width, height, title: panel.title, source: 'demo-session.json' });
}
writeFileSync(new URL('demo-transcript.txt', directory), transcript.join('\n'));
writeFileSync(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Rendered ${manifest.assets.length} fictional terminal illustrations in ${fileURLToPath(directory)}`);
