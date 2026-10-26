import {readFile,writeFile,rename,unlink,chmod} from 'node:fs/promises';
import path from 'node:path';
import {readSecret} from './read-secret';

type Pending={url:string;publishableKey:string;secretKey:string;bucket:string;projectRef:string;poolerHost:string;adminEmail?:string};
const root=process.cwd();
const pendingPath=path.join(root,'.env.supabase.pending.json');
const envPath=path.join(root,'.env.local');

async function main(){
 const pending=JSON.parse(await readFile(pendingPath,'utf8')) as Pending;
 if(!/^[a-z0-9]+$/.test(pending.projectRef)||!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(pending.poolerHost)
  ||pending.url!==`https://${pending.projectRef}.supabase.co`
  ||!pending.publishableKey.startsWith('sb_publishable_')||!pending.secretKey.startsWith('sb_secret_'))throw new Error('Файл подготовки Supabase повреждён');
 const password=await readSecret('Пароль PostgreSQL из Supabase (ввод скрыт): ');
 if(!password)throw new Error('Пароль не введён');
 const databaseUrl=new URL(`postgresql://postgres.${pending.projectRef}@${pending.poolerHost}:5432/postgres`);
 databaseUrl.password=password;databaseUrl.searchParams.set('sslmode','require');
 const names=new Set(['DATABASE_URL','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SECRET_KEY','SUPABASE_STORAGE_BUCKET','MEDTRACE_ORG_NAME','MEDTRACE_ADMIN_EMAIL']);
 const previous=await readFile(envPath,'utf8');
 const lines=previous.split('\n').filter(line=>![...names].some(name=>line.startsWith(name+'=')));
 const next=lines.join('\n').trimEnd()+'\n'+[
  `DATABASE_URL=${databaseUrl.toString()}`,
  `SUPABASE_URL=${pending.url}`,
  `SUPABASE_PUBLISHABLE_KEY=${pending.publishableKey}`,
  `SUPABASE_SECRET_KEY=${pending.secretKey}`,
  `SUPABASE_STORAGE_BUCKET=${pending.bucket}`,
  'MEDTRACE_ORG_NAME=MedTrace',
  ...(pending.adminEmail?[`MEDTRACE_ADMIN_EMAIL=${pending.adminEmail}`]:[]),
 ].join('\n')+'\n';
 const tmp=envPath+'.'+process.pid+'.tmp';
 try{await writeFile(tmp,next,{mode:0o600});await chmod(tmp,0o600);await rename(tmp,envPath);await unlink(pendingPath);}catch(error){await unlink(tmp).catch(()=>undefined);throw error;}
 console.log('Подключение сохранено в .env.local. Пароль не показан и не сохранён отдельно.');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Ошибка настройки');process.exitCode=1;});
