import {AppError,hasRole,type Actor} from './auth';
import {query} from './db';

const DOCUMENT_ENTITIES:Record<string,string[]>={
  lot:['admin','auditor','quality_manager','quality_specialist','warehouse','production_manager','shipping'],
  receipt:['admin','auditor','quality_manager','quality_specialist','warehouse'],
  quality_check:['admin','auditor','quality_manager','quality_specialist'],
  production_run:['admin','auditor','quality_manager','production_manager'],
  shipment:['admin','auditor','quality_manager','shipping','warehouse'],
  recall:['admin','auditor','quality_manager','shipping'],
  nonconformity:['admin','auditor','quality_manager','quality_specialist','warehouse'],
};
export async function canAccessEntity(actor:Actor,entityType:string,entityId:string,write=false):Promise<boolean>{
  if(!DOCUMENT_ENTITIES[entityType]||!entityId)return false;
  if(!write&&hasRole(actor,...DOCUMENT_ENTITIES[entityType]))return true;
  if(write&&hasRole(actor,...DOCUMENT_ENTITIES[entityType].filter(r=>r!=='auditor'&&r!=='admin'))){
    if(entityType==='quality_check')return hasRole(actor,'quality_specialist','quality_manager');
    if(entityType==='production_run')return hasRole(actor,'production_manager');
    if(entityType==='shipment'||entityType==='recall')return hasRole(actor,'shipping','warehouse','quality_manager');
    if(entityType==='receipt')return hasRole(actor,'warehouse','quality_specialist','quality_manager');
    if(entityType==='nonconformity')return hasRole(actor,'quality_specialist','quality_manager','warehouse');
    if(entityType==='lot')return true;
  }
  if(hasRole(actor,'admin')&&write)return true;
  if(!hasRole(actor,'operator')||!['production_run','lot'].includes(entityType))return false;
  const sql=entityType==='production_run'
    ?`SELECT 1 FROM production_runs pr JOIN production_orders po ON po.id=pr.order_id WHERE pr.id=$1 AND po.assigned_to=$2`
    :`SELECT 1 FROM lots l LEFT JOIN finished_lots fl ON fl.lot_id=l.id LEFT JOIN production_orders po ON po.id=fl.order_id LEFT JOIN material_reservations mr ON mr.lot_id=l.id LEFT JOIN production_orders source_po ON source_po.id=mr.order_id WHERE l.id=$1 AND (po.assigned_to=$2 OR source_po.assigned_to=$2)`;
  return (await query(sql,[entityId,actor.id])).rows.length>0;
}
export async function requireEntityAccess(actor:Actor,entityType:string,entityId:string,write=false){
  if(!await canAccessEntity(actor,entityType,entityId,write))throw new AppError('Недостаточно прав для документа',403);
}
