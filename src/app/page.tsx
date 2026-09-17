import Link from 'next/link';
import { ArrowUpRight, ArrowRight, Check, Sparkles, CalendarDays, AtSign, PenLine } from 'lucide-react';
import { Brand, ThreadsIcon } from '@/components/ui';
import { defaultPlans } from '@/lib/domain';

export default function Home() {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Link href="/" aria-label="RB Post home"><Brand/></Link>
        <div>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link href="/login">Sign in</Link>
          <Link className="btn primary" href="/signup">Get started <ArrowUpRight size={16}/></Link>
        </div>
      </nav>
      <main>
        <section className="landing-hero">
          <div>
            <span className="eyebrow"><ThreadsIcon size={14}/> CREATIVE STUDIO FOR THREADS & INSTAGRAM</span>
            <h1>Your ideas.<br/>Your voice.<br/><em>Consistently delivered.</em></h1>
            <p>From initial inspiration to scheduled post. Generate copy and visuals with AI, refine in your authentic voice, and schedule seamlessly — all in one calm workspace.</p>
            <div className="button-row">
              <Link href="/signup" className="btn primary large">Start your journey <ArrowUpRight size={18}/></Link>
              <Link href="/demo/dashboard" className="btn secondary large">Explore demo <ArrowRight size={18}/></Link>
            </div>
            <small>English & Multilingual · Built for creators · Cross-post to Threads & Instagram</small>
          </div>
          <div className="hero-board">
            <div className="board-heading">
              <span className="tiny-label">FROM INSPIRATION TO CONVERSATION</span>
              <Sparkles size={24}/>
            </div>
            <div className="hero-prompt">
              <span>Today’s thought</span>
              <strong>How to stay consistent<br/>without running out of ideas?</strong>
              <div>
                <span className="pill">Casual</span>
                <span className="pill">English</span>
              </div>
            </div>
            <div className="hero-thread">
              <header>
                <span className="avatar">a</span>
                <b>alex.creates</b>
                <ThreadsIcon size={20}/>
              </header>
              <p>You don’t need the perfect idea to begin.<br/><br/>One honest share today can spark a conversation that changes everything.<br/><br/>Start with what you know. ✨</p>
              <footer><CalendarDays size={16}/> Tomorrow, 9:00 AM <span>Sample post</span></footer>
            </div>
            <div className="board-bottom">
              <span>01 / Create</span>
              <span>02 / Refine</span>
              <span>03 / Schedule</span>
            </div>
          </div>
        </section>

        <section id="how" className="how-section">
          <div>
            <span className="eyebrow">LESS BUSYWORK. MORE CREATIVITY.</span>
            <h2>One flow. Endless momentum.</h2>
          </div>
          <div className="how-grid">
            {[
              [AtSign, '01', 'Connect Accounts', 'Link your Threads and Instagram accounts with a single click.'],
              [PenLine, '02', 'Turn Ideas into Posts', 'Type a topic. Let AI generate high-converting captions and visuals.'],
              [CalendarDays, '03', 'Publish with Cadence', 'Review posts, pick optimal times, and let your automated schedule run.']
            ].map(([Icon, n, title, desc]) => {
              const I = Icon as typeof AtSign;
              return (
                <article key={String(n)}>
                  <div><I size={24}/><span>{String(n)}</span></div>
                  <h3>{String(title)}</h3>
                  <p>{String(desc)}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section id="pricing" className="pricing-section">
          <span className="eyebrow">FIND YOUR PACE</span>
          <h2>Simple, predictable pricing.</h2>
          <p>Monthly subscriptions. Manage or cancel anytime via billing portal.</p>
          <div className="pricing-grid">
            {defaultPlans.map(plan => (
              <article key={plan.id} className={`plan-card ${plan.id==='pro'?'featured':''}`}>
                <div className="split">
                  <h3>{plan.name}</h3>
                  {plan.id==='pro'&&<span className="pill">Creator choice</span>}
                </div>
                <div className="price">RM{plan.monthly_price}<span>/ month</span></div>
                <ul>
                  <li><Check size={17}/>{plan.monthly_post_limit} caption generations</li>
                  <li><Check size={17}/>{plan.monthly_image_limit} image generations</li>
                  <li><Check size={17}/>Threads & Instagram accounts</li>
                  <li><Check size={17}/>Calendar & auto-publishing</li>
                </ul>
                <Link href={`/signup?plan=${plan.id}`} className={`btn ${plan.id==='pro'?'primary':'secondary'}`}>
                  Choose {plan.name}<ArrowUpRight size={16}/>
                </Link>
              </article>
            ))}
          </div>
          <small>Regenerations consume credits. Launch pricing subject to checkout terms.</small>
        </section>
      </main>
      <footer className="landing-footer">
        <Brand/>
        <span>Turn ideas into conversations.</span>
        <span>RB Post is an independent platform, not affiliated with Meta.</span>
      </footer>
    </div>
  );
}
