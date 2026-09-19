'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatInTimeZone } from 'date-fns-tz';
import { ArrowUpRight, Plus, ChevronLeft, ChevronRight, Search, Trash2, CalendarDays, Check, Link2, LogOut, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { api, AtThreads, Empty, PageHeader, useWorkspace } from './workspace';
import { Badge, PlatformBadge, AtInstagram, Modal, Spinner } from './ui';
import { dateLabel, editable, statusLabels, statuses, timezones, platforms, platformLabels, type Post, type Plan } from '@/lib/domain';
import { createDemo } from '@/lib/demo';
import { browserSupabase } from '@/lib/supabase/browser';

export function PostsView(){
  const {data,base,removePost,notify,reload,demo}=useWorkspace();
  const [filter,setFilter]=useState('all');
  const [platformFilter,setPlatformFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [deleting,setDeleting]=useState<Post|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    const f=new URLSearchParams(window.location.search).get('status');
    if(f&&statuses.includes(f as Post['status']))setFilter(f);
  },[]);
  const filtered=data.posts.filter(p=>
    (filter==='all'||p.status===filter)&&
    (platformFilter==='all'||p.platform===platformFilter||(platformFilter!=='both'&&p.platform==='both'))&&
    `${p.title} ${p.caption}`.toLowerCase().includes(query.toLowerCase())
  ).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));

  return (
    <>
      <PageHeader
        eyebrow="ALL YOUR STORIES"
        title="One workspace. All posts."
        description="From early draft ideas to published stories on Threads & Instagram."
      >
        <Link className="btn primary" href={`${base}/create`}>
          <Plus size={18}/>Create new post
        </Link>
      </PageHeader>
      <section className="panel">
        <div className="post-toolbar">
          <div className="filter-tabs" role="group" aria-label="Filter status">
            {[['all','All'],...statuses.map(s=>[s,statusLabels[s]])].map(([s,label])=>(
              <button key={s} aria-pressed={filter===s} className={filter===s?'selected':''} onClick={()=>setFilter(s)}>
                {label}<span>{s==='all'?data.posts.length:data.posts.filter(p=>p.status===s).length}</span>
              </button>
            ))}
          </div>
          <div className="filter-tabs" role="group" aria-label="Filter platform">
            {[['all','All platforms'],...platforms.map(p=>[p,platformLabels[p]])].map(([p,label])=>(
              <button key={p} aria-pressed={platformFilter===p} className={platformFilter===p?'selected':''} onClick={()=>setPlatformFilter(p)}>
                {label}
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={17}/>
            <input aria-label="Search posts" placeholder="Search posts…" value={query} onChange={e=>setQuery(e.target.value)}/>
          </label>
        </div>
        {!demo&&<button className="btn ghost" onClick={()=>reload().catch(e=>notify(e.message))}><RotateCcw size={16}/>Reload status</button>}
        {filtered.length?(
          <div className="post-table-wrap">
            <table className="post-table">
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Platform & Status</th>
                  <th>Date</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p=>(
                  <tr key={p.id}>
                    <td>
                      <Link href={`${base}/create/${p.id}`}>
                        <strong>{p.title}</strong>
                        <p>{p.caption||'No caption yet'}</p>
                      </Link>
                      {p.error_message&&<small className="danger-text">{p.error_message}</small>}
                    </td>
                    <td>
                      <div className="post-badge-group">
                        <Badge status={p.status}/>
                        <PlatformBadge platform={p.platform}/>
                      </div>
                    </td>
                    <td>
                      {dateLabel(p.published_at||p.scheduled_at||p.updated_at,data.profile.timezone)}
                      <small>{p.status==='draft'?'Edited':data.profile.timezone.replaceAll('_',' ')}</small>
                    </td>
                    <td>
                      <div className="button-row">
                        <Link className="icon-btn" aria-label={`Open ${p.title}`} href={`${base}/create/${p.id}`}>
                          <ArrowUpRight size={18}/>
                        </Link>
                        {editable(p)&&(
                          <button className="icon-btn" aria-label={`Delete ${p.title}`} onClick={()=>{setDeleting(p);setError('');}}>
                            <Trash2 size={16}/>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ):(
          <Empty
            title={query?'No search results':'No posts here yet'}
            description={query?'Try a different search term.':'Create something worth sharing.'}
          >
            <Link className="btn secondary" href={`${base}/create`}>Create post</Link>
          </Empty>
        )}
      </section>
      {deleting&&(
        <Modal title="Delete this post?" onClose={()=>{if(!busy)setDeleting(null);}}>
          <div className="form-fields">
            <p>“{deleting.title}” will be removed from your workspace{deleting.status==='scheduled'?' and publication schedule':''}.</p>
            {error&&<p className="form-error" role="alert">{error}</p>}
            <button disabled={busy} className="btn danger" onClick={async()=>{setBusy(true);try{await removePost(deleting.id);setDeleting(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
              {busy?<Spinner/>:<Trash2 size={16}/>}Delete post
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function CalendarView(){
  const {data,base}=useWorkspace();
  const [month,setMonth]=useState(()=>formatInTimeZone(new Date(),data.profile.timezone,'yyyy-MM'));
  const [filter,setFilter]=useState('all');
  const [year,m]=month.split('-').map(Number);
  const first=new Date(Date.UTC(year,m-1,1));
  const offset=(first.getUTCDay()+6)%7;
  const days=new Date(Date.UTC(year,m,0)).getUTCDate();
  const cells=Math.ceil((days+offset)/7)*7;
  const visible=data.posts.filter(p=>(p.scheduled_at||p.published_at)&&(filter==='all'||p.status===filter));
  function move(by:number){
    const d=new Date(Date.UTC(year,m-1+by,1));
    setMonth(d.toISOString().slice(0,7));
  }

  return (
    <>
      <PageHeader
        eyebrow="BUILD YOUR CADENCE"
        title="Content calendar"
        description="See how your stories unfold, one day at a time."
      >
        <Link className="btn primary" href={`${base}/create`}>
          <Plus size={18}/>Schedule post
        </Link>
      </PageHeader>
      <section className="panel calendar-panel">
        <div className="calendar-toolbar">
          <div>
            <button className="icon-btn" aria-label="Previous month" onClick={()=>move(-1)}>
              <ChevronLeft size={20}/>
            </button>
            <h2>{new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(first)}</h2>
            <button className="icon-btn" aria-label="Next month" onClick={()=>move(1)}>
              <ChevronRight size={20}/>
            </button>
            <button className="btn secondary small" onClick={()=>setMonth(formatInTimeZone(new Date(),data.profile.timezone,'yyyy-MM'))}>
              Today
            </button>
          </div>
          <select aria-label="Filter calendar status" value={filter} onChange={e=>setFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {statuses.filter(s=>s!=='draft').map(s=>(
              <option value={s} key={s}>{statusLabels[s]}</option>
            ))}
          </select>
        </div>
        <div className="calendar-scroll">
          <div className="calendar-weekdays">
            {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=><span key={d}>{d}</span>)}
          </div>
          <div className="calendar-grid">
            {Array.from({length:cells},(_,i)=>{
              const day=i-offset+1;
              const valid=day>0&&day<=days;
              const key=`${month}-${String(day).padStart(2,'0')}`;
              const posts=valid?visible.filter(p=>formatInTimeZone(p.published_at||p.scheduled_at!,data.profile.timezone,'yyyy-MM-dd')===key):[];
              const today=key===formatInTimeZone(new Date(),data.profile.timezone,'yyyy-MM-dd');
              return (
                <div className={`calendar-cell ${!valid?'outside':''} ${today?'today':''}`} key={i}>
                  {valid&&(
                    <>
                      <span className="calendar-day">{day}</span>
                      {posts.map(p=>(
                        <Link className={`calendar-post ${p.status}`} href={`${base}/create/${p.id}`} key={p.id}>
                          <b>{dateLabel(p.published_at||p.scheduled_at,data.profile.timezone,'HH:mm')}</b>
                          <PlatformBadge platform={p.platform}/>
                          <span>{p.title}</span>
                        </Link>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <footer className="calendar-legend">
          <span>{data.profile.timezone.replaceAll('_',' ')}</span>
          <Badge status="scheduled"/>
          <Badge status="published"/>
          <Badge status="failed"/>
        </footer>
      </section>
      <p className="muted footnote">Unscheduled drafts can be found in All Posts.</p>
    </>
  );
}

export function ConnectionsView(){
  const {data,demo,notify,reload,base}=useWorkspace();
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [threadsConnectOpen,setThreadsConnectOpen]=useState(false);
  const [confirm,setConfirm]=useState<'threads'|'instagram'|null>(null);
  useEffect(()=>{
    const errorCode=new URLSearchParams(window.location.search).get('error');
    if(errorCode==='different_account')setError('This RB Post profile is already linked to a different Threads account. Disconnect the existing Threads account first, then connect the account you want.');
    else if(errorCode)setError('Connection failed. Please try again and grant account permissions.');
  },[]);
  const threadsAcc=data.account;
  const igAcc=data.instagramAccount||data.accounts?.instagram;
  async function connect(plat:'threads'|'instagram'){
    setError('');
    if(demo){
      notify(`This is a demo connection. Open a live account to connect ${plat==='threads'?'Threads':'Instagram'}.`);
      return;
    }
    setBusy(plat);
    try{
      const r=await api<{url:string}>(`auth/${plat}`);
      window.location.assign(r.url);
    }catch(e){
      setError((e as Error).message);
      setBusy('');
    }
  }
  async function disconnect(plat:'threads'|'instagram'){
    setBusy(plat);
    try{
      await api(`auth/${plat}/disconnect`,{});
      await reload();
      setConfirm(null);
      notify(`${plat==='threads'?'Threads':'Instagram'} disconnected.`);
    }catch(e){
      setError((e as Error).message);
      setConfirm(null);
    }finally{
      setBusy('');
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="ONE CONNECTION, ALL IDEAS"
        title="Your Social Accounts"
        description="Connect your Threads and Instagram accounts to publish seamlessly from one creative space."
      />
      {error&&<p className="form-error" role="alert">{error}</p>}
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div className="inline-heading">
            <span className="network-icon threads-icon"><AtThreads size={24}/></span>
            <div>
              <h2>Meta Threads</h2>
              <p>Publish text and visual stories directly to your Threads feed.</p>
            </div>
          </div>
          <span className={`pill ${threadsAcc?.status==='connected'?'success-pill':''}`}>
            {threadsAcc?.status==='connected'?(demo?'Demo Sample':'Connected'):threadsAcc?'Reconnect':'Not Connected'}
          </span>
        </div>
        <div className="form-fields">
          {threadsAcc?(
            <div className="connected-profile">
              <span className="avatar large-avatar">{data.profile.name[0]}</span>
              <div>
                <h3>@{threadsAcc.username}</h3>
                <p>{threadsAcc.expires_at?`Connection valid until ${dateLabel(threadsAcc.expires_at,data.profile.timezone,'d MMM yyyy')}`:'Please reconnect your account.'}</p>
              </div>
            </div>
          ):(
            <p>Sign in to Threads and grant access to automatically share posts.</p>
          )}
          <div className="button-row">
            <button className="btn primary" disabled={!!busy} onClick={()=>demo?connect('threads'):setThreadsConnectOpen(true)}>
              {busy==='threads'?<Spinner/>:<Link2 size={17}/>} {threadsAcc?'Reconnect Threads':'Connect Threads'}
            </button>
            {threadsAcc&&!demo&&(
              <button className="btn ghost danger-text" onClick={()=>setConfirm('threads')}>Disconnect</button>
            )}
          </div>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div className="inline-heading">
            <span className="network-icon instagram-icon"><AtInstagram size={28}/></span>
            <div>
              <h2>Instagram</h2>
              <p>Publish feed images and captions directly to your Instagram profile.</p>
            </div>
          </div>
          <span className={`pill ${igAcc?.status==='connected'?'success-pill':''}`}>
            {igAcc?.status==='connected'?(demo?'Demo Sample':'Connected'):igAcc?'Reconnect':'Not Connected'}
          </span>
        </div>
        <div className="form-fields">
          {igAcc?(
            <div className="connected-profile">
              <span className="avatar large-avatar">{data.profile.name[0]}</span>
              <div>
                <h3>@{igAcc.username}</h3>
                <p>{igAcc.expires_at?`Connection valid until ${dateLabel(igAcc.expires_at,data.profile.timezone,'d MMM yyyy')}`:'Please reconnect your account.'}</p>
              </div>
            </div>
          ):(
            <p>Connect an Instagram Creator or Business account to share visual posts directly.</p>
          )}
          <div className="notice">
            <ShieldCheck size={20}/>
            <span>You are always in control. Review every post before scheduling.</span>
          </div>
          <div className="button-row">
            <button className="btn primary" disabled={!!busy} onClick={()=>connect('instagram')}>
              {busy==='instagram'?<Spinner/>:<Link2 size={17}/>} {igAcc?'Reconnect Instagram':'Connect Instagram'}
            </button>
            {igAcc&&!demo&&(
              <button className="btn ghost danger-text" onClick={()=>setConfirm('instagram')}>Disconnect</button>
            )}
            {demo&&<Link className="btn secondary" href="/signup">Open Live Account</Link>}
          </div>
        </div>
      </section>
      {threadsConnectOpen&&(
        <Modal title="Choose the correct Threads account" onClose={()=>{if(!busy)setThreadsConnectOpen(false);}}>
          <div className="form-fields">
            <p>Threads uses the account that is currently signed in within this browser. It may continue as that account without showing a login screen.</p>
            {threadsAcc&&<div className="notice warning"><ShieldCheck size={20}/><span>RB Post is currently linked to @{threadsAcc.username}. To replace it, close this window and disconnect that account first.</span></div>}
            <div className="notice">
              <ShieldCheck size={20}/>
              <span>To connect a different account, open Threads below, switch or log out, then sign in to the account you want. Return here when it is active.</span>
            </div>
            <a className="btn secondary full" href="https://www.threads.com/login/" target="_blank" rel="noopener noreferrer">
              Open Threads to switch account <ArrowUpRight size={16}/>
            </a>
            <button className="btn primary full" disabled={!!busy} onClick={()=>{setThreadsConnectOpen(false);void connect('threads');}}>
              {busy==='threads'?<Spinner/>:<Link2 size={17}/>} Continue with active Threads account
            </button>
          </div>
        </Modal>
      )}
      {confirm&&(
        <Modal title={`Disconnect ${confirm==='threads'?'Threads':'Instagram'}?`} onClose={()=>{if(!busy)setConfirm(null);}}><div className="form-fields"><p>Scheduled posts to {confirm==='threads'?'Threads':'Instagram'} will fail until you reconnect this account.</p><button disabled={!!busy} className="btn danger" onClick={()=>disconnect(confirm)}>{busy?<Spinner/>:<Trash2 size={16}/>} Disconnect</button></div></Modal>
      )}
    </>
  );
}

export function BillingView(){
  const {data,demo,notify}=useWorkspace();
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const current=data.plans.find(p=>p.id===data.subscription?.plan_id);
  async function go(path:string,body:unknown,key:string){
    setBusy(key);
    setError('');
    try{
      if(demo){
        notify('Billing is disabled in demo mode. Create an account to subscribe.');
        return;
      }
      const r=await api<{url:string}>(path,body);
      window.location.assign(r.url);
    }catch(e){
      setError((e as Error).message);
    }finally{
      setBusy('');
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="ROOM TO GROW"
        title="Plans that match your pace"
        description="Create with confidence. Monitor your usage and manage subscriptions here."
      />
      {error&&<div className="form-error" role="alert">{error}</div>}
      {data.subscription&&(
        <section className="panel current-plan">
          <div>
            <span className="overline">CURRENT PLAN {demo?'· DEMO':''}</span>
            <h2>{current?.name} <span className="pill">{data.subscription.status}</span></h2>
            <p>{data.subscription.cancel_at_period_end?'Access ends':'Current period through'} {dateLabel(data.subscription.current_period_end,data.profile.timezone,'d MMM yyyy')}</p>
          </div>
          <button className="btn secondary" disabled={!!busy} onClick={()=>go('billing/portal',{},'portal')}>
            {busy==='portal'?<Spinner/>:null}Manage subscription <ArrowUpRight size={16}/>
          </button>
        </section>
      )}
      <div className="pricing-grid">
        {data.plans.filter(p=>p.active).map(p=>(
          <article key={p.id} className={`plan-card ${p.id==='pro'?'featured':''}`}>
            <div className="split">
              <h3>{p.name}</h3>
              {p.id==='pro'&&<span className="pill">Creator choice</span>}
            </div>
            <div className="price">RM{p.monthly_price}<span>/ month</span></div>
            <ul>
              <li><Check size={17}/>{p.monthly_post_limit} caption generations</li>
              <li><Check size={17}/>{p.monthly_image_limit} image generations</li>
              <li><Check size={17}/>1 Threads account</li>
              <li><Check size={17}/>Calendar & auto-publish</li>
            </ul>
            <button
              className={`btn full ${p.id==='pro'?'primary':'secondary'}`}
              disabled={!!busy}
              onClick={()=>go(data.subscription?'billing/portal':'billing/checkout',{plan_id:p.id},p.id)}
            >
              {busy===p.id?<Spinner/>:null}
              {current?.id===p.id?'Manage this plan':data.subscription?'Change plan':'Choose plan'}
              <ArrowUpRight size={16}/>
            </button>
          </article>
        ))}
      </div>
      <section className="panel usage-panel">
        <h2>Usage this month</h2>
        <div className="usage-lines">
          {[['AI Captions',data.usage.copy_generations,current?.monthly_post_limit||0],['AI Images',data.usage.image_generations,current?.monthly_image_limit||0]].map(([label,num,total])=>(
            <div key={String(label)}>
              <div className="split">
                <b>{label}</b>
                <span>{num} / {total}</span>
              </div>
              <div className="progress">
                <span style={{width:`${Math.min(100,Number(num)/(Number(total)||1)*100)}%`}}/>
              </div>
            </div>
          ))}
        </div>
        <p className="muted">Credits reset every calendar month (UTC). Regenerations use 1 caption or image credit. Failed generations are automatically refunded once failure is verified.</p>
      </section>
    </>
  );
}

export function SettingsView(){
  const {data,demo,setData,notify}=useWorkspace();
  const router=useRouter();
  const [name,setName]=useState(data.profile.name);
  const [timezone,setTimezone]=useState(data.profile.timezone);
  const [language,setLanguage]=useState(data.profile.language);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [reset,setReset]=useState(false);
  const [deletingAccount,setDeletingAccount]=useState(false);
  const [deleteConfirmation,setDeleteConfirmation]=useState('');
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="Workspace settings"
        description="Personalize your profile and posting defaults."
      />
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>Profile & preferences</h2>
        </div>
        <form className="form-fields" onSubmit={async e=>{
          e.preventDefault();
          setBusy(true);
          setError('');
          try{
            const profile={...data.profile,name:name.trim(),timezone,language};
            if(!profile.name)throw new Error('Name is required.');
            if(!demo)await api('settings',profile,'PATCH');
            setData(d=>d?{...d,profile}:d);
            notify('Settings saved.');
          }catch(e){
            setError((e as Error).message);
          }finally{
            setBusy(false);
          }
        }}>
          <label>Name<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
          <label>Email<input readOnly value={data.profile.email}/></label>
          <div className="form-grid">
            <label>Timezone
              <select value={timezone} onChange={e=>setTimezone(e.target.value)}>
                {timezones.map(t=><option key={t}>{t}</option>)}
              </select>
            </label>
            <label>Content language
              <select value={language} onChange={e=>setLanguage(e.target.value)}>
                <option>English</option>
                <option>Bahasa Melayu</option>
              </select>
            </label>
          </div>
          <p className="muted">Changing timezone does not alter the delivery time of already scheduled posts.</p>
          {error&&<div className="form-error" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy?<Spinner/>:<Check size={16}/>}Save settings
          </button>
        </form>
      </section>
      {!demo&&<section className="panel settings-panel danger-zone">
        <div className="form-fields">
          <h2>Delete account and data</h2>
          <p>Permanently remove your profile, posts, stored images, usage records, and saved social connection tokens. Published posts on Threads or Instagram are not removed.</p>
          <button className="btn danger" onClick={()=>setDeletingAccount(true)}><Trash2 size={16}/>Delete account and data</button>
          <p className="muted">Read the <Link href="/data-deletion">data deletion instructions</Link> before continuing.</p>
        </div>
      </section>}
      <section className="panel settings-panel">
        <div className="form-fields">
          <h2>{demo?'Demo data':'Your session'}</h2>
          <p>{demo?'Demo drafts and modifications are stored in this browser only.':'Sign out of your workspace on this device.'}</p>
          {demo?(
            <button className="btn secondary" onClick={()=>setReset(true)}>
              <RotateCcw size={16}/>Reset demo
            </button>
          ):(
            <button className="btn secondary" onClick={async()=>{
              try{
                const s=browserSupabase();
                const {error}=await s.auth.signOut();
                if(error)throw error;
                router.push('/login');
              }catch(e){
                setError((e as Error).message);
              }
            }}>
              <LogOut size={16}/>Sign out
            </button>
          )}
        </div>
      </section>
      {reset&&(
        <Modal title="Reset demo data?" onClose={()=>setReset(false)}>
          <div className="form-fields">
            <p>All demo changes in this browser will be reset to the original sample data.</p>
            <button className="btn danger" onClick={()=>{
              const seed=createDemo();
              setData(seed);
              setName(seed.profile.name);
              setTimezone(seed.profile.timezone);
              setLanguage(seed.profile.language);
              setReset(false);
              notify('Demo reset.');
            }}>
              Reset data
            </button>
          </div>
        </Modal>
      )}
      {deletingAccount&&(
        <Modal title="Permanently delete account?" onClose={()=>{setDeletingAccount(false);setDeleteConfirmation('');}}>
          <div className="form-fields">
            <p>This cannot be undone. Type <strong>DELETE</strong> to confirm.</p>
            <label>Confirmation<input autoComplete="off" value={deleteConfirmation} onChange={e=>setDeleteConfirmation(e.target.value)} /></label>
            {error&&<div className="form-error" role="alert">{error}</div>}
            <button className="btn danger" disabled={busy||deleteConfirmation!=='DELETE'} onClick={async()=>{
              setBusy(true);setError('');
              try{await api('account',{},'DELETE');await browserSupabase().auth.signOut({scope:'local'});router.replace('/?account=deleted');}
              catch(e){setError((e as Error).message);setBusy(false);}
            }}>{busy?<Spinner/>:<Trash2 size={16}/>}Permanently delete account</button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface AdminStats {users:number;subscribers:number;mrr:number;aiCost:number;images:number;published:number;failed:number;infra:number;settings:{copy_model:string;image_model:string};plans:Plan[];}
export function AdminView(){
  const {data,demo,notify}=useWorkspace();
  const [stats,setStats]=useState<AdminStats|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(data.isAdmin&&!demo)api<AdminStats>('admin').then(setStats).catch(e=>setError(e.message));
  },[data.isAdmin,demo]);
  if(!data.isAdmin)return <Empty title="Admin access required" description="This page is restricted to platform administrators."/>;
  return (
    <>
      <PageHeader eyebrow="PLATFORM ADMIN" title="Overview"/>
      {error&&<div className="form-error" role="alert">{error}</div>}
      {stats?(
        <>
          <div className="admin-stats">
            {[
              ['Users',stats.users],
              ['Active subscribers',stats.subscribers],
              ['MRR',`RM${stats.mrr.toFixed(2)}`],
              ['AI cost this month',`RM${stats.aiCost.toFixed(2)}`],
              ['Images this month',stats.images],
              ['Published posts',stats.published],
              ['Failed posts',stats.failed],
              ['Estimated margin',`RM${(stats.mrr-stats.aiCost-stats.infra).toFixed(2)}`]
            ].map(([label,v])=>(
              <div className="stat-card" key={String(label)}>
                <span>{label}</span>
                <div className="stat-number">{v}</div>
              </div>
            ))}
          </div>
          <section className="panel settings-panel">
            <form className="form-fields" onSubmit={async e=>{
              e.preventDefault();
              setBusy(true);
              try{
                await api('admin/settings',stats.settings,'PATCH');
                notify('Models updated.');
              }catch(e){
                setError((e as Error).message);
              }finally{
                setBusy(false);
              }
            }}>
              <h2>AI Models</h2>
              <label>Caption model<input required value={stats.settings.copy_model} onChange={e=>setStats({...stats,settings:{...stats.settings,copy_model:e.target.value}})}/></label>
              <label>Image model<input required value={stats.settings.image_model} onChange={e=>setStats({...stats,settings:{...stats.settings,image_model:e.target.value}})}/></label>
              <button className="btn primary" disabled={busy}>Save models</button>
            </form>
          </section>
          <section className="panel">
            <div className="form-fields">
              <h2>Plans & quotas</h2>
              <p>Checkout prices are managed via Stripe. Ensure Stripe price IDs align before activating a plan.</p>
              {stats.plans.map((p,i)=>(
                <form className="admin-plan-form" key={p.id} onSubmit={async e=>{
                  e.preventDefault();
                  setBusy(true);
                  try{
                    await api(`admin/plans/${p.id}`,p,'PATCH');
                    notify('Plan updated.');
                  }catch(e){
                    setError((e as Error).message);
                  }finally{
                    setBusy(false);
                  }
                }}>
                  <b>{p.name}</b>
                  {(['monthly_price','monthly_post_limit','monthly_image_limit'] as const).map((key,j)=>(
                    <label key={key}>
                      {['Price (RM)','Caption credits','Image credits'][j]}
                      <input type="number" min="0" step={j===0?'0.01':'1'} value={p[key]} onChange={e=>setStats({...stats,plans:stats.plans.map((x,n)=>n===i?{...x,[key]:Number(e.target.value)}:x)})}/>
                    </label>
                  ))}
                  <button className="btn secondary" disabled={busy}>Save</button>
                </form>
              ))}
            </div>
          </section>
        </>
      ):(
        <Spinner/>
      )}
    </>
  );
}
