import { AppError } from './auth';
import { type Db, one } from './db';
export type Lot = { id:string;code:string;kind:'material'|'finished';quality_status:string;expires_at:string|null;material_id:string|null;product_id:string|null;version:number };
export async function lot(db:Db,id:string):Promise<Lot>{return one<Lot>(db,'SELECT * FROM lots WHERE id=$1',[id]);}
export async function balance(db:Db,lotId:string,warehouseId?:string):Promise<number>{
  const r=await db.query<{balance:string}>(`SELECT COALESCE(sum(CASE WHEN to_warehouse_id IS NOT NULL ${warehouseId?'AND to_warehouse_id=$2':''} THEN quantity ELSE 0 END)-sum(CASE WHEN from_warehouse_id IS NOT NULL ${warehouseId?'AND from_warehouse_id=$2':''} THEN quantity ELSE 0 END),0)::text AS balance FROM inventory_movements WHERE lot_id=$1`,warehouseId?[lotId,warehouseId]:[lotId]);
  return Number(r.rows[0].balance);
}
export async function usableBalance(db:Db,lotId:string,kind:'material'|'finished'):Promise<number>{
  const warehouseKind=kind==='material'?'raw':'finished';
  const r=await db.query<{quantity:string}>(`SELECT COALESCE(sum(CASE WHEN wt.kind=$2 THEN im.quantity ELSE 0 END)-sum(CASE WHEN wf.kind=$2 THEN im.quantity ELSE 0 END),0)::text quantity FROM inventory_movements im LEFT JOIN warehouses wt ON wt.id=im.to_warehouse_id LEFT JOIN warehouses wf ON wf.id=im.from_warehouse_id WHERE im.lot_id=$1`,[lotId,warehouseKind]);
  return Number(r.rows[0].quantity);
}
export async function reserved(db:Db,lotId:string):Promise<number>{
  const r=await db.query<{quantity:string}>(`SELECT COALESCE(sum(quantity-consumed_quantity),0)::text AS quantity FROM material_reservations WHERE lot_id=$1 AND active=true`,[lotId]);
  return Number(r.rows[0].quantity);
}
export async function assertUsable(db:Db,lotId:string,kind:'material'|'finished',quantity:number,excludeReservations=false){
  const l=await lot(db,lotId);
  if(l.kind!==kind) throw new AppError('Неверный тип партии');
  if(l.quality_status!=='released') throw new AppError('Партия не разрешена качеством');
  if(l.expires_at && new Date(l.expires_at).toISOString().slice(0,10)<new Date().toISOString().slice(0,10)) throw new AppError('Срок годности партии истёк');
  const holds=await db.query('SELECT id FROM lot_holds WHERE lot_id=$1 AND released_at IS NULL LIMIT 1',[lotId]);
  if(holds.rows.length) throw new AppError('Партия заблокирована');
  const physical=await usableBalance(db,lotId,kind); const available=physical-(excludeReservations?0:await reserved(db,lotId));
  if(available+1e-8<quantity) throw new AppError(`Недостаточный остаток: доступно ${available}`);
  return l;
}
export async function unitForLot(db:Db,lotId:string):Promise<{code:string;whole_only:boolean}>{
  return one(db,`SELECT u.code,u.whole_only FROM lots l LEFT JOIN materials m ON m.id=l.material_id LEFT JOIN products p ON p.id=l.product_id JOIN units u ON u.code=COALESCE(m.unit_code,p.unit_code) WHERE l.id=$1`,[lotId]);
}
export async function validateQuantity(db:Db,lotId:string,raw:unknown):Promise<number>{
  const value=String(raw??'');
  if(!/^\d+(\.\d{1,6})?$/.test(value) || Number(value)<=0 || !Number.isFinite(Number(value))) throw new AppError('Введите положительное количество (до 6 знаков после запятой)');
  const unit=await unitForLot(db,lotId);
  if(unit.whole_only && !Number.isInteger(Number(value))) throw new AppError('Для этой единицы допускаются только целые значения');
  return Number(value);
}
export async function move(db:Db,args:{lotId:string;type:string;quantity:number;from?:string|null;to?:string|null;basisType:string;basisId:string;actorId:string;reversalOf?:string}){
  const unit=await unitForLot(db,args.lotId);
  await db.query(`INSERT INTO inventory_movements(id,lot_id,movement_type,quantity,unit_code,from_warehouse_id,to_warehouse_id,basis_type,basis_id,reversal_of,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[crypto.randomUUID(),args.lotId,args.type,args.quantity,unit.code,args.from||null,args.to||null,args.basisType,args.basisId,args.reversalOf||null,args.actorId]);
}
export async function warehouse(db:Db,kind:string):Promise<string>{return (await one<{id:string}>(db,'SELECT id FROM warehouses WHERE kind=$1 AND active=true LIMIT 1',[kind])).id;}
