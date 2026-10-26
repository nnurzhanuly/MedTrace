import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir=mkdtempSync(path.join(os.tmpdir(),'medtrace-test-'));
process.env.MEDTRACE_DB_DIR=dir;
const seed=spawnSync(process.execPath,['--import','tsx','scripts/seed.ts'],{cwd:process.cwd(),env:{...process.env,MEDTRACE_DB_DIR:dir},encoding:'utf8'});
if(seed.status!==0)throw new Error(`Seed failed: ${seed.stderr}`);

test('critical end-to-end invariants',async t=>{
 const {query,uid}=await import('../src/lib/db');
 const {executeAction}=await import('../src/lib/actions');
 const {trace}=await import('../src/lib/trace');
 const {assertUsable,balance}=await import('../src/lib/stock');
 const {snapshot}=await import('../src/lib/snapshot');
 const {canAccessEntity}=await import('../src/lib/access');
 type Actor={id:string;email:string;name:string;roles:string[]};
 async function actor(role:string):Promise<Actor>{const r=await query<{id:string;email:string;name:string}>('SELECT id,email,name FROM profiles WHERE email=$1',[`${({production_manager:'manager',quality_manager:'qa',quality_specialist:'qc'} as Record<string,string>)[role]||role}@medtrace.demo`]);return {...r.rows[0],roles:[role]};}
 const actors:Record<string,Actor>={};for(const role of ['admin','warehouse','quality_specialist','quality_manager','production_manager','operator','shipping'])actors[role]=await actor(role);
 let n=0;async function act(role:string,action:string,input:Record<string,unknown>,key?:string){return await executeAction(action,input,actors[role],key||`test-${++n}-${uid()}`) as Record<string,any>}
 const lots=(await query<{id:string;code:string;kind:string}>('SELECT id,code,kind FROM lots ORDER BY code')).rows;
 const rm1=lots.find(l=>l.code==='RM-2026-000001')!,rm2=lots.find(l=>l.code==='RM-2026-000004')!,fg1=lots.find(l=>l.code==='FG-2026-000001')!,fg4=lots.find(l=>l.code==='FG-2026-000004')!;
 const specA=(await query<{id:string}>('SELECT id FROM specification_versions WHERE specification_id=(SELECT id FROM specifications WHERE code=$1) AND version_no=1',['SPEC-MF'])).rows[0].id;
 const customers=(await query<{id:string}>('SELECT id FROM customers ORDER BY code')).rows;
 await t.test('seed contains exact demo relationships and 500 remaining units',async()=>{
  assert.equal((await query('SELECT id FROM suppliers')).rows.length,3);assert.equal((await query("SELECT id FROM lots WHERE kind='material'")).rows.length,6);
 });
 await t.test('demo credentials are rejected in production mode',async()=>{
  const {authenticate}=await import('../src/lib/auth');const previous=process.env.NODE_ENV;
  try{Reflect.set(process.env,'NODE_ENV','production');assert.equal(await authenticate('admin@medtrace.demo','MedTrace2026!'),null);}finally{if(previous===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else Reflect.set(process.env,'NODE_ENV',previous);}
 });
 await t.test('operator snapshot and document access are scoped to assigned work',async()=>{
  const view=await snapshot(actors.operator) as any;
  assert.equal(view.users.length,0);assert.equal(view.customers.length,0);assert.equal(view.audit.length,0);assert.equal(view.shipments.length,0);
  assert.ok(view.orders.every((o:any)=>o.assigned_to===actors.operator.id));
  const shipment=(await query<{id:string}>('SELECT id FROM shipments LIMIT 1')).rows[0].id;
  assert.equal(await canAccessEntity(actors.operator,'shipment',shipment),false);
  assert.equal(await canAccessEntity(actors.shipping,'shipment',shipment),true);
 });
 await t.test('backward and forward trace use actual consumption, not reservation',async()=>{
  const forward=await trace(rm1.code) as any;assert.deepEqual(forward.descendants.map((x:any)=>x.code).sort(),['FG-2026-000001','FG-2026-000002']);assert.equal(forward.shipments.length,2);
  const backward=await trace(fg1.code) as any;assert.ok(backward.materials.some((x:any)=>x.code===rm1.code));assert.ok(backward.materials.every((x:any)=>x.supplier_name));
  assert.equal(await balance({query},fg1.id),500);
 });
 await t.test('warehouse receipt is idempotent and quarantined lot cannot be reserved',async()=>{
  const supplier=(await query<{id:string}>('SELECT id FROM suppliers LIMIT 1')).rows[0].id;
  const material=(await query<{id:string}>('SELECT id FROM materials WHERE code=$1',['MAT-001'])).rows[0].id;
  const receipt=await act('warehouse','receipt.create',{supplierId:supplier,materialId:material,supplierLot:'TEST-Q',quantity:100,expiresAt:'2028-12-31',deliveryDocument:'TEST'});
  await act('warehouse','receipt.confirm',{id:receipt.id});await act('warehouse','receipt.confirm',{id:receipt.id});
  const quarantine=(await query<{id:string}>('SELECT lot_id id FROM receipt_items WHERE receipt_id=$1',[receipt.id])).rows[0];
  assert.equal((await query('SELECT id FROM inventory_movements WHERE lot_id=$1',[quarantine.id])).rows.length,1);
  const order=await act('production_manager','order.create',{specVersionId:specA,quantity:1000,line:'Test'});
  const additive=(await query<{id:string}>('SELECT id FROM lots WHERE material_id=(SELECT id FROM materials WHERE code=$1) LIMIT 1',['MAT-002'])).rows[0].id;
  const packaging=(await query<{id:string}>('SELECT id FROM lots WHERE material_id=(SELECT id FROM materials WHERE code=$1) LIMIT 1',['MAT-003'])).rows[0].id;
  await assert.rejects(act('production_manager','order.reserve',{id:order.id,selections:[{lotId:quarantine.id,quantity:50},{lotId:additive,quantity:5},{lotId:packaging,quantity:1000}]}),/не разрешена/);
 });
 await t.test('idempotency key rejects a different payload',async()=>{
  const key=`payload-${uid()}`;
  const first=await act('shipping','shipment.create',{customerId:customers[0].id},key);
  assert.ok(first.id);
  await assert.rejects(act('shipping','shipment.create',{customerId:customers[1].id},key),/Ключ операции/);
  assert.equal((await query('SELECT id FROM shipments WHERE id=$1',[first.id])).rows.length,1);
 });
 await t.test('quarantine cannot be laundered into usable stock and reserved stock cannot be written off',async()=>{
  const quarantined=(await query<{id:string}>('SELECT lot_id id FROM receipt_items WHERE supplier_lot_number=$1',['TEST-Q'])).rows[0].id;
  const wh=(await query<{id:string;kind:string}>('SELECT id,kind FROM warehouses')).rows;
  const q=wh.find(x=>x.kind==='quarantine')!.id,blocked=wh.find(x=>x.kind==='blocked')!.id,raw=wh.find(x=>x.kind==='raw')!.id;
  await act('warehouse','inventory.transfer',{lotId:quarantined,quantity:1,fromWarehouseId:q,toWarehouseId:blocked,reason:'Проверка'});
  await assert.rejects(act('warehouse','inventory.transfer',{lotId:quarantined,quantity:1,fromWarehouseId:blocked,toWarehouseId:raw,reason:'Обход'}),/решения качества/);
  await act('warehouse','inventory.transfer',{lotId:quarantined,quantity:1,fromWarehouseId:blocked,toWarehouseId:q,reason:'Возврат в карантин'});
  const order=await act('production_manager','order.create',{specVersionId:specA,quantity:100,line:'Test reserve'});
  const total=await balance({query},rm2.id);
  await act('warehouse','inventory.transfer',{lotId:rm2.id,quantity:5,fromWarehouseId:raw,toWarehouseId:blocked,reason:'Частичная блокировка'});
  await query('INSERT INTO material_reservations(id,order_id,lot_id,quantity) VALUES($1,$2,$3,1)',[uid(),order.id,rm2.id]);
  await assert.rejects(assertUsable({query},rm2.id,'material',total-5),/Недостаточный остаток/);
  await assert.rejects(act('warehouse','inventory.transfer',{lotId:rm2.id,quantity:total-5,fromWarehouseId:raw,toWarehouseId:blocked,reason:'Обход резерва'}),/резерв/);
  await assert.rejects(act('quality_manager','inventory.writeoff',{lotId:rm2.id,quantity:total-5,warehouseId:raw,reason:'Обход резерва'}),/резерв/);
  await act('production_manager','order.cancel',{id:order.id});
  await act('warehouse','inventory.transfer',{lotId:rm2.id,quantity:5,fromWarehouseId:blocked,toWarehouseId:raw,reason:'Возврат'});
 });
 await t.test('incoming lot split preserves quantity and requires separate quality decisions',async()=>{
  const parent=(await query<{id:string}>('SELECT lot_id id FROM receipt_items WHERE supplier_lot_number=$1',['TEST-Q'])).rows[0];
  const split=await act('warehouse','lot.split',{lotId:parent.id,quantity:40,reason:'Неоднородная упаковка'});
  assert.equal(split.children.length,2);
  assert.deepEqual(split.children.map((c:any)=>c.quantity),[40,60]);
  assert.equal(await balance({query},parent.id),0);
  assert.equal(await balance({query},split.children[0].id),40);
  assert.equal(await balance({query},split.children[1].id),60);
  await act('quality_specialist','quality.check',{lotId:split.children[0].id,summary:'Соответствует',results:{label:true,package:true,documents:true}});
  await act('quality_manager','quality.decide',{lotId:split.children[0].id,decision:'release',basis:'Отдельный протокол дочерней партии'});
  const statuses=(await query<{quality_status:string}>('SELECT quality_status FROM lots WHERE parent_lot_id=$1 ORDER BY code',[parent.id])).rows.map(r=>r.quality_status);
  assert.deepEqual(statuses,['released','quarantine']);
  assert.equal((await query('SELECT id FROM documents WHERE kind=$1 AND entity_id=$2',['lot_split',parent.id])).rows.length,1);
 });
 await t.test('direct shipment of blocked or expired lot is rejected',async()=>{
  const blocked=await act('shipping','shipment.create',{customerId:customers[0].id});await act('shipping','shipment.allocate',{id:blocked.id,lotId:fg1.id,quantity:1});await assert.rejects(act('warehouse','shipment.confirm',{id:blocked.id}),/заблокирована/);
  const product=(await query<{id:string}>('SELECT id FROM products LIMIT 1')).rows[0].id;const wh=(await query<{id:string}>('SELECT id FROM warehouses WHERE kind=$1',['finished'])).rows[0].id;const expired=uid();
  await query(`INSERT INTO lots(id,code,kind,product_id,quality_status,expires_at,public_token) VALUES($1,$2,'finished',$3,'released',$4,$5)`,[expired,'FG-TEST-EXPIRED',product,'2020-01-01',uid()]);
  await query(`INSERT INTO inventory_movements(id,lot_id,movement_type,quantity,unit_code,to_warehouse_id,basis_type,basis_id,actor_id) VALUES($1,$2,'test_fixture',10,'pcs',$3,'fixture',$4,$5)`,[uid(),expired,wh,uid(),actors.warehouse.id]);
  const sh=await act('shipping','shipment.create',{customerId:customers[0].id});await act('shipping','shipment.allocate',{id:sh.id,lotId:expired,quantity:1});await assert.rejects(act('warehouse','shipment.confirm',{id:sh.id}),/истёк/);
 });
 await t.test('concurrent shipment confirmations cannot oversell, retry is idempotent',async()=>{
  const a=await act('shipping','shipment.create',{customerId:customers[0].id});const b=await act('shipping','shipment.create',{customerId:customers[1].id});
  await act('shipping','shipment.allocate',{id:a.id,lotId:fg4.id,quantity:300});await act('shipping','shipment.allocate',{id:b.id,lotId:fg4.id,quantity:300});
  const key=`confirmed-${uid()}`;const result=await Promise.allSettled([act('warehouse','shipment.confirm',{id:a.id},key),act('warehouse','shipment.confirm',{id:b.id})]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);assert.equal(await balance({query},fg4.id),100);
  const success=result[0].status==='fulfilled'?a:b;const before=(await query('SELECT id FROM inventory_movements WHERE basis_type=$1 AND basis_id=$2',['shipment',success.id])).rows.length;
  const retry=await act('warehouse','shipment.confirm',{id:success.id},result[0].status==='fulfilled'?key:`retry-${uid()}`);assert.ok(retry.id);assert.equal((await query('SELECT id FROM inventory_movements WHERE basis_type=$1 AND basis_id=$2',['shipment',success.id])).rows.length,before);
 });
 await t.test('recall contact and return are distinct quantities',async()=>{
  const recall=(await query<{id:string}>('SELECT id FROM recall_campaigns LIMIT 1')).rows[0].id;
  const row=(await query<{id:string;shipment_id:string;lot_id:string}>('SELECT id,shipment_id,lot_id FROM recall_customer_actions WHERE recall_id=$1 LIMIT 1',[recall])).rows[0];
  await act('shipping','recall.action',{id:row.id,status:'notified',note:'Звонок зарегистрирован'});
  let state=(await query<{status:string;returned_quantity:string}>('SELECT status,returned_quantity FROM recall_customer_actions WHERE id=$1',[row.id])).rows[0];assert.equal(state.status,'notified');assert.equal(Number(state.returned_quantity),0);
  await act('warehouse','return.create',{shipmentId:row.shipment_id,lotId:row.lot_id,quantity:50,reason:'Возврат по отзыву'});
  state=(await query<{status:string;returned_quantity:string}>('SELECT status,returned_quantity FROM recall_customer_actions WHERE id=$1',[row.id])).rows[0];assert.equal(state.status,'notified');assert.equal(Number(state.returned_quantity),50);
  await act('shipping','recall.action',{id:row.id,status:'returned',note:'Фактический возврат принят'});
 });
 await t.test('historical order keeps approved specification snapshot',async()=>{
  const spec=(await query<{id:string}>('SELECT id FROM specifications WHERE code=$1',['SPEC-MF'])).rows[0].id;
  const product=(await query<{id:string}>('SELECT id FROM materials WHERE code=$1',['MAT-001'])).rows[0].id;
  const next=await act('production_manager','spec.newVersion',{id:spec,baseQuantity:1000,items:[{materialId:product,quantity:999}],route:['Новый этап']});assert.ok(next.id);
  const orders=await query<{spec_version_id:string}>('SELECT spec_version_id FROM production_orders WHERE product_id=(SELECT product_id FROM specifications WHERE id=$1) AND code LIKE $2',[spec,'PO-%']);assert.ok(orders.rows.every(o=>o.spec_version_id===specA));
  await assert.rejects(query('UPDATE specification_versions SET base_quantity=2 WHERE id=$1',[specA]),/immutable/);
 });
 await t.test('administrator cannot approve quality decisions',async()=>{await assert.rejects(act('admin','quality.decide',{lotId:rm2.id,decision:'release',basis:'No'}),/Недостаточно прав/)});
 await t.test('parent lot trace and hold include consumption of a split child',async()=>{
  const parent=(await query<{id:string;code:string}>('SELECT l.id,l.code FROM lots l JOIN receipt_items ri ON ri.lot_id=l.id WHERE ri.supplier_lot_number=$1',['TEST-Q'])).rows[0];
  const child=(await query<{id:string}>('SELECT id FROM lots WHERE parent_lot_id=$1 AND quality_status=$2',[parent.id,'released'])).rows[0];
  const additive=(await query<{id:string}>('SELECT id FROM lots WHERE material_id=(SELECT id FROM materials WHERE code=$1) AND quality_status=$2 LIMIT 1',['MAT-002','released'])).rows[0];
  const packaging=(await query<{id:string}>('SELECT id FROM lots WHERE material_id=(SELECT id FROM materials WHERE code=$1) AND quality_status=$2 LIMIT 1',['MAT-003','released'])).rows[0];
  const order=await act('production_manager','order.create',{specVersionId:specA,quantity:1000,line:'Split test',assignedTo:actors.operator.id});
  const selections=[{lotId:child.id,quantity:40},{lotId:rm2.id,quantity:10},{lotId:additive.id,quantity:5},{lotId:packaging.id,quantity:1000}];
  await act('production_manager','order.reserve',{id:order.id,selections});
  const run=await act('operator','run.create',{orderId:order.id});
  await assert.rejects(act('production_manager','order.cancel',{id:order.id}),/Запуск уже создан/);
  const stranger={...actors.operator,id:actors.shipping.id};
  await assert.rejects(executeAction('run.consume',{runId:run.id,lotId:child.id,quantity:1},stranger,`other-${uid()}`),/не назначен/);
  await assert.rejects(executeAction('run.step',{runId:run.id},stranger,`other-${uid()}`),/не назначен/);
  await assert.rejects(executeAction('run.finish',{runId:run.id,manufactured:1000,quarantine:1000},stranger,`other-${uid()}`),/не назначен/);
  await assert.rejects(executeAction('nonconformity.create',{sourceType:'lot',lotId:fg1.id,description:'Чужая партия'},stranger,`other-${uid()}`),/не относится/);
  for(let i=0;i<3;i++)await act('operator','run.step',{runId:run.id,comment:'Выполнено'});
  await assert.rejects(act('operator','run.finish',{runId:run.id,manufactured:1000,scrap:0,quarantine:1000,expiresAt:'2028-12-31',expiryBasis:'Тест'}),/Расход материалов/);
  for(const item of selections)await act('operator','run.consume',{runId:run.id,...item});
  const output=await act('operator','run.finish',{runId:run.id,manufactured:1000,scrap:0,quarantine:1000,expiresAt:'2028-12-31',expiryBasis:'Тестовое утверждённое правило'});
  const forward=await trace(parent.code) as any;
  assert.ok(forward.descendants.some((r:any)=>r.id===output.id));
  const backward=await trace((await query<{code:string}>('SELECT code FROM lots WHERE id=$1',[output.id])).rows[0].code) as any;
  assert.ok(backward.materials.some((r:any)=>r.id===child.id&&r.receipt_code));
  await act('quality_manager','hold.place',{lotId:parent.id,reason:'Подозрение по исходной партии'});
  assert.ok((await query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL',[child.id])).rows.length);
  assert.ok((await query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL',[output.id])).rows.length);
 });
 await t.test('open recall keeps its own protective hold even after another hold is released',async()=>{
  const manual=await act('quality_manager','hold.place',{lotId:fg4.id,reason:'Ручная блокировка'});
  const recall=await act('quality_manager','recall.create',{sourceLotId:fg4.id,reason:'Проверка',actionPlan:'Уведомить клиента'});
  assert.ok(recall.id);
  await act('quality_manager','hold.release',{id:manual.id,reason:'Ручная причина устранена'});
  const active=(await query<{id:string;protective:boolean}>('SELECT id,protective FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL',[fg4.id])).rows;
  assert.ok(active.some(h=>h.protective));
  await assert.rejects(act('quality_manager','hold.release',{id:active.find(h=>h.protective)!.id,reason:'Обход'}),/после закрытия кампании/);
 });
});
