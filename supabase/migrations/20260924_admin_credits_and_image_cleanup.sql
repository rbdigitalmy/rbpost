-- Apply once to an existing database (Supabase Dashboard -> SQL Editor). Fresh installs get these from schema.sql.
begin;

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
commit;
