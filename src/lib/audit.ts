import {type Db,uid} from './db';
export async function audit(db:Db,entityType:string,entityId:string,action:string,actorId:string,oldValue:unknown,newValue:unknown,reason?:string){
  await db.query(`INSERT INTO audit_logs(id,entity_type,entity_id,action,old_value,new_value,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[uid(),entityType,entityId,action,oldValue==null?null:JSON.stringify(oldValue),newValue==null?null:JSON.stringify(newValue),actorId,reason||null]);
}
export async function status(db:Db,entityType:string,entityId:string,oldStatus:string|null,newStatus:string,actorId:string,reason?:string){
  await db.query(`INSERT INTO status_history(id,entity_type,entity_id,old_status,new_status,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,[uid(),entityType,entityId,oldStatus,newStatus,actorId,reason||null]);
  await audit(db,entityType,entityId,'status',actorId,{status:oldStatus},{status:newStatus},reason);
}
