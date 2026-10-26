import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { query, uid } from './db';
import {supabaseEnabled,supabasePublic} from './supabase';
export const COOKIE = 'medtrace_session';
const DUMMY_HASH='$2b$12$JAaQ7MLwhgp/5T7bXcpvBO5t44ND9XOly8fewhkJgVbs7f5/E9Wuq';
export type Actor = { id: string; name: string; email: string; roles: string[] };
export async function authenticate(email: string, password: string): Promise<Actor | null> {
  let supabaseId:string|undefined;
  if(supabaseEnabled()){
    const auth=await supabasePublic().auth.signInWithPassword({email,password});
    if(auth.error||!auth.data.user||auth.data.user.email?.toLowerCase()!==email.toLowerCase())return null;
    supabaseId=auth.data.user.id;
  }
  const r = await query<{id:string;name:string;email:string;password_hash:string;organization_id:string}>(
    'SELECT id,name,email,password_hash,organization_id FROM profiles WHERE lower(email)=lower($1) AND ($2::text IS NULL OR id=$2) AND active=true',[email,supabaseId||null]);
  const user = r.rows[0];
  const passwordValid=supabaseEnabled()||await bcrypt.compare(password,user?.password_hash||DUMMY_HASH);
  if (!user||!passwordValid) return null;
  if(process.env.NODE_ENV==='production'&&user.organization_id==='demo-org'&&process.env.MEDTRACE_ALLOW_DEMO_LOGIN!=='1')return null;
  const roles = await query<{role_code:string}>('SELECT role_code FROM user_roles WHERE user_id=$1',[user.id]);
  return { id:user.id,name:user.name,email:user.email,roles:roles.rows.map(x=>x.role_code) };
}
export async function startSession(userId: string) {
  const id=uid(); const seconds=supabaseEnabled()?3600:7*24*3600;
  await query('DELETE FROM sessions WHERE expires_at<now()');
  await query('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[id,userId,new Date(Date.now()+seconds*1000).toISOString()]);
  (await cookies()).set(COOKIE,id,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:seconds});
}
export async function endSession() {
  const cookie=(await cookies()).get(COOKIE)?.value;
  if(cookie) await query('DELETE FROM sessions WHERE id=$1',[cookie]);
  (await cookies()).delete(COOKIE);
}
export async function currentActor(): Promise<Actor | null> {
  const cookie=(await cookies()).get(COOKIE)?.value;
  if(!cookie) return null;
  const r=await query<{id:string;name:string;email:string}>(`SELECT p.id,p.name,p.email FROM sessions s JOIN profiles p ON p.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND p.active=true`,[cookie]);
  if(!r.rows[0]) return null;
  const roles=await query<{role_code:string}>('SELECT role_code FROM user_roles WHERE user_id=$1',[r.rows[0].id]);
  return {...r.rows[0],roles:roles.rows.map(x=>x.role_code)};
}
export function hasRole(actor: Actor, ...roles: string[]) { return roles.some(r=>actor.roles.includes(r)); }
export function requireRole(actor: Actor, ...roles: string[]) {
  if(!hasRole(actor,...roles)) throw new AppError('Недостаточно прав для этого действия',403);
}
export class AppError extends Error { constructor(message:string,public status=400){super(message);} }
