import { NextResponse } from 'next/server';
import { authClient,appUrl,ensureProfile } from '@/lib/server/core';
export async function GET(req:Request){try{const code=new URL(req.url).searchParams.get('code');if(code){const sb=await authClient();const {data,error}=await sb.auth.exchangeCodeForSession(code);if(!error&&data.user){await ensureProfile(data.user);return NextResponse.redirect(`${appUrl()}/billing`);}}}catch{/* Never include credentials or raw provider responses in the redirect. */}return NextResponse.redirect(`${appUrl()}/login?error=auth`);}
