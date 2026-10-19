import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Prefer a student's ignored local notes, but make a clean checkout
// reproducible when the judge builds directly from the repository.
export function loadBundleNotes(root) {
  const localPath = join(root, 'bundle-notes.json');
  let text;
  try { text = readFileSync(localPath, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (text !== undefined) {
    return { notes: JSON.parse(text), origin: 'local_bundle_notes' };
  }
  const defaultPath = join(root, 'package', 'bundle-notes.template.json');
  return {
    notes: JSON.parse(readFileSync(defaultPath, 'utf8')),
    origin: 'tracked_conservative_template',
  };
}
