import type { Metadata } from 'next';
import LegalPage from '@/components/legal-page';

export const metadata: Metadata = {title:'Privacy Policy',description:'How RB Post collects, uses, protects, and deletes personal data.'};

export default function PrivacyPage(){return <LegalPage title="Privacy Policy" updated="19 September 2026">
  <section><h2>What we collect</h2><p>RB Post stores account details, profile preferences, drafts, scheduled content, generated content, usage records, subscription status, and encrypted connection tokens for social accounts you choose to connect. We also process technical records needed to secure, troubleshoot, and operate the service.</p></section>
  <section><h2>How we use information</h2><p>We use this information to authenticate you, generate requested content, store your work, publish or schedule posts, enforce usage limits, provide support, prevent abuse, and improve reliability. We do not sell personal information.</p></section>
  <section><h2>Service providers</h2><p>RB Post relies on service providers including Netlify for hosting, Supabase for authentication and data storage, OpenRouter and selected AI model providers for requested generations, and Meta services for Threads and Instagram connections. A payment provider may be added separately. Each provider processes only the information required for its role.</p></section>
  <section><h2>Social account access</h2><p>Connection tokens are encrypted before storage. RB Post uses them only to perform actions you request, such as publishing content or refreshing a connection. You can disconnect an account at any time. You can also revoke RB Post directly in your Meta account settings.</p></section>
  <section><h2>Retention and security</h2><p>We retain account data while your account is active and for only as long as reasonably required for security, legal, and operational purposes. We use access controls, encryption, tenant isolation, request validation, and audit records, but no online service can guarantee absolute security.</p></section>
  <section><h2>Your choices</h2><p>You may review or update profile information in Settings, disconnect social accounts in Connections, and permanently delete your RB Post account from Settings. Account deletion removes your profile, posts, stored images, usage records, and locally stored social connection tokens, subject to limited records we must retain by law.</p></section>
  <section><h2>Contact</h2><p>For privacy questions, contact the RB Post operator through the support channel provided with your account. Include the email address associated with your account, but never send passwords, access tokens, or secret keys.</p></section>
</LegalPage>}

