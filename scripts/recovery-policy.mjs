import { recoverTestPolicyFile } from '../src/recovery/policy.mjs';

const [action, planSha256] = process.argv.slice(2);
if (!['preview', 'apply'].includes(action) || (action === 'apply' && !planSha256)
    || (action === 'preview' && planSha256)) {
  console.error('Usage: node scripts/recovery-policy.mjs preview | apply <planSha256>');
  process.exitCode = 2;
} else {
  try {
    const result = await recoverTestPolicyFile({
      currentPath: process.env.ALEPH_RECOVERY_TEST_POLICY_PATH,
      backupPath: process.env.ALEPH_RECOVERY_POLICY_BACKUP_PATH,
      trustedSha256: process.env.ALEPH_RECOVERY_POLICY_SHA256,
      incidentAt: process.env.ALEPH_RECOVERY_INCIDENT_AT,
      confirm: action === 'apply' ? planSha256 : null,
    });
    process.stdout.write(JSON.stringify({
      applied: result.applied,
      verifiedAfterRead: result.verifiedAfterRead === true,
      serviceId: result.preview.serviceId,
      fromVersion: result.preview.currentVersion,
      toVersion: result.preview.restoreVersion,
      changedPaths: result.preview.changedPaths,
      changes: result.preview.changes,
      backupSha256: result.preview.backupSha256,
      planSha256: result.preview.planSha256,
    }, null, 2) + '\n');
  } catch (error) {
    // Codes only. Never print backup content, policy secrets or private paths.
    console.error(error?.message && /^[A-Z_]+$/.test(error.message)
      ? error.message : 'POLICY_RECOVERY_FAILED');
    process.exitCode = 1;
  }
}