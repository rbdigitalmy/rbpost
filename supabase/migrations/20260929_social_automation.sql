-- Apply once to an existing database (Supabase Dashboard -> SQL Editor). Fresh installs get this from schema.sql.
-- Instagram comment/DM automation and Threads reply automation.
begin;

-- Scopes granted at the last OAuth connection; NULL means a legacy connection that must reconnect for automation.
-- provider_account_id is the Instagram professional account ID that webhooks use as entry.id.
alter table public.social_accounts add column if not exists scopes text[];
alter table public.social_accounts add column if not exists provider_account_id text;
alter table public.social_accounts add column if not exists webhooks_subscribed_at timestamptz;
grant select(scopes) on public.social_accounts to authenticated;

-- One rule per connected account. `enabled` is the account's emergency switch: off stops every automated reply.
create table public.automation_rules (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 social_account_id uuid not null unique, platform text not null check(platform in ('threads','instagram')),
 enabled boolean not null default false,
 comment_reply_enabled boolean not null default false, comment_reply_template text not null default '' check(char_length(comment_reply_template)<=1000),
 private_reply_enabled boolean not null default false, private_reply_template text not null default '' check(octet_length(private_reply_template)<=1000),
 dm_reply_enabled boolean not null default false, dm_reply_template text not null default '' check(octet_length(dm_reply_template)<=1000),
 threads_reply_enabled boolean not null default false, threads_reply_template text not null default '' check(char_length(threads_reply_template)<=500),
 keywords text[] not null default '{}' check(cardinality(keywords)<=20), exclude_keywords text[] not null default '{}' check(cardinality(exclude_keywords)<=20),
 cooldown_minutes integer not null default 60 check(cooldown_minutes between 1 and 1440),
 -- Threads polling never replies to anything older than the moment reply automation was switched on.
 threads_since timestamptz, threads_polled_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(social_account_id,user_id) references public.social_accounts(id,user_id) on delete cascade,
 check(platform='instagram' or not (comment_reply_enabled or private_reply_enabled or dm_reply_enabled)),
 check(platform='threads' or not threads_reply_enabled)
);
create index automation_rules_user on public.automation_rules(user_id);

-- Inbound comments, messages and replies. Message text is never stored: filters run before insert.
create table public.inbound_social_events (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 social_account_id uuid not null, platform text not null check(platform in ('threads','instagram')),
 kind text not null check(kind in ('ig_comment','ig_message','threads_reply')),
 provider_event_id text not null check(length(provider_event_id) between 1 and 200),
 sender_id text check(length(sender_id)<=200), parent_id text check(length(parent_id)<=200),
 provider_created_at timestamptz, received_at timestamptz not null default now(),
 status text not null check(status in ('queued','skipped')), skip_reason text,
 foreign key(social_account_id,user_id) references public.social_accounts(id,user_id) on delete cascade,
 unique(social_account_id,kind,provider_event_id)
);
create index inbound_social_events_user on public.inbound_social_events(user_id,received_at desc);
create index inbound_social_events_received on public.inbound_social_events(received_at);

-- One outgoing reply per event and action (idempotency_key). send_attempted_at is written before the irreversible call.
create table public.automation_runs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 social_account_id uuid not null, event_id uuid not null references public.inbound_social_events(id) on delete cascade,
 action text not null check(action in ('comment_reply','private_reply','dm_reply','threads_reply')),
 idempotency_key text not null unique, recipient_id text,
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','skipped','uncertain')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(), claimed_at timestamptz,
 send_attempted_at timestamptz, provider_container_id text, provider_result_id text,
 error_code text, error_message text check(char_length(error_message)<=300),
 created_at timestamptz not null default now(), sent_at timestamptz, updated_at timestamptz not null default now(),
 foreign key(social_account_id,user_id) references public.social_accounts(id,user_id) on delete cascade
);
create index automation_runs_due on public.automation_runs(next_attempt_at) where status='pending';
create index automation_runs_account on public.automation_runs(social_account_id,created_at desc);
create index automation_runs_recipient on public.automation_runs(social_account_id,recipient_id,created_at desc);
create index automation_runs_user on public.automation_runs(user_id,created_at desc);
create index automation_runs_event on public.automation_runs(event_id);

-- Threads polling checkpoint per root post: only replies newer than last_reply_at are read.
create table public.automation_checkpoints (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 social_account_id uuid not null, media_id text not null check(length(media_id) between 1 and 200),
 media_created_at timestamptz, last_reply_at timestamptz not null, polled_at timestamptz,
 foreign key(social_account_id,user_id) references public.social_accounts(id,user_id) on delete cascade,
 unique(social_account_id,media_id)
);
create index automation_checkpoints_media on public.automation_checkpoints(media_id);
create index automation_checkpoints_user on public.automation_checkpoints(user_id);

alter table public.automation_rules enable row level security;
alter table public.inbound_social_events enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_checkpoints enable row level security;
revoke all on public.automation_rules,public.inbound_social_events,public.automation_runs,public.automation_checkpoints from anon,authenticated;
grant select on public.automation_rules,public.inbound_social_events,public.automation_runs,public.automation_checkpoints to authenticated;
grant all on public.automation_rules,public.inbound_social_events,public.automation_runs,public.automation_checkpoints to service_role;
create policy automation_rules_read on public.automation_rules for select to authenticated using(user_id=(select auth.uid()));
create policy inbound_social_events_read on public.inbound_social_events for select to authenticated using(user_id=(select auth.uid()));
create policy automation_runs_read on public.automation_runs for select to authenticated using(user_id=(select auth.uid()));
create policy automation_checkpoints_read on public.automation_checkpoints for select to authenticated using(user_id=(select auth.uid()));

-- Records an inbound event exactly once and queues its replies. A per-sender advisory lock makes the
-- cooldown check and the queueing atomic, so two deliveries at once cannot both reply.
create function public.ingest_automation_event(p_user uuid,p_account uuid,p_platform text,p_kind text,p_event_id text,p_sender text,p_parent text,p_created timestamptz,p_actions text[],p_skip text,p_cooldown_minutes integer)
returns table(event_id uuid,inserted boolean,event_status text,queued integer) language plpgsql set search_path='' as $$
declare eid uuid; n integer:=0;
begin
 if not exists(select 1 from public.social_accounts a where a.id=p_account and a.user_id=p_user and a.platform=p_platform) then raise exception 'not_found'; end if;
 insert into public.inbound_social_events(user_id,social_account_id,platform,kind,provider_event_id,sender_id,parent_id,provider_created_at,status,skip_reason)
 values(p_user,p_account,p_platform,p_kind,p_event_id,p_sender,p_parent,p_created,case when p_skip is null then 'queued' else 'skipped' end,p_skip)
 on conflict(social_account_id,kind,provider_event_id) do nothing returning id into eid;
 if eid is null then
  return query select e.id,false,e.status,0 from public.inbound_social_events e where e.social_account_id=p_account and e.kind=p_kind and e.provider_event_id=p_event_id;
  return;
 end if;
 if p_skip is not null or coalesce(cardinality(p_actions),0)=0 then
  update public.inbound_social_events set status='skipped',skip_reason=coalesce(p_skip,'disabled') where id=eid;
  return query select eid,true,'skipped'::text,0; return;
 end if;
 if p_sender is not null then
  perform pg_advisory_xact_lock(hashtextextended(p_account::text||':'||p_sender,0));
  if exists(select 1 from public.automation_runs r where r.social_account_id=p_account and r.recipient_id=p_sender
   and r.status in ('pending','sending','sent','uncertain') and r.created_at>now()-make_interval(mins=>greatest(p_cooldown_minutes,1))) then
   update public.inbound_social_events set status='skipped',skip_reason='cooldown' where id=eid;
   return query select eid,true,'skipped'::text,0; return;
  end if;
 end if;
 insert into public.automation_runs(user_id,social_account_id,event_id,action,recipient_id,idempotency_key)
 select p_user,p_account,eid,a,p_sender,eid::text||':'||a from unnest(p_actions) a
 where a in ('comment_reply','private_reply','dm_reply','threads_reply') on conflict(idempotency_key) do nothing;
 get diagnostics n=row_count;
 return query select eid,true,'queued'::text,n;
end;$$;

-- Claims due replies for one worker (SKIP LOCKED). A worker that crashed after the irreversible call leaves an
-- unknown outcome: that run becomes 'uncertain' and is never sent again automatically.
create function public.claim_automation_runs(p_limit integer default 10) returns setof public.automation_runs language plpgsql set search_path='' as $$
begin
 update public.automation_runs set status=case when send_attempted_at is null then 'pending' else 'uncertain' end,
  error_code=case when send_attempted_at is null then error_code else 'outcome_unknown' end,
  error_message=case when send_attempted_at is null then error_message else 'Hasil balasan tidak dapat dipastikan. Semak akaun sebelum membalas semula.' end,
  updated_at=now()
 where status='sending' and claimed_at<now()-interval '10 minutes';
 return query with due as (select id from public.automation_runs where status='pending' and next_attempt_at<=now() order by next_attempt_at for update skip locked limit least(greatest(p_limit,0),25))
 update public.automation_runs r set status='sending',claimed_at=now(),attempts=r.attempts+1,updated_at=now() from due where r.id=due.id returning r.*;
end;$$;

-- Settles a claimed run. 'retry' reschedules (bounded by the caller), 'defer' reschedules without spending an attempt.
create function public.finish_automation_run(p_id uuid,p_status text,p_error_code text default null,p_error_message text default null,p_result_id text default null,p_retry_at timestamptz default null)
returns boolean language plpgsql set search_path='' as $$
begin
 if p_status not in ('sent','failed','skipped','uncertain','retry','defer') then raise exception 'invalid_status'; end if;
 update public.automation_runs set
  status=case when p_status in ('retry','defer') then 'pending' else p_status end,
  attempts=case when p_status='defer' then greatest(attempts-1,0) else attempts end,
  next_attempt_at=case when p_status in ('retry','defer') then coalesce(p_retry_at,now()+interval '1 minute') else next_attempt_at end,
  send_attempted_at=case when p_status in ('retry','defer') then null else send_attempted_at end,
  claimed_at=case when p_status in ('retry','defer') then null else claimed_at end,
  error_code=case when p_status='sent' then null else p_error_code end,
  error_message=case when p_status='sent' then null else left(p_error_message,300) end,
  provider_result_id=coalesce(p_result_id,provider_result_id),
  sent_at=case when p_status='sent' then now() else sent_at end,
  updated_at=now()
 where id=p_id and status='sending';
 return found;
end;$$;

-- Retention: inbound event metadata and reply audit rows are kept for p_days (default 30).
create function public.purge_automation_data(p_days integer default 30) returns integer language plpgsql set search_path='' as $$
declare n integer;
begin
 delete from public.inbound_social_events where received_at<now()-make_interval(days=>greatest(p_days,7));
 get diagnostics n=row_count;
 delete from public.automation_checkpoints where coalesce(media_created_at,polled_at,now())<now()-make_interval(days=>greatest(p_days,7));
 return n;
end;$$;

revoke all on function public.ingest_automation_event(uuid,uuid,text,text,text,text,text,timestamptz,text[],text,integer),public.claim_automation_runs(integer),public.finish_automation_run(uuid,text,text,text,text,timestamptz),public.purge_automation_data(integer) from public,anon,authenticated;
grant execute on function public.ingest_automation_event(uuid,uuid,text,text,text,text,text,timestamptz,text[],text,integer),public.claim_automation_runs(integer),public.finish_automation_run(uuid,text,text,text,text,timestamptz),public.purge_automation_data(integer) to service_role;

commit;
