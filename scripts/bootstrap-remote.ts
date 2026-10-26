import {loadEnvConfig} from '@next/env';
import {randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {supabaseAdmin,supabaseEnabled} from '../src/lib/supabase';
import {readSecret} from './read-secret';

loadEnvConfig(process.cwd());
async function main(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL отсутствует');
 if(!supabaseEnabled()||!process.env.SUPABASE_STORAGE_BUCKET)throw new Error('Укажите полный набор Supabase и приватный bucket');
 const orgName=process.env.MEDTRACE_ORG_NAME?.trim(),email=process.env.MEDTRACE_ADMIN_EMAIL?.trim().toLowerCase(),password=process.env.MEDTRACE_ADMIN_PASSWORD||await readSecret('Новый пароль администратора MedTrace (ввод скрыт): ');
 if(!orgName||!email||!email.includes('@')||!password||password.length<12)throw new Error('Нужны MEDTRACE_ORG_NAME, MEDTRACE_ADMIN_EMAIL и временный MEDTRACE_ADMIN_PASSWORD (не короче 12 символов)');
 if(email.endsWith('@medtrace.demo')||password==='MedTrace2026!')throw new Error('Демонстрационные учётные данные недопустимы');
 const {migrate,query,transaction,uid}=await import('../src/lib/db');
 await migrate();
 const existing=await query<{organizations:string;profiles:string}>(`SELECT (SELECT count(*)::text FROM organizations) organizations,(SELECT count(*)::text FROM profiles) profiles`);
 if(Number(existing.rows[0].organizations)||Number(existing.rows[0].profiles))throw new Error('База уже содержит организацию или пользователей. Начальная настройка отменена');
 const admin=supabaseAdmin(),bucketName=process.env.SUPABASE_STORAGE_BUCKET;
 const bucket=await admin.storage.getBucket(bucketName);
 if(bucket.data?.public)throw new Error('Bucket открыт публично. Сделайте его приватным перед запуском');
 if(bucket.error||!bucket.data){const created=await admin.storage.createBucket(bucketName,{public:false});if(created.error)throw new Error(`Не удалось создать приватный bucket: ${created.error.message}`);}
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});
 if(created.error||!created.data.user)throw new Error(`Не удалось создать администратора Supabase Auth: ${created.error?.message||'неизвестная ошибка'}`);
 const userId=created.data.user.id,orgId=uid();
 try{
  await transaction(async db=>{
   await db.query('INSERT INTO organizations(id,name) VALUES($1,$2)',[orgId,orgName]);
   const roles:Record<string,string>={admin:'Администратор',warehouse:'Сотрудник склада',quality_specialist:'Специалист КК',quality_manager:'Ответственный за качество',production_manager:'Начальник производства',operator:'Оператор',shipping:'Менеджер отгрузки',auditor:'Аудитор'};
   for(const [code,label] of Object.entries(roles))await db.query('INSERT INTO roles(code,label) VALUES($1,$2)',[code,label]);
   for(const [code,label,whole] of [['kg','кг',false],['pcs','шт',true],['m','м',false]] as const)await db.query('INSERT INTO units(code,label,whole_only) VALUES($1,$2,$3)',[code,label,whole]);
   for(const [code,name,kind] of [['RAW','Склад сырья','raw'],['QUAR','Карантинная зона','quarantine'],['PROD','Производственный участок','production'],['FG','Склад готовой продукции','finished'],['HOLD','Зона блокировки','blocked'],['RET','Брак и возвраты','returns']])await db.query('INSERT INTO warehouses(id,code,name,kind) VALUES($1,$2,$3,$4)',[uid(),code,name,kind]);
   await db.query('INSERT INTO profiles(id,organization_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)',[userId,orgId,email,'Администратор',await bcrypt.hash(randomBytes(32).toString('hex'),12)]);
   await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)',[userId,'admin']);
  });
 }catch(error){await admin.auth.admin.deleteUser(userId);throw error;}
 console.log(`Созданы организация «${orgName}» и администратор ${email}; bucket ${bucketName} приватный. Удалите MEDTRACE_ADMIN_PASSWORD из окружения после запуска.`);
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Ошибка начальной настройки');process.exitCode=1;});
