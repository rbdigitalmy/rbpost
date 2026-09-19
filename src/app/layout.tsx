import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  title: {
    default: 'RB Post — Automate Threads & Instagram',
    template: '%s | RB Post'
  },
  description: 'Create, refine, and schedule content across Threads and Instagram from one calm workspace.',
  applicationName: 'RB Post',
  openGraph: {type:'website',title:'RB Post — Automate Threads & Instagram',description:'Create, refine, and schedule content across Threads and Instagram from one calm workspace.',images:['/logo.png']},
  icons: { icon: '/logo.png' }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ backgroundColor: '#FFF9FA' }}>{children}</body>
    </html>
  );
}
