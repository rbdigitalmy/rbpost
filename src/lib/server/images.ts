import 'server-only';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db, checkDB, AppError } from './core';
import { imageMime, mediaPath } from '../media';
export async function storeImage(bytes: Buffer, userId: string) {
  if (bytes.length > 8 * 1024 * 1024) throw new AppError('Saiz gambar terlalu besar.', 413);
  const mime = imageMime(bytes);
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
  const path = `${userId}/${randomUUID()}.${ext}`;
  const { error } = await db()
    .storage.from('post-images')
    .upload(path, bytes, { contentType: mime, upsert: false, cacheControl: '3600' });
  checkDB(error);
  return `/api/media?path=${encodeURIComponent(path)}`;
}
function ownedPath(url: string, userId: string) {
  try {
    return mediaPath(url, userId);
  } catch (e) {
    throw new AppError((e as Error).message);
  }
}
async function signedUrl(path: string) {
  const { data, error } = await db()
    .storage.from('post-images')
    .createSignedUrl(path, 60 * 60);
  checkDB(error);
  if (!data) throw new AppError('Gambar tidak dapat dimuatkan.');
  return data.signedUrl;
}
export async function publishImageUrl(url: string, userId: string) {
  return signedUrl(ownedPath(url, userId));
}
// Instagram's publishing API accepts JPEG only. PNG/WebP are converted to a sibling .jpg (same UUID) so retries reuse the same path.
export async function instagramImageUrl(url: string, userId: string) {
  const path = ownedPath(url, userId);
  if (path.endsWith('.jpg')) return signedUrl(path);
  const { data, error } = await db().storage.from('post-images').download(path);
  checkDB(error);
  if (!data) throw new AppError('Gambar tidak dapat dimuatkan.');
  const jpeg = await sharp(Buffer.from(await data.arrayBuffer()))
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  if (jpeg.length > 8 * 1024 * 1024)
    throw new AppError('Gambar terlalu besar untuk Instagram (maksimum 8 MB).', 413, 'media_failed');
  const target = path.replace(/\.(png|webp)$/, '.jpg');
  const saved = await db()
    .storage.from('post-images')
    .upload(target, jpeg, { contentType: 'image/jpeg', upsert: true, cacheControl: '3600' });
  checkDB(saved.error);
  return signedUrl(target);
}
