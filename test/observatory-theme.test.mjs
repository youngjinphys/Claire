import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/observatory-theme.css',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));

test('Observatory-inspired HUD preserves authoritative evidence and vault anchors',()=>{
  assert.match(html,/href="\/operations\.css"/u);
  assert.match(html,/href="\/observatory-theme\.css"/u);
  assert.match(html,/class="hero-orbit" aria-hidden="true"/u);
  for(const id of ['ops-refresh','ops-export','metric-observed','metric-verified',
    'metric-stages','metric-attacks','vault','ops-records']){
    assert.ok(html.includes('id="'+id+'"'), 'missing existing element '+id);
  }
  assert.match(html,/OFFICIAL JUDGE UNVERIFIED/u);
  assert.doesNotMatch(css,/https?:\/\/|@import|url\(/iu);
});
test('visual-only layer is responsive and reduced-motion-aware',()=>{
  assert.match(css,/prefers-reduced-motion:reduce/u);
  assert.match(css,/max-width:730px/u);
  assert.match(css,/\.hero-orbit\s*\{[^}]*pointer-events:none/su);
  assert.match(css,/--bg:#071322/u);
  assert.equal(manifest.background_color,'#071322');
  assert.equal(manifest.theme_color,'#071322');
  assert.match(html,/name="theme-color" content="#071322"/u);
});
