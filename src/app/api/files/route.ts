import {NextRequest,NextResponse} from 'next/server';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {currentActor,AppError} from '@/lib/auth';
import {requireEntityAccess} from '@/lib/access';
import {apiError,checkMutationOrigin,readJson,readLimitedFormData} from '@/lib/http-security';
import {query,transaction,one,uid} from '@/lib/db';
import {storageEnabled,supabaseAdmin} from '@/lib/supabase';
const MAX=10*1024*1024;const TYPES=new Set(['application/pdf','image/png','image/jpeg','image/webp','text/plain']);
const root=path.join(process.cwd(),'private-uploads');
const localSecret=randomBytes(32).toString('hex');
function sig(id:string,exp:string,actorId:string){
 const secret=process.env.SESSION_SECRET||(process.env.NODE_ENV==='production'?null:localSecret);
 if(!secret)throw new AppError('SESSION_SECRET не настроен',500);
 return createHmac('sha256',secret).update(`${id}:${exp}:${actorId}`).digest('hex');
}
function verifyMime(mime:string,b:Buffer){
 if(mime==='application/pdf')return b.subarray(0,5).toString()==='%PDF-';
 if(mime==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/jpeg')return b[0]===255&&b[1]===216&&b[2]===255;
 if(mime==='image/webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
 if(mime==='text/plain')return !b.includes(0)&&new TextDecoder('utf-8',{fatal:true}).decode(b).length>=0;
 return false;
}
const entities:Record<string,string>={lot:'lots',shipment:'shipments',receipt:'receipts',recall:'recall_campaigns',quality_check:'quality_checks',production_run:'production_runs',nonconformity:'nonconformities'};
export async function POST(req:NextRequest){
 let uploaded:string|undefined;
 try{
  checkMutationOrigin(req);
  const actor=await currentActor();if(!actor)return NextResponse.json({error:'Требуется вход'},{status:401});
  const form=await readLimitedFormData(req,MAX+1024*1024);const file=form.get('file'),entityType=String(form.get('entityType')||''),entityId=String(form.get('entityId')||''),kind=String(form.get('kind')||'attachment'),existingId=String(form.get('documentId')||'');
  if(!(file instanceof File)||!TYPES.has(file.type)||file.size>MAX||file.size===0)throw new AppError('Допустимы PDF, PNG, JPEG, WebP или TXT до 10 МБ');
  if(!entities[entityType]||!entityId)throw new AppError('Неверная связь документа');
  await requireEntityAccess(actor,entityType,entityId,true);
  const entity=await query(`SELECT id FROM ${entities[entityType]} WHERE id=$1`,[entityId]);if(!entity.rows[0])throw new AppError('Связанная запись не найдена');
  const bytes=Buffer.from(await file.arrayBuffer());if(!verifyMime(file.type,bytes))throw new AppError('Содержимое файла не соответствует типу');
  const id=existingId||uid(),vid=uid(),fileId=uid(),storage=`${entityType}/${entityId}/${fileId}`,remote=storageEnabled();
  if(remote){const up=await supabaseAdmin().storage.from(process.env.SUPABASE_STORAGE_BUCKET!).upload(storage,bytes,{contentType:file.type,upsert:false});if(up.error)throw new AppError(`Хранилище: ${up.error.message}`);uploaded=`supabase:${storage}`;}
  else{await mkdir(path.dirname(path.join(root,storage)),{recursive:true});await writeFile(path.join(root,storage),bytes,{flag:'wx'});uploaded=storage;}
  const result=await transaction(async db=>{
   let version=1;
   if(existingId){const doc=await one<{entity_type:string;entity_id:string}>(db,'SELECT entity_type,entity_id FROM documents WHERE id=$1',[existingId]);if(doc.entity_type!==entityType||doc.entity_id!==entityId)throw new AppError('Версия должна относиться к тому же объекту');const r=await db.query<{n:string}>('SELECT COALESCE(max(version_no),0)::text n FROM document_versions WHERE document_id=$1',[existingId]);version=Number(r.rows[0].n)+1;}
   else await db.query('INSERT INTO documents(id,title,kind,entity_type,entity_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,file.name,kind,entityType,entityId,actor.id]);
   await db.query('INSERT INTO document_versions(id,document_id,version_no,storage_path,mime_type,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[vid,id,version,uploaded,file.type,file.size,actor.id]);
   await db.query('INSERT INTO attachments(id,document_version_id,name,storage_path,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6)',[fileId,vid,file.name,uploaded,file.type,file.size]);
   await db.query('INSERT INTO audit_logs(id,entity_type,entity_id,action,new_value,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[uid(),'document',id,existingId?'new_version':'upload',JSON.stringify({entityType,entityId,version,mime:file.type,size:file.size}),actor.id]);
   return {id,version};
  });return NextResponse.json(result);
 }catch(e){if(uploaded){if(uploaded.startsWith('supabase:'))await supabaseAdmin().storage.from(process.env.SUPABASE_STORAGE_BUCKET!).remove([uploaded.slice(9)]);else await unlink(path.join(root,uploaded)).catch(()=>undefined);}return apiError(e,'Ошибка загрузки');}
}
export async function GET(req:NextRequest){
 try{const actor=await currentActor();if(!actor)return NextResponse.json({error:'Требуется вход'},{status:401});
 const id=req.nextUrl.searchParams.get('id')||'',exp=req.nextUrl.searchParams.get('exp')||'',signature=req.nextUrl.searchParams.get('sig')||'';
 if(!id||!/^\d{13}$/.test(exp)||Date.now()>Number(exp)||Number(exp)-Date.now()>5*60*1000||!/^[0-9a-f]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(sig(id,exp,actor.id))))return NextResponse.json({error:'Ссылка недействительна'},{status:403});
 const r=await query<{storage_path:string;mime_type:string;name:string;entity_type:string;entity_id:string}>('SELECT a.storage_path,a.mime_type,a.name,d.entity_type,d.entity_id FROM attachments a JOIN document_versions dv ON dv.id=a.document_version_id JOIN documents d ON d.id=dv.document_id WHERE dv.document_id=$1 ORDER BY dv.version_no DESC LIMIT 1',[id]);if(!r.rows[0])return NextResponse.json({error:'Файл не найден'},{status:404});
 await requireEntityAccess(actor,r.rows[0].entity_type,r.rows[0].entity_id);
 const file=r.rows[0];if(file.storage_path.startsWith('supabase:'))return NextResponse.json({error:'Для облачного файла запросите новую ссылку'},{status:400});
 try{return new NextResponse(new Uint8Array(await readFile(path.join(root,file.storage_path))),{headers:{'Content-Type':file.mime_type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}catch{return NextResponse.json({error:'Файл отсутствует в хранилище'},{status:404});}
 }catch(e){return apiError(e,'Ошибка получения файла');}
}
export async function PUT(req:NextRequest){
 try{checkMutationOrigin(req);const actor=await currentActor();if(!actor)return NextResponse.json({error:'Требуется вход'},{status:401});
 const id=String((await readJson(req,4096)).id||'');const r=await query<{storage_path:string;entity_type:string;entity_id:string}>('SELECT dv.storage_path,d.entity_type,d.entity_id FROM document_versions dv JOIN documents d ON d.id=dv.document_id WHERE dv.document_id=$1 AND dv.storage_path IS NOT NULL ORDER BY dv.version_no DESC LIMIT 1',[id]);if(!r.rows[0])return NextResponse.json({error:'Файл не найден'},{status:404});
 await requireEntityAccess(actor,r.rows[0].entity_type,r.rows[0].entity_id);
 if(r.rows[0].storage_path.startsWith('supabase:')){const signed=await supabaseAdmin().storage.from(process.env.SUPABASE_STORAGE_BUCKET!).createSignedUrl(r.rows[0].storage_path.slice(9),300);if(signed.error)return NextResponse.json({error:signed.error.message},{status:500});return NextResponse.json({url:signed.data.signedUrl,expiresIn:300});}
 const exp=String(Date.now()+5*60*1000);return NextResponse.json({url:`/api/files?id=${encodeURIComponent(id)}&exp=${exp}&sig=${sig(id,exp,actor.id)}`,expiresIn:300});
 }catch(e){return apiError(e,'Ошибка получения ссылки');}
}
