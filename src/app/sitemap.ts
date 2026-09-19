import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const lastModified = new Date('2026-09-19T00:00:00.000Z');
  return [
    {url:origin,lastModified,changeFrequency:'weekly',priority:1},
    {url:`${origin}/privacy`,lastModified,changeFrequency:'yearly',priority:0.3},
    {url:`${origin}/terms`,lastModified,changeFrequency:'yearly',priority:0.3},
    {url:`${origin}/data-deletion`,lastModified,changeFrequency:'yearly',priority:0.3},
  ];
}

