import { URL } from 'node:url';
import { validateAllowedRoutes, validateOriginalApiUrl, validateProtectedService, validateRestoreRoute, validateResourceZones } from './config-contract.mjs';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[a-f0-9]{40}$/iu;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/iu;
// Stage 12 must bind the checked-in repository identity to Vercel's verified Git source.
const REPOSITORY_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/iu;

export function deploymentIdentity(env, config) {
  const owner = env.VERCEL_GIT_REPO_OWNER;
  const repo = env.VERCEL_GIT_REPO_SLUG;
  const commit = env.VERCEL_GIT_COMMIT_SHA;
  const host = env.VERCEL_URL;
  const step = config?.step;
  // Preserve the immutable deployment URL contract of stages 1-11.
  // Stage 12 publishes the designated production alias.
  const publicUrl = step === 12 ? (() => {
    try {
      const url = new URL(config?.publicAppUrl);
      return url.protocol === 'https:' && HOST.test(url.hostname)
        && url.pathname === '/' && !url.search && !url.hash
        && !url.username && !url.password && !url.port
        ? url.origin : null;
    } catch { return null; }
  })() : null;
  const stepOneMarkerInvalid = step === 1 && (typeof config.sampleMarker !== 'string'
    || !/^[A-Z0-9_]{1,80}$/u.test(config.sampleMarker));

  let allowedRoutes;
  let originalApiUrl;
  let protectedService;
  let restoreRoute;
  let resourceZones;
  try {
    allowedRoutes = validateAllowedRoutes(config);
    originalApiUrl = validateOriginalApiUrl(config);
    protectedService = validateProtectedService(config);
    restoreRoute = validateRestoreRoute(config);
    resourceZones = validateResourceZones(config);
  } catch {
    throw new Error('배포 단계 설정의 허용 경로 또는 원본 자료 API 주소를 확인하세요.');
  }

  if (env.VERCEL_GIT_PROVIDER !== 'github' || !OWNER.test(owner || '')
      || !REPO.test(repo || '') || repo === '.' || repo === '..'
      || repo.toLowerCase().endsWith('.git') || !SHA.test(commit || '')
      || !HOST.test(host || '') || (step === 12 && !publicUrl) || !Number.isInteger(step) || step < 1 || step > 12
      || typeof config.judgeIssuer !== 'string'
      || !/^https:\/\/[a-z0-9-]+\.up\.railway\.app\/defense\/judge$/iu.test(config.judgeIssuer)
      || stepOneMarkerInvalid) {
    throw new Error('배포 식별 정보를 확인할 수 없습니다. Vercel 시스템 환경변수와 현재 단계 설정을 확인하세요.');
  }
  // Stage 1-11 retain their original system-environment identity contract.
  // Stage 12 must never publish a plausible manifest for a different GitHub repo.
  const declaredRepo = step === 12 && typeof config?.repoUrl === 'string'
    ? REPOSITORY_URL.exec(config.repoUrl) : null;
  if (step === 12 && (!declaredRepo
      || ['.', '..', '.git'].includes(declaredRepo[2].toLowerCase())
      || declaredRepo[2].toLowerCase().endsWith('.git')
      || config.repoUrl !== `https://github.com/${declaredRepo[1]}/${declaredRepo[2]}`
      || declaredRepo[1].toLowerCase() !== owner.toLowerCase()
      || declaredRepo[2].toLowerCase() !== repo.toLowerCase())) {
    throw new Error('배포 GitHub 저장소가 aleph.config.json.repoUrl과 일치하지 않습니다.');
  }
  const identity = {
    schema: 'aleph.defense.deployment.v1',
    step,
    repoUrl: step === 12 ? config.repoUrl
      : `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
    commit: commit.toLowerCase(),
    publicAppUrl: step === 12 ? publicUrl : `https://${host.toLowerCase()}`,
    judgeIssuer: config.judgeIssuer,
  };
  if (step === 1) identity.sampleMarker = config.sampleMarker;
  if (step >= 3) identity.allowedRoutes = allowedRoutes;
  if (step >= 5) identity.originalApiUrl = originalApiUrl;
  if (step >= 6) identity.protectedService = protectedService;
  if (step >= 8) identity.resourceZones = resourceZones;
  if (step >= 10) identity.restoreRoute = restoreRoute;
  return identity;
}
