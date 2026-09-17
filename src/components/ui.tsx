'use client';
import { useEffect, useRef } from 'react';
import { AtSign, X, LoaderCircle } from 'lucide-react';
import { statusLabels, platformLabels, type PostStatus, type PlatformTarget } from '@/lib/domain';
export function Brand(){
  return (
    <span className="brand">
      <span className="brand-logo-wrap">
        <img src="/logo.png" alt="RB Post Logo" width={38} height={38} />
      </span>
      <span className="brand-text">RB <span className="brand-ai">POST</span></span>
    </span>
  );
}

export function ThreadsIcon({size=16,className=''}:{size?:number;className?:string}){
  return (
    <svg width={size} height={size} viewBox="35.7 0 440.4 512" fill="currentColor" className={`homarr-icon homarr-threads ${className}`} aria-hidden="true">
      <path d="M378.5 237.3c-2.2-1.1-4.4-2.1-6.7-3-4-72.8-43.7-114.5-110.6-114.9h-.9c-40 0-73.2 17.1-93.7 48.1l36.7 25.2c15.3-23.2 39.3-28.1 56.9-28.1h.6c22 .1 38.6 6.5 49.3 19q11.7 13.65 15.6 37.5c-19.5-3.3-40.6-4.3-63.1-3-63.5 3.7-104.4 40.7-101.6 92.2 1.4 26.1 14.4 48.6 36.6 63.3 18.8 12.4 43 18.5 68.2 17.1 33.2-1.8 59.3-14.5 77.5-37.7 13.8-17.6 22.5-40.4 26.4-69.1 15.8 9.6 27.6 22.1 34 37.2 11 25.7 11.7 67.9-22.8 102.3-30.2 30.2-66.5 43.2-121.3 43.6-60.8-.5-106.8-20-136.7-58-28-35.6-42.5-87-43-152.8.5-65.8 15-117.2 43-152.8 29.9-38 75.9-57.5 136.7-58 61.3.5 108.1 20.1 139.1 58.3 15.2 18.7 26.7 42.3 34.3 69.8l43.1-11.5c-9.2-33.8-23.6-63-43.3-87.1C393.2 25.6 335 .5 259.9 0h-.3C184.8.5 127.2 25.7 88.5 74.9c-34.4 43.8-52.2 104.6-52.8 180.9v.4c.6 76.3 18.3 137.2 52.8 180.9 38.7 49.2 96.2 74.4 171.1 74.9h.3c66.6-.5 113.5-17.9 152.1-56.5 50.6-50.5 49-113.8 32.4-152.7-11.9-27.9-34.7-50.5-65.9-65.5M263.6 345.4c-27.8 1.6-56.8-10.9-58.2-37.7-1.1-19.8 14.1-42 59.9-44.6 5.2-.3 10.4-.5 15.4-.5 16.6 0 32.2 1.6 46.3 4.7-5.2 65.9-36.1 76.6-63.4 78.1"/>
    </svg>
  );
}

export function InstagramIcon({size=20,className=''}:{size?:number;className?:string}){
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" className={`homarr-icon homarr-instagram ${className}`} aria-hidden="true">
      <defs>
        <radialGradient id="homarr-ig-a" cx="-167.747" cy="-6.147" r="255.952" gradientTransform="matrix(0 -1.982 -1.8439 0 124.667 218.883)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fd5"/>
          <stop offset=".1" stopColor="#fd5"/>
          <stop offset=".5" stopColor="#ff543e"/>
          <stop offset="1" stopColor="#c837ab"/>
        </radialGradient>
        <radialGradient id="homarr-ig-b" cx="278.405" cy="166.356" r="255.952" gradientTransform="matrix(.1739 .8687 3.5818 -.7172 -730.042 -85.605)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3771c8"/>
          <stop offset=".128" stopColor="#3771c8"/>
          <stop offset="1" stopColor="#60f" stopOpacity="0"/>
        </radialGradient>
      </defs>
      <path d="M256.1.1C149.2.1 118 .2 111.9.7 89.9 2.5 76.3 6 61.4 13.4 50 19.1 40.9 25.6 32 34.9 15.8 51.8 5.9 72.5 2.4 97.2.7 109.2.2 111.6.1 172.8V256c0 106.8.1 138 .6 144.1 1.8 21.3 5.1 34.8 12.2 49.5 13.5 28.1 39.4 49.2 69.9 57.1 10.6 2.7 22.2 4.2 37.2 4.9 6.3.3 71 .5 135.6.5s129.3-.1 135.5-.4c17.3-.8 27.4-2.2 38.5-5 30.7-7.9 56.1-28.7 69.9-57.2 7-14.3 10.5-28.3 12.1-48.5.3-4.4.5-74.7.5-144.9s-.2-140.4-.5-144.8c-1.6-20.6-5.1-34.4-12.3-49-5.9-12-12.4-20.9-21.9-30-16.9-16.2-37.6-26-62.3-29.6C403.1 1 400.8.5 339.6.4h-83.5z" fill="url(#homarr-ig-a)"/>
      <path d="M256.1.1C149.2.1 118 .2 111.9.7 89.9 2.5 76.3 6 61.4 13.4 50 19.1 40.9 25.6 32 34.9 15.8 51.8 5.9 72.5 2.4 97.2.7 109.2.2 111.6.1 172.8V256c0 106.8.1 138 .6 144.1 1.8 21.3 5.1 34.8 12.2 49.5 13.5 28.1 39.4 49.2 69.9 57.1 10.6 2.7 22.2 4.2 37.2 4.9 6.3.3 71 .5 135.6.5s129.3-.1 135.5-.4c17.3-.8 27.4-2.2 38.5-5 30.7-7.9 56.1-28.7 69.9-57.2 7-14.3 10.5-28.3 12.1-48.5.3-4.4.5-74.7.5-144.9s-.2-140.4-.5-144.8c-1.6-20.6-5.1-34.4-12.3-49-5.9-12-12.4-20.9-21.9-30-16.9-16.2-37.6-26-62.3-29.6C403.1 1 400.8.5 339.6.4h-83.5z" fill="url(#homarr-ig-b)"/>
      <path d="M256 67c-51.3 0-57.8.2-77.9 1.1s-33.9 4.1-45.9 8.8c-12.4 4.8-23 11.3-33.5 21.8s-17 21.1-21.8 33.5c-4.7 12-7.9 25.8-8.8 45.9-.9 20.2-1.1 26.6-1.1 77.9s.2 57.8 1.1 77.9 4.1 33.9 8.8 45.9c4.8 12.4 11.3 23 21.8 33.5s21 17 33.5 21.8c12 4.7 25.8 7.9 45.9 8.8 20.2.9 26.6 1.1 77.9 1.1s57.8-.2 77.9-1.1 33.9-4.1 45.9-8.8c12.4-4.8 23-11.3 33.5-21.8s17-21.1 21.8-33.5c4.6-12 7.8-25.8 8.8-45.9.9-20.2 1.1-26.6 1.1-77.9s-.2-57.8-1.1-77.9-4.1-33.9-8.8-45.9c-4.8-12.4-11.3-23-21.8-33.5s-21-17-33.5-21.8c-12-4.7-25.8-7.9-45.9-8.8-20.2-.9-26.6-1.1-77.9-1.1m-17 34.1h17c50.5 0 56.4.2 76.4 1.1 18.4.8 28.4 3.9 35.1 6.5 8.8 3.4 15.1 7.5 21.7 14.1s10.7 12.9 14.1 21.7c2.6 6.7 5.7 16.7 6.5 35.1.9 19.9 1.1 25.9 1.1 76.4s-.2 56.4-1.1 76.4c-.8 18.4-3.9 28.4-6.5 35.1-3.4 8.8-7.5 15.1-14.1 21.7s-12.9 10.7-21.7 14.1c-6.7 2.6-16.7 5.7-35.1 6.5-19.9.9-25.9 1.1-76.4 1.1s-56.5-.2-76.4-1.1c-18.4-.9-28.4-3.9-35.1-6.5-8.8-3.4-15.1-7.5-21.7-14.1s-10.7-12.9-14.1-21.7c-2.6-6.7-5.7-16.7-6.5-35.1-.9-19.9-1.1-25.9-1.1-76.4s.2-56.4 1.1-76.4c.8-18.4 3.9-28.4 6.5-35.1 3.4-8.8 7.5-15.1 14.1-21.7s12.9-10.7 21.7-14.1c6.7-2.6 16.7-5.7 35.1-6.5 17.4-.9 24.2-1.1 59.4-1.1m117.9 31.4c-12.5 0-22.7 10.1-22.7 22.7 0 12.5 10.2 22.7 22.7 22.7s22.7-10.2 22.7-22.7-10.2-22.8-22.7-22.7M256 159c-53.6 0-97.1 43.5-97.1 97.1s43.5 97 97.1 97 97-43.4 97-97-43.4-97.1-97-97.1m0 34c34.8 0 63 28.2 63 63s-28.2 63-63 63-63-28.2-63-63 28.2-63 63-63" fill="#fff"/>
    </svg>
  );
}

export function OpenAIIcon({size=16,className=''}:{size?:number;className?:string}){
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={`homarr-icon homarr-openai ${className}`} aria-hidden="true">
      <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"/>
    </svg>
  );
}

export function MetaIcon({size=20,className=''}:{size?:number;className?:string}){
  return (
    <svg width={size} height={Math.round((size * 1041) / 1567)} viewBox="0 0 1567 1041" className={`homarr-icon homarr-meta ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id="homarr-meta-a" x1="332.6" x2="1411" y1="637.7" y2="692.2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0064e1"/>
          <stop offset=".4" stopColor="#0064e1"/>
          <stop offset=".8" stopColor="#0073ee"/>
          <stop offset="1" stopColor="#0082fb"/>
        </linearGradient>
        <linearGradient id="homarr-meta-b" x1="245.4" x2="245.4" y1="757.6" y2="359.7" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0082fb"/>
          <stop offset="1" stopColor="#0064e0"/>
        </linearGradient>
      </defs>
      <path d="M169.5 686.5c0 59.9 13.1 105.8 30.3 133.6 22.5 36.4 56 51.8 90.2 51.8 44.2 0 84.5-10.9 162.3-118.6C514.6 667.1 588 546 637.4 470l83.7-128.6c58.1-89.3 125.3-188.6 202.5-255.9C986.5 30.5 1054.5 0 1122.8 0c114.8 0 224.1 66.5 307.7 191.4 91.6 136.7 136 308.8 136 486.5 0 105.6-20.8 183.2-56.2 244.6-34.2 59.3-100.8 118.5-213 118.5V871.9c96 0 120-88.3 120-189.3 0-144-33.6-303.8-107.5-418-52.4-81-120.4-130.5-195.2-130.5-80.8 0-145.9 61.1-219.1 169.9-38.9 57.8-78.8 128.3-123.6 207.8l-49.4 87.5c-99.1 175.9-124.2 216-173.8 282.1C461.9 997.1 387.7 1041 290 1041c-115.8 0-189.1-50.2-234.4-125.8C18.5 853.5.3 772.6.3 680.5z" fill="#0081fb"/>
      <path d="M133.7 203.3C211.3 83.7 323.2 0 451.6 0 525.9 0 599.8 22 677 85.1c84.4 68.9 174.4 182.5 286.7 369.6l40.2 67.1c97.2 162 152.5 245.3 184.8 284.6 41.6 50.5 70.8 65.5 108.6 65.5 96 0 120-88.3 120-189.3l149.2-4.7c0 105.6-20.8 183.2-56.2 244.6-34.2 59.3-100.8 118.5-213 118.5-69.7 0-131.5-15.2-199.8-79.6C1045 911.9 983.6 824 936.4 744.9L796 510.1c-70.5-117.8-135.2-205.6-172.6-245.4-40.2-42.8-92-94.5-174.5-94.5-66.9 0-123.6 46.9-171.1 118.7z" fill="url(#homarr-meta-a)"/>
      <path d="M448.9 170.2c-66.9 0-123.6 46.9-171.1 118.7-67.2 101.4-108.3 252.5-108.3 397.6 0 59.9 13.1 105.8 30.3 133.6L55.6 915.2C18.5 853.5.3 772.6.3 680.5c0-167.6 46-342.3 133.4-477.2C211.3 83.7 323.2 0 451.6 0z" fill="url(#homarr-meta-b)"/>
    </svg>
  );
}

export function StripeIcon({size=20,className=''}:{size?:number;className?:string}){
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#635BFF" className={`homarr-icon homarr-stripe ${className}`} aria-hidden="true">
      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252 1.988 15.686 1.4 12.52 1.4 6.84 1.4 3 4.417 3 9.404c0 6.643 8.948 5.61 8.948 8.874 0 .978-.859 1.495-2.091 1.495-2.583 0-5.328-1.206-7.05-2.222l-.895 5.567c1.782.905 4.793 1.482 7.945 1.482 6.002 0 9.948-2.904 9.948-8.082 0-7.039-8.948-5.94-8.948-8.922 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252 1.988 15.686 1.4 12.52 1.4"/>
    </svg>
  );
}

export function Badge({status}:{status:PostStatus}){return <span className={`badge ${status}`}><span/>{statusLabels[status]}</span>;}

export function Instagram({size=20,className=''}:{size?:number;className?:string}){
  return <InstagramIcon size={size} className={className}/>;
}

export function AtThreads({size=16,className=''}:{size?:number;className?:string}){
  return <ThreadsIcon size={size} className={className}/>;
}

export function AtInstagram({size=20,className=''}:{size?:number;className?:string}){
  return <InstagramIcon size={size} className={className}/>;
}

export function PlatformBadge({platform='threads'}:{platform?:PlatformTarget}){
  return (
    <span className={`platform-badge ${platform}`} title={platformLabels[platform]}>
      {(platform==='threads'||platform==='both') && <ThreadsIcon size={12}/>}
      {platform==='both' && <span className="badge-plus">+</span>}
      {(platform==='instagram'||platform==='both') && <InstagramIcon size={12}/>}
      <span className="platform-name">{platformLabels[platform]}</span>
    </span>
  );
}

export function Spinner(){return <LoaderCircle className="spin" size={18} aria-label="Loading"/>;}
export function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const el=ref.current; el?.showModal();return()=>el?.close();},[]);
  return <dialog ref={ref} className="modal" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><header><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header>{children}</dialog>;
}
