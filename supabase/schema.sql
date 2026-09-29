-- Threads AI bootstrap schema. Apply once to a NEW, dedicated Supabase project.
-- All writes go through authenticated server routes. Browser roles have only owner reads.
begin;
create table public.users (
 id uuid primary key references auth.users(id) on delete cascade,
 email text not null, name text not null default 'Kreator', avatar_url text,
 timezone text not null default 'Asia/Kuala_Lumpur', language text not null default 'Bahasa Melayu',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.plans (
 id text primary key, name text not null, monthly_price numeric(10,2) not null check(monthly_price>=0),
 monthly_post_limit integer not null check(monthly_post_limit>=0), monthly_image_limit integer not null check(monthly_image_limit>=0), active boolean not null default true
);
insert into public.plans values ('starter','Starter',19,30,30,true),('pro','Pro',39,100,100,true),('business','Business',79,300,300,true);
create table public.subscriptions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references public.users(id) on delete cascade,
 plan_id text not null references public.plans(id), status text not null,
 current_period_start timestamptz not null, current_period_end timestamptz not null,
 provider_customer_id text unique, provider_subscription_id text unique, cancel_at_period_end boolean not null default false,
 last_event_created bigint not null default 0, monthly_amount numeric(10,2) not null default 0, created_at timestamptz not null default now()
);
create table public.social_accounts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 platform text not null default 'threads' check(platform in ('threads','instagram')), platform_user_id text not null, username text not null,
 access_token_encrypted text, expires_at timestamptz, status text not null default 'connected' check(status in ('connected','reconnect','disconnected')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id), unique(user_id,platform), unique(platform,platform_user_id)
);
create table public.posts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 social_account_id uuid, platform text not null default 'threads' check(platform in ('threads','instagram','both')),
 title text not null check(length(title) between 1 and 120), caption text not null default '' check(char_length(caption)<=2200),
 image_url text, image_prompt text not null default '', timezone text not null default 'Asia/Kuala_Lumpur',
 status text not null default 'draft' check(status in ('draft','scheduled','publishing','published','failed')),
 scheduled_at timestamptz, published_at timestamptz, platform_post_id text, container_id text,
 error_message text, error_code text, attempts integer not null default 0, claimed_at timestamptz, publish_attempted_at timestamptz, next_attempt_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(social_account_id,user_id) references public.social_accounts(id,user_id),
 check(status<>'scheduled' or scheduled_at is not null),
 check(status not in ('scheduled','publishing','published') or length(trim(caption))>0),
 check(status not in ('scheduled','publishing','published') or platform='threads' or (image_url is not null and length(trim(image_url))>0)),
 check(status not in ('scheduled','publishing','published') or platform='instagram' or char_length(caption)<=500)
);
create index posts_user_updated on public.posts(user_id,updated_at desc);
create index posts_due on public.posts(scheduled_at) where status='scheduled';
create index posts_account on public.posts(social_account_id);
create table public.usage (
 user_id uuid not null references public.users(id) on delete cascade, month date not null,
 copy_generations integer not null default 0 check(copy_generations>=0), image_generations integer not null default 0 check(image_generations>=0),
 posts_published integer not null default 0 check(posts_published>=0), estimated_cost numeric(14,6) not null default 0,
 primary key(user_id,month)
);
create table public.generations (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 post_id uuid references public.posts(id) on delete set null, type text not null check(type in ('copy','image')),
 model text not null, status text not null default 'reserved' check(status in ('reserved','succeeded','failed','uncertain')),
 input_tokens integer not null default 0, output_tokens integer not null default 0, estimated_cost numeric(14,6) not null default 0,
 provider_id text, cost_known boolean not null default false, result jsonb, created_at timestamptz not null default now()
);
create index generations_user_created on public.generations(user_id,created_at desc);
create index generations_post on public.generations(post_id);
create table public.rate_limits (user_id uuid not null references public.users(id) on delete cascade, action text not null, window_start timestamptz not null, count integer not null, primary key(user_id,action));
create table public.payment_events (id text primary key, created bigint not null, processed_at timestamptz not null default now());
create table public.billing_checkouts (user_id uuid primary key references public.users(id) on delete cascade, attempt_id uuid not null default gen_random_uuid(), plan_id text not null references public.plans(id), session_id text, url text, expires_at timestamptz not null);
create table public.technical_errors (id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id) on delete cascade, post_id uuid references public.posts(id) on delete set null, code text not null, detail jsonb not null default '{}', created_at timestamptz not null default now());
create index technical_errors_user on public.technical_errors(user_id);
create index technical_errors_post on public.technical_errors(post_id);
create table public.app_settings (id boolean primary key default true check(id), copy_model text not null, image_model text not null);
-- Empty settings: environment variables are the initial defaults; admin changes override them.

alter table public.users enable row level security;
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.social_accounts enable row level security;
alter table public.posts enable row level security;
alter table public.usage enable row level security;
alter table public.generations enable row level security;
alter table public.rate_limits enable row level security;
alter table public.payment_events enable row level security;
alter table public.technical_errors enable row level security;
alter table public.app_settings enable row level security;
alter table public.billing_checkouts enable row level security;
revoke all on public.billing_checkouts from anon,authenticated;
grant all on public.billing_checkouts to service_role;
revoke all on public.users,public.plans,public.subscriptions,public.social_accounts,public.posts,public.usage,public.generations,public.rate_limits,public.payment_events,public.technical_errors,public.app_settings from anon, authenticated;
grant select on public.users,public.posts,public.subscriptions,public.usage,public.generations to authenticated;
grant select(id,user_id,platform,platform_user_id,username,expires_at,status,created_at,updated_at) on public.social_accounts to authenticated;
grant select on public.plans to anon,authenticated;
grant all on public.users,public.plans,public.subscriptions,public.social_accounts,public.posts,public.usage,public.generations,public.rate_limits,public.payment_events,public.technical_errors,public.app_settings to service_role;
create policy users_read on public.users for select to authenticated using(id=(select auth.uid()));
create policy plans_read on public.plans for select to anon,authenticated using(active);
create policy subscriptions_read on public.subscriptions for select to authenticated using(user_id=(select auth.uid()));
create policy accounts_read on public.social_accounts for select to authenticated using(user_id=(select auth.uid()));
create policy posts_read on public.posts for select to authenticated using(user_id=(select auth.uid()));
create policy usage_read on public.usage for select to authenticated using(user_id=(select auth.uid()));
create policy generations_read on public.generations for select to authenticated using(user_id=(select auth.uid()));

-- INVOKER functions: only service_role can execute; no browser-controlled writes.
create function public.take_rate(p_user uuid,p_action text,p_limit integer) returns boolean language plpgsql set search_path='' as $$
declare n integer;
begin
 insert into public.rate_limits(user_id,action,window_start,count) values(p_user,p_action,date_trunc('minute',now()),1)
 on conflict(user_id,action) do update set
 count=case when public.rate_limits.window_start=date_trunc('minute',now()) then public.rate_limits.count+1 else 1 end,
 window_start=date_trunc('minute',now()) returning count into n;
 return n<=p_limit;
end;$$;

create function public.reserve_generation(p_user uuid,p_type text,p_model text,p_post uuid default null) returns uuid language plpgsql set search_path='' as $$
declare lim integer; used integer; gid uuid; mon date:=(date_trunc('month',now() at time zone 'UTC'))::date;
begin
 if p_type not in ('copy','image') then raise exception 'invalid_type'; end if;
 if p_post is not null and not exists(select 1 from public.posts where id=p_post and user_id=p_user) then raise exception 'not_found'; end if;
 select case when p_type='copy' then p.monthly_post_limit else p.monthly_image_limit end into lim
 from public.subscriptions s join public.plans p on p.id=s.plan_id where s.user_id=p_user and s.status='active' and s.current_period_end>now();
 if lim is null then raise exception 'subscription_required'; end if;
 insert into public.usage(user_id,month) values(p_user,mon) on conflict do nothing;
 select case when p_type='copy' then copy_generations else image_generations end into used from public.usage where user_id=p_user and month=mon for update;
 if used>=lim then raise exception 'quota_exceeded'; end if;
 update public.usage set copy_generations=copy_generations+case when p_type='copy' then 1 else 0 end,
 image_generations=image_generations+case when p_type='image' then 1 else 0 end where user_id=p_user and month=mon;
 insert into public.generations(user_id,post_id,type,model) values(p_user,p_post,p_type,p_model) returning id into gid;
 return gid;
end;$$;

create function public.finish_generation(p_id uuid,p_status text,p_input integer default 0,p_output integer default 0,p_cost numeric default 0,p_known boolean default false,p_provider text default null,p_result jsonb default null) returns void language plpgsql set search_path='' as $$
declare g public.generations; mon date;
begin
 if p_status not in ('succeeded','failed','uncertain') then raise exception 'invalid_status'; end if;
 select * into g from public.generations where id=p_id for update;
 if not found or g.status<>'reserved' then return; end if;
 mon:=(date_trunc('month',g.created_at at time zone 'UTC'))::date;
 update public.generations set status=p_status,input_tokens=greatest(0,p_input),output_tokens=greatest(0,p_output),estimated_cost=greatest(0,p_cost),cost_known=p_known,provider_id=p_provider,result=p_result where id=p_id;
 update public.usage set copy_generations=copy_generations-case when p_status='failed' and g.type='copy' then 1 else 0 end,
 image_generations=image_generations-case when p_status='failed' and g.type='image' then 1 else 0 end,
 estimated_cost=estimated_cost+greatest(0,p_cost) where user_id=g.user_id and month=mon;
end;$$;

create function public.claim_post(p_id uuid,p_user uuid) returns setof public.posts language plpgsql set search_path='' as $$
begin
 return query update public.posts set status='publishing',claimed_at=now(),updated_at=now(),error_message=null,error_code=null,attempts=attempts+1
 where id=p_id and user_id=p_user and status in ('draft','scheduled','failed') and coalesce(error_code,'')<>'outcome_unknown' and publish_attempted_at is null and length(trim(caption))>0
 returning *;
end;$$;

create function public.claim_due_posts(p_limit integer default 4) returns setof public.posts language plpgsql set search_path='' as $$
begin
 -- A crashed worker's external result is unknown. Never republish automatically.
 update public.posts set status='failed',error_code='outcome_unknown',error_message='Hasil penerbitan belum pasti. Semak Threads sebelum mencuba lagi.',updated_at=now()
 where status='publishing' and claimed_at<now()-interval '10 minutes';
 return query with due as (select id from public.posts where status='scheduled' and scheduled_at<=now() and (next_attempt_at is null or next_attempt_at<=now()) order by scheduled_at for update skip locked limit least(p_limit,10))
 update public.posts p set status='publishing',claimed_at=now(),updated_at=now(),attempts=attempts+1 from due where p.id=due.id returning p.*;
end;$$;

create function public.complete_publish(p_id uuid,p_platform_id text) returns void language plpgsql set search_path='' as $$
declare uid uuid;
begin
 update public.posts set status='published',platform_post_id=p_platform_id,published_at=now(),error_message=null,error_code=null,updated_at=now()
 where id=p_id and status='publishing' returning user_id into uid;
 if uid is not null then
 insert into public.usage(user_id,month,posts_published) values(uid,(date_trunc('month',now() at time zone 'UTC'))::date,1)
 on conflict(user_id,month) do update set posts_published=public.usage.posts_published+1;
 end if;
end;$$;

create function public.apply_subscription(p_event_id text,p_event_created bigint,p_user uuid,p_plan text,p_status text,p_start timestamptz,p_end timestamptz,p_customer text,p_subscription text,p_cancel boolean,p_amount numeric default 0) returns void language plpgsql set search_path='' as $$
begin
 insert into public.payment_events(id,created) values(p_event_id,p_event_created) on conflict do nothing;
 if not found then return; end if;
 insert into public.subscriptions(user_id,plan_id,status,current_period_start,current_period_end,provider_customer_id,provider_subscription_id,cancel_at_period_end,last_event_created,monthly_amount)
 values(p_user,p_plan,p_status,p_start,p_end,p_customer,p_subscription,p_cancel,p_event_created,p_amount)
 on conflict(user_id) do update set plan_id=excluded.plan_id,status=excluded.status,current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,provider_customer_id=excluded.provider_customer_id,provider_subscription_id=excluded.provider_subscription_id,cancel_at_period_end=excluded.cancel_at_period_end,last_event_created=excluded.last_event_created,monthly_amount=excluded.monthly_amount
 where public.subscriptions.last_event_created<=excluded.last_event_created;
end;$$;

create function public.reserve_checkout(p_user uuid,p_plan text) returns uuid language plpgsql set search_path='' as $$
declare attempt uuid;
begin
 insert into public.billing_checkouts(user_id,plan_id,expires_at) values(p_user,p_plan,now()+interval '31 minutes')
 on conflict(user_id) do update set attempt_id=gen_random_uuid(),plan_id=excluded.plan_id,session_id=null,url=null,expires_at=excluded.expires_at
 where public.billing_checkouts.expires_at<now() returning attempt_id into attempt;
 return attempt;
end;$$;

create function public.admin_metrics() returns jsonb language sql set search_path='' as $$
 select jsonb_build_object(
  'users',(select count(*) from public.users),
  'subscribers',(select count(*) from public.subscriptions where status='active' and current_period_end>now()),
  'mrr',(select coalesce(sum(monthly_amount),0) from public.subscriptions where status='active' and current_period_end>now()),
  'aiCostUsd',(select coalesce(sum(estimated_cost),0) from public.usage where month=(date_trunc('month',now() at time zone 'UTC'))::date),
  'images',(select coalesce(sum(image_generations),0) from public.usage where month=(date_trunc('month',now() at time zone 'UTC'))::date),
  'published',(select count(*) from public.posts where status='published'),
  'failed',(select count(*) from public.posts where status='failed'),
  'unknownCosts',(select count(*) from public.generations where status in ('succeeded','uncertain') and not cost_known and created_at>=date_trunc('month',now() at time zone 'UTC'))
 );
$$;

revoke all on function public.take_rate(uuid,text,integer),public.reserve_generation(uuid,text,text,uuid),public.finish_generation(uuid,text,integer,integer,numeric,boolean,text,jsonb),public.claim_post(uuid,uuid),public.claim_due_posts(integer),public.complete_publish(uuid,text),public.apply_subscription(text,bigint,uuid,text,text,timestamptz,timestamptz,text,text,boolean,numeric),public.reserve_checkout(uuid,text),public.admin_metrics() from public,anon,authenticated;
grant execute on function public.take_rate(uuid,text,integer),public.reserve_generation(uuid,text,text,uuid),public.finish_generation(uuid,text,integer,integer,numeric,boolean,text,jsonb),public.claim_post(uuid,uuid),public.claim_due_posts(integer),public.complete_publish(uuid,text),public.apply_subscription(text,bigint,uuid,text,text,timestamptz,timestamptz,text,text,boolean,numeric),public.reserve_checkout(uuid,text),public.admin_metrics() to service_role;

-- Operator decision for a generation whose provider outcome was never confirmed.
-- Refund returns the credit to the month it was reserved in; charge keeps it. Returns false if already resolved.
create function public.resolve_generation(p_id uuid,p_refund boolean) returns boolean language plpgsql set search_path='' as $$
declare g public.generations; mon date;
begin
 select * into g from public.generations where id=p_id for update;
 if not found or g.status<>'uncertain' then return false; end if;
 update public.generations set status=case when p_refund then 'failed' else 'succeeded' end where id=p_id;
 if p_refund then
  mon:=(date_trunc('month',g.created_at at time zone 'UTC'))::date;
  update public.usage set copy_generations=greatest(0,copy_generations-case when g.type='copy' then 1 else 0 end),
  image_generations=greatest(0,image_generations-case when g.type='image' then 1 else 0 end) where user_id=g.user_id and month=mon;
 end if;
 return true;
end;$$;

-- Stored images older than a week that no post references (matched by the file UUID, so a post's
-- converted .jpg sibling for Instagram counts as referenced too).
create function public.orphan_images(p_limit integer default 500) returns setof text language plpgsql set search_path='' as $$
begin
 return query select o.name::text from storage.objects o
 where o.bucket_id='post-images' and o.created_at<now()-interval '7 days'
 and not exists(select 1 from public.posts p where p.image_url like '%'||split_part(split_part(o.name,'/',2),'.',1)||'%')
 order by o.created_at limit least(greatest(p_limit,0),1000);
end;$$;

revoke all on function public.resolve_generation(uuid,boolean),public.orphan_images(integer) from public,anon,authenticated;
grant execute on function public.resolve_generation(uuid,boolean),public.orphan_images(integer) to service_role;

-- Social automation (identical to supabase/migrations/20260929_social_automation.sql).
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
