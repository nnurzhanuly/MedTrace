import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {AppError} from './auth';
import {transaction} from './db';

export function checkMutationOrigin(req:NextRequest){
  const origin=req.headers.get('origin');
  const site=req.headers.get('sec-fetch-site');
  if(site&&site!=='same-origin'&&site!=='none')throw new AppError('Недопустимый источник запроса',403);
  if(origin){let host:string;try{host=new URL(origin).host;}catch{throw new AppError('Недопустимый источник запроса',403);}if(host!==(req.headers.get('host')||req.nextUrl.host))throw new AppError('Недопустимый источник запроса',403);}
  if(!origin&&!site)throw new AppError('Источник запроса не указан',403);
}
export async function readJson(req:NextRequest,max=64*1024):Promise<Record<string,unknown>>{
  if(Number(req.headers.get('content-length')||0)>max)throw new AppError('Запрос слишком большой',413);
  const raw=await req.text();if(Buffer.byteLength(raw)>max)throw new AppError('Запрос слишком большой',413);
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new AppError('Неверный JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Неверный запрос');
  return value as Record<string,unknown>;
}
export async function readLimitedFormData(req:NextRequest,max:number):Promise<FormData>{
  if(Number(req.headers.get('content-length')||0)>max)throw new AppError('Файл слишком большой',413);
  if(!req.body)throw new AppError('Файл не передан');
  const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new AppError('Файл слишком большой',413);chunks.push(value);}}
  finally{reader.releaseLock();}
  return new Request(req.url,{method:'POST',headers:{'content-type':req.headers.get('content-type')||''},body:Buffer.concat(chunks.map(c=>Buffer.from(c)))}).formData();
}
export function apiError(e:unknown,fallback='Внутренняя ошибка'){
  if(e instanceof AppError)return NextResponse.json({error:e.message},{status:e.status});
  console.error(fallback,e);
  return NextResponse.json({error:fallback},{status:500});
}
export async function loginAllowed(email:string,_ip:string){
  const bucket=createHash('sha256').update(email.toLowerCase()).digest('hex');
  return transaction(async db=>{
    await db.query(`DELETE FROM login_attempts WHERE window_start<now()-interval '1 day'`);
    const r=await db.query<{attempts:number;window_start:string;blocked_until:string|null}>('SELECT attempts,window_start,blocked_until FROM login_attempts WHERE bucket=$1',[bucket]);
    const row=r.rows[0],now=Date.now();
    if(row?.blocked_until&&new Date(row.blocked_until).getTime()>now)return false;
    if(!row||now-new Date(row.window_start).getTime()>15*60*1000){
      await db.query('INSERT INTO login_attempts(bucket,attempts,window_start,blocked_until) VALUES($1,0,now(),NULL) ON CONFLICT(bucket) DO UPDATE SET attempts=0,window_start=now(),blocked_until=NULL',[bucket]);
    }
    return true;
  });
}
export async function recordLogin(email:string,_ip:string,success:boolean){
  const bucket=createHash('sha256').update(email.toLowerCase()).digest('hex');
  await transaction(async db=>{
    if(success)await db.query('DELETE FROM login_attempts WHERE bucket=$1',[bucket]);
    else await db.query(`UPDATE login_attempts SET attempts=attempts+1,blocked_until=CASE WHEN attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE bucket=$1`,[bucket]);
  });
}
