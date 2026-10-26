import bcrypt from 'bcryptjs';
import { AppError,hasRole,requireRole,type Actor } from './auth';
import { transaction,uid,one,code,type Db } from './db';
import {audit,status} from './audit';
import {assertUsable,balance,lot,move,reserved,usableBalance,validateQuantity,warehouse} from './stock';
import {supabaseEnabled,supabaseAdmin} from './supabase';
import {createHash,randomBytes} from 'node:crypto';

type Input=Record<string,unknown>;
const str=(v:unknown,label='Поле')=>{if(typeof v!=='string'||!v.trim())throw new AppError(`${label}: обязательное поле`);return v.trim();};
const opt=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
const pos=(v:unknown)=>{const n=Number(v);if(!Number.isFinite(n)||n<=0)throw new AppError('Количество должно быть положительным');return n;};
const int=(v:unknown)=>{const n=pos(v);if(!Number.isInteger(n))throw new AppError('Количество должно быть целым');return n;};
const today=()=>new Date().toISOString().slice(0,10);
async function getStockWarehouse(db:Db,lotId:string,kind:string,needed:number){
  const r=await db.query<{warehouse_id:string;balance:string}>(`SELECT x.warehouse_id,sum(x.delta)::text AS balance FROM (SELECT to_warehouse_id warehouse_id,quantity delta FROM inventory_movements WHERE lot_id=$1 AND to_warehouse_id IS NOT NULL UNION ALL SELECT from_warehouse_id warehouse_id,-quantity delta FROM inventory_movements WHERE lot_id=$1 AND from_warehouse_id IS NOT NULL) x JOIN warehouses w ON w.id=x.warehouse_id WHERE w.kind=$2 GROUP BY x.warehouse_id HAVING sum(x.delta)>0 ORDER BY sum(x.delta) DESC`,[lotId,kind]);
  const candidate=r.rows.find(x=>Number(x.balance)>=needed);
  if(!candidate)throw new AppError('Недостаточный остаток на одном складе для операции');
  return candidate.warehouse_id;
}
async function documentSnapshot(db:Db,title:string,kind:string,entityType:string,entityId:string,snapshot:unknown,actorId:string){
  const id=uid(),vid=uid();
  await db.query('INSERT INTO documents(id,title,kind,entity_type,entity_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,title,kind,entityType,entityId,actorId]);
  await db.query('INSERT INTO document_versions(id,document_id,version_no,snapshot,created_by) VALUES($1,$2,1,$3,$4)',[vid,id,JSON.stringify(snapshot),actorId]);
  return id;
}
async function nextLotCode(db:Db,kind:'material'|'finished'){
  const r=await db.query<{n:string}>('SELECT count(*)::text n FROM lots WHERE kind=$1',[kind]);
  return `${kind==='material'?'RM':'FG'}-${new Date().getFullYear()}-${String(Number(r.rows[0].n)+1).padStart(6,'0')}`;
}
export async function executeAction(action:string,input:Input,actor:Actor,key?:string){
  if(!key || key.length<12 || key.length>120)throw new AppError('Отсутствует корректный ключ операции');
  const requestHash=createHash('sha256').update(JSON.stringify([action,input])).digest('hex');
  return transaction(async db=>{
    const existing=await db.query<{action:string;actor_id:string;request_hash:string|null;response:unknown}>('SELECT action,actor_id,request_hash,response FROM idempotency_keys WHERE key=$1',[key]);
    if(existing.rows[0]){
      if(existing.rows[0].action!==action||existing.rows[0].actor_id!==actor.id||existing.rows[0].request_hash!==requestHash)throw new AppError('Ключ операции уже использован для другого запроса',409);
      return existing.rows[0].response;
    }
    const response=await perform(db,action,input,actor);
    await db.query('INSERT INTO idempotency_keys(key,actor_id,action,request_hash,response) VALUES($1,$2,$3,$4,$5)',[key,actor.id,action,requestHash,JSON.stringify(response)]);
    return response;
  });
}
async function assertRunAccess(db:Db,orderId:string,a:Actor){
  if(a.roles.includes('production_manager'))return;
  const order=await one<{assigned_to:string|null}>(db,'SELECT assigned_to FROM production_orders WHERE id=$1',[orderId]);
  if(order.assigned_to!==a.id)throw new AppError('Запуск не назначен этому оператору',403);
}
async function perform(db:Db,action:string,x:Input,a:Actor):Promise<unknown>{
  const aid=a.id;
  switch(action){
  case 'catalog.create': {
    requireRole(a,'admin','warehouse','shipping','production_manager');
    const type=str(x.type); const id=uid();
    if(type==='supplier'){
      requireRole(a,'admin','warehouse');
      await db.query('INSERT INTO suppliers(id,code,name,contact) VALUES($1,$2,$3,$4)',[id,str(x.code,'Код'),str(x.name,'Название'),opt(x.contact)]);
    }else if(type==='customer'){
      requireRole(a,'admin','shipping');
      await db.query('INSERT INTO customers(id,code,name,address,contact) VALUES($1,$2,$3,$4,$5)',[id,str(x.code,'Код'),str(x.name,'Название'),str(x.address,'Адрес'),opt(x.contact)]);
    }else if(type==='material'){
      requireRole(a,'admin');
      const category=str(x.category); if(!['raw','component','packaging','label','other'].includes(category))throw new AppError('Неверная категория');
      await db.query('INSERT INTO materials(id,code,name,category,unit_code,requires_inspection,requires_expiry,storage_conditions) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,str(x.code),str(x.name),category,str(x.unit),Boolean(x.requiresInspection),Boolean(x.requiresExpiry),opt(x.storage)]);
    }else if(type==='product'){
      requireRole(a,'admin');
      await db.query('INSERT INTO products(id,code,name,variant,unit_code,expiry_rule,storage_conditions) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,str(x.code),str(x.name),opt(x.variant),str(x.unit),opt(x.expiryRule),opt(x.storage)]);
    }else if(type==='warehouse'){
      requireRole(a,'admin');
      const kind=str(x.kind);if(!['raw','quarantine','production','finished','blocked','returns'].includes(kind))throw new AppError('Неверный тип склада');
      await db.query('INSERT INTO warehouses(id,code,name,kind) VALUES($1,$2,$3,$4)',[id,str(x.code),str(x.name),kind]);
    }else throw new AppError('Неизвестный справочник');
    await audit(db,type,id,'create',aid,null,x); return {id};
  }
  case 'catalog.update': {
    requireRole(a,'admin','shipping');
    const type=str(x.type),id=str(x.id),expected=int(x.version);
    const fields:Record<string,string[]>={supplier:['name','contact','active'],customer:['name','address','contact','active'],material:['name','storage_conditions','active'],product:['name','variant','expiry_rule','storage_conditions','active']};
    const table:Record<string,string>={supplier:'suppliers',customer:'customers',material:'materials',product:'products'};
    if(!table[type])throw new AppError('Неверный справочник');
    if(type!=='customer')requireRole(a,'admin');
    const old=await one<Record<string,unknown>>(db,`SELECT * FROM ${table[type]} WHERE id=$1`,[id]);
    const updates:Record<string,unknown>={}; for(const f of fields[type]) if(x[f]!==undefined) updates[f]=x[f];
    const keys=Object.keys(updates); if(!keys.length)throw new AppError('Нет изменений');
    const values=keys.map(k=>updates[k]);
    const r=await db.query(`UPDATE ${table[type]} SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')},version=version+1 WHERE id=$${keys.length+1} AND version=$${keys.length+2} RETURNING *`,[...values,id,expected]);
    if(!r.rows[0])throw new AppError('Запись изменена другим пользователем. Обновите страницу',409);
    await audit(db,type,id,'update',aid,old,r.rows[0],opt(x.reason)||undefined);return {id};
  }
  case 'user.create': {
    requireRole(a,'admin'); let id=uid();const email=str(x.email).toLowerCase(),password=str(x.password); if(password.length<10)throw new AppError('Пароль не короче 10 символов');
    const roles=Array.isArray(x.roles)?x.roles.map(String):[]; if(!roles.length)throw new AppError('Выберите роль');
    const org=await one<{id:string}>(db,'SELECT id FROM organizations LIMIT 1');
    let authId:string|undefined;
    const remoteAuth=supabaseEnabled();
    if(remoteAuth){
      const created=await supabaseAdmin().auth.admin.createUser({email,password,email_confirm:true});
      if(created.error||!created.data.user)throw new AppError(`Supabase Auth: ${created.error?.message||'ошибка создания'}`);
      authId=created.data.user.id;id=authId;
    }
    try{
      const localHash=await bcrypt.hash(remoteAuth?randomBytes(32).toString('hex'):password,12);
      await db.query('INSERT INTO profiles(id,organization_id,email,name,password_hash) VALUES($1,$2,$3,$4,$5)',[id,org.id,email,str(x.name),localHash]);
      for(const role of roles)await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)',[id,role]);
      await audit(db,'profile',id,'create',aid,null,{email,name:x.name,roles});return {id};
    }catch(e){if(authId)await supabaseAdmin().auth.admin.deleteUser(authId);throw e;}
  }
  case 'user.roles': {
    requireRole(a,'admin'); const id=str(x.id);const roles=Array.isArray(x.roles)?x.roles.map(String):[]; if(!roles.length)throw new AppError('Выберите роль');
    const old=await db.query<{role_code:string}>('SELECT role_code FROM user_roles WHERE user_id=$1',[id]);
    await db.query('DELETE FROM user_roles WHERE user_id=$1',[id]);for(const role of roles)await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)',[id,role]);
    await audit(db,'profile',id,'roles',aid,old.rows.map(v=>v.role_code),roles);return {id};
  }
  case 'receipt.create': {
    requireRole(a,'warehouse');
    const supplierId=str(x.supplierId), materialId=str(x.materialId),qty=pos(x.quantity);
    const material=await one<{unit_code:string;requires_expiry:boolean}>(db,'SELECT unit_code,requires_expiry FROM materials WHERE id=$1 AND active=true',[materialId]);
    if(material.unit_code==='pcs'&&!Number.isInteger(qty))throw new AppError('Количество в штуках должно быть целым');
    if(material.requires_expiry&&!x.expiresAt)throw new AppError('Укажите срок годности');
    const id=uid(),itemId=uid(),c=await code(db,'receipts','RC');
    await db.query('INSERT INTO receipts(id,code,supplier_id,delivery_document,status,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,c,supplierId,str(x.deliveryDocument),'draft',aid]);
    await db.query('INSERT INTO receipt_items(id,receipt_id,material_id,supplier_lot_number,quantity,manufactured_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[itemId,id,materialId,str(x.supplierLot),qty,opt(x.manufacturedAt),opt(x.expiresAt)]);
    await audit(db,'receipt',id,'create',aid,null,{code:c,supplierId,itemId,materialId,quantity:qty});return {id,code:c};
  }
  case 'receipt.confirm': {
    requireRole(a,'warehouse'); const id=str(x.id);
    const receipt=await one<{id:string;code:string;status:string}>(db,'SELECT * FROM receipts WHERE id=$1',[id]);
    if(receipt.status==='confirmed')return {id,alreadyConfirmed:true};
    const items=await db.query<{id:string;material_id:string;quantity:string;expires_at:string|null;manufactured_at:string|null;supplier_lot_number:string;requires_inspection:boolean;supplier_id:string}>(`SELECT ri.*,m.requires_inspection,r.supplier_id FROM receipt_items ri JOIN materials m ON m.id=ri.material_id JOIN receipts r ON r.id=ri.receipt_id WHERE ri.receipt_id=$1`,[id]);
    const quarantine=await warehouse(db,'quarantine');
    for(const item of items.rows){
      const lotId=uid(),lc=await nextLotCode(db,'material');
      await db.query(`INSERT INTO lots(id,code,kind,material_id,supplier_id,supplier_lot_number,receipt_item_id,manufactured_at,expires_at,quality_status,public_token) VALUES($1,$2,'material',$3,$4,$5,$6,$7,$8,'quarantine',$9)`,[lotId,lc,item.material_id,item.supplier_id,item.supplier_lot_number,item.id,item.manufactured_at,item.expires_at,uid()]);
      await db.query('UPDATE receipt_items SET lot_id=$1 WHERE id=$2',[lotId,item.id]);
      await move(db,{lotId,type:'receipt',quantity:Number(item.quantity),to:quarantine,basisType:'receipt',basisId:id,actorId:aid});
      await status(db,'lot',lotId,null,'quarantine',aid,'Поступление');
    }
    await db.query(`UPDATE receipts SET status='confirmed',confirmed_by=$1,confirmed_at=now(),version=version+1 WHERE id=$2`,[aid,id]);
    await status(db,'receipt',id,'draft','confirmed',aid);
    return {id,lots:items.rows.length};
  }
  case 'quality.check': {
    requireRole(a,'quality_specialist'); const lotId=str(x.lotId),l=await lot(db,lotId);const kind=l.kind==='material'?'incoming':'finished';
    if(l.quality_status==='released'||l.quality_status==='rejected')throw new AppError('Партия уже имеет окончательное решение');
    const plans=await db.query<{id:string;checks:unknown}>(`SELECT * FROM quality_plan_versions WHERE kind=$1 AND subject_id=$2 AND status='active' ORDER BY version_no DESC LIMIT 1`,[kind,l.material_id||l.product_id]);
    const plan=plans.rows[0]; const definitions=plan?typeof plan.checks==='string'?JSON.parse(plan.checks):plan.checks:[];
    const values=typeof x.results==='object'&&x.results!==null?x.results as Record<string,unknown>:{};
    let passed=true;let lines:{key:string;value:string;passed:boolean}[]=[];
    for(const def of definitions as {key:string;label:string;type:string;required:boolean;expected?:string;min?:number;max?:number}[]){
      const val=values[def.key]; if(def.required&&(val==null||String(val).trim()===''))throw new AppError(`Заполните проверку: ${def.label}`);
      let ok=true; if(val!=null&&String(val)!==''){
        if(def.type==='number'){const n=Number(val);ok=Number.isFinite(n)&&(def.min==null||n>=def.min)&&(def.max==null||n<=def.max);}
        if(def.type==='boolean')ok=String(val)==='true';
        if(def.expected!=null)ok=String(val)===def.expected;
      }
      if(!ok)passed=false;
      lines.push({key:def.key,value:String(val??''),passed:ok});
    }
    if(!definitions.length){if(typeof x.passed!=='boolean')throw new AppError('Укажите результат проверки');passed=x.passed;lines=[{key:'result',value:str(x.summary),passed}];}
    const attempt=await db.query<{n:string}>('SELECT (count(*)+1)::text n FROM quality_checks WHERE lot_id=$1 AND kind=$2',[lotId,kind]);
    const id=uid();await db.query(`INSERT INTO quality_checks(id,lot_id,plan_version_id,kind,attempt,status,result_summary,passed,performed_by) VALUES($1,$2,$3,$4,$5,'submitted',$6,$7,$8)`,[id,lotId,plan?.id||null,kind,Number(attempt.rows[0].n),str(x.summary,'Заключение'),passed,aid]);
    for(const line of lines)await db.query('INSERT INTO quality_check_results(id,check_id,item_key,value_text,passed) VALUES($1,$2,$3,$4,$5)',[uid(),id,line.key,line.value,line.passed]);
    if(!passed){const nc=uid(),ncCode=await code(db,'nonconformities','NC');await db.query('INSERT INTO nonconformities(id,code,source_type,source_id,lot_id,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[nc,ncCode,'quality_check',id,lotId,`Неудовлетворительная проверка ${l.code}: ${str(x.summary)}`,aid]);await audit(db,'nonconformity',nc,'create',aid,null,{lotId,checkId:id});}
    await audit(db,'quality_check',id,'submit',aid,null,{lotId,kind,passed,lines});return {id,passed};
  }
  case 'quality.decide': {
    requireRole(a,'quality_manager');const lotId=str(x.lotId),decision=str(x.decision),basis=str(x.basis,'Основание');
    if(!['release','reject','additional'].includes(decision))throw new AppError('Неверное решение');
    const l=await lot(db,lotId); if(l.quality_status!=='quarantine')throw new AppError('Решение по партии уже принято');
    const material=l.kind==='material'?await one<{requires_inspection:boolean}>(db,'SELECT requires_inspection FROM materials WHERE id=$1',[l.material_id]):null;
    const checks=await db.query<{id:string;passed:boolean;performed_by:string;status:string}>(`SELECT * FROM quality_checks WHERE lot_id=$1 ORDER BY performed_at DESC LIMIT 1`,[lotId]);
    const check=checks.rows[0];
    if((l.kind==='finished'||material?.requires_inspection)&&!check)throw new AppError('Сначала выполните контроль');
    if(check?.performed_by===aid)throw new AppError('Проверяющий не может утвердить собственную проверку');
    if(decision==='release'){
      if(check&&!check.passed)throw new AppError('Нельзя разрешить партию с неудовлетворительным контролем');
      const openNc=await db.query(`SELECT id FROM nonconformities WHERE lot_id=$1 AND status!='closed' LIMIT 1`,[lotId]);if(openNc.rows.length)throw new AppError('Есть открытое несоответствие');
      const activeHolds=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL LIMIT 1',[lotId]);if(activeHolds.rows.length)throw new AppError('Есть активная блокировка');
      if(l.kind==='finished'){
        const fl=await one<{run_id:string;order_id:string}>(db,'SELECT * FROM finished_lots WHERE lot_id=$1',[lotId]);
        const order=await one<{spec_version_id:string}>(db,'SELECT spec_version_id FROM production_orders WHERE id=$1',[fl.order_id]);
        const spec=await one<{route_snapshot:unknown}>(db,'SELECT route_snapshot FROM specification_versions WHERE id=$1',[order.spec_version_id]);
        const steps=typeof spec.route_snapshot==='string'?JSON.parse(spec.route_snapshot):spec.route_snapshot as string[];
        const done=await db.query<{sequence_no:number}>('SELECT sequence_no FROM production_step_records WHERE run_id=$1',[fl.run_id]);
        if((steps as string[]).some((_,i)=>!done.rows.some(d=>d.sequence_no===i+1)))throw new AppError('Не все производственные этапы выполнены');
      }
    }
    const id=uid();await db.query('INSERT INTO quality_decisions(id,lot_id,check_id,decision,basis,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[id,lotId,check?.id||null,decision,basis,aid]);
    if(decision==='release'||decision==='reject'){
      const newStatus=decision==='release'?'released':'rejected';await db.query('UPDATE lots SET quality_status=$1,version=version+1 WHERE id=$2',[newStatus,lotId]);
      await status(db,'lot',lotId,l.quality_status,newStatus,aid,basis);
      if(decision==='release'){
        const to=await warehouse(db,l.kind==='material'?'raw':'finished');const q=await warehouse(db,'quarantine');const qty=await balance(db,lotId,q);
        if(qty>0)await move(db,{lotId,type:'quality_release_transfer',quantity:qty,from:q,to,basisType:'quality_decision',basisId:id,actorId:aid});
      }
    }else if(check) await db.query(`UPDATE quality_checks SET status='additional_requested' WHERE id=$1`,[check.id]);
    await documentSnapshot(db,`Решение о качестве ${l.code}`,'quality_decision','lot',lotId,{lot:l.code,decision,basis,checkId:check?.id||null,actor:a.name,at:new Date().toISOString()},aid);
    return {id,decision};
  }
  case 'lot.split': {
    requireRole(a,'warehouse');
    const parentId=str(x.lotId),reason=str(x.reason,'Основание разделения');
    const parent=await lot(db,parentId);
    if(parent.kind!=='material'||parent.quality_status!=='quarantine')throw new AppError('Разделить можно только входящую партию в карантине');
    const original=await db.query('SELECT id FROM receipt_items WHERE lot_id=$1',[parentId]);
    if(!original.rows.length)throw new AppError('Повторное разделение дочерней партии не поддерживается');
    const check=await db.query('SELECT id FROM quality_checks WHERE lot_id=$1 LIMIT 1',[parentId]);
    if(check.rows.length)throw new AppError('Разделение выполните до контроля исходной партии');
    const reservations=await db.query('SELECT id FROM material_reservations WHERE lot_id=$1 AND active=true LIMIT 1',[parentId]);
    if(reservations.rows.length)throw new AppError('Есть активный резерв');
    const holds=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL LIMIT 1',[parentId]);
    if(holds.rows.length)throw new AppError('Сначала рассмотрите блокировку исходной партии');
    const q=await warehouse(db,'quarantine'),total=await balance(db,parentId);
    const first=await validateQuantity(db,parentId,x.quantity);
    const second=Number((total-first).toFixed(6));
    if(total<=0||first>=total||second<=0||await balance(db,parentId,q)+1e-8<total)throw new AppError('Разделение требует полного остатка в карантине и двух положительных частей');
    const source=await one<{material_id:string;supplier_id:string|null;supplier_lot_number:string|null;manufactured_at:string|null;expires_at:string|null}>(db,'SELECT * FROM lots WHERE id=$1',[parentId]);
    const children=[];
    for(const quantity of [first,second]){
      const id=uid(),lotCode=await nextLotCode(db,'material');
      await db.query(`INSERT INTO lots(id,code,kind,material_id,supplier_id,supplier_lot_number,parent_lot_id,manufactured_at,expires_at,quality_status,public_token) VALUES($1,$2,'material',$3,$4,$5,$6,$7,$8,'quarantine',$9)`,[id,lotCode,source.material_id,source.supplier_id,source.supplier_lot_number,parentId,source.manufactured_at,source.expires_at,uid()]);
      await move(db,{lotId:parentId,type:'split_out',quantity,from:q,basisType:'lot_split',basisId:id,actorId:aid});
      await move(db,{lotId:id,type:'split_in',quantity,to:q,basisType:'lot_split',basisId:id,actorId:aid});
      await status(db,'lot',id,null,'quarantine',aid,reason);
      children.push({id,code:lotCode,quantity});
    }
    await documentSnapshot(db,`Разделение ${parent.code}`,'lot_split','lot',parentId,{parentId,parentCode:parent.code,reason,children,actor:a.name,at:new Date().toISOString()},aid);
    await audit(db,'lot',parentId,'split',aid,{quantity:total},{children},reason);
    return {parentId,children};
  }
  case 'spec.create': {
    requireRole(a,'production_manager');const productId=str(x.productId),base=pos(x.baseQuantity),items=Array.isArray(x.items)?x.items:[],route=Array.isArray(x.route)?x.route.map(String).filter(Boolean):[];
    if(!items.length||!route.length)throw new AppError('Нужны материалы и этапы');
    const product=await one<{unit_code:string}>(db,'SELECT unit_code FROM products WHERE id=$1',[productId]);
    const specId=uid(),versionId=uid();await db.query('INSERT INTO specifications(id,product_id,code,name) VALUES($1,$2,$3,$4)',[specId,productId,str(x.code),str(x.name)]);
    await db.query(`INSERT INTO specification_versions(id,specification_id,version_no,status,base_quantity,unit_code,route_snapshot) VALUES($1,$2,1,'draft',$3,$4,$5)`,[versionId,specId,base,product.unit_code,JSON.stringify(route)]);
    const seen=new Set<string>();for(const raw of items){const item=raw as Record<string,unknown>,materialId=str(item.materialId);if(seen.has(materialId))throw new AppError('Материал повторяется в спецификации');seen.add(materialId);const m=await one<{unit_code:string}>(db,'SELECT unit_code FROM materials WHERE id=$1',[materialId]);
      const tolerance=item.tolerancePercent==null?null:Number(item.tolerancePercent);if(tolerance!==null&&(!Number.isFinite(tolerance)||tolerance<0||tolerance>100))throw new AppError('Допуск должен быть от 0 до 100%');
      await db.query('INSERT INTO specification_items(id,version_id,material_id,quantity,unit_code,tolerance_percent) VALUES($1,$2,$3,$4,$5,$6)',[uid(),versionId,materialId,pos(item.quantity),m.unit_code,tolerance]);}
    await audit(db,'specification',specId,'create',aid,null,{productId,versionId,items,route});return {id:specId,versionId};
  }
  case 'spec.newVersion': {
    requireRole(a,'production_manager');const specId=str(x.id),base=pos(x.baseQuantity),items=Array.isArray(x.items)?x.items:[],route=Array.isArray(x.route)?x.route.map(String).filter(Boolean):[];
    if(!items.length||!route.length)throw new AppError('Нужны материалы и этапы');
    const prev=await one<{version_no:number;unit_code:string}>(db,'SELECT version_no,unit_code FROM specification_versions WHERE specification_id=$1 ORDER BY version_no DESC LIMIT 1',[specId]);
    const id=uid();await db.query(`INSERT INTO specification_versions(id,specification_id,version_no,status,base_quantity,unit_code,route_snapshot) VALUES($1,$2,$3,'draft',$4,$5,$6)`,[id,specId,prev.version_no+1,base,prev.unit_code,JSON.stringify(route)]);
    const seen=new Set<string>();for(const raw of items){const item=raw as Record<string,unknown>,materialId=str(item.materialId);if(seen.has(materialId))throw new AppError('Материал повторяется в спецификации');seen.add(materialId);const m=await one<{unit_code:string}>(db,'SELECT unit_code FROM materials WHERE id=$1',[materialId]);const tolerance=item.tolerancePercent==null?null:Number(item.tolerancePercent);if(tolerance!==null&&(!Number.isFinite(tolerance)||tolerance<0||tolerance>100))throw new AppError('Допуск должен быть от 0 до 100%');await db.query('INSERT INTO specification_items(id,version_id,material_id,quantity,unit_code,tolerance_percent) VALUES($1,$2,$3,$4,$5,$6)',[uid(),id,materialId,pos(item.quantity),m.unit_code,tolerance]);}
    await audit(db,'specification_version',id,'create',aid,null,{specId,version:prev.version_no+1,items,route});return {id};
  }
  case 'spec.submit': case 'spec.approve': {
    requireRole(a,action==='spec.submit'?'production_manager':'quality_manager');const id=str(x.id),v=await one<{status:string;specification_id:string}>(db,'SELECT * FROM specification_versions WHERE id=$1',[id]);
    if(action==='spec.submit'&&v.status!=='draft'||action==='spec.approve'&&v.status!=='review')throw new AppError('Неверный статус версии');
    const next=action==='spec.submit'?'review':'active';
    if(next==='active'){
      await db.query(`UPDATE specification_versions SET status='archived' WHERE specification_id=$1 AND status='active'`,[v.specification_id]);
      await db.query(`UPDATE specification_versions SET status='active',approved_by=$1,approved_at=now() WHERE id=$2`,[aid,id]);
    }else await db.query('UPDATE specification_versions SET status=$1 WHERE id=$2',[next,id]);
    await status(db,'specification_version',id,v.status,next,aid);return {id,status:next};
  }
  case 'order.create': {
    requireRole(a,'production_manager');const versionId=str(x.specVersionId),qty=pos(x.quantity);
    const v=await one<{status:string;product_id:string;unit_code:string}>(db,`SELECT sv.status,s.product_id,sv.unit_code FROM specification_versions sv JOIN specifications s ON s.id=sv.specification_id WHERE sv.id=$1`,[versionId]);
    if(v.status!=='active')throw new AppError('Спецификация не действует');
    const unit=await one<{whole_only:boolean}>(db,'SELECT whole_only FROM units WHERE code=$1',[v.unit_code]);if(unit.whole_only&&!Number.isInteger(qty))throw new AppError('Изделия учитываются целыми штуками');
    const id=uid(),c=await code(db,'production_orders','PO');await db.query(`INSERT INTO production_orders(id,code,product_id,spec_version_id,planned_quantity,line,assigned_to,status,planned_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'planned',$8,$9)`,[id,c,v.product_id,versionId,qty,str(x.line),opt(x.assignedTo),opt(x.plannedDate),aid]);
    await status(db,'production_order',id,null,'planned',aid);return {id,code:c};
  }
  case 'order.reserve': {
    requireRole(a,'production_manager');const id=str(x.id),o=await one<{status:string;spec_version_id:string;planned_quantity:string}>(db,'SELECT * FROM production_orders WHERE id=$1',[id]);
    if(o.status!=='planned')throw new AppError('Резервирование возможно для запланированного заказа');
    const spec=await one<{base_quantity:string}>(db,'SELECT base_quantity FROM specification_versions WHERE id=$1',[o.spec_version_id]);
    const items=await db.query<{material_id:string;quantity:string}>(`SELECT material_id,quantity FROM specification_items WHERE version_id=$1`,[o.spec_version_id]);
    const selections=Array.isArray(x.selections)?x.selections as {lotId:string;quantity:unknown}[]:[];
    for(const item of items.rows){
      const need=Number(item.quantity)*Number(o.planned_quantity)/Number(spec.base_quantity);
      const chosen=selections.filter(s=>s.lotId);let selected=0;
      for(const s of chosen){const l=await lot(db,s.lotId);if(l.material_id!==item.material_id)continue;selected+=await validateQuantity(db,s.lotId,s.quantity);}
      if(Math.abs(selected-need)>0.000001)throw new AppError(`Потребность материала: ${need}; выбрано ${selected}`);
    }
    for(const s of selections){const qty=await validateQuantity(db,s.lotId,s.quantity);const l=await lot(db,s.lotId);if(!items.rows.some(i=>i.material_id===l.material_id))throw new AppError('Партия отсутствует в спецификации');
      await assertUsable(db,s.lotId,'material',qty);
      await db.query('INSERT INTO material_reservations(id,order_id,lot_id,quantity) VALUES($1,$2,$3,$4)',[uid(),id,s.lotId,qty]);}
    await db.query(`UPDATE production_orders SET status='reserved',version=version+1 WHERE id=$1`,[id]);await status(db,'production_order',id,'planned','reserved',aid);return {id};
  }
  case 'order.cancel': {
    requireRole(a,'production_manager');const id=str(x.id),o=await one<{status:string}>(db,'SELECT status FROM production_orders WHERE id=$1',[id]);
    if(['closed','cancelled','production_complete'].includes(o.status))throw new AppError('Заказ нельзя отменить');
    const runs=await db.query('SELECT id FROM production_runs WHERE order_id=$1 LIMIT 1',[id]);if(runs.rows.length)throw new AppError('Запуск уже создан. Заказ нельзя отменить без урегулирования производства');
    const consumed=await db.query('SELECT id FROM material_consumptions WHERE order_id=$1 LIMIT 1',[id]);if(consumed.rows.length)throw new AppError('Материал уже израсходован. Требуется отдельное урегулирование');
    await db.query('UPDATE material_reservations SET active=false WHERE order_id=$1',[id]);await db.query(`UPDATE production_orders SET status='cancelled' WHERE id=$1`,[id]);await status(db,'production_order',id,o.status,'cancelled',aid);return {id};
  }
  case 'run.create': {
    requireRole(a,'production_manager','operator');const orderId=str(x.orderId),o=await one<{status:string;assigned_to:string|null}>(db,'SELECT * FROM production_orders WHERE id=$1',[orderId]);
    if(!['reserved','in_progress'].includes(o.status))throw new AppError('Сначала зарезервируйте материалы');
    await assertRunAccess(db,orderId,a);
    const id=uid(),c=await code(db,'production_runs','RUN');await db.query(`INSERT INTO production_runs(id,order_id,code,status,created_by) VALUES($1,$2,$3,'in_progress',$4)`,[id,orderId,c,aid]);
    if(o.status!=='in_progress'){await db.query(`UPDATE production_orders SET status='in_progress' WHERE id=$1`,[orderId]);await status(db,'production_order',orderId,o.status,'in_progress',aid);}
    await audit(db,'production_run',id,'create',aid,null,{orderId,code:c});return {id,code:c};
  }
  case 'run.consume': {
    requireRole(a,'operator','production_manager');const runId=str(x.runId),lotId=str(x.lotId),run=await one<{order_id:string;status:string}>(db,'SELECT * FROM production_runs WHERE id=$1',[runId]);
    await assertRunAccess(db,run.order_id,a);if(run.status!=='in_progress')throw new AppError('Запуск завершён');const qty=await validateQuantity(db,lotId,x.quantity);
    const reservation=await one<{id:string;quantity:string;consumed_quantity:string;active:boolean}>(db,'SELECT * FROM material_reservations WHERE order_id=$1 AND lot_id=$2',[run.order_id,lotId]);
    if(!reservation.active||Number(reservation.quantity)-Number(reservation.consumed_quantity)+1e-8<qty)throw new AppError('Расход превышает резерв');
    await assertUsable(db,lotId,'material',qty,true);
    const from=await getStockWarehouse(db,lotId,'raw',qty);const id=uid(),unit=await one<{unit_code:string}>(db,'SELECT m.unit_code FROM lots l JOIN materials m ON m.id=l.material_id WHERE l.id=$1',[lotId]);
    await db.query('INSERT INTO material_consumptions(id,run_id,order_id,lot_id,quantity,unit_code,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,runId,run.order_id,lotId,qty,unit.unit_code,aid,opt(x.reason)]);
    await db.query('UPDATE material_reservations SET consumed_quantity=consumed_quantity+$1 WHERE id=$2',[qty,reservation.id]);
    await move(db,{lotId,type:'consumption',quantity:qty,from,basisType:'material_consumption',basisId:id,actorId:aid});
    await audit(db,'material_consumption',id,'create',aid,null,{runId,lotId,quantity:qty});return {id};
  }
  case 'run.step': {
    requireRole(a,'operator','production_manager');const runId=str(x.runId),run=await one<{status:string;order_id:string}>(db,'SELECT * FROM production_runs WHERE id=$1',[runId]);await assertRunAccess(db,run.order_id,a);if(run.status!=='in_progress')throw new AppError('Запуск завершён');
    const o=await one<{spec_version_id:string}>(db,'SELECT spec_version_id FROM production_orders WHERE id=$1',[run.order_id]);const spec=await one<{route_snapshot:unknown}>(db,'SELECT route_snapshot FROM specification_versions WHERE id=$1',[o.spec_version_id]);
    const route=typeof spec.route_snapshot==='string'?JSON.parse(spec.route_snapshot) as string[]:spec.route_snapshot as string[];
    const done=await db.query<{n:string}>('SELECT count(*)::text n FROM production_step_records WHERE run_id=$1',[runId]);const index=Number(done.rows[0].n);
    if(index>=route.length)throw new AppError('Все этапы уже подтверждены');
    const id=uid();await db.query('INSERT INTO production_step_records(id,run_id,sequence_no,name,started_at,result,equipment,comment,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,runId,index+1,route[index],opt(x.startedAt)||new Date().toISOString(),JSON.stringify(x.result||{}),opt(x.equipment),opt(x.comment),aid]);
    await audit(db,'production_step',id,'complete',aid,null,{runId,sequence:index+1,name:route[index]});return {id,next:route[index+1]||null};
  }
  case 'run.finish': {
    requireRole(a,'production_manager','operator');const runId=str(x.runId),run=await one<{status:string;order_id:string}>(db,'SELECT * FROM production_runs WHERE id=$1',[runId]);await assertRunAccess(db,run.order_id,a);if(run.status!=='in_progress')throw new AppError('Запуск уже завершён');
    const o=await one<{spec_version_id:string;product_id:string;planned_quantity:string;status:string}>(db,'SELECT * FROM production_orders WHERE id=$1',[run.order_id]);
    const spec=await one<{route_snapshot:unknown}>(db,'SELECT route_snapshot FROM specification_versions WHERE id=$1',[o.spec_version_id]);const route=typeof spec.route_snapshot==='string'?JSON.parse(spec.route_snapshot) as string[]:spec.route_snapshot as string[];
    const done=await db.query<{n:string}>('SELECT count(*)::text n FROM production_step_records WHERE run_id=$1',[runId]);if(Number(done.rows[0].n)!==route.length)throw new AppError('Завершите все обязательные этапы');
    const manufactured=int(x.manufactured),scrap=x.scrap==null?0:Number(x.scrap),quarantine=int(x.quarantine);
    if(!Number.isInteger(scrap)||scrap<0||manufactured!==quarantine+scrap)throw new AppError('Изготовлено = карантин + брак');
    const required=await db.query<{material_id:string;quantity:string;tolerance_percent:string|null;base_quantity:string}>(`SELECT si.material_id,si.quantity::text,si.tolerance_percent::text,sv.base_quantity::text FROM specification_items si JOIN specification_versions sv ON sv.id=si.version_id WHERE si.version_id=$1`,[o.spec_version_id]);
    const consumed=await db.query<{material_id:string;quantity:string}>(`SELECT l.material_id,COALESCE(sum(mc.quantity),0)::text quantity FROM material_consumptions mc JOIN lots l ON l.id=mc.lot_id WHERE mc.run_id=$1 GROUP BY l.material_id`,[runId]);
    for(const item of required.rows){const target=Number(item.quantity)*manufactured/Number(item.base_quantity),actual=Number(consumed.rows.find(c=>c.material_id===item.material_id)?.quantity||0),tolerance=Number(item.tolerance_percent||0)/100;
      if(actual+1e-6<target*(1-tolerance)||actual-1e-6>target*(1+tolerance))throw new AppError('Расход материалов не соответствует спецификации');}
    const totals=await db.query<{n:string}>(`SELECT COALESCE(sum(fl.manufactured_quantity),0)::text n FROM finished_lots fl WHERE fl.order_id=$1`,[run.order_id]);
    if(Number(totals.rows[0].n)+manufactured>Number(o.planned_quantity))throw new AppError('Выпуск превышает план заказа');
    const expiry=opt(x.expiresAt),basis=opt(x.expiryBasis);const product=await one<{expiry_rule:string|null}>(db,'SELECT expiry_rule FROM products WHERE id=$1',[o.product_id]);
    if(product.expiry_rule&&!expiry)throw new AppError('Укажите срок годности по правилу предприятия');
    if(expiry&&!basis)throw new AppError('Укажите основание срока годности');
    const lotId=uid(),lc=await nextLotCode(db,'finished');await db.query(`INSERT INTO lots(id,code,kind,product_id,production_run_id,manufactured_at,expires_at,expiry_basis,quality_status,public_token) VALUES($1,$2,'finished',$3,$4,$5,$6,$7,'quarantine',$8)`,[lotId,lc,o.product_id,runId,today(),expiry,basis,uid()]);
    await db.query('INSERT INTO finished_lots(lot_id,run_id,order_id,spec_version_id,manufactured_quantity,scrap_quantity,quarantine_quantity) VALUES($1,$2,$3,$4,$5,$6,$7)',[lotId,runId,run.order_id,o.spec_version_id,manufactured,scrap,quarantine]);
    await move(db,{lotId,type:'production_receipt',quantity:quarantine,to:await warehouse(db,'quarantine'),basisType:'production_run',basisId:runId,actorId:aid});
    await db.query(`UPDATE production_runs SET status='completed',completed_at=now() WHERE id=$1`,[runId]);await status(db,'lot',lotId,null,'quarantine',aid,'Выпуск из производства');
    await documentSnapshot(db,`Производственная запись ${lc}`,'batch_record','lot',lotId,{runId,orderId:run.order_id,specVersionId:o.spec_version_id,manufactured,scrap,quarantine,consumptions:await db.query('SELECT * FROM material_consumptions WHERE run_id=$1',[runId]),steps:await db.query('SELECT * FROM production_step_records WHERE run_id=$1 ORDER BY sequence_no',[runId])},aid);
    return {id:lotId,code:lc};
  }
  case 'order.complete': {
    requireRole(a,'production_manager');const id=str(x.id),o=await one<{status:string}>(db,'SELECT status FROM production_orders WHERE id=$1',[id]);if(o.status!=='in_progress')throw new AppError('Заказ не в работе');
    const open=await db.query(`SELECT id FROM production_runs WHERE order_id=$1 AND status!='completed' LIMIT 1`,[id]);if(open.rows.length)throw new AppError('Есть незавершённые запуски');
    await db.query('UPDATE material_reservations SET active=false WHERE order_id=$1',[id]);await db.query(`UPDATE production_orders SET status='production_complete' WHERE id=$1`,[id]);await status(db,'production_order',id,o.status,'production_complete',aid);return {id};
  }
  case 'shipment.create': {
    requireRole(a,'shipping');const customerId=str(x.customerId),customer=await one<{address:string}>(db,'SELECT address FROM customers WHERE id=$1 AND active=true',[customerId]);
    const id=uid(),c=await code(db,'shipments','SH');await db.query(`INSERT INTO shipments(id,code,customer_id,address_snapshot,customer_order,ship_date,status,created_by) VALUES($1,$2,$3,$4,$5,$6,'draft',$7)`,[id,c,customerId,opt(x.address)||customer.address,opt(x.customerOrder),opt(x.shipDate),aid]);
    await status(db,'shipment',id,null,'draft',aid);return {id,code:c};
  }
  case 'shipment.allocate': {
    requireRole(a,'shipping','warehouse');const id=str(x.id),lotId=str(x.lotId),shipment=await one<{status:string}>(db,'SELECT status FROM shipments WHERE id=$1',[id]);
    if(!['draft','picking'].includes(shipment.status))throw new AppError('Отгрузку уже нельзя изменить');
    const qty=await validateQuantity(db,lotId,x.quantity),l=await lot(db,lotId);if(l.kind!=='finished')throw new AppError('Выберите готовую партию');
    const itemId=uid();await db.query('INSERT INTO shipment_items(id,shipment_id,product_id,quantity) VALUES($1,$2,$3,$4)',[itemId,id,l.product_id,qty]);
    await db.query('INSERT INTO shipment_lot_allocations(id,shipment_item_id,lot_id,quantity) VALUES($1,$2,$3,$4)',[uid(),itemId,lotId,qty]);
    if(shipment.status==='draft'){await db.query(`UPDATE shipments SET status='picking' WHERE id=$1`,[id]);await status(db,'shipment',id,'draft','picking',aid);}
    await audit(db,'shipment',id,'allocate',aid,null,{lotId,quantity:qty});return {id,itemId};
  }
  case 'shipment.confirm': {
    requireRole(a,'warehouse');const id=str(x.id),shipment=await one<{status:string;customer_id:string;code:string;address_snapshot:string;customer_name_snapshot:string|null}>(db,'SELECT * FROM shipments WHERE id=$1',[id]);
    if(shipment.status==='shipped')return {id,alreadyShipped:true};
    if(shipment.status!=='picking'&&shipment.status!=='ready')throw new AppError('Отгрузка не готова');
    const allocations=await db.query<{id:string;lot_id:string;quantity:string;product_id:string;item_id:string}>(`SELECT a.id,a.lot_id,a.quantity,si.product_id,si.id item_id FROM shipment_lot_allocations a JOIN shipment_items si ON si.id=a.shipment_item_id WHERE si.shipment_id=$1`,[id]);
    if(!allocations.rows.length)throw new AppError('Нет распределённых партий');
    const customer=await one<{name:string}>(db,'SELECT name FROM customers WHERE id=$1',[shipment.customer_id]);
    const total=new Map<string,number>();for(const row of allocations.rows)total.set(row.lot_id,(total.get(row.lot_id)||0)+Number(row.quantity));
    const sourceWarehouses=new Map<string,string>();
    for(const [lotId,qty] of total){await assertUsable(db,lotId,'finished',qty);sourceWarehouses.set(lotId,await getStockWarehouse(db,lotId,'finished',qty));}
    for(const row of allocations.rows)await move(db,{lotId:row.lot_id,type:'shipment',quantity:Number(row.quantity),from:sourceWarehouses.get(row.lot_id),basisType:'shipment',basisId:id,actorId:aid});
    await db.query(`UPDATE shipments SET status='shipped',customer_name_snapshot=$1,confirmed_by=$2,confirmed_at=now(),version=version+1 WHERE id=$3`,[customer.name,aid,id]);
    await status(db,'shipment',id,shipment.status,'shipped',aid);
    await documentSnapshot(db,`Накладная ${shipment.code}`,'shipment','shipment',id,{code:shipment.code,customer:customer.name,address:shipment.address_snapshot,allocations:allocations.rows,confirmedAt:new Date().toISOString()},aid);
    return {id,allocations:allocations.rows.length};
  }
  case 'hold.place': {
    requireRole(a,'quality_manager');const lotId=str(x.lotId),l=await lot(db,lotId),reason=str(x.reason,'Причина');
    const holdId=uid();await db.query('INSERT INTO lot_holds(id,lot_id,reason,placed_by) VALUES($1,$2,$3,$4)',[holdId,lotId,reason,aid]);
    const affected:string[]=[];
    if(l.kind==='material'){
      const family=await db.query<{id:string}>(`WITH RECURSIVE family(id) AS (SELECT $1::text UNION ALL SELECT l.id FROM lots l JOIN family f ON l.parent_lot_id=f.id) SELECT id FROM family`,[lotId]);
      const materialIds=family.rows.map(r=>r.id);
      for(const child of materialIds.filter(id=>id!==lotId)){
        const existing=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL',[child]);
        if(!existing.rows.length)await db.query('INSERT INTO lot_holds(id,lot_id,reason,source_lot_id,protective,placed_by) VALUES($1,$2,$3,$4,true,$5)',[uid(),child,`Дочерняя партия ${l.code}: ${reason}`,lotId,aid]);
      }
      const rs=await db.query<{lot_id:string}>(`SELECT DISTINCT fl.lot_id FROM material_consumptions mc JOIN finished_lots fl ON fl.run_id=mc.run_id WHERE mc.lot_id=ANY($1::text[])`,[materialIds]);
      for(const row of rs.rows){
        const exists=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND source_lot_id=$2 AND released_at IS NULL',[row.lot_id,lotId]);
        if(!exists.rows.length)await db.query('INSERT INTO lot_holds(id,lot_id,reason,source_lot_id,protective,placed_by) VALUES($1,$2,$3,$4,true,$5)',[uid(),row.lot_id,`Защитная блокировка: ${l.code}. ${reason}`,lotId,aid]);
        affected.push(row.lot_id);
      }
    }
    const orders=await db.query<{order_id:string}>(`WITH RECURSIVE family(id) AS (SELECT $1::text UNION ALL SELECT l.id FROM lots l JOIN family f ON l.parent_lot_id=f.id) SELECT DISTINCT order_id FROM material_reservations WHERE lot_id IN (SELECT id FROM family) AND active=true`,[lotId]);
    const shipments=await db.query<{shipment_id:string}>(`SELECT DISTINCT si.shipment_id FROM shipment_lot_allocations a JOIN shipment_items si ON si.id=a.shipment_item_id WHERE a.lot_id=ANY($1::text[])`,[[lotId,...affected]]);
    const managers=await db.query<{user_id:string}>(`SELECT user_id FROM user_roles WHERE role_code='quality_manager'`);
    for(const manager of managers.rows)await db.query('INSERT INTO notifications(id,user_id,title,body) VALUES($1,$2,$3,$4)',[uid(),manager.user_id,`Оценка блокировки ${l.code}`,`Затронуты партии: ${affected.length}, заказы: ${orders.rows.length}, отгрузки: ${shipments.rows.length}`]);
    await audit(db,'lot_hold',holdId,'place',aid,null,{lotId,reason,affected,orders:orders.rows,shipments:shipments.rows});return {id:holdId,affected,orders:orders.rows,shipments:shipments.rows};
  }
  case 'hold.release': {
    requireRole(a,'quality_manager');const id=str(x.id),reason=str(x.reason,'Основание'),h=await one<{lot_id:string;source_lot_id:string|null;protective:boolean;released_at:string|null}>(db,'SELECT * FROM lot_holds WHERE id=$1',[id]);
    if(h.released_at)return {id,alreadyReleased:true};
    if(h.protective&&h.source_lot_id){const recall=await db.query(`SELECT id FROM recall_campaigns WHERE source_lot_id=$1 AND status='open' LIMIT 1`,[h.source_lot_id]);if(recall.rows.length)throw new AppError('Блокировку отзыва можно снять после закрытия кампании');}
    if(h.source_lot_id&&h.source_lot_id!==h.lot_id){const source=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND id<>$2 AND released_at IS NULL LIMIT 1',[h.source_lot_id,id]);if(source.rows.length)throw new AppError('Сначала снимите блокировку исходной партии');}
    await db.query('UPDATE lot_holds SET released_by=$1,released_at=now(),release_reason=$2 WHERE id=$3',[aid,reason,id]);await audit(db,'lot_hold',id,'release',aid,{released_at:null},{reason},reason);return {id};
  }
  case 'nonconformity.create': {
    requireRole(a,'quality_specialist','quality_manager','operator','warehouse');const id=uid(),c=await code(db,'nonconformities','NC');
    const sourceType=str(x.sourceType),lotId=opt(x.lotId),severity=opt(x.severity)||'medium';
    if(!['receipt','quality_check','production','lot','customer_return','supplier_report'].includes(sourceType)||!['low','medium','high'].includes(severity))throw new AppError('Неверный источник или срочность');
    if(a.roles.includes('operator')&&!hasRole(a,'quality_specialist','quality_manager','warehouse')){
      if(!lotId)throw new AppError('Укажите партию назначенного заказа');
      const assigned=await db.query(`SELECT 1 FROM lots l LEFT JOIN finished_lots fl ON fl.lot_id=l.id LEFT JOIN production_orders po ON po.id=fl.order_id LEFT JOIN material_reservations mr ON mr.lot_id=l.id LEFT JOIN production_orders source_po ON source_po.id=mr.order_id WHERE l.id=$1 AND (po.assigned_to=$2 OR source_po.assigned_to=$2) LIMIT 1`,[lotId,aid]);
      if(!assigned.rows.length)throw new AppError('Партия не относится к назначенному заказу',403);
    }
    await db.query('INSERT INTO nonconformities(id,code,source_type,source_id,lot_id,description,category,severity,owner_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,c,sourceType,opt(x.sourceId),lotId,str(x.description),opt(x.category)||'quality',severity,opt(x.ownerId),aid]);
    await audit(db,'nonconformity',id,'create',aid,null,x);return {id,code:c};
  }
  case 'nonconformity.update': {
    requireRole(a,'quality_manager');const id=str(x.id),n=await one<{status:string}>(db,'SELECT status FROM nonconformities WHERE id=$1',[id]);
    const next=str(x.status),allowed:Record<string,string[]>={open:['review'],review:['decided'],decided:['actions_done'],actions_done:['closed'],closed:[]};
    if(!allowed[n.status]?.includes(next))throw new AppError('Неверный переход статуса');
    if(next==='closed'&&!x.resolution)throw new AppError('Укажите решение');
    await db.query('UPDATE nonconformities SET status=$1,resolution=COALESCE($2,resolution) WHERE id=$3',[next,opt(x.resolution),id]);await status(db,'nonconformity',id,n.status,next,aid,opt(x.resolution)||undefined);return {id};
  }
  case 'recall.create': {
    requireRole(a,'quality_manager');const sourceId=str(x.sourceLotId),l=await lot(db,sourceId);const reason=str(x.reason),plan=str(x.actionPlan);
    const materialIds=l.kind==='material'?(await db.query<{id:string}>(`WITH RECURSIVE family(id) AS (SELECT $1::text UNION ALL SELECT child.id FROM lots child JOIN family f ON child.parent_lot_id=f.id) SELECT id FROM family`,[sourceId])).rows.map(r=>r.id):[];
    const affected=l.kind==='finished'?[sourceId]:(await db.query<{lot_id:string}>(`SELECT DISTINCT fl.lot_id FROM material_consumptions mc JOIN finished_lots fl ON fl.run_id=mc.run_id WHERE mc.lot_id=ANY($1::text[])`,[materialIds])).rows.map(r=>r.lot_id);
    const id=uid(),c=await code(db,'recall_campaigns','RE');await db.query(`INSERT INTO recall_campaigns(id,code,source_lot_id,reason,action_plan,status,owner_id) VALUES($1,$2,$3,$4,$5,'open',$6)`,[id,c,sourceId,reason,plan,aid]);
    for(const materialId of materialIds){
      await db.query('INSERT INTO lot_holds(id,lot_id,reason,source_lot_id,protective,placed_by) VALUES($1,$2,$3,$4,true,$5)',[uid(),materialId,`Отзыв ${c}: ${reason}`,sourceId,aid]);
    }
    for(const lotId of affected){
      await db.query('INSERT INTO recall_affected_lots(recall_id,lot_id) VALUES($1,$2)',[id,lotId]);
      await db.query('INSERT INTO lot_holds(id,lot_id,reason,source_lot_id,protective,placed_by) VALUES($1,$2,$3,$4,true,$5)',[uid(),lotId,`Отзыв ${c}: ${reason}`,sourceId,aid]);
      const shipped=await db.query<{shipment_id:string}>(`SELECT DISTINCT si.shipment_id FROM shipment_lot_allocations sa JOIN shipment_items si ON si.id=sa.shipment_item_id JOIN shipments s ON s.id=si.shipment_id WHERE sa.lot_id=$1 AND s.status='shipped'`,[lotId]);
      for(const row of shipped.rows)await db.query(`INSERT INTO recall_customer_actions(id,recall_id,shipment_id,lot_id,status,actor_id) VALUES($1,$2,$3,$4,'pending',$5)`,[uid(),id,row.shipment_id,lotId,aid]);
    }
    await audit(db,'recall',id,'create',aid,null,{sourceId,reason,affected});return {id,code:c,affected};
  }
  case 'recall.action': {
    requireRole(a,'quality_manager','shipping');const id=str(x.id),r=await one<{status:string;recall_id:string;shipment_id:string;lot_id:string;returned_quantity:string}>(db,'SELECT * FROM recall_customer_actions WHERE id=$1',[id]);
    const next=str(x.status),allowed:Record<string,string[]>={pending:['notified'],notified:['confirmed','returned'],confirmed:['returned','resolved'],returned:['resolved'],resolved:[]};
    if(!allowed[r.status]?.includes(next))throw new AppError('Неверный этап работы с клиентом');
    const shipped=await db.query<{quantity:string}>(`SELECT COALESCE(sum(sa.quantity),0)::text quantity FROM shipment_lot_allocations sa JOIN shipment_items si ON si.id=sa.shipment_item_id WHERE si.shipment_id=$1 AND sa.lot_id=$2`,[r.shipment_id,r.lot_id]);
    const confirmed=x.confirmedQuantity==null?0:Number(x.confirmedQuantity);if(!Number.isFinite(confirmed)||confirmed<0||confirmed>Number(shipped.rows[0].quantity))throw new AppError('Подтверждённое количество больше отгруженного');
    if(next==='returned'&&Number(r.returned_quantity)<=0)throw new AppError('Сначала оформите фактический возврат');
    await db.query(`UPDATE recall_customer_actions SET status=$1,note=$2,notified_at=CASE WHEN $1='notified' THEN now() ELSE notified_at END,confirmed_quantity=CASE WHEN $1='confirmed' THEN $3 ELSE confirmed_quantity END,actor_id=$4,updated_at=now() WHERE id=$5`,[next,opt(x.note),confirmed,aid,id]);
    await status(db,'recall_customer_action',id,r.status,next,aid,opt(x.note)||undefined);return {id};
  }
  case 'recall.close': {
    requireRole(a,'quality_manager');const id=str(x.id),r=await one<{status:string}>(db,'SELECT status FROM recall_campaigns WHERE id=$1',[id]);if(r.status!=='open')throw new AppError('Кампания уже закрыта');
    const actions=await db.query<{status:string;quantity:string;returned_quantity:string}>(`SELECT rca.status,COALESCE(sum(sa.quantity),0)::text quantity,rca.returned_quantity::text FROM recall_customer_actions rca JOIN shipment_items si ON si.shipment_id=rca.shipment_id JOIN shipment_lot_allocations sa ON sa.shipment_item_id=si.id AND sa.lot_id=rca.lot_id WHERE rca.recall_id=$1 GROUP BY rca.id`,[id]);
    const unresolved=actions.rows.reduce((s,row)=>s+Math.max(0,Number(row.quantity)-Number(row.returned_quantity)),0);
    if(unresolved>0&&!x.unresolvedExplanation)throw new AppError('Объясните неурегулированное количество');
    const decision=str(x.finalDecision);await db.query(`UPDATE recall_campaigns SET status='closed',final_decision=$1,unresolved_explanation=$2,closed_at=now() WHERE id=$3`,[decision,opt(x.unresolvedExplanation),id]);
    await status(db,'recall',id,'open','closed',aid,decision);await documentSnapshot(db,`Итог отзыва ${id}`,'recall','recall',id,{finalDecision:decision,unresolved,unresolvedExplanation:x.unresolvedExplanation,actions:actions.rows},aid);return {id,unresolved};
  }
  case 'return.create': {
    requireRole(a,'warehouse');const shipmentId=str(x.shipmentId),lotId=str(x.lotId),qty=await validateQuantity(db,lotId,x.quantity),reason=str(x.reason);
    const shipped=await db.query<{quantity:string}>(`SELECT COALESCE(sum(sa.quantity),0)::text quantity FROM shipment_lot_allocations sa JOIN shipment_items si ON si.id=sa.shipment_item_id JOIN shipments s ON s.id=si.shipment_id WHERE s.id=$1 AND s.status='shipped' AND sa.lot_id=$2`,[shipmentId,lotId]);
    const returned=await db.query<{quantity:string}>(`SELECT COALESCE(sum(ri.quantity),0)::text quantity FROM return_items ri JOIN customer_returns cr ON cr.id=ri.return_id WHERE cr.shipment_id=$1 AND ri.lot_id=$2`,[shipmentId,lotId]);
    if(Number(shipped.rows[0].quantity)-Number(returned.rows[0].quantity)+1e-8<qty)throw new AppError('Возврат больше отгруженного количества');
    const id=uid(),c=await code(db,'customer_returns','RT');await db.query('INSERT INTO customer_returns(id,shipment_id,code,reason,created_by) VALUES($1,$2,$3,$4,$5)',[id,shipmentId,c,reason,aid]);
    await db.query('INSERT INTO return_items(id,return_id,lot_id,quantity) VALUES($1,$2,$3,$4)',[uid(),id,lotId,qty]);
    await move(db,{lotId,type:'customer_return',quantity:qty,to:await warehouse(db,'quarantine'),basisType:'customer_return',basisId:id,actorId:aid});
    await db.query(`UPDATE recall_customer_actions SET returned_quantity=returned_quantity+$1,updated_at=now() WHERE shipment_id=$2 AND lot_id=$3`,[qty,shipmentId,lotId]);
    const nc=uid(),ncc=await code(db,'nonconformities','NC');await db.query('INSERT INTO nonconformities(id,code,source_type,source_id,lot_id,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[nc,ncc,'customer_return',id,lotId,reason,aid]);
    await audit(db,'customer_return',id,'create',aid,null,{shipmentId,lotId,quantity:qty,reason});return {id,code:c};
  }
  case 'inventory.transfer': {
    requireRole(a,'warehouse');const lotId=str(x.lotId),qty=await validateQuantity(db,lotId,x.quantity),from=str(x.fromWarehouseId),to=str(x.toWarehouseId),reason=str(x.reason);
    if(from===to)throw new AppError('Выберите другой склад');
    const fromKind=await one<{kind:string}>(db,'SELECT kind FROM warehouses WHERE id=$1',[from]);const toKind=await one<{kind:string}>(db,'SELECT kind FROM warehouses WHERE id=$1',[to]);
    const currentLot=await lot(db,lotId);
    if(['quarantine','returns'].includes(fromKind.kind)&&['raw','finished'].includes(toKind.kind))throw new AppError('Вывод из карантина или возвратов требует решения качества');
    if(['raw','finished'].includes(toKind.kind)){
      if(currentLot.quality_status!=='released')throw new AppError('Вывод партии в доступный запас требует решения качества');
      if(toKind.kind!==(currentLot.kind==='material'?'raw':'finished'))throw new AppError('Тип склада не соответствует партии');
      const holds=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL LIMIT 1',[lotId]);if(holds.rows.length)throw new AppError('Партия заблокирована');
    }
    if(await balance(db,lotId,from)+1e-8<qty)throw new AppError('Недостаточный остаток на складе');
    if(currentLot.kind==='material'&&fromKind.kind==='raw'&&toKind.kind!=='raw'&&await usableBalance(db,lotId,'material')-qty+1e-8<await reserved(db,lotId))throw new AppError('Операция нарушит активный резерв');
    await move(db,{lotId,type:'transfer',quantity:qty,from,to,basisType:'transfer',basisId:uid(),actorId:aid});await audit(db,'lot',lotId,'transfer',aid,{from},{to,quantity:qty},reason);return {lotId};
  }
  case 'inventory.writeoff': {
    requireRole(a,'quality_manager');const lotId=str(x.lotId),qty=await validateQuantity(db,lotId,x.quantity),from=str(x.warehouseId),reason=str(x.reason);
    if(await balance(db,lotId,from)+1e-8<qty)throw new AppError('Недостаточный остаток');
    const source=await one<{kind:string}>(db,'SELECT kind FROM warehouses WHERE id=$1',[from]);
    if(source.kind==='raw'&&await usableBalance(db,lotId,'material')-qty+1e-8<await reserved(db,lotId))throw new AppError('Сначала освободите активный резерв');
    await move(db,{lotId,type:'writeoff',quantity:qty,from,basisType:'writeoff',basisId:uid(),actorId:aid});await audit(db,'lot',lotId,'writeoff',aid,null,{quantity:qty,from},reason);return {lotId};
  }
  default: throw new AppError('Неизвестное действие',404);
  }
}
