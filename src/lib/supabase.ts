import {createClient} from '@supabase/supabase-js';
export function supabaseSettings(){
 const url=process.env.SUPABASE_URL;
 const publicKey=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY;
 const secretKey=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
 const settings=[url,publicKey,secretKey];
 if(settings.some(Boolean)&&!settings.every(Boolean))throw new Error('Supabase настроен не полностью: нужны SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY и SUPABASE_SECRET_KEY');
 return settings.every(Boolean)?{url:url!,publicKey:publicKey!,secretKey:secretKey!}:null;
}
export function supabaseEnabled(){
 return Boolean(supabaseSettings());
}
export function supabasePublic(){
 const settings=supabaseSettings();
 if(!settings)throw new Error('Supabase Auth is not configured');
 return createClient(settings.url,settings.publicKey,{auth:{persistSession:false,autoRefreshToken:false}});
}
export function supabaseAdmin(){
 const settings=supabaseSettings();
 if(!settings)throw new Error('Supabase secret key is not configured');
 return createClient(settings.url,settings.secretKey,{auth:{persistSession:false,autoRefreshToken:false}});
}
export function storageEnabled(){
 const enabled=supabaseEnabled();
 if(process.env.SUPABASE_STORAGE_BUCKET&&!enabled)throw new Error('Для Supabase Storage нужны URL и оба ключа Supabase');
 return enabled&&Boolean(process.env.SUPABASE_STORAGE_BUCKET);
}
