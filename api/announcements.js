import { createClient } from '@supabase/supabase-js';
import config from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from '../src/verify-login.mjs';
import { typedResourceId, mayEditAnnouncement } from '../src/resource-zones.mjs';
import { verifyDeviceGrant } from '../src/device-access.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function createAnnouncementsHandler({ env = process.env, supabaseFactory = createClient,
  verifierFactory = createLoginVerifier, deviceGrantVerifier = verifyDeviceGrant } = {}) {
let backend;
const init = () => {
  if (backend) return backend;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return null;
  const db = supabaseFactory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  backend = { db, verify: verifierFactory({ config, supabaseClient: db }) };
  return backend;
};
const deny = (response, status, reason) => {
  // No account identifiers, credentials, notice contents or IDs in logs.
  if (status === 403 || status === 404) console.info('RESOURCE_DENIED zone=announcements reason=' + reason);
  return response.status(status).json({ error: reason });
};
const bodyData = request => {
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) return request.body;
  if (typeof request.body !== 'string' || request.body.length > 8192) return null;
  try { const value = JSON.parse(request.body); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
};
const validBody = value => value && Object.keys(value).every(key => ['title','body'].includes(key))
  && typeof value.title === 'string' && value.title.trim().length > 0 && value.title.trim().length <= 120
  && typeof value.body === 'string' && value.body.trim().length > 0 && value.body.trim().length <= 2000;

return async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' && request.method !== 'PUT') {
    response.setHeader('Allow', 'GET, PUT');
    return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }
  const current = init();
  if (!current) return response.status(503).json({ error: 'ANNOUNCEMENTS_BACKEND_UNAVAILABLE' });
  const identity = await current.verify(request.headers?.authorization);
  if (!identity) {
    response.setHeader('WWW-Authenticate', 'Bearer');
    return response.status(401).json({ error: 'UNAUTHORIZED' });
  }
  if(identity.kind !== 'judge' && !(await deviceGrantVerifier({
    db: current.db, identity, authorization: request.headers?.authorization,
    headers: request.headers ?? {}
  }))) return deny(response,403,'DEVICE_NOT_VERIFIED');

  const input = request.query?.id;
  const id = Array.isArray(input) ? null : input;
  if (typeof id !== 'string' || !UUID.test(id)) return response.status(400).json({ error: 'INVALID_RESOURCE_ID' });

  let metadata = null;
  if (request.method === 'PUT') {
    if (identity.kind !== 'student') return deny(response, 403, 'INSTRUCTOR_REQUIRED');
    // Admin API fetches app_metadata from Supabase Auth, not browser role/user_metadata.
    const { data, error } = await current.db.auth.admin.getUserById(identity.userId);
    if (error || !data?.user || data.user.id !== identity.userId) {
      return deny(response, 403, 'INSTRUCTOR_REQUIRED');
    }
    metadata = data.user.app_metadata;
    if (!metadata || !(metadata.role === 'instructor'
        || (Array.isArray(metadata.roles) && metadata.roles.includes('instructor')))) {
      return deny(response, 403, 'INSTRUCTOR_REQUIRED');
    }
  }

  // This table must be provisioned by the course operator. This step does not
  // create or migrate DB tables. Missing storage is fail-closed (never fabricate).
  const lookup = current.db.from('learning_announcements')
    .select('id,title,content,owner_id').eq('id', id);
  if (request.method === 'PUT') lookup.eq('owner_id', identity.userId);
  const { data: existing, error: findError } = await lookup.maybeSingle();
  if (findError) return response.status(503).json({ error: 'ANNOUNCEMENTS_STORE_UNAVAILABLE' });
  if (!existing) return deny(response, 404, 'RESOURCE_NOT_FOUND');

  if (request.method === 'GET') {
    response.setHeader('X-Resource-Id', typedResourceId('announcement', id));
    return response.status(200).json({ id: existing.id, title: existing.title, body: existing.content });
  }

  if (!mayEditAnnouncement({ identity, verifiedAppMetadata: metadata, storedOwnerId: existing.owner_id })) {
    return deny(response, 404, 'RESOURCE_NOT_FOUND');
  }
  const value = bodyData(request);
  if (!validBody(value)) return response.status(400).json({ error: 'INVALID_ANNOUNCEMENT' });
  const { data: updated, error } = await current.db.from('learning_announcements')
    .update({ title: value.title.trim(), content: value.body.trim(), owner_id: identity.userId })
    .eq('id', id).eq('owner_id', identity.userId)
    .select('id,title,content,owner_id').maybeSingle();
  if (error) return response.status(503).json({ error: 'ANNOUNCEMENTS_STORE_UNAVAILABLE' });
  if (!updated || !mayEditAnnouncement({ identity, verifiedAppMetadata: metadata, storedOwnerId: updated.owner_id })) {
    return deny(response, 404, 'RESOURCE_NOT_FOUND');
  }
  response.setHeader('X-Resource-Id', typedResourceId('announcement', id));
  return response.status(200).json({ id: updated.id, title: updated.title, body: updated.content });
}
}

export default createAnnouncementsHandler();
