import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const alice = '11111111-1111-4111-8111-111111111111',
  bob = '22222222-2222-4222-8222-222222222222';
async function setup() {
  const pg = new PGlite();
  await pg.exec(
    `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth,public to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`,
  );
  await pg.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await pg.exec(
    `insert into auth.users values('${alice}'),('${bob}'); insert into public.users(id,email) values('${alice}','alice@example.com'),('${bob}','bob@example.com');insert into public.subscriptions(user_id,plan_id,status,current_period_start,current_period_end) values('${alice}','starter','active',now(),now()+interval '1 month'),('${bob}','starter','active',now(),now()+interval '1 month');`,
  );
  return pg;
}

test('RLS isolates every user and never exposes encrypted tokens or server mutation functions', async () => {
  const pg = await setup();
  try {
    await pg.exec(
      `insert into public.posts(user_id,title,caption) values('${alice}','Alice draft','a'),('${bob}','Bob draft','b'); insert into public.social_accounts(user_id,platform_user_id,username,access_token_encrypted) values('${alice}','100','alice','secret-ciphertext');set role authenticated; select set_config('request.jwt.claim.sub','${alice}',false);`,
    );
    const posts = await pg.query<{ title: string }>('select title from public.posts');
    assert.deepEqual(
      posts.rows.map(x => x.title),
      ['Alice draft'],
    );
    assert.equal((await pg.query('select * from public.users')).rows.length, 1);
    await assert.rejects(pg.query('select access_token_encrypted from public.social_accounts'), /permission denied/);
    await assert.rejects(pg.query(`update public.posts set status='published'`), /permission denied/);
    await assert.rejects(
      pg.query(`select public.reserve_generation('${alice}','copy','model',null)`),
      /permission denied/,
    );
    await assert.rejects(pg.query(`select public.claim_due_posts(4)`), /permission denied/);
    await assert.rejects(pg.query(`select * from public.technical_errors`), /permission denied/);
    await pg.exec('reset role;set role anon;');
    assert.equal((await pg.query('select * from public.plans')).rows.length, 3);
    await assert.rejects(pg.query('select * from public.posts'), /permission denied/);
  } finally {
    await pg.close();
  }
});

test('quota reservations are atomic and failures refund once, including late completion after month rollover', async () => {
  const pg = await setup();
  try {
    await pg.exec("update public.plans set monthly_post_limit=2 where id='starter';set role service_role;");
    const values = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        pg.query<{ id: string }>(`select public.reserve_generation('${alice}','copy','model',null) as id`),
      ),
    );
    assert.equal(values.filter(v => v.status === 'fulfilled').length, 2);
    assert.equal(values.filter(v => v.status === 'rejected').length, 3);
    const success = values.find(v => v.status === 'fulfilled') as PromiseFulfilledResult<{ rows: { id: string }[] }>;
    const id = success.value.rows[0].id;
    await pg.query(`select public.finish_generation($1,'failed',0,0,0,false,null,null)`, [id]);
    await pg.query(`select public.finish_generation($1,'failed',0,0,0,false,null,null)`, [id]);
    assert.equal(
      (await pg.query<{ copy_generations: number }>('select copy_generations from public.usage')).rows[0]
        .copy_generations,
      1,
    );
    await pg.query(`select public.reserve_generation('${alice}','copy','model',null)`);
    assert.equal(
      (await pg.query<{ copy_generations: number }>('select copy_generations from public.usage')).rows[0]
        .copy_generations,
      2,
    );
  } finally {
    await pg.close();
  }
});

test('unpaid, expired and cross-tenant generation attempts are rejected', async () => {
  const pg = await setup();
  try {
    const p = await pg.query<{ id: string }>(
      `insert into public.posts(user_id,title) values('${bob}','Private') returning id`,
    );
    await assert.rejects(
      pg.query(`select public.reserve_generation('${alice}','copy','model',$1)`, [p.rows[0].id]),
      /not_found/,
    );
    await pg.exec(`update public.subscriptions set status='past_due' where user_id='${alice}'`);
    await assert.rejects(
      pg.query(`select public.reserve_generation('${alice}','image','model',null)`),
      /subscription_required/,
    );
    await pg.exec(
      `update public.subscriptions set status='active',current_period_end=now()-interval '1 second' where user_id='${alice}'`,
    );
    await assert.rejects(
      pg.query(`select public.reserve_generation('${alice}','copy','model',null)`),
      /subscription_required/,
    );
  } finally {
    await pg.close();
  }
});

test('separate copy/image credits, persistent outputs, known costs and idempotent completion', async () => {
  const pg = await setup();
  try {
    const g = (await pg.query<{ id: string }>(`select public.reserve_generation('${alice}','image','model',null) id`))
      .rows[0].id;
    await pg.query(
      `select public.finish_generation($1,'succeeded',20,30,0.04,true,'gen-123','{"image_url":"/api/media?path=image"}')`,
      [g],
    );
    await pg.query(`select public.finish_generation($1,'succeeded',20,30,0.04,true,'gen-123',null)`, [g]);
    const u = (
      await pg.query<{ image_generations: number; copy_generations: number; estimated_cost: string }>(
        'select * from public.usage',
      )
    ).rows[0];
    assert.equal(u.image_generations, 1);
    assert.equal(u.copy_generations, 0);
    assert.equal(Number(u.estimated_cost), 0.04);
    const saved = (await pg.query<{ result: { image_url: string } }>('select result from public.generations')).rows[0];
    assert.equal(saved.result.image_url, '/api/media?path=image');
  } finally {
    await pg.close();
  }
});

test('unknown generation outcomes retain reserved credit for operator reconciliation', async () => {
  const pg = await setup();
  try {
    const g = (await pg.query<{ id: string }>(`select public.reserve_generation('${alice}','copy','model',null) id`))
      .rows[0].id;
    await pg.query(`select public.finish_generation($1,'uncertain')`, [g]);
    assert.equal(
      (await pg.query<{ copy_generations: number }>('select copy_generations from public.usage')).rows[0]
        .copy_generations,
      1,
    );
  } finally {
    await pg.close();
  }
});

test('distributed minute rate limits do not reset until the minute changes', async () => {
  const pg = await setup();
  try {
    const vals = [];
    for (let i = 0; i < 4; i++)
      vals.push((await pg.query<{ ok: boolean }>(`select public.take_rate('${alice}','ai',2) ok`)).rows[0].ok);
    assert.deepEqual(vals, [true, true, false, false]);
    assert.equal((await pg.query<{ ok: boolean }>(`select public.take_rate('${bob}','ai',2) ok`)).rows[0].ok, true);
    await pg.exec(`update public.rate_limits set window_start=now()-interval '2 minutes' where user_id='${alice}'`);
    assert.equal((await pg.query<{ ok: boolean }>(`select public.take_rate('${alice}','ai',2) ok`)).rows[0].ok, true);
  } finally {
    await pg.close();
  }
});

test('scheduler claims due work once; future work is untouched and crashes cannot auto-republish', async () => {
  const pg = await setup();
  try {
    await pg.exec(
      `insert into public.posts(user_id,title,caption,status,scheduled_at) values('${alice}','Due','hello','scheduled',now()-interval '1 minute'),('${alice}','Future','hello','scheduled',now()+interval '1 day');`,
    );
    const first = await pg.query<{ id: string; title: string }>('select * from public.claim_due_posts(4)');
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].title, 'Due');
    assert.equal((await pg.query('select * from public.claim_due_posts(4)')).rows.length, 0);
    await pg.exec(`update public.posts set claimed_at=now()-interval '11 minutes' where title='Due'`);
    await pg.query('select * from public.claim_due_posts(4)');
    const failed = (
      await pg.query<{ status: string; error_code: string }>(
        "select status,error_code from public.posts where title='Due'",
      )
    ).rows[0];
    assert.deepEqual(failed, { status: 'failed', error_code: 'outcome_unknown' });
    assert.equal((await pg.query(`select * from public.claim_post($1,'${alice}')`, [first.rows[0].id])).rows.length, 0);
  } finally {
    await pg.close();
  }
});

test('a post cannot bind to another user account; publish count increments only once', async () => {
  const pg = await setup();
  try {
    const a = (
      await pg.query<{ id: string }>(
        `insert into public.social_accounts(user_id,platform_user_id,username) values('${bob}','remote','bob') returning id`,
      )
    ).rows[0].id;
    await assert.rejects(
      pg.query(`insert into public.posts(user_id,title,social_account_id) values('${alice}','invalid',$1)`, [a]),
      /foreign key/,
    );
    const p = (
      await pg.query<{ id: string }>(
        `insert into public.posts(user_id,title,caption) values('${alice}','Draft','caption') returning id`,
      )
    ).rows[0].id;
    assert.equal((await pg.query(`select * from public.claim_post($1,'${bob}')`, [p])).rows.length, 0);
    assert.equal((await pg.query(`select * from public.claim_post($1,'${alice}')`, [p])).rows.length, 1);
    assert.equal((await pg.query(`select * from public.claim_post($1,'${alice}')`, [p])).rows.length, 0);
    await pg.query(`select public.complete_publish($1,'thread-1')`, [p]);
    await pg.query(`select public.complete_publish($1,'thread-1')`, [p]);
    assert.equal(
      (await pg.query<{ posts_published: number }>('select posts_published from public.usage')).rows[0].posts_published,
      1,
    );
  } finally {
    await pg.close();
  }
});

test('webhooks deduplicate events and do not regress subscription state from out-of-order delivery', async () => {
  const pg = await setup();
  try {
    const apply = (event: string, ts: number, status: string) =>
      pg.query(
        `select public.apply_subscription($1,$2,'${alice}','pro',$3,now(),now()+interval '1 month','cus-a','sub-a',false)`,
        [event, ts, status],
      );
    await apply('event-new', 200, 'active');
    await apply('event-old', 100, 'past_due');
    await apply('event-new', 200, 'canceled');
    assert.equal(
      (await pg.query<{ status: string }>(`select status from public.subscriptions where user_id='${alice}'`)).rows[0]
        .status,
      'active',
    );
    assert.equal((await pg.query('select * from public.payment_events')).rows.length, 2);
    await apply('event-delete', 300, 'canceled');
    assert.equal(
      (await pg.query<{ status: string }>(`select status from public.subscriptions where user_id='${alice}'`)).rows[0]
        .status,
      'canceled',
    );
  } finally {
    await pg.close();
  }
});

test('operators settle unconfirmed AI credits exactly once: refund returns the credit, keep does not', async () => {
  const pg = await setup();
  try {
    const reserve = async (type: string) =>
      (await pg.query<{ id: string }>(`select public.reserve_generation('${alice}',$1,'model',null) id`, [type]))
        .rows[0].id;
    const copy = await reserve('copy');
    const image = await reserve('image');
    await pg.query(`select public.finish_generation($1,'uncertain')`, [copy]);
    await pg.query(`select public.finish_generation($1,'uncertain')`, [image]);
    const resolve = async (id: string, refund: boolean) =>
      (await pg.query<{ ok: boolean }>('select public.resolve_generation($1,$2) ok', [id, refund])).rows[0].ok;
    assert.equal(await resolve(copy, true), true);
    assert.equal(await resolve(copy, true), false);
    assert.equal(await resolve(image, false), true);
    const usage = (
      await pg.query<{ copy_generations: number; image_generations: number }>('select * from public.usage')
    ).rows[0];
    assert.deepEqual([usage.copy_generations, usage.image_generations], [0, 1]);
    const statuses = (await pg.query<{ type: string; status: string }>('select type,status from public.generations'))
      .rows;
    assert.deepEqual(Object.fromEntries(statuses.map(r => [r.type, r.status])), { copy: 'failed', image: 'succeeded' });
    await pg.exec('set role authenticated;');
    await assert.rejects(pg.query('select public.resolve_generation($1,true)', [copy]), /permission denied/);
  } finally {
    await pg.close();
  }
});

test('image cleanup lists only week-old files that no post references, including converted JPEG siblings', async () => {
  const pg = await setup();
  try {
    await pg.exec(
      `create schema storage; create table storage.objects(bucket_id text, name text, created_at timestamptz); grant usage on schema storage to service_role; grant select on storage.objects to service_role;`,
    );
    const used = '0c8f6a5e-2b1d-4c3a-9e8f-7a6b5c4d3e2f',
      orphan = '1d9e7b6f-3c2e-4d4b-8f9a-8b7c6d5e4f3a',
      fresh = '2eaf8c7a-4d3f-4e5c-9a0b-9c8d7e6f5a4b';
    await pg.exec(`insert into public.posts(user_id,title,image_url) values('${alice}','With image','/api/media?path=${alice}%2F${used}.png');
      insert into storage.objects values
        ('post-images','${alice}/${used}.png',now()-interval '30 days'),
        ('post-images','${alice}/${used}.jpg',now()-interval '30 days'),
        ('post-images','${alice}/${orphan}.webp',now()-interval '30 days'),
        ('post-images','${alice}/${fresh}.png',now()-interval '1 day'),
        ('other-bucket','${alice}/${orphan}.png',now()-interval '30 days');
      set role service_role;`);
    const rows = (await pg.query<{ orphan_images: string }>('select * from public.orphan_images(100)')).rows;
    assert.deepEqual(
      rows.map(r => r.orphan_images),
      [`${alice}/${orphan}.webp`],
    );
  } finally {
    await pg.close();
  }
});

async function automationSetup() {
  const pg = await setup();
  const ids = await pg.query<{ id: string; user_id: string }>(
    `insert into public.social_accounts(user_id,platform,platform_user_id,username,scopes) values
      ('${alice}','instagram','ig-a','alice',array['instagram_business_basic']),
      ('${bob}','instagram','ig-b','bob',array['instagram_business_basic']) returning id,user_id`,
  );
  const aliceAccount = ids.rows.find(r => r.user_id === alice)!.id;
  const bobAccount = ids.rows.find(r => r.user_id === bob)!.id;
  await pg.query(
    `insert into public.automation_rules(user_id,social_account_id,platform,enabled,comment_reply_enabled,comment_reply_template) values($1,$2,'instagram',true,true,'Thanks'),($3,$4,'instagram',true,true,'Hi')`,
    [alice, aliceAccount, bob, bobAccount],
  );
  const ingest = (
    account: string,
    user: string,
    eventId: string,
    sender: string | null,
    cooldown = 60,
    skip: string | null = null,
  ) =>
    pg.query<{ event_id: string; inserted: boolean; event_status: string; queued: number }>(
      `select * from public.ingest_automation_event($1,$2,'instagram','ig_comment',$3,$4,'media-1',now(),array['comment_reply','private_reply'],$5,$6)`,
      [user, account, eventId, sender, skip, cooldown],
    );
  return { pg, aliceAccount, bobAccount, ingest };
}

test('schema.sql carries the automation migration verbatim', async () => {
  const schema = (await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const migration = (
    await readFile(new URL('../supabase/migrations/20260929_social_automation.sql', import.meta.url), 'utf8')
  ).replace(/\r\n/g, '\n');
  const body = migration.slice(migration.indexOf('begin;\n') + 7, migration.lastIndexOf('commit;')).trim();
  assert.ok(schema.includes(body), 'fresh installs and migrated databases get the same automation schema');
});

test('duplicate webhook deliveries queue each reply once', async () => {
  const { pg, aliceAccount, ingest } = await automationSetup();
  try {
    await pg.exec('set role service_role;');
    const results = await Promise.all([1, 2, 3].map(() => ingest(aliceAccount, alice, 'comment-1', 'fan')));
    assert.deepEqual(results.map(r => r.rows[0].inserted).sort(), [false, false, true]);
    const runs = await pg.query<{ action: string }>('select action from public.automation_runs order by action');
    assert.deepEqual(
      runs.rows.map(r => r.action),
      ['comment_reply', 'private_reply'],
    );
    assert.equal((await pg.query('select * from public.inbound_social_events')).rows.length, 1);
  } finally {
    await pg.close();
  }
});

test('per-sender cooldown skips follow-ups; other senders and skipped events queue nothing extra', async () => {
  const { pg, aliceAccount, ingest } = await automationSetup();
  try {
    await pg.exec('set role service_role;');
    assert.equal((await ingest(aliceAccount, alice, 'c1', 'fan')).rows[0].queued, 2);
    const second = (await ingest(aliceAccount, alice, 'c2', 'fan')).rows[0];
    assert.deepEqual([second.event_status, second.queued], ['skipped', 0]);
    const reason = await pg.query<{ skip_reason: string }>(
      `select skip_reason from public.inbound_social_events where provider_event_id='c2'`,
    );
    assert.equal(reason.rows[0].skip_reason, 'cooldown');
    assert.equal((await ingest(aliceAccount, alice, 'c3', 'someone-else')).rows[0].queued, 2);
    assert.equal((await ingest(aliceAccount, alice, 'c4', 'third', 60, 'own')).rows[0].event_status, 'skipped');
    // After the cooldown window the same sender is answered again.
    await pg.exec(`update public.automation_runs set created_at=now()-interval '2 hours' where recipient_id='fan'`);
    assert.equal((await ingest(aliceAccount, alice, 'c5', 'fan')).rows[0].queued, 2);
  } finally {
    await pg.close();
  }
});

test('a worker cannot record events for another tenant account', async () => {
  const { pg, bobAccount, ingest } = await automationSetup();
  try {
    await pg.exec('set role service_role;');
    await assert.rejects(ingest(bobAccount, alice, 'c1', 'fan'), /not_found/);
  } finally {
    await pg.close();
  }
});

test('replies are claimed by one worker; retries back off, defers keep attempts, crashes become uncertain', async () => {
  const { pg, aliceAccount, ingest } = await automationSetup();
  try {
    await pg.exec('set role service_role;');
    await ingest(aliceAccount, alice, 'c1', 'fan');
    const claims = await Promise.all(
      [1, 2].map(() => pg.query<{ id: string }>('select * from public.claim_automation_runs(10)')),
    );
    assert.equal(claims[0].rows.length + claims[1].rows.length, 2, 'each run claimed exactly once');
    assert.equal((await pg.query('select * from public.claim_automation_runs(10)')).rows.length, 0);
    const [a, b] = [...claims[0].rows, ...claims[1].rows].map(r => r.id);
    await pg.query(
      `select public.finish_automation_run($1,'retry','retrying','Retry',null,now()+interval '1 minute')`,
      [a],
    );
    await pg.query(`select public.finish_automation_run($1,'sent',null,null,'reply-1')`, [b]);
    const again = await pg.query<{ ok: boolean }>(`select public.finish_automation_run($1,'failed') ok`, [b]);
    assert.equal(again.rows[0].ok, false, 'a settled run cannot be settled again');
    const retry = await pg.query<{ status: string; attempts: number }>(
      'select status,attempts from public.automation_runs where id=$1',
      [a],
    );
    assert.deepEqual(retry.rows[0], { status: 'pending', attempts: 1 });
    assert.equal((await pg.query('select * from public.claim_automation_runs(10)')).rows.length, 0, 'not due yet');
    await pg.exec(`update public.automation_runs set next_attempt_at=now()-interval '1 second' where id='${a}'`);
    assert.equal((await pg.query('select * from public.claim_automation_runs(10)')).rows.length, 1);
    await pg.query(`select public.finish_automation_run($1,'defer',null,null,null,now()-interval '1 second')`, [a]);
    const deferred = await pg.query<{ attempts: number }>('select attempts from public.automation_runs where id=$1', [
      a,
    ]);
    assert.equal(deferred.rows[0].attempts, 1, 'a deferral does not spend an attempt');
    // Worker crash after the irreversible call: never sent again.
    await pg.query('select * from public.claim_automation_runs(10)');
    await pg.exec(
      `update public.automation_runs set send_attempted_at=now(),claimed_at=now()-interval '11 minutes' where id='${a}'`,
    );
    await pg.query('select * from public.claim_automation_runs(10)');
    const crashed = await pg.query<{ status: string; error_code: string }>(
      'select status,error_code from public.automation_runs where id=$1',
      [a],
    );
    assert.deepEqual(crashed.rows[0], { status: 'uncertain', error_code: 'outcome_unknown' });
  } finally {
    await pg.close();
  }
});

test('automation data is readable only by its owner and writable only by the server', async () => {
  const { pg, aliceAccount, bobAccount, ingest } = await automationSetup();
  try {
    await pg.exec('set role service_role;');
    await ingest(aliceAccount, alice, 'c1', 'fan');
    await ingest(bobAccount, bob, 'c2', 'fan');
    await pg.exec(
      `insert into public.automation_checkpoints(user_id,social_account_id,media_id,last_reply_at) values('${alice}','${aliceAccount}','m1',now()),('${bob}','${bobAccount}','m2',now());reset role;set role authenticated;select set_config('request.jwt.claim.sub','${alice}',false);`,
    );
    for (const table of ['automation_rules', 'inbound_social_events', 'automation_runs', 'automation_checkpoints']) {
      const rows = await pg.query<{ user_id: string }>(`select user_id from public.${table}`);
      assert.ok(rows.rows.length > 0 && rows.rows.every(r => r.user_id === alice), table);
    }
    const scopes = await pg.query<{ scopes: string[] }>('select scopes from public.social_accounts');
    assert.deepEqual(
      scopes.rows.map(r => r.scopes),
      [['instagram_business_basic']],
    );
    await assert.rejects(pg.query(`update public.automation_rules set enabled=false`), /permission denied/);
    await assert.rejects(
      pg.query(
        `insert into public.automation_rules(user_id,social_account_id,platform) values('${alice}','${aliceAccount}','instagram')`,
      ),
      /permission denied/,
    );
    await assert.rejects(pg.query('select * from public.claim_automation_runs(1)'), /permission denied/);
    await assert.rejects(
      pg.query(
        `select * from public.ingest_automation_event('${alice}','${aliceAccount}','instagram','ig_comment','x',null,null,null,array['comment_reply'],null,60)`,
      ),
      /permission denied/,
    );
    await pg.exec('reset role;set role anon;');
    await assert.rejects(pg.query('select * from public.automation_runs'), /permission denied/);
  } finally {
    await pg.close();
  }
});

test('retention removes old event metadata and its reply records', async () => {
  const { pg, aliceAccount, ingest } = await automationSetup();
  try {
    await pg.exec('set role service_role;');
    await ingest(aliceAccount, alice, 'old', 'fan');
    await ingest(aliceAccount, alice, 'new', 'other');
    await pg.exec(
      `update public.inbound_social_events set received_at=now()-interval '40 days' where provider_event_id='old'`,
    );
    assert.equal((await pg.query<{ n: number }>('select public.purge_automation_data(30) n')).rows[0].n, 1);
    const left = await pg.query<{ provider_event_id: string }>(
      'select provider_event_id from public.inbound_social_events',
    );
    assert.deepEqual(
      left.rows.map(r => r.provider_event_id),
      ['new'],
    );
    assert.equal((await pg.query('select * from public.automation_runs')).rows.length, 2, 'old event runs are gone');
  } finally {
    await pg.close();
  }
});
