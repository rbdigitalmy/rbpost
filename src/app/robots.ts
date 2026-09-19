import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return {rules:[{userAgent:'*',allow:['/','/privacy','/terms','/data-deletion'],disallow:['/api/','/dashboard','/create','/calendar','/posts','/connections','/billing','/settings','/admin']}],sitemap:`${origin}/sitemap.xml`};
}

