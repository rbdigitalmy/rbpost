import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';
const supabaseOrigin = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').origin; }
  catch { return ''; }
})();
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ''}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const config: NextConfig = {
  allowedDevOrigins: process.env.NEXT_PUBLIC_APP_URL ? [new URL(process.env.NEXT_PUBLIC_APP_URL).hostname] : [],
  poweredByHeader: false,
  devIndicators: false,
  async headers() { return [{source:'/(.*)',headers:[
    {key:'Content-Security-Policy',value:contentSecurityPolicy},
    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=(), payment=()'},
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
    {key:'X-Frame-Options',value:'DENY'}
  ]}]; }
};
export default config;
