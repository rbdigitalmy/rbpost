import fs from 'fs';
import path from 'path';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

async function verify() {
  const env = loadEnv();
  console.log('\n======================================================');
  console.log('   RB POST — STATUS KONFIGURASI MOD LIVE');
  console.log('======================================================\n');

  const report = [];
  const sbUrl = env.NEXT_PUBLIC_SUPABASE_URL || '';
  const sbAnon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const sbRole = env.SUPABASE_SERVICE_ROLE_KEY || '';
  let sbStatus = 'Belum Diisi';
  let sbDetail = 'Isi URL, Anon Key & Service Role Key';
  let bucketStatus = 'Belum Diuji';
  let bucketDetail = '-';

  if (sbUrl && sbAnon && sbRole) {
    try {
      const res = await fetch(sbUrl + '/rest/v1/plans?select=*', {
        headers: { 'apikey': sbRole, 'Authorization': 'Bearer ' + sbRole }
      });
      if (res.ok) {
        const plans = await res.json();
        sbStatus = 'Bersambung & Aktif';
        sbDetail = plans.length + ' pelan dikesan';
      } else if (res.status === 401 || res.status === 403) {
        sbStatus = 'Kunci Ditolak';
        sbDetail = 'Semak semula SUPABASE_SERVICE_ROLE_KEY';
      } else {
        sbStatus = 'Schema Belum Ada';
        sbDetail = 'Jalankan supabase/schema.sql dalam SQL Editor';
      }

      // Check storage bucket
      const bucketRes = await fetch(sbUrl + '/storage/v1/bucket/post-images', {
        headers: { 'apikey': sbRole, 'Authorization': 'Bearer ' + sbRole }
      });
      if (bucketRes.ok) {
        bucketStatus = 'Aktif (post-images)';
        bucketDetail = 'Storan gambar sedia digunakan';
      } else {
        bucketStatus = 'Bucket Belum Ada';
        bucketDetail = 'Jalankan supabase/storage.sql dalam SQL Editor';
      }
    } catch (err) {
      sbStatus = 'Gagal Bersambung';
      sbDetail = err.message;
    }
  }
  report.push({ Komponen: 'Supabase (DB & Auth)', Status: sbStatus, Catatan: sbDetail });
  report.push({ Komponen: 'Supabase Storage (Gambar)', Status: bucketStatus, Catatan: bucketDetail });

  const encKey = env.TOKEN_ENCRYPTION_KEY || '';
  report.push({
    Komponen: 'Token Encryption Key',
    Status: encKey.length === 64 && /^[0-9a-fA-F]+$/.test(encKey) ? 'Sah (AES-256)' : 'Perlu 64 hex',
    Catatan: encKey.length === 64 ? 'Sudah dijana secara rawak' : 'Jana 32-byte hex'
  });

  const cronSec = env.CRON_SECRET || '';
  report.push({
    Komponen: 'Cron Secret Key',
    Status: cronSec.length >= 32 ? 'Sah' : 'Perlu >= 32 aksara',
    Catatan: cronSec.length >= 32 ? 'Kawalan auto-publish selamat' : 'Isi CRON_SECRET'
  });

  const aiKey = env.OPENROUTER_API_KEY || '';
  report.push({
    Komponen: 'OpenRouter (AI Copy & Visual)',
    Status: aiKey ? 'Kunci Dikesan' : 'Belum Diisi',
    Catatan: aiKey ? ('Model: ' + (env.COPY_MODEL || 'gpt-4.1-mini')) : 'Dapatkan dari openrouter.ai/keys'
  });

  const metaId = env.META_APP_ID || '';
  const metaSec = env.META_APP_SECRET || '';
  report.push({
    Komponen: 'Meta API (Threads & IG)',
    Status: metaId && metaSec ? 'Kunci Dikesan' : 'Belum Diisi',
    Catatan: metaId && metaSec ? ('App ID: ' + metaId) : 'Dapatkan dari developers.facebook.com'
  });

  const stripeKey = env.STRIPE_SECRET_KEY || '';
  report.push({
    Komponen: 'Stripe (Billing)',
    Status: stripeKey ? 'Kunci Dikesan' : 'Belum Diisi',
    Catatan: stripeKey ? (stripeKey.startsWith('sk_test_') ? 'Mod Test' : 'Mod Live') : 'Diperlukan untuk pembayaran live'
  });

  console.table(report);
  console.log('------------------------------------------------------');
  console.log('Panduan tindakan seterusnya:');
  console.log('1. Masukkan nilai sebenar ke dalam fail .env.local');
  console.log('2. Jalankan schema SQL di Supabase SQL Editor');
  console.log('3. Jalankan semula: node scripts/verify-live.mjs\n');
}

verify();