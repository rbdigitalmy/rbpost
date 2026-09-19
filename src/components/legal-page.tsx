import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Brand } from './ui';

export default function LegalPage({title,updated,children}:{title:string;updated:string;children:React.ReactNode}) {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <Link href="/" aria-label="RB Post home"><Brand/></Link>
        <Link className="text-link" href="/"><ArrowLeft size={16}/>Back to home</Link>
      </header>
      <article className="legal-card">
        <span className="eyebrow">RB POST LEGAL</span>
        <h1>{title}</h1>
        <p className="legal-updated">Effective: {updated}</p>
        {children}
      </article>
      <nav className="legal-nav" aria-label="Legal documents">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/data-deletion">Data deletion</Link>
      </nav>
    </main>
  );
}

