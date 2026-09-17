'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main className="center-page"><h1>Ada masalah memuatkan halaman.</h1><p>Cuba muatkan semula. Draf yang disimpan tidak terjejas.</p><button className="btn primary" onClick={reset}>Cuba lagi</button></main>;}
