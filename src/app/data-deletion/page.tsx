import type { Metadata } from 'next';
import Link from 'next/link';
import LegalPage from '@/components/legal-page';

export const metadata: Metadata = {title:'Data Deletion',description:'How to permanently delete RB Post account data.'};

export default function DataDeletionPage(){return <LegalPage title="Data Deletion Instructions" updated="19 September 2026">
  <section><h2>Delete your RB Post account</h2><ol><li><Link href="/login">Sign in to RB Post</Link>.</li><li>Open <strong>Settings</strong>.</li><li>Select <strong>Delete account and data</strong>.</li><li>Type <strong>DELETE</strong> and confirm.</li></ol><p>The deletion is permanent and cannot be undone.</p></section>
  <section><h2>What is deleted</h2><p>Your RB Post profile, drafts, scheduled and published-post records, stored images, usage records, generated-content records, and locally stored social connection tokens are removed. Deleting RB Post data does not delete posts already published on Threads or Instagram.</p></section>
  <section><h2>Revoke Meta access</h2><p>For complete disconnection, also remove RB Post from the Apps and Websites area of your Meta account. This revokes access held by Meta independently of the data stored by RB Post.</p></section>
  <section><h2>If you cannot sign in</h2><p>Contact the RB Post operator through the official support channel provided during onboarding. Send the email address used for the account and request account deletion. Never include your password or social access tokens.</p></section>
</LegalPage>}

