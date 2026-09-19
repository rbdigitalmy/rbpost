'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowLeft, Sparkles } from 'lucide-react';
import { Brand, Spinner } from './ui';
import { browserSupabase } from '@/lib/supabase/browser';

export default function AuthScreen({ signup }: { signup: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link href="/"><Brand /></Link>
        <div>
          <span className="eyebrow">FROM IDEAS TO CONVERSATIONS</span>
          <h1>Your voice<br />deserves to be heard.</h1>
          <p>A single, calm space to create, organize, and publish your stories across Threads and Instagram.</p>
          <div className="auth-quote">
            <Sparkles size={24} />
            <p>Start with a single spark.<br />We handle the cadence and publishing.</p>
          </div>
        </div>
        <span>RB Post · Built for creators</span>
      </section>

      <section className="auth-form-wrap">
        <Link className="text-link" href="/"><ArrowLeft size={16} />Back to home</Link>
        <form onSubmit={e => {
          e.preventDefault();
          run(async () => {
            const sb = browserSupabase();
            if (signup) {
              const { error } = await sb.auth.signUp({
                email,
                password,
                options: { data: { name }, emailRedirectTo: `${window.location.origin}/auth/callback` }
              });
              if (error) throw error;
              setMessage('Check your email to confirm your account, then sign in.');
            } else {
              const { error } = await sb.auth.signInWithPassword({ email, password });
              if (error) throw error;
              router.push('/dashboard');
            }
          });
        }}>
          <span className="eyebrow">{signup ? 'YOUR CREATIVE STUDIO STARTS HERE' : 'WELCOME BACK'}</span>
          <h1>{signup ? 'Start sharing your voice.' : 'Sign in to your space.'}</h1>
          <p>{signup ? 'Create an account, pick your plan, and connect your social accounts.' : 'Your next big idea is waiting for you.'}</p>

          <button type="button" className="btn secondary full" disabled={busy} onClick={() => run(async () => {
            const { data, error } = await browserSupabase().auth.signInWithOAuth({
              provider: 'google',
              options: { redirectTo: `${window.location.origin}/auth/callback` }
            });
            if (error) throw error;
            if (data.url) window.location.assign(data.url);
          })}>
            <b className="google-g">G</b>Continue with Google
          </button>

          <div className="divider"><span>or continue with email</span></div>

          {signup && (
            <label>Name
              <input required maxLength={80} autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
            </label>
          )}

          <label>Email
            <input required type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
          </label>

          <label>Password
            <input required minLength={8} type="password" autoComplete={signup ? 'new-password' : 'current-password'} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
          </label>

          {error && <div className="form-error" role="alert">{error}</div>}
          {message && <div className="notice" role="status">{message}</div>}

          <button className="btn primary full" disabled={busy}>
            {busy ? <Spinner /> : null}
            {signup ? 'Create account' : 'Sign in'}
            <ArrowRight size={17} />
          </button>

          {!signup && (
            <button type="button" className="btn ghost full" disabled={busy} onClick={() => run(async () => {
              if (!email) throw new Error('Please enter your email first.');
              const { error } = await browserSupabase().auth.signInWithOtp({
                email,
                options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` }
              });
              if (error) throw error;
              setMessage('Magic link sent. Please check your inbox.');
            })}>
              Send magic link via email
            </button>
          )}

          <p className="auth-switch">
            {signup ? 'Already have an account?' : "Don't have an account?"}{' '}
            <Link href={signup ? '/login' : '/signup'}>{signup ? 'Sign in' : 'Sign up'}</Link>
          </p>

          <Link className="demo-link" href="/demo/dashboard">Explore demo workspace first <ArrowRight size={15} /></Link>
          <nav className="auth-legal" aria-label="Legal"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/data-deletion">Data deletion</Link></nav>
        </form>
      </section>
    </main>
  );
}
