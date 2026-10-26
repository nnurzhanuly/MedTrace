import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

test('Supabase API roles cannot access MedTrace business tables',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  const tableNames:string[]=[];
  for(const file of ['001_initial.sql','002_security.sql','003_supabase_api_lockdown.sql']){
   const sql=readFileSync(path.join(process.cwd(),'migrations',file),'utf8');
   tableNames.push(...[...sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(match=>match[1]));
   await db.exec(sql);
  }
  const result=await db.query<{relname:string;relrowsecurity:boolean;exposed:boolean}>(`
   SELECT c.relname,c.relrowsecurity,
    EXISTS (
     SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) AS role_name
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege_name
     WHERE has_table_privilege(role_name,c.oid,privilege_name)
    ) exposed
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`,[tableNames]);
  assert.equal(result.rows.length,tableNames.length);
  assert.ok(result.rows.every(row=>row.relrowsecurity&&!row.exposed),JSON.stringify(result.rows));
 }finally{await db.close();}
});
