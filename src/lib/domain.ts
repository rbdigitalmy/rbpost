import { z } from 'zod';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

export const statuses = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
export type PostStatus = typeof statuses[number];
export const statusLabels: Record<PostStatus,string> = { draft:'Draft', scheduled:'Scheduled', publishing:'Publishing', published:'Published', failed:'Failed' };
export const platforms = ['threads', 'instagram', 'both'] as const;
export type PlatformTarget = typeof platforms[number];
export const platformLabels: Record<PlatformTarget,string> = { threads:'Threads', instagram:'Instagram', both:'Threads + Instagram' };
export const timezones = ['Asia/Kuala_Lumpur','Asia/Singapore','Asia/Jakarta','Asia/Bangkok','Asia/Tokyo','Australia/Sydney','Europe/London','America/New_York','UTC'];
export const timezoneSchema = z.string().refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } }, 'Invalid timezone.');
export const threadsCaptionMax = 500;
export const instagramCaptionMax = 2200;
export const captionSchema = z.string().max(2000).refine(v => Array.from(v).length <= 500, 'Caption cannot exceed 500 characters.');
export const instagramCaptionSchema = z.string().max(3000).refine(v => Array.from(v).length <= 2200, 'Caption cannot exceed 2,200 characters.');
export const postSchema = z.object({
  title: z.string().trim().min(1).max(120),
  caption: z.string().max(3000),
  image_url: z.string().max(3000).nullable().default(null),
  image_prompt: z.string().max(3000).default(''),
  timezone: timezoneSchema.default('Asia/Kuala_Lumpur'),
  platform: z.enum(platforms).default('threads'),
}).superRefine((data, ctx) => {
  const len = Array.from(data.caption).length;
  if ((data.platform === 'threads' || data.platform === 'both') && len > 500) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Caption cannot exceed 500 characters for Threads.', path: ['caption'] });
  } else if (len > 2200) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Caption cannot exceed 2,200 characters for Instagram.', path: ['caption'] });
  }
});
export const generationSchema = z.object({topic:z.string().trim().min(3).max(1000),tone:z.enum(['Casual','Professional','Inspirational','Humorous','Santai','Profesional','Inspirasi','Humor']).default('Casual'),language:z.enum(['English','Bahasa Melayu']).default('English'),objective:z.string().max(200).default(''),audience:z.string().max(200).default(''),cta:z.string().max(200).default(''),post_id:z.uuid().optional(),platform:z.enum(platforms).optional()});
export type GenerationInput = z.infer<typeof generationSchema>;
export type PostInput = z.infer<typeof postSchema>;
export interface SocialAccount {id:string;platform:'threads'|'instagram';username:string;status:string;expires_at:string|null;}
export interface Post extends PostInput { id:string; status:PostStatus; scheduled_at:string|null; published_at:string|null; created_at:string; updated_at:string; platform_post_id?:string|null; error_message?:string|null; error_code?:string|null; }
export interface Plan {id:string;name:string;monthly_price:number;monthly_post_limit:number;monthly_image_limit:number;active:boolean}
export const defaultPlans: Plan[] = [
  {id:'starter',name:'Starter',monthly_price:19,monthly_post_limit:30,monthly_image_limit:30,active:true},
  {id:'pro',name:'Pro',monthly_price:39,monthly_post_limit:100,monthly_image_limit:100,active:true},
  {id:'business',name:'Business',monthly_price:79,monthly_post_limit:300,monthly_image_limit:300,active:true},
];
export interface Workspace {profile:{name:string;email:string;timezone:string;language:string};posts:Post[];account:SocialAccount|null;instagramAccount?:SocialAccount|null;accounts?:{threads:SocialAccount|null;instagram:SocialAccount|null};subscription:{plan_id:string;status:string;current_period_end:string;cancel_at_period_end?:boolean}|null;usage:{copy_generations:number;image_generations:number;posts_published:number;estimated_cost:number};plans:Plan[];isAdmin:boolean;}
export function characterCount(value:string) {return Array.from(value).length;}
export function scheduledUTC(local:string, timezone:string, now=new Date()) {
  timezoneSchema.parse(timezone);
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('Please enter a valid date and time.');
  const date=fromZonedTime(local,timezone);
  if(!Number.isFinite(date.getTime()) || formatInTimeZone(date,timezone,"yyyy-MM-dd'T'HH:mm")!==local) throw new Error('This time is invalid in the selected timezone.');
  if(date.getTime() < now.getTime()+60_000) throw new Error('Please choose a time at least one minute from now.');
  return date.toISOString();
}
export function dateLabel(date:string|null, timezone='Asia/Kuala_Lumpur', pattern='d MMM, HH:mm') {return date?formatInTimeZone(date,timezone,pattern):'Not scheduled';}
export function editable(post:Post) {return ['draft','scheduled','failed'].includes(post.status) && post.error_code!=='outcome_unknown';}
