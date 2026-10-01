-- Pomodoro : file d'alertes par appareil (appliqué sur le projet samuelfr-site).

-- Dernière demande reçue de chaque appareil : une demande plus ancienne arrivée en retard est ignorée.
create table if not exists public.pomodoro_push_devices (
  device text primary key,
  seq bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.pomodoro_push_devices enable row level security;
revoke all on public.pomodoro_push_devices from anon, authenticated;

create index if not exists pomodoro_push_jobs_endpoint
  on public.pomodoro_push_jobs ((subscription->>'endpoint'));
-- Une alerte donnée ne peut être en file qu'une fois par téléphone.
create unique index if not exists pomodoro_push_jobs_once
  on public.pomodoro_push_jobs ((subscription->>'endpoint'), fire_at, kind) where not claimed;

-- Remplace d'un bloc les alertes à venir d'un appareil (p_sub null = annulation).
-- Les alertes remplacées sortent de la file (claimed) ; le passage planifié les purge ensuite.
-- Renvoie false si une demande plus récente de cet appareil est déjà passée.
-- p_seq null (ancienne version de l'app) : la demande passe toujours.
create or replace function public.pomodoro_schedule(p_device text, p_seq bigint, p_sub jsonb, p_jobs jsonb)
returns boolean
language plpgsql
set search_path to ''
as $$
declare
  ok boolean;
  ep text := p_sub->>'endpoint';
begin
  insert into public.pomodoro_push_devices as d (device, seq, updated_at)
       values (p_device, coalesce(p_seq, 0), now())
  on conflict (device) do update set seq = greatest(d.seq + 1, excluded.seq), updated_at = now()
       where p_seq is null or d.seq < excluded.seq
  returning true into ok;
  if ok is null then return false; end if;

  -- Un téléphone n'a qu'une seule file d'alertes, même si son identifiant a changé.
  if ep is not null then
    perform pg_advisory_xact_lock(hashtextextended(ep, 0));
  end if;
  update public.pomodoro_push_jobs set claimed = true
   where not claimed and (device = p_device or (ep is not null and subscription->>'endpoint' = ep));

  if ep is not null and jsonb_typeof(p_jobs) = 'array' then
    insert into public.pomodoro_push_jobs (device, subscription, fire_at, kind)
    select distinct p_device, p_sub, (j->>'at')::timestamptz, j->>'kind'
      from jsonb_array_elements(p_jobs) j
    on conflict do nothing;
  end if;
  return true;
end;
$$;
revoke all on function public.pomodoro_schedule(text, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pomodoro_schedule(text, bigint, jsonb, jsonb) to service_role;
