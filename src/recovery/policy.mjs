import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9_:-]{0,63}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
export const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };

function checkedTime(value) {
  if (typeof value !== 'string' || !UTC.test(value)) fail('INVALID_BACKUP_TIME');
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !==
    (value.includes('.') ? value : value.slice(0, -1) + '.000Z')) fail('INVALID_BACKUP_TIME');
  return n;
}
function checkedRules(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).sort().join(',') !== 'ownerOnly,rules,version'
      || typeof policy.version !== 'string' || !ID.test(policy.version)
      || typeof policy.ownerOnly !== 'boolean'
      || !Array.isArray(policy.rules) || policy.rules.length > 20
      || policy.rules.some(rule => typeof rule !== 'string' || !ID.test(rule))
      || new Set(policy.rules).size !== policy.rules.length) fail('INVALID_POLICY_STRUCTURE');
  return structuredClone(policy);
}
export function verifyPolicyBackup(raw, expectedSha256, incidentAt) {
  if (typeof raw !== 'string' || raw.length > 65536 || !HEX.test(expectedSha256 ?? '')
      || hash(raw) !== expectedSha256) fail('UNVERIFIED_POLICY_BACKUP');
  let backup;
  try { backup = JSON.parse(raw); } catch { fail('INVALID_POLICY_BACKUP'); }
  if (backup?.schema !== 'aleph.recovery.policy-backup.v1'
    || backup.serviceId !== 'notes'
    || Object.keys(backup).sort().join(',') !==
       'capturedAt,policy,schema,serviceId,verifiedAt') fail('INVALID_POLICY_BACKUP');
  if (checkedTime(backup.capturedAt) > checkedTime(backup.verifiedAt)
      || checkedTime(backup.verifiedAt) >= checkedTime(incidentAt)) {
    fail('NOT_VERIFIED_BEFORE_INCIDENT');
  }
  return { ...backup, policy: checkedRules(backup.policy), sha256: expectedSha256 };
}
export function previewPolicyRestore({ current, backupRaw, trustedSha256, incidentAt }) {
  const backup = verifyPolicyBackup(backupRaw, trustedSha256, incidentAt);
  if (current?.schema !== 'aleph.recovery.test-policy.v1'
      || !current.services || typeof current.services !== 'object'
      || Array.isArray(current.services) || !Object.hasOwn(current.services, 'notes')
      || !Array.isArray(current.audit)) fail('INVALID_TEST_POLICY');
  const oldNotes = checkedRules(current.services.notes);
  const nextNotes = backup.policy;
  const changes = Object.keys(nextNotes).filter(k =>
    JSON.stringify(oldNotes[k]) !== JSON.stringify(nextNotes[k]))
    .map(k => ({ path: 'services.notes.' + k, before: oldNotes[k], after: nextNotes[k] }));
  const currentHash = hash(JSON.stringify(current));
  const planSha256 = hash(JSON.stringify({
    currentHash, backupHash: backup.sha256, serviceId: 'notes', target: nextNotes,
  }));
  return {
    schema: 'aleph.recovery.policy-preview.v1', serviceId: 'notes',
    currentVersion: oldNotes.version, restoreVersion: nextNotes.version,
    backupSha256: backup.sha256, currentSha256: currentHash,
    planSha256, changes, changedPaths: changes.map(x => x.path),
  };
}
// Applies only the "notes" part of a test policy. No live decider, table,
// grants, other services or audit records are written.
export function restoreTestPolicy({ current, backupRaw, trustedSha256, incidentAt, confirmedPlanSha256 }) {
  const preview = previewPolicyRestore({ current, backupRaw, trustedSha256, incidentAt });
  if (!HEX.test(confirmedPlanSha256 ?? '') || preview.planSha256 !== confirmedPlanSha256)
    fail('POLICY_PLAN_CONFIRMATION_REQUIRED');
  const restored = structuredClone(current);
  restored.services.notes = verifyPolicyBackup(backupRaw, trustedSha256, incidentAt).policy;
  return { preview, restored };
}
const safeRegularFile = async path => {
  // Opening the descriptor with O_NOFOLLOW closes the lstat/readFile
  // symlink-swap gap. Validate the SAME descriptor that supplies the bytes.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const meta = await handle.stat();
    if (!meta.isFile() || meta.nlink !== 1 || meta.size > 65536)
      fail('UNSAFE_POLICY_FILE');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle?.close();
  }
};
// Verify the on-disk backup each time it is read, including immediately before
// writing. A previously verified in-memory object is not a trusted file.
async function rereadVerifiedPolicyBackup(path, trustedSha256, incidentAt) {
  let raw;
  try { raw = await safeRegularFile(path); }
  catch { fail('UNVERIFIED_POLICY_BACKUP'); }
  verifyPolicyBackup(raw, trustedSha256, incidentAt);
  return raw;
}
export async function recoverTestPolicyFile({ currentPath, backupPath, trustedSha256, incidentAt, confirm }) {
  if (typeof currentPath !== 'string' || typeof backupPath !== 'string'
      || basename(currentPath) !== 'test-policy.json'
      || basename(backupPath) !== 'safe-policy.json') fail('TEST_POLICY_PATH_REQUIRED');
  const dir = await realpath(dirname(currentPath));
  const backupDir = await realpath(dirname(backupPath));
  const tempBase = resolve(tmpdir()) + sep;
  if (!dir.startsWith(tempBase) || !basename(dir).startsWith('aleph-recovery-lab-')
      || backupDir !== dir) fail('TEST_POLICY_PATH_REQUIRED');
  const resolvedCurrent = join(dir, 'test-policy.json');
  const resolvedBackup = join(dir, 'safe-policy.json');
  if (resolve(currentPath) !== resolvedCurrent || resolve(backupPath) !== resolvedBackup)
    fail('TEST_POLICY_PATH_REQUIRED');
  const currentRaw = await safeRegularFile(resolvedCurrent);
  const backupRaw = await rereadVerifiedPolicyBackup(resolvedBackup, trustedSha256, incidentAt);
  let current;
  try { current = JSON.parse(currentRaw); } catch { fail('INVALID_TEST_POLICY'); }
  const preview = previewPolicyRestore({ current, backupRaw, trustedSha256, incidentAt });
  if (confirm == null) return { preview, applied: false };
  // Require a SECOND real disk read after preview, not just the cached raw.
  const rereadBackup = await rereadVerifiedPolicyBackup(resolvedBackup, trustedSha256, incidentAt);
  if (rereadBackup !== backupRaw) fail('UNVERIFIED_POLICY_BACKUP');
  const { restored } = restoreTestPolicy({
    current, backupRaw: rereadBackup, trustedSha256, incidentAt, confirmedPlanSha256: confirm,
  });
  // Optimistic compare immediately before the atomic replacement.
  if (hash(await safeRegularFile(resolvedCurrent)) !== hash(currentRaw))
    fail('POLICY_CHANGED_DURING_RESTORE');
  const temp = join(dir, '.test-policy-' + randomUUID() + '.tmp');
  try {
    const stagedRaw = JSON.stringify(restored, null, 2) + '\n';
    await writeFile(temp, stagedRaw, { flag: 'wx', mode: 0o600 });
    // Verify the exact staged bytes before replacing any policy file.
    if (await safeRegularFile(temp) !== stagedRaw)
      fail('UNVERIFIED_STAGED_POLICY');
    // Recheck both source files after staging and before the atomic switch.
    const backupBeforeCommit = await rereadVerifiedPolicyBackup(resolvedBackup, trustedSha256, incidentAt);
    if (backupBeforeCommit !== rereadBackup) fail('UNVERIFIED_POLICY_BACKUP');
    if (hash(await safeRegularFile(resolvedCurrent)) !== hash(currentRaw))
      fail('POLICY_CHANGED_DURING_RESTORE');
    await rename(temp, resolvedCurrent);
  } finally {
    await unlink(temp).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }
  // A successful rename is not equivalent to a verified restoration.
  // Read back the final policy and compare the entire allowed result,
  // including unchanged services and immutable audit history.
  let saved;
  try { saved = JSON.parse(await safeRegularFile(resolvedCurrent)); }
  catch { fail('POST_RESTORE_VERIFICATION_FAILED'); }
  if (hash(JSON.stringify(saved)) !== hash(JSON.stringify(restored))
      || JSON.stringify(saved.audit) !== JSON.stringify(current.audit)
      || Object.keys(saved.services).sort().join(',') !== Object.keys(current.services).sort().join(',')) {
    fail('POST_RESTORE_VERIFICATION_FAILED');
  }
  return { preview, applied: true, verifiedAfterRead: true };
}
