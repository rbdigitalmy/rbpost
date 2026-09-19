import type { Metadata } from 'next';
import LegalPage from '@/components/legal-page';

export const metadata: Metadata = {title:'Terms of Service',description:'Terms governing use of the RB Post service.'};

export default function TermsPage(){return <LegalPage title="Terms of Service" updated="19 September 2026">
  <section><h2>Using RB Post</h2><p>You must provide accurate account information, keep your login secure, and use RB Post only for lawful content and social accounts you are authorized to manage. You are responsible for reviewing content before it is published.</p></section>
  <section><h2>Acceptable use</h2><p>You may not use the service for fraud, harassment, spam, infringement, illegal content, credential theft, platform manipulation, or attempts to bypass security, rate limits, or provider policies.</p></section>
  <section><h2>AI-generated content</h2><p>AI output may be incomplete, inaccurate, or similar to other content. You must review factual claims, ownership, permissions, and suitability before use. RB Post does not guarantee that generated content is unique or appropriate for every purpose.</p></section>
  <section><h2>Publishing and third-party platforms</h2><p>Publishing depends on Meta and other third-party services. Delivery times are targets rather than guarantees, and provider outages, reviews, rate limits, token expiry, or policy changes may delay or prevent publication. RB Post is independent and is not affiliated with or endorsed by Meta.</p></section>
  <section><h2>Availability and changes</h2><p>We may maintain, improve, suspend, or discontinue features when necessary for security, reliability, legal compliance, or provider compatibility. Material changes to these terms will be communicated through the service or official support channel.</p></section>
  <section><h2>Liability</h2><p>To the extent permitted by applicable law, RB Post is provided on an “as available” basis. The operator is not liable for indirect losses, lost engagement, missed publishing times, or third-party account actions. Nothing here excludes rights or liabilities that cannot legally be excluded.</p></section>
  <section><h2>Termination</h2><p>You may stop using RB Post and delete your account at any time. We may restrict access for serious abuse, security threats, legal requirements, or repeated violations of these terms.</p></section>
</LegalPage>}

