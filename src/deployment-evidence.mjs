// A public manifest is unsigned evidence, not proof of a successful deployment
// or of an official ALEPH judge decision. Validate only explicit expected values.
const SHA = /^[0-9a-f]{40}$/u;
const object = value => value !== null && typeof value === 'object'
  && !Array.isArray(value);
const same = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((entry, i) => same(entry, b[i]));
  }
  if (!object(a) || !object(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length
    && left.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
};
const result = (outcome, reason) => Object.freeze({outcome, reason});

export function compareDeploymentIdentity(manifest, config, expectedCommit) {
  if (!object(config) || config.step !== 12
      || typeof config.repoUrl !== 'string' || typeof config.publicAppUrl !== 'string') {
    return result('inconclusive', 'EXPECTED_CONFIG_UNAVAILABLE');
  }
  if (!object(manifest) || manifest.schema !== 'aleph.defense.deployment.v1'
      || manifest.step !== 12 || !SHA.test(manifest.commit ?? '')) {
    return result('failed', 'MANIFEST_INVALID');
  }
  for (const key of ['repoUrl', 'publicAppUrl', 'judgeIssuer',
    'originalApiUrl', 'restoreRoute', 'allowedRoutes', 'protectedService',
    'resourceZones']) {
    if (!same(manifest[key], config[key])) {
      return result('failed', 'MANIFEST_' + key.replace(/[A-Z]/g, match => '_' + match).toUpperCase() + '_MISMATCH');
    }
  }
  if (typeof expectedCommit !== 'string' || !SHA.test(expectedCommit.toLowerCase())) {
    return result('inconclusive', 'EXPECTED_COMMIT_UNAVAILABLE');
  }
  if (manifest.commit !== expectedCommit.toLowerCase()) {
    return result('failed', 'COMMIT_MISMATCH');
  }
  return result('verified', 'IDENTITY_CONSISTENT');
}
