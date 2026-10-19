import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, recoverTestPolicyFile } from './policy.mjs';
import { contentSha256, sha256, previewNoteRestore, restoreNoteOnce } from './note.mjs';

// Exercise the ACTUAL restoration code using disposable, synthetic material.
// This is reproducible proof of local fail-closed behavior, not a real backup.
const ensure = (ok, code) => {
  if (!ok) throw new Error('S10_SELF_CHECK_' + code);
};

async function mustReject(operation, expected) {
  try { await operation(); } catch (error) {
    ensure(error?.message === expected, 'UNEXPECTED_REJECTION');
    return;
  }
  throw new Error('S10_SELF_CHECK_WRITE_AFTER_FAILED_VERIFICATION');
}

export async function verifySyntheticStage10Recovery() {
  const dir = await mkdtemp(join(tmpdir(), 'aleph-recovery-lab-'));
  const capturedAt = '2026-09-01T00:00:00.000Z';
  const verifiedAt = '2026-09-02T00:00:00.000Z';
  const incidentAt = '2026-09-04T00:00:00.000Z';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const policyPath = join(dir, 'test-policy.json');
  const backupPath = join(dir, 'safe-policy.json');

  try {
    const baseline = {
      schema: 'aleph.recovery.test-policy.v1',
      services: {
        notes: { version: 'unsafe_v2', ownerOnly: false, rules: [] },
        otherService: { version: 'untouched', ownerOnly: true, rules: ['unchanged'] },
      },
      audit: [{ id: 'audit_fixture_001' }],
    };
    const policyBackupRaw = JSON.stringify({
      schema: 'aleph.recovery.policy-backup.v1',
      serviceId: 'notes', capturedAt, verifiedAt,
      policy: { version: 'safe_v1', ownerOnly: true,
        rules: ['device_registered', 'step_up_required'] },
    });
    const trustedPolicyDigest = hash(policyBackupRaw); // pinned BEFORE modification
    await writeFile(policyPath, JSON.stringify(baseline), 'utf8');
    await writeFile(backupPath, policyBackupRaw, 'utf8');
    const options = {
      currentPath: policyPath, backupPath,
      trustedSha256: trustedPolicyDigest, incidentAt,
    };
    const { preview } = await recoverTestPolicyFile(options);
    ensure(preview.restoreVersion === 'safe_v1'
      && preview.currentVersion === 'unsafe_v2'
      && preview.changedPaths.length === 3
      && preview.changedPaths.every(x => x.startsWith('services.notes.')),
      'POLICY_PREVIEW_MISMATCH');

    // An attacker changes the backup after preview. Nothing may be restored.
    await writeFile(backupPath, policyBackupRaw.replace('safe_v1', 'tampered_v1'));
    await mustReject(
      () => recoverTestPolicyFile({ ...options, confirm: preview.planSha256 }),
      'UNVERIFIED_POLICY_BACKUP',
    );
    ensure(JSON.stringify(JSON.parse(await readFile(policyPath, 'utf8')))
      === JSON.stringify(baseline), 'POLICY_CHANGED_AFTER_TAMPER');

    // Removing the backup after preview must also stop the operation.
    await rm(backupPath);
    await mustReject(
      () => recoverTestPolicyFile({ ...options, confirm: preview.planSha256 }),
      'UNVERIFIED_POLICY_BACKUP',
    );
    ensure(JSON.stringify(JSON.parse(await readFile(policyPath, 'utf8')))
      === JSON.stringify(baseline), 'POLICY_CHANGED_WITHOUT_BACKUP');

    // Only the tested notes service should be recovered.
    await writeFile(backupPath, policyBackupRaw, 'utf8');
    const policyRestored = await recoverTestPolicyFile({
      ...options, confirm: preview.planSha256,
    });
    const policyAfter = JSON.parse(await readFile(policyPath, 'utf8'));
    ensure(policyRestored.verifiedAfterRead === true
      && policyAfter.services.notes.version === 'safe_v1'
      && policyAfter.services.notes.ownerOnly === true
      && JSON.stringify(policyAfter.services.otherService)
        === JSON.stringify(baseline.services.otherService)
      && JSON.stringify(policyAfter.audit) === JSON.stringify(baseline.audit),
      'POLICY_POST_READBACK');

    const expected = {
      id: targetId, owner_id: B, title: 'B training item',
      body: 'Synthetic fixture only',
    };
    const noteRaw = JSON.stringify({
      schema: 'aleph.recovery.note-backup.v1',
      version: 'safe_v1', id: targetId, ownerId: B,
      capturedAt, verifiedAt, title: expected.title, body: expected.body,
      contentSha256: contentSha256(expected),
    });
    const trustedNoteDigest = sha256(noteRaw);
    const other = {
      id: otherId, owner_id: A, title: 'A item', content: 'Leave A unchanged',
    };
    const rows = new Map([[otherId, { ...other }]]);
    const audit = [{ id: 'audit_fixture_002' }];
    let writes = 0;
    const store = {
      async find(id) { return rows.has(id) ? { ...rows.get(id) } : null; },
      async restoreVerified(row, previous) {
        ensure(previous === null && !rows.has(row.id), 'NOTE_INSERT_COLLISION');
        const updated={id:row.id,owner_id:row.owner_id,title:row.title,content:row.body};
        ensure(updated.owner_id === B
          && contentSha256({...updated,body:updated.content}) === contentSha256(row),
          'NOTE_ATOMIC_READBACK');
        rows.set(row.id,updated);
        writes++;
        return {id:row.id,transactionalReadbackVerified:true};
      },
    };
    const noteArgs = {
      store, raw: noteRaw, trustedSha256: trustedNoteDigest,
      incidentAt, pinnedBOwnerId: B, identityUserId: B, id: targetId,
    };
    const notePlan = previewNoteRestore({ ...noteArgs, current: null });
    ensure(notePlan.backupVersion === 'safe_v1'
      && notePlan.contentSha256 === contentSha256(expected),
      'NOTE_PREVIEW_MISMATCH');

    await mustReject(() => restoreNoteOnce({
      ...noteArgs, confirmedPlanSha256: notePlan.planSha256,
      rereadBackup: async () => ({ raw: noteRaw.replace('safe_v1', 'tampered_v1'),
        trustedSha256: trustedNoteDigest }),
    }), 'UNVERIFIED_NOTE_BACKUP');
    await mustReject(() => restoreNoteOnce({
      ...noteArgs, confirmedPlanSha256: notePlan.planSha256,
      rereadBackup: async () => { throw new Error('not_available'); },
    }), 'UNVERIFIED_NOTE_BACKUP');
    await mustReject(() => restoreNoteOnce({
      ...noteArgs, confirmedPlanSha256: notePlan.planSha256,
      // Intentionally omit rereadBackup.
    }), 'UNVERIFIED_NOTE_BACKUP');
    ensure(writes === 0 && !rows.has(targetId)
      && JSON.stringify(rows.get(otherId)) === JSON.stringify(other),
      'NOTE_WRITE_AFTER_FAILED_VERIFICATION');

    const applied = await restoreNoteOnce({
      ...noteArgs, confirmedPlanSha256: notePlan.planSha256,
      rereadBackup: async () => ({ raw: noteRaw,
        trustedSha256: trustedNoteDigest }),
    });
    const actual = await store.find(targetId);
    ensure(writes === 1 && applied.status === 'restored'
      && applied.id === targetId && applied.ownerId === B
      && contentSha256({ ...actual, body: actual.content }) === notePlan.contentSha256
      && JSON.stringify(rows.get(otherId)) === JSON.stringify(other)
      && JSON.stringify(audit) === JSON.stringify([{id:'audit_fixture_002'}]),
      'NOTE_POST_READBACK');

    return {
      kind:'synthetic_local_only',
      policyPreviewVerified: true,
      policyTamperStoppedBeforeWrite: true,
      policyMissingBackupStoppedBeforeWrite: true,
      policyRestoreReadbackVerified: true,
      unchangedServiceAndAuditPreserved: true,
      noteTamperStoppedBeforeWrite: true,
      noteMissingBackupStoppedBeforeWrite: true,
      noteRestoreReadbackVerified: true,
      otherNotesPreserved: true,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
