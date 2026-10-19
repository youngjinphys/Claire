import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import config from '../aleph.config.json' with { type: 'json' };

const TEST_ID = '00000000-0000-4000-8000-000000000000';
const RESTORE_ERROR = /^[A-Z][A-Z0-9_]{1,79}$/u;

export function classifyStage10Probe({ manifest, manifestStatus, restoreStatus, restoreError }) {
  const deploymentMatches = manifestStatus === 200
    && manifest?.step === 10
    && manifest?.restoreRoute === '/api/restore/notes/:id'
    && Array.isArray(manifest?.allowedRoutes)
    && manifest.allowedRoutes.includes(manifest.restoreRoute);
  const knownError = typeof restoreError === 'string' && RESTORE_ERROR.test(restoreError)
    ? restoreError : null;

  let readiness = 'UNDETERMINED';
  if (!deploymentMatches) readiness = 'DEPLOYMENT_CONTRACT_MISMATCH';
  else if (restoreStatus === 503 && knownError === 'RESTORE_DISABLED')
    readiness = 'RESTORE_DISABLED';
  else if (restoreStatus === 503 && knownError === 'VERIFIED_BACKUP_NOT_CONFIGURED')
    readiness = 'BACKUP_NOT_CONFIGURED';
  else if (restoreStatus === 503 && knownError === 'UNVERIFIED_NOTE_BACKUP')
    readiness = 'BACKUP_REJECTED';
  else if (restoreStatus === 401 && knownError === 'UNAUTHORIZED')
    readiness = 'AUTH_REQUIRED';

  // A probe without a real authenticated B restore can never prove a backup
  // match, persistent DB read-back, or complete 1-9 regression execution.
  return {
    deploymentContractVerified: deploymentMatches,
    readiness,
    backupMatch: 'not_proven',
    restoredReadback: 'not_proven',
    stages1to9Retested: 'not_proven',
  };
}

const jsonOrNull = async response => {
  try { return await response.json(); } catch { return null; }
};

export async function diagnoseRestore({ fetcher = fetch, baseUrl = config.publicAppUrl } = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('INVALID_PUBLIC_APP_URL');
  }

  const args = { redirect:'error', cache:'no-store',
    headers: {Accept:'application/json'}, signal: AbortSignal.timeout(10000) };
  const identityResponse = await fetcher(new URL('/aleph.json', origin), args);
  const manifest = identityResponse.ok ? await jsonOrNull(identityResponse) : null;
  const noteResponse = await fetcher(
    new URL('/api/restore/notes/' + TEST_ID, origin), args);
  const payload = await jsonOrNull(noteResponse);

  const classification = classifyStage10Probe({
    manifest, manifestStatus: identityResponse.status,
    restoreStatus: noteResponse.status, restoreError: payload?.error,
  });

  return {
    schema: 'aleph.recovery.diagnostic.v1',
    source: 'anonymous-live-http',
    manifest: {
      httpStatus: identityResponse.status,
      step: Number.isInteger(manifest?.step) ? manifest.step : null,
      commit: /^[a-f0-9]{40}$/iu.test(manifest?.commit || '') ? manifest.commit : null,
      restoreRoute: typeof manifest?.restoreRoute === 'string'
        ? manifest.restoreRoute : null,
    },
    anonymousRestore: {
      httpStatus: noteResponse.status,
      error: typeof payload?.error === 'string' && RESTORE_ERROR.test(payload.error)
        ? payload.error : null,
      // No response body, token, note, account, or backup is retained.
    },
    ...classification,
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const diagnostic = await diagnoseRestore();
    console.log('Stage 10 diagnosis: ' + diagnostic.readiness
      + '; backup=' + diagnostic.backupMatch
      + '; regression=' + diagnostic.stages1to9Retested);
  } catch (error) {
    console.error('Stage 10 diagnosis failed: ' +
      (error instanceof Error ? error.message : 'unknown'));
    process.exitCode = 1;
  }
}
