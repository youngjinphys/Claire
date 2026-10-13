-- 10단계 검토용: 지정 B 학습 메모의 조건부 갱신만 지원합니다.
-- 이 SQL은 이번 작업에서 실제 Supabase DB에 실행하지 않습니다.
-- PRIVILEGE: service_role ONLY; SECURITY INVOKER; 다른 테이블/감사 기록에 영향 없음.
begin;

create or replace function public.restore_one_learning_note(
  p_id uuid,
  p_owner_id uuid,
  p_original_title text,
  p_original_content text,
  p_restored_title text,
  p_restored_content text
) returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $body$
declare
  v_changed uuid;
begin
  update public.learning_notes
  set title = p_restored_title,
      content = p_restored_content
  where id = p_id
    and owner_id = p_owner_id
    and title is not distinct from p_original_title
    and content is not distinct from p_original_content
  returning id into v_changed;
  return v_changed;
end;
$body$;

revoke all on function public.restore_one_learning_note(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.restore_one_learning_note(
  uuid, uuid, text, text, text, text
) to service_role;

commit;

-- 기대: anon, authenticated = execute false; service_role = execute true.
select
  has_function_privilege('anon',
    'public.restore_one_learning_note(uuid,uuid,text,text,text,text)', 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',
    'public.restore_one_learning_note(uuid,uuid,text,text,text,text)', 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',
    'public.restore_one_learning_note(uuid,uuid,text,text,text,text)', 'EXECUTE') as service_execute;
