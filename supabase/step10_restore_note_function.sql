-- Stage 10 proposed transaction-safe B-note restore (NOT applied by this task).
-- The caller MUST authenticate B, pin an independently verified pre-incident
-- backup hash, and re-read the backup before reaching this function.
-- Restore both missing and existing rows within one SECURITY INVOKER TX.
begin;

drop function if exists public.restore_one_learning_note(
  uuid, uuid, text, text, text, text
);

create or replace function public.restore_one_learning_note(
  p_id uuid,
  p_owner_id uuid,
  p_expected_exists boolean,
  p_original_title text,
  p_original_content text,
  p_restored_title text,
  p_restored_content text
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $body$
declare
  v_previous_owner uuid;
  v_previous_title text;
  v_previous_content text;
  v_after_owner uuid;
  v_after_title text;
  v_after_content text;
  v_found boolean;
begin
  if p_id is null or p_owner_id is null or p_expected_exists is null
     or p_restored_title is null or p_restored_content is null
     or char_length(trim(p_restored_title)) not between 1 and 120
     or char_length(trim(p_restored_content)) not between 1 and 2000
     or (p_expected_exists and
         (p_original_title is null or p_original_content is null))
  then
    raise exception 'RESTORE_INVALID_INPUT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_id::text, 0)
  );

  select owner_id, title, content
    into v_previous_owner, v_previous_title, v_previous_content
    from public.learning_notes
    where id = p_id
    for update;
  v_found := found;

  if p_expected_exists then
    if not v_found or v_previous_owner is distinct from p_owner_id
       or v_previous_title is distinct from p_original_title
       or v_previous_content is distinct from p_original_content
    then
      raise exception 'NOTE_CHANGED_DURING_RESTORE';
    end if;

    update public.learning_notes
      set title = p_restored_title, content = p_restored_content
      where id = p_id and owner_id = p_owner_id
        and title is not distinct from p_original_title
        and content is not distinct from p_original_content;
    if not found then raise exception 'NOTE_CHANGED_DURING_RESTORE'; end if;
  else
    if v_found then raise exception 'NOTE_CHANGED_DURING_RESTORE'; end if;
    insert into public.learning_notes (id, owner_id, title, content)
      values (p_id, p_owner_id, p_restored_title, p_restored_content);
  end if;

  -- Internal readback is in the SAME transaction. Any mismatch raises and
  -- rolls back even the INSERT branch; the caller cannot report success.
  select owner_id, title, content
    into v_after_owner, v_after_title, v_after_content
    from public.learning_notes
    where id = p_id
    for update;
  if not found or v_after_owner is distinct from p_owner_id
     or v_after_title is distinct from p_restored_title
     or v_after_content is distinct from p_restored_content
  then
    raise exception 'POST_RESTORE_VERIFICATION_FAILED';
  end if;

  return pg_catalog.jsonb_build_object(
    'verified', true, 'id', p_id, 'owner_id', v_after_owner,
    'title', v_after_title, 'content', v_after_content
  );
end;
$body$;

revoke all on function public.restore_one_learning_note(
  uuid,uuid,boolean,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.restore_one_learning_note(
  uuid,uuid,boolean,text,text,text,text
) to service_role;

commit;

-- READ-ONLY post-deployment verification, to be run after explicit approval:
-- SELECT has_function_privilege('anon',
--   'public.restore_one_learning_note(uuid,uuid,boolean,text,text,text,text)','EXECUTE') AS anon_execute;
-- SELECT has_function_privilege('service_role',
--   'public.restore_one_learning_note(uuid,uuid,boolean,text,text,text,text)','EXECUTE') AS service_execute;
