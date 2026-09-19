'use client';
import { useEffect } from 'react';

export default function GlobalError({error,reset}:{error:Error & {digest?:string};reset:()=>void}){
  useEffect(()=>{console.error(JSON.stringify({event:'global_ui_error',type:error.name,digest:error.digest||null}));},[error]);
  return <html lang="en"><body><main className="center-page"><h1>RB Post tidak dapat dimuatkan.</h1><p>Cuba sekali lagi. Jika masalah berterusan, hubungi pentadbir platform.</p><button className="btn primary" onClick={reset}>Cuba lagi</button></main></body></html>;
}
