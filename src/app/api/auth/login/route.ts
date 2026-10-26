import {NextRequest,NextResponse} from 'next/server';
import {authenticate,startSession} from '@/lib/auth';
import {apiError,checkMutationOrigin,loginAllowed,recordLogin,readJson} from '@/lib/http-security';
export async function POST(req:NextRequest){
  try{checkMutationOrigin(req);const body=await readJson(req,4096);const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');
    if(email.length>254||password.length>1024||!email.includes('@'))return NextResponse.json({error:'Неверная почта или пароль'},{status:401});
    const ip=req.headers.get('x-real-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
    if(!await loginAllowed(email,ip))return NextResponse.json({error:'Слишком много попыток. Повторите через 15 минут'},{status:429});
    const actor=await authenticate(email,password);await recordLogin(email,ip,Boolean(actor));
    if(!actor)return NextResponse.json({error:'Неверная почта или пароль'},{status:401});await startSession(actor.id);return NextResponse.json({actor});}
  catch(e){return apiError(e,'Ошибка входа');}
}
