import { notFound } from 'next/navigation';
import WorkspaceApp from '@/components/workspace';
import AuthScreen from '@/components/auth-screen';
export default async function Page({params}:{params:Promise<{view:string[]}>}) {
  const {view}=await params;
  if(view.length===1 && ['login','signup'].includes(view[0])) return <AuthScreen signup={view[0]==='signup'}/>;
  const demo=view[0]==='demo'; const parts=demo?view.slice(1):view;
  const section=parts[0] || 'dashboard';
  if(!['dashboard','create','calendar','posts','connections','billing','settings','admin'].includes(section) || parts.length>2 || (parts.length===2&&section!=='create')) notFound();
  return <WorkspaceApp demo={demo} section={section} postId={parts[1]}/>;
}
