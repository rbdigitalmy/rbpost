'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { LayoutDashboard, Plus, CalendarDays, Files, Link2, CreditCard, Settings, ArrowUpRight, ArrowRight, Sparkles, MoreHorizontal, PanelLeftClose, Menu, X, LogOut, ShieldCheck, CircleHelp, Check, Clock3, Image as ImageIcon, FileText } from 'lucide-react';
import { Brand, Badge, PlatformBadge, AtInstagram, AtThreads, ThreadsIcon, InstagramIcon, OpenAIIcon, Spinner } from './ui';
import { createDemo, DEMO_KEY } from '@/lib/demo';
import { type Workspace, type Post, type PostInput, dateLabel } from '@/lib/domain';
import Editor from './editor';
import { CalendarView, PostsView, ConnectionsView, BillingView, SettingsView, AdminView } from './views';

export async function api<T>(path:string,body?:unknown,method?:string):Promise<T>{
  const res=await fetch(`/api/${path}`,{method:method||(body?'POST':'GET'),headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const result=await res.json();if(!res.ok)throw new Error(result.error||'Permintaan gagal. Sila cuba lagi.');return result;
}
interface Context {data:Workspace;demo:boolean;base:string;notify:(message:string)=>void;reload:()=>Promise<void>;setData:React.Dispatch<React.SetStateAction<Workspace|null>>;savePost:(input:PostInput,id?:string)=>Promise<Post>;removePost:(id:string)=>Promise<void>;updatePost:(post:Post)=>void;}
const WorkspaceContext=createContext<Context|null>(null);
export function useWorkspace(){const ctx=useContext(WorkspaceContext);if(!ctx)throw new Error('Missing workspace');return ctx;}
const nav=[['dashboard','Dashboard',LayoutDashboard],['create','Create Post',Plus],['calendar','Calendar',CalendarDays],['posts','All Posts',Files],['connections','Connections',Link2],['billing','Billing',CreditCard],['settings','Settings',Settings]] as const;
export default function WorkspaceApp({demo,section,postId}:{demo:boolean;section:string;postId?:string}){
  const router=useRouter();const [data,setData]=useState<Workspace|null>(null);const [error,setError]=useState('');const [toast,setToast]=useState('');const [mobile,setMobile]=useState(false);const timer=useRef<ReturnType<typeof setTimeout>|null>(null);const base=demo?'/demo':'';
  const notify=useCallback((m:string)=>{setToast(m);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setToast(''),5500);},[]);
  const reload=useCallback(async()=>{if(demo)return;setData(await api<Workspace>('workspace'));},[demo]);
  useEffect(()=>{let active=true;if(demo){try{const saved=localStorage.getItem(DEMO_KEY);const parsed=saved?JSON.parse(saved):null;setData(parsed?.profile&&Array.isArray(parsed.posts)&&parsed.plans?parsed:createDemo());}catch{setData(createDemo());}}else{api<Workspace>('workspace').then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});}return()=>{active=false;};},[demo]);
  useEffect(()=>{if(demo&&data)try{localStorage.setItem(DEMO_KEY,JSON.stringify(data));}catch{notify('Browser storage full. Recent changes could not be saved.');}},[demo,data,notify]);
  useEffect(()=>{setMobile(false);},[section]);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  function updatePost(post:Post){setData(d=>d?{...d,posts:[post,...d.posts.filter(p=>p.id!==post.id)]}:d);}
  async function savePost(input:PostInput,id?:string){
    let post:Post;
    if(demo){const old=data?.posts.find(p=>p.id===id);const now=new Date().toISOString();post={...input,id:id||crypto.randomUUID(),status:old?.status||'draft',created_at:old?.created_at||now,updated_at:now,scheduled_at:old?.scheduled_at||null,published_at:null};}
    else{post=await api<Post>(id?`posts/${id}`:'posts',input,id?'PATCH':'POST');}
    updatePost(post);return post;
  }
  async function removePost(id:string){if(!demo)await api(`posts/${id}`,undefined,'DELETE');setData(d=>d?{...d,posts:d.posts.filter(p=>p.id!==id)}:d);notify('Post deleted.');}
  if(!data)return <main className="center-page"><Brand/>{error?<><h1>Workspace not available.</h1><p className="muted">{error}</p><div className="button-row"><Link href="/login" className="btn primary">Log in</Link><Link href="/demo/dashboard" className="btn secondary">Explore local demo</Link></div></>:<><Spinner/><p>Loading your workspace…</p></>}</main>;
  const plan=data.plans.find(p=>p.id===data.subscription?.plan_id);const quota=plan?.monthly_post_limit||0;
  const context={data,demo,base,notify,reload,setData,savePost,removePost,updatePost};
  return <WorkspaceContext.Provider value={context}><div className="workspace">{mobile&&<button aria-label="Close menu" className="sidebar-scrim" onClick={()=>setMobile(false)}/>}
    <aside aria-label="Workspace navigation" className={`sidebar ${mobile?'open':''}`}>
      <div className="sidebar-brand-wrap">
        <Link href="/" className="sidebar-brand"><Brand/></Link>
      </div>
      <nav className="sidebar-nav">
        {nav.map(([id,label,Icon])=><Link key={id} href={`${base}/${id}`} className={`nav-item ${section===id?'active':''}`}><span className="nav-icon-box"><Icon size={17}/></span><span className="nav-label-text">{label}</span>{id==='posts'&&<small className="nav-badge">{data.posts.length}</small>}</Link>)}
        {data.isAdmin&&<Link href={`${base}/admin`} className={`nav-item ${section==='admin'?'active':''}`}><span className="nav-icon-box"><ShieldCheck size={17}/></span><span className="nav-label-text">Admin</span></Link>}
      </nav>
      <div className="sidebar-bottom">
        <Link className="user-block" href={`${base}/settings`}>
          <span className="avatar">{data.profile.name[0]||'A'}</span>
          <div className="user-block-details">
            <b>{data.profile.name}</b>
            <small>{demo?'Sample account':data.profile.email}</small>
          </div>
          <MoreHorizontal size={17}/>
        </Link>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar">
        <div className="breadcrumb">
          <button className="icon-btn mobile-menu" aria-label="Open menu" onClick={()=>setMobile(true)}><Menu size={20}/></button>
          <span>Pages</span><span>/</span><b>{nav.find(n=>n[0]===section)?.[1]||'Admin'}</b>
        </div>
        <div className="topbar-right">
          <span className="timezone-label">{data.profile.timezone.replaceAll('_',' ')}</span>
          <Link href={`${base}/connections`} className="top-account">
            <span className="both-icons"><ThreadsIcon size={14}/><InstagramIcon size={14}/></span>
            <span>{data.account?`@${data.account.username}`:data.instagramAccount?`@${data.instagramAccount.username}`:'Connect account'}</span>
          </Link>
        </div>
      </header>
      {demo&&<div className="demo-banner" role="region" aria-label="Demo notice"><span><span className="demo-dot"/>Demo mode <span className="demo-detail">— sample data stored in this browser. No posts will be sent to Threads or Instagram.</span></span><Link href="/signup">Open live account <ArrowUpRight size={14}/></Link></div>}
      <main className="content">{section==='dashboard'?<Dashboard/>:section==='create'?<Editor key={postId||'new'} postId={postId}/>:section==='calendar'?<CalendarView/>:section==='posts'?<PostsView/>:section==='connections'?<ConnectionsView/>:section==='billing'?<BillingView/>:section==='settings'?<SettingsView/>:<AdminView/>}</main>
      <footer className="workspace-footer"><span>RB Post <span>·</span> Turn ideas into conversations on Threads & Instagram.</span><span>Focus on your voice.</span></footer>
    </div>
    {toast&&<div role="status" className="toast"><Check size={18}/><span>{toast}</span><button className="icon-btn" aria-label="Close notification" onClick={()=>setToast('')}><X size={16}/></button></div>}
  </div></WorkspaceContext.Provider>;
}
export { AtThreads, ThreadsIcon, InstagramIcon, OpenAIIcon } from './ui';
export function PageHeader({eyebrow,title,description,children}:{eyebrow?:string;title:string;description?:string;children?:React.ReactNode}){return <div className="page-header"><div>{eyebrow&&<span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description&&<p>{description}</p>}</div>{children}</div>;}
export function Empty({title,description,children}:{title:string;description:string;children?:React.ReactNode}){return <div className="empty"><Files size={28}/><h3>{title}</h3><p>{description}</p>{children}</div>;}
function Dashboard(){const {data,base,demo}=useWorkspace();const plan=data.plans.find(p=>p.id===data.subscription?.plan_id);const upcoming=data.posts.filter(p=>p.status==='scheduled').sort((a,b)=>(a.scheduled_at||'').localeCompare(b.scheduled_at||''));const drafts=data.posts.filter(p=>p.status==='draft');const published=data.posts.filter(p=>p.status==='published');const firstName=data.profile.name.split(' ')[0];
  return <><PageHeader eyebrow="CREATIVE DASHBOARD" title={`Welcome back, ${firstName} 👋`} description="Turn your next idea into a conversation across Threads & Instagram."><Link className="btn primary" href={`${base}/create`}><Plus size={18}/>Create new post</Link></PageHeader>
  <div className="dashboard-stats">
    <div className="stat-card"><div className="stat-content"><span className="stat-label">Captions Used</span><div className="stat-number">{data.usage.copy_generations} <small>/ {plan?.monthly_post_limit||0}</small></div></div><div className="stat-icon-square"><OpenAIIcon size={18}/></div></div>
    <div className="stat-card"><div className="stat-content"><span className="stat-label">AI Images</span><div className="stat-number">{data.usage.image_generations} <small>/ {plan?.monthly_image_limit||0}</small></div></div><div className="stat-icon-square"><Sparkles size={18}/></div></div>
    <div className="stat-card"><div className="stat-content"><span className="stat-label">Scheduled</span><div className="stat-number">{upcoming.length}</div></div><div className="stat-icon-square"><CalendarDays size={18}/></div></div>
    <div className="stat-card"><div className="stat-content"><span className="stat-label">Published</span><div className="stat-number">{published.length}</div></div><div className="stat-icon-square"><FileText size={18}/></div></div>
  </div>
  <div className="dashboard-grid">
    <section className="panel upcoming">
      <div className="panel-heading">
        <div><h2>Publishing Schedule</h2><p>Posts ready to reach your audience.</p></div>
        <Link className="text-link" href={`${base}/calendar`}>View calendar <ArrowUpRight size={15}/></Link>
      </div>
      {upcoming.length?upcoming.slice(0,4).map(post=><Link href={`${base}/create/${post.id}`} className="upcoming-row" key={post.id}><div className="date-tile"><b>{dateLabel(post.scheduled_at,data.profile.timezone,'dd')}</b><span>{dateLabel(post.scheduled_at,data.profile.timezone,'MMM')}</span></div><div className="upcoming-copy"><div className="split"><h3>{post.title}</h3><div className="post-badge-group"><Badge status={post.status}/><PlatformBadge platform={post.platform}/></div></div><p>{post.caption}</p><small><Clock3 size={13}/>{dateLabel(post.scheduled_at,data.profile.timezone,'HH:mm')}</small></div><ArrowUpRight className="row-arrow" size={17}/></Link>):<Empty title="Your schedule is clear" description="Create a new post and choose when to publish."><Link href={`${base}/create`} className="btn secondary">Create post</Link></Empty>}
      <Link className="panel-bottom-link" href={`${base}/posts`}>View all posts <ArrowRight size={15}/></Link>
    </section>
    <aside className="dashboard-right" aria-label="Accounts and inspiration">
      <section className="connection-card">
        <div className="split"><h3>Connected Accounts</h3><div className="both-icons"><ThreadsIcon size={16}/><InstagramIcon size={16}/></div></div>
        <div className="connection-person"><span className="avatar large-avatar">{data.profile.name[0]}</span><div><b>{data.account?`@${data.account.username}`:data.instagramAccount?`@${data.instagramAccount.username}`:'No accounts linked'}</b><small className={(data.account?.status==='connected'||data.instagramAccount?.status==='connected')?'green-text':''}>{(data.account?.status==='connected'||data.instagramAccount?.status==='connected')?(demo?'Demo Active':'Connected'):'Connect accounts'}</small></div></div>
        <Link className="btn secondary full" href={`${base}/connections`}>Manage connections<ArrowUpRight size={15}/></Link>
      </section>
      <section className="idea-card">
        <div className="split"><span className="overline">Quick Prompt</span><Sparkles size={16}/></div>
        <h2>Need an idea today?</h2>
        <p>Share one honest lesson you learned recently. Your audience is waiting for your authentic perspective.</p>
        <Link href={`${base}/create?idea=One%20valuable%20lesson%20I%20learned%20recently`}>Try this prompt <ArrowUpRight size={15}/></Link>
      </section>
    </aside>
  </div>
  <section className="draft-section">
    <div className="panel-heading"><div><h2>Recent Drafts <span className="count">{drafts.length}</span></h2><p>Continue where you left off.</p></div><Link className="text-link" href={`${base}/posts?status=draft`}>All drafts <ArrowUpRight size={15}/></Link></div>
    <div className="draft-grid">
      {drafts.slice(0,3).map(post=><Link className="draft-card" key={post.id} href={`${base}/create/${post.id}`}><div className="split"><div className="post-badge-group"><Badge status="draft"/><PlatformBadge platform={post.platform}/></div><ArrowUpRight size={16}/></div><h3>{post.title}</h3><p>{post.caption}</p><footer><span>Edited {dateLabel(post.updated_at,data.profile.timezone,'d MMM')}</span></footer></Link>)}
      <Link className="new-draft" href={`${base}/create`}><span><Plus size={20}/></span><b>New idea?</b><p>Start a new draft.</p></Link>
    </div>
  </section></>;
}
