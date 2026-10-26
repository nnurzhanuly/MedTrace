import {loadEnvConfig} from '@next/env';
import {Pool} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {supabaseSettings} from '../src/lib/supabase';

loadEnvConfig(process.cwd());
const required=['DATABASE_URL','SUPABASE_URL','SUPABASE_STORAGE_BUCKET'] as const;
const missing:string[]=[...required.filter(name=>!process.env[name])];
if(!process.env.SUPABASE_PUBLISHABLE_KEY&&!process.env.SUPABASE_ANON_KEY)missing.push('SUPABASE_PUBLISHABLE_KEY');
if(!process.env.SUPABASE_SECRET_KEY&&!process.env.SUPABASE_SERVICE_ROLE_KEY)missing.push('SUPABASE_SECRET_KEY');
if(missing.length){console.error(`Подключение не завершено. Отсутствуют: ${missing.join(', ')}`);process.exit(1);}

async function main(){
 const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:8000,max:1});
 try{
  const status=await pool.query<{database:string;schema_ready:boolean}>(`SELECT current_database() database,to_regclass('public.organizations') IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL schema_ready`);
  if(!status.rows[0]?.schema_ready)throw new Error('Миграции PostgreSQL не применены');
  const organizations=await pool.query<{count:string}>('SELECT count(*)::text AS count FROM organizations');
  console.log(`PostgreSQL: подключён, база ${status.rows[0].database}, организаций ${organizations.rows[0].count}`);
  const tableNames=['001_initial.sql','002_security.sql'].flatMap(file=>
   [...readFileSync(path.join(process.cwd(),'migrations',file),'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(match=>match[1]));
  const access=await pool.query<{relname:string;relrowsecurity:boolean;exposed:boolean}>(`
   SELECT c.relname,c.relrowsecurity,
    EXISTS (
     SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) AS role_name
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege_name
     WHERE has_table_privilege(role_name,c.oid,privilege_name)
    ) exposed
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind IN ('r','p')`,[tableNames]);
  if(access.rows.length!==tableNames.length)throw new Error('Не все таблицы MedTrace созданы в PostgreSQL');
  const unsafe=access.rows.filter(row=>!row.relrowsecurity||row.exposed);
  if(unsafe.length)throw new Error(`Data API открыт для таблиц MedTrace: ${unsafe.map(row=>row.relname).join(', ')}`);
  console.log(`Data API: ${tableNames.length} таблиц MedTrace закрыты для прямого доступа`);
 }finally{await pool.end();}
 const settings=supabaseSettings()!;
 const client=createClient(settings.url,settings.secretKey,{auth:{persistSession:false,autoRefreshToken:false}});
 const auth=await client.auth.admin.listUsers({page:1,perPage:1});
 if(auth.error)throw new Error(`Supabase Auth: ${auth.error.message}`);
 console.log('Supabase Auth: service role доступен');
 const bucket=await client.storage.getBucket(process.env.SUPABASE_STORAGE_BUCKET!);
 if(bucket.error||!bucket.data)throw new Error(`Supabase Storage: ${bucket.error?.message||'bucket не найден'}`);
 if(bucket.data.public)throw new Error('Supabase Storage: bucket должен быть приватным');
 console.log(`Supabase Storage: приватный bucket ${bucket.data.name} доступен`);
 console.log('Интеграции подключены. Проверка входа пользователя выполняется отдельно.');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Ошибка проверки интеграций');process.exitCode=1;});
