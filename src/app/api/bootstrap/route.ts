import {NextResponse} from 'next/server';import {currentActor} from '@/lib/auth';import {snapshot} from '@/lib/snapshot';import {apiError} from '@/lib/http-security';
export const dynamic='force-dynamic';
export async function GET(){try{const actor=await currentActor();if(!actor)return NextResponse.json({error:'Требуется вход'},{status:401});return NextResponse.json(await snapshot(actor));}catch(e){return apiError(e,'Ошибка данных');}}
