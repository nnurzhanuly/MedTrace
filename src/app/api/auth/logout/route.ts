import {NextRequest,NextResponse} from 'next/server';import {endSession} from '@/lib/auth';import {apiError,checkMutationOrigin} from '@/lib/http-security';
export async function POST(req:NextRequest){try{checkMutationOrigin(req);await endSession();return NextResponse.json({ok:true});}catch(e){return apiError(e,'Ошибка выхода');}}
