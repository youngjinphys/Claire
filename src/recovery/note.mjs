import { createHash } from 'node:crypto';

const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const fail = code => { throw new Error(code); };
export const sha256 = data => createHash('sha256').update(data).digest('hex');

const timestamp = value => {
  if (typeof value !== 'string' || !TIME.test(value)) fail('INVALID_BACKUP_TIME');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString()
    !== (value.includes('.') ? value : value.slice(0, -1) + '.000Z')) fail('INVALID_BACKUP_TIME');
  return ms;
};
const noteFields = record => ({
  id: record.id, owner_id: record.owner_id, title: record.title, body: record.body,
});
export const contentSha256 = note => sha256(JSON.stringify(noteFields(note)));
const validText = (x,max) => typeof x === 'string' && x.length > 0 && x.length <= max
  && x.trim().length > 0;

export function verifyNoteBackup({ raw, trustedSha256, incidentAt, pinnedBOwnerId }) {
  if (typeof raw !== 'string' || raw.length > 8192 || !SHA.test(trustedSha256 ?? '')
      || sha256(raw) !== trustedSha256) fail('UNVERIFIED_NOTE_BACKUP');
  let item;
  try { item = JSON.parse(raw); } catch { fail('INVALID_NOTE_BACKUP'); }
  if (item?.schema !== 'aleph.recovery.note-backup.v1'
      || Object.keys(item).sort().join(',') !==
        'body,capturedAt,contentSha256,id,ownerId,schema,title,verifiedAt,version'
      || typeof item.version !== 'string'
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(item.version)
      || !UUID.test(item.id) || !UUID.test(item.ownerId)
      || !UUID.test(pinnedBOwnerId ?? '')
      || item.ownerId !== pinnedBOwnerId
      || !validText(item.title,120) || !validText(item.body,2000)
      || !SHA.test(item.contentSha256 ?? '')) fail('INVALID_NOTE_BACKUP');
  if (timestamp(item.capturedAt) > timestamp(item.verifiedAt)
    || timestamp(item.verifiedAt) >= timestamp(incidentAt))
    fail('NOT_VERIFIED_BEFORE_INCIDENT');
  const row = { id: item.id, owner_id: item.ownerId, title: item.title, body: item.body };
  if (contentSha256(row) !== item.contentSha256) fail('BACKUP_CONTENT_HASH_MISMATCH');
  return { item, row, trustedSha256 };
}

function presentRow(data) {
  return data == null ? null : { id: data.id, owner_id: data.owner_id,
    title: data.title, body: data.content ?? data.body };
}
export function previewNoteRestore({
  raw, trustedSha256, incidentAt, pinnedBOwnerId, identityUserId, id, current,
}) {
  const verified = verifyNoteBackup({ raw, trustedSha256, incidentAt, pinnedBOwnerId });
  if (!UUID.test(id ?? '') || id !== verified.row.id) fail('NOTE_NOT_IN_BACKUP');
  if (!UUID.test(identityUserId ?? '') || identityUserId !== pinnedBOwnerId)
    fail('RESTORE_NOT_AUTHORIZED');
  const existing = presentRow(current);
  if (existing && (existing.id !== id || existing.owner_id !== pinnedBOwnerId))
    fail('NOTE_OWNER_CONFLICT');
  const currentHash = existing ? contentSha256(existing) : null;
  const status = !existing ? 'insert' :
    currentHash === verified.item.contentSha256 ? 'already_restored' : 'replace';
  const planSha256 = sha256(JSON.stringify({
    snapshotSha256: trustedSha256, id, ownerId: pinnedBOwnerId,
    beforeSha256: currentHash, afterSha256: verified.item.contentSha256, status,
  }));
  return {
    schema: 'aleph.recovery.note-preview.v1', id,
    ownerId: pinnedBOwnerId, beforeSha256: currentHash,
    contentSha256: verified.item.contentSha256,
    backupSha256: trustedSha256, planSha256, status,
  };
}
export async function restoreNoteOnce({
  store, raw, trustedSha256, incidentAt, pinnedBOwnerId,
  identityUserId, id, confirmedPlanSha256, rereadBackup,
}) {
  if (!store || typeof store.find !== 'function'
      || typeof store.insert !== 'function' || typeof store.replaceIfCurrent !== 'function')
    fail('RESTORE_BACKEND_UNAVAILABLE');
  const current = await store.find(id);
  const preview = previewNoteRestore({
    raw, trustedSha256, incidentAt, pinnedBOwnerId, identityUserId, id, current,
  });
  if (!SHA.test(confirmedPlanSha256 ?? '') || preview.planSha256 !== confirmedPlanSha256)
    fail('NOTE_PLAN_CONFIRMATION_REQUIRED');
  // Server adapter must re-read the configured backup and pinned digest after
  // plan confirmation. A missing, switched or unverified backup cannot write.
  if (rereadBackup !== undefined) {
    if (typeof rereadBackup !== 'function') fail('UNVERIFIED_NOTE_BACKUP');
    let source;
    try { source = await rereadBackup(); }
    catch { fail('UNVERIFIED_NOTE_BACKUP'); }
    if (source?.raw !== raw || source?.trustedSha256 !== trustedSha256)
      fail('UNVERIFIED_NOTE_BACKUP');
    verifyNoteBackup({ raw: source.raw, trustedSha256: source.trustedSha256,
      incidentAt, pinnedBOwnerId });
  }
  if (preview.status !== 'already_restored') {
    const verified = verifyNoteBackup({ raw, trustedSha256, incidentAt, pinnedBOwnerId });
    // No upsert: never overwrite another owner's row or another concurrent write.
    if (preview.status === 'insert') await store.insert(verified.row);
    else await store.replaceIfCurrent(verified.row, current);
  }
  const after = await store.find(id);
  if (!after || after.owner_id !== pinnedBOwnerId
    || contentSha256(presentRow(after)) !== preview.contentSha256)
    fail('POST_RESTORE_VERIFICATION_FAILED');
  return { id, ownerId: pinnedBOwnerId, contentSha256: preview.contentSha256,
    status: preview.status === 'already_restored' ? 'unchanged' : 'restored' };
}
