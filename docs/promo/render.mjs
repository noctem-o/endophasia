// Renders scene.html frame by frame in headless Chromium and pipes the frames
// to ffmpeg. Usage:
//   node render.mjs --w 1080 --h 1920 --out out/video-9x16.mp4 [--audio out/soundtrack.wav]
//   node render.mjs --w 1080 --h 1920 --stills 1.5,5.8,21.8 --out out/stills
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const W = +(args.w ?? 1080), H = +(args.h ?? 1920);
const tl = JSON.parse(readFileSync(join(here, 'timeline.js'), 'utf8').split('window.TL =')[1].trim().replace(/;\s*$/, ''));
const fps = +(args.fps ?? tl.fps);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'scene.html')).href + `?w=${W}&h=${H}`);
await page.evaluate(() => document.fonts.ready);
const shot = async (t) => { await page.evaluate((x) => window.renderAt(x), t); return page.screenshot({ type: 'png' }); };

if (args.stills) {
  const dir = resolve(args.out ?? join(here, 'out/stills'));
  mkdirSync(dir, { recursive: true });
  for (const t of args.stills.split(',').map(Number)) {
    await page.evaluate((x) => window.renderAt(x), t);
    await page.screenshot({ path: join(dir, `${W}x${H}-t${t.toFixed(2)}.png`) });
  }
  console.log('stills ->', dir);
} else {
  const out = resolve(args.out ?? join(here, `out/endophasia-${W}x${H}.mp4`));
  mkdirSync(dirname(out), { recursive: true });
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    ...(args.audio ? ['-i', resolve(args.audio), '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round(tl.duration * fps);
  for (let f = 0; f < n; f++) {
    const buf = await shot(f / fps);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log(`${W}x${H} frame ${f}/${n}`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on('close', (c) => (c ? j(new Error('ffmpeg ' + c)) : r())));
  console.log('video ->', out);
}
await browser.close();
