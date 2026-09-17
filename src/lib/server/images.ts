import 'server-only';
import { randomUUID } from 'node:crypto';
import { db,checkDB,AppError } from './core';
import { imageMime, mediaPath } from '../media';
export async function storeImage(bytes:Buffer,userId:string){if(bytes.length>8*1024*1024)throw new AppError('Saiz gambar terlalu besar.',413);const mime=imageMime(bytes);const ext=mime==='image/jpeg'?'jpg':mime==='image/png'?'png':'webp';const path=`${userId}/${randomUUID()}.${ext}`;const {error}=await db().storage.from('post-images').upload(path,bytes,{contentType:mime,upsert:false,cacheControl:'3600'});checkDB(error);return `/api/media?path=${encodeURIComponent(path)}`;}
export async function publishImageUrl(url:string,userId:string){let path:string;try{path=mediaPath(url,userId);}catch(e){throw new AppError((e as Error).message);}const {data,error}=await db().storage.from('post-images').createSignedUrl(path,60*60);checkDB(error);if(!data)throw new AppError('Gambar tidak dapat dimuatkan.');return data.signedUrl;}
