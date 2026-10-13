import { createClient } from '@supabase/supabase-js';
import config from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from '../src/verify-login.mjs';
import {
  previewNoteRestore, restoreNoteOnce, verifyNoteBackup,
} from '../src/recovery/note.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
const NO_STORE = value => {
  value.setHeader('Cache-Control', 'no-store');
  value.setHeader('CDN-Cache-Control', 'no-store');
  value.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  value.setHeader('X-Content-Type-Options', 'nosniff');
};
const parseBody = req => {
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
    if (raw.length > 256) return null;
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).join(',') !== 'planSha256' || !SHA.test(body.planSha256)) return null;
    return body;
  } catch { return null; }
};
const rawSnapshot = value => {
  if (typeof value !== 'string' || value.length > 12000
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) return null;
  try {
    const content = Buffer.from(value, 'base64');
    return content.toString('base64') === value ? content.toString('utf8') : null;
  } catch { return null; }
};

function storeFor(db) {
  const select = 'id,owner_id,title,content';
  const check = ({ error, data }) => {
    if (error) throw new Error('RESTORE_BACKEND_ERROR');
    return data;
  };
  return {
    async find(id) {
      return check(await db.from('learning_notes').select(select).eq('id', id).maybeSingle());
    },
    async insert(row) {
      const { data, error } = await db.from('learning_notes')
        .insert({ id: row.id, owner_id: row.owner_id, title: row.title, content: row.body })
        .select('id')
        .maybeSingle();
      if (error?.code === '23505') throw new Error('NOTE_CHANGED_DURING_RESTORE');
      check({ data, error });
      if (!data || data.id !== row.id) throw new Error('NOTE_CHANGED_DURING_RESTORE');
    },
    async replaceIfCurrent(row, current) {
      if (!current || current.id !== row.id || current.owner_id !== row.owner_id
          || typeof current.title !== 'string' || typeof current.content !== 'string')
        throw new Error('NOTE_OWNER_CONFLICT');
      // Private note values belong in the HTTPS RPC body, not a URL filter.
      // A SECURITY INVOKER SQL function handles the old-value CAS atomically.
      const { data, error } = await db.rpc('restore_one_learning_note', {
        p_id: row.id, p_owner_id: row.owner_id,
        p_original_title: current.title, p_original_content: current.content,
        p_restored_title: row.title, p_restored_content: row.body,
      });
      check({ data, error });
      if (data !== row.id) throw new Error('NOTE_CHANGED_DURING_RESTORE');
    },
  };
}

export function createRestoreHandler({
  env = process.env, supabaseFactory = createClient,
  verifierFactory = createLoginVerifier,
} = {}) {
  let runtime;
  return async function handler(req, res) {
    NO_STORE(res);
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    }
    if (env.RESTORE_ENABLED !== '1') return res.status(503).json({ error: 'RESTORE_DISABLED' });

    const wanted = Array.isArray(req.query?.id) ? null : req.query?.id;
    if (typeof wanted !== 'string' || !UUID.test(wanted))
      return res.status(400).json({ error: 'INVALID_NOTE_ID' });

    // Same-origin browser requests only. No refresh cookies authenticate this route;
    // the existing verified Bearer token is mandatory.
    if (typeof req.headers?.origin === 'string'
      && req.headers.origin !== config.publicAppUrl)
      return res.status(403).json({ error: 'ORIGIN_DENIED' });

    const snapshot = rawSnapshot(env.RESTORE_NOTE_SNAPSHOT_BASE64);
    if (!snapshot || !env.RESTORE_NOTE_BACKUP_SHA256 || !env.RESTORE_INCIDENT_AT
        || !env.RESTORE_B_OWNER_ID || !env.RESTORE_OPERATOR_USER_ID
        || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      return res.status(503).json({ error: 'VERIFIED_BACKUP_NOT_CONFIGURED' });
    }
    const inputs = {
      raw: snapshot,
      trustedSha256: env.RESTORE_NOTE_BACKUP_SHA256,
      incidentAt: env.RESTORE_INCIDENT_AT,
      pinnedBOwnerId: env.RESTORE_B_OWNER_ID,
    };
    let verified;
    try { verified = verifyNoteBackup(inputs); }
    catch { return res.status(503).json({ error: 'UNVERIFIED_NOTE_BACKUP' }); }
    if (wanted !== verified.row.id)
      return res.status(404).json({ error: 'NOTE_NOT_IN_BACKUP' });

    try {
      if (!runtime) {
        const db = supabaseFactory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        runtime = { db, verify: verifierFactory({ config, supabaseClient: db }) };
      }
      const identity = await runtime.verify(req.headers?.authorization);
      if (!identity) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }
      // Restore is a separately pinned test-user operation, not a role claim
      // sent from the browser. Judge tokens and other users cannot use it.
      if (identity.kind !== 'student'
        || identity.userId !== env.RESTORE_B_OWNER_ID
        || identity.userId !== env.RESTORE_OPERATOR_USER_ID)
        return res.status(403).json({ error: 'RESTORE_NOT_AUTHORIZED' });

      const store = storeFor(runtime.db);
      if (req.method === 'GET') {
        const current = await store.find(wanted);
        const plan = previewNoteRestore({
          ...inputs, identityUserId: identity.userId, id: wanted, current,
        });
        return res.status(200).json(plan);
      }

      const body = parseBody(req);
      if (!body) return res.status(400).json({ error: 'INVALID_PLAN_CONFIRMATION' });
      const applied = await restoreNoteOnce({
        ...inputs, identityUserId: identity.userId, id: wanted, store,
        confirmedPlanSha256: body.planSha256,
        rereadBackup: async () => ({
          raw: rawSnapshot(env.RESTORE_NOTE_SNAPSHOT_BASE64),
          trustedSha256: env.RESTORE_NOTE_BACKUP_SHA256,
        }),
      });
      return res.status(200).json(applied);
    } catch (error) {
      const code = error?.message;
      if (code === 'UNVERIFIED_NOTE_BACKUP' || code === 'BACKUP_CONTENT_HASH_MISMATCH')
        return res.status(503).json({ error: 'UNVERIFIED_NOTE_BACKUP' });
      if (code === 'NOTE_OWNER_CONFLICT') return res.status(409).json({ error: code });
      if (code === 'NOTE_CHANGED_DURING_RESTORE'
          || code === 'NOTE_PLAN_CONFIRMATION_REQUIRED')
        return res.status(409).json({ error: code });
      return res.status(502).json({ error: 'RESTORE_BACKEND_ERROR' });
    }
  };
}

export default createRestoreHandler();
