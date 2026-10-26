import {query} from './db';
import {hasRole,type Actor} from './auth';
import {canAccessEntity} from './access';
import {storageEnabled,supabaseEnabled} from './supabase';
export async function snapshot(actor:Actor){
  const organization=await query<{id:string;name:string}>('SELECT id,name FROM organizations LIMIT 1');
  const [suppliers,customers,materials,products,warehouses,users,receipts,lots,specs,orders,runs,reservations,consumptions,steps,checks,decisions,holds,shipments,allocations,returns,ncs,recalls,actions,documents,audit,notifications,balances,qualityPlans]=await Promise.all([
    query('SELECT * FROM suppliers ORDER BY name'),query('SELECT * FROM customers ORDER BY name'),query('SELECT * FROM materials ORDER BY name'),query('SELECT * FROM products ORDER BY name'),query('SELECT * FROM warehouses ORDER BY name'),
    query(`SELECT p.id,p.name,p.email,p.active,COALESCE(array_agg(ur.role_code) FILTER(WHERE ur.role_code IS NOT NULL),'{}') roles FROM profiles p LEFT JOIN user_roles ur ON ur.user_id=p.id GROUP BY p.id ORDER BY p.name`),
    query(`SELECT r.*,s.name supplier_name,ri.id item_id,ri.material_id,ri.quantity::text,m.name material_name,ri.supplier_lot_number,ri.expires_at,ri.lot_id FROM receipts r JOIN suppliers s ON s.id=r.supplier_id JOIN receipt_items ri ON ri.receipt_id=r.id JOIN materials m ON m.id=ri.material_id ORDER BY r.received_at DESC`),
    query(`SELECT l.*,m.name material_name,m.unit_code material_unit,p.name product_name,p.unit_code product_unit,s.name supplier_name FROM lots l LEFT JOIN materials m ON m.id=l.material_id LEFT JOIN products p ON p.id=l.product_id LEFT JOIN suppliers s ON s.id=l.supplier_id ORDER BY l.created_at DESC`),
    query(`SELECT s.id,s.code,s.name,p.name product_name,s.product_id,sv.id version_id,sv.version_no,sv.status,sv.base_quantity::text,sv.route_snapshot,sv.approved_at,(SELECT json_agg(json_build_object('materialId',si.material_id,'materialName',m.name,'quantity',si.quantity,'unit',si.unit_code)) FROM specification_items si JOIN materials m ON m.id=si.material_id WHERE si.version_id=sv.id) items FROM specifications s JOIN products p ON p.id=s.product_id JOIN specification_versions sv ON sv.specification_id=s.id ORDER BY s.code,sv.version_no DESC`),
    query(`SELECT po.*,p.name product_name,sv.version_no spec_version FROM production_orders po JOIN products p ON p.id=po.product_id JOIN specification_versions sv ON sv.id=po.spec_version_id ORDER BY po.created_at DESC`),
    query(`SELECT pr.*,po.code order_code,fl.lot_id finished_lot_id FROM production_runs pr JOIN production_orders po ON po.id=pr.order_id LEFT JOIN finished_lots fl ON fl.run_id=pr.id ORDER BY pr.started_at DESC`),
    query(`SELECT mr.*,l.code lot_code FROM material_reservations mr JOIN lots l ON l.id=mr.lot_id`),
    query(`SELECT mc.*,l.code lot_code FROM material_consumptions mc JOIN lots l ON l.id=mc.lot_id ORDER BY mc.created_at DESC`),
    query(`SELECT psr.* FROM production_step_records psr ORDER BY completed_at DESC`),
    query(`SELECT qc.*,l.code lot_code,p.name performer FROM quality_checks qc JOIN lots l ON l.id=qc.lot_id JOIN profiles p ON p.id=qc.performed_by ORDER BY qc.performed_at DESC`),
    query(`SELECT qd.*,l.code lot_code,p.name actor FROM quality_decisions qd JOIN lots l ON l.id=qd.lot_id JOIN profiles p ON p.id=qd.actor_id ORDER BY qd.created_at DESC`),
    query(`SELECT h.*,l.code lot_code FROM lot_holds h JOIN lots l ON l.id=h.lot_id ORDER BY h.placed_at DESC`),
    query(`SELECT sh.*,c.name current_customer_name FROM shipments sh JOIN customers c ON c.id=sh.customer_id ORDER BY sh.created_at DESC`),
    query(`SELECT sa.*,si.shipment_id,l.code lot_code,p.name product_name FROM shipment_lot_allocations sa JOIN shipment_items si ON si.id=sa.shipment_item_id JOIN lots l ON l.id=sa.lot_id JOIN products p ON p.id=si.product_id`),
    query(`SELECT cr.*,sh.code shipment_code,ri.lot_id,ri.quantity::text,l.code lot_code FROM customer_returns cr JOIN shipments sh ON sh.id=cr.shipment_id JOIN return_items ri ON ri.return_id=cr.id JOIN lots l ON l.id=ri.lot_id ORDER BY cr.received_at DESC`),
    query(`SELECT n.*,l.code lot_code FROM nonconformities n LEFT JOIN lots l ON l.id=n.lot_id ORDER BY n.created_at DESC`),
    query(`SELECT rc.*,l.code source_lot_code,(SELECT count(*)::integer FROM recall_affected_lots ral WHERE ral.recall_id=rc.id) affected_count FROM recall_campaigns rc JOIN lots l ON l.id=rc.source_lot_id ORDER BY rc.created_at DESC`),
    query(`SELECT rca.*,sh.code shipment_code,l.code lot_code,sh.customer_name_snapshot,COALESCE((SELECT sum(sa.quantity) FROM shipment_lot_allocations sa JOIN shipment_items si ON si.id=sa.shipment_item_id WHERE si.shipment_id=rca.shipment_id AND sa.lot_id=rca.lot_id),0)::text shipped_quantity FROM recall_customer_actions rca JOIN shipments sh ON sh.id=rca.shipment_id JOIN lots l ON l.id=rca.lot_id`),
    query(`SELECT d.*,dv.id version_id,dv.version_no,dv.snapshot,dv.storage_path,dv.mime_type,dv.size_bytes FROM documents d JOIN document_versions dv ON dv.document_id=d.id ORDER BY d.created_at DESC`),
    query(`SELECT al.*,p.name actor FROM audit_logs al JOIN profiles p ON p.id=al.actor_id ORDER BY al.created_at DESC LIMIT 250`),
    query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,[actor.id]),
    query(`SELECT l.id lot_id, w.id warehouse_id,w.name warehouse_name,COALESCE(sum(CASE WHEN im.to_warehouse_id=w.id THEN im.quantity ELSE 0 END)-sum(CASE WHEN im.from_warehouse_id=w.id THEN im.quantity ELSE 0 END),0)::text quantity FROM lots l CROSS JOIN warehouses w LEFT JOIN inventory_movements im ON im.lot_id=l.id AND (im.to_warehouse_id=w.id OR im.from_warehouse_id=w.id) GROUP BY l.id,w.id,w.name HAVING COALESCE(sum(CASE WHEN im.to_warehouse_id=w.id THEN im.quantity ELSE 0 END)-sum(CASE WHEN im.from_warehouse_id=w.id THEN im.quantity ELSE 0 END),0)<>0`),
    query(`SELECT * FROM quality_plan_versions WHERE status='active'`)
  ]);
  const data={actor,organization:organization.rows[0],environment:{demo:organization.rows[0]?.id==='demo-org',database:process.env.DATABASE_URL?'PostgreSQL':'PGlite',auth:supabaseEnabled()?'Supabase Auth':'Локальная авторизация',storage:storageEnabled()?'Supabase Storage':'Локальные файлы'},suppliers:suppliers.rows,customers:customers.rows,materials:materials.rows,products:products.rows,warehouses:warehouses.rows,users:users.rows,receipts:receipts.rows,lots:lots.rows,specs:specs.rows,orders:orders.rows,runs:runs.rows,reservations:reservations.rows,consumptions:consumptions.rows,steps:steps.rows,checks:checks.rows,decisions:decisions.rows,holds:holds.rows,shipments:shipments.rows,allocations:allocations.rows,returns:returns.rows,nonconformities:ncs.rows,recalls:recalls.rows,recallActions:actions.rows,documents:documents.rows,audit:audit.rows,notifications:notifications.rows,balances:balances.rows,qualityPlans:qualityPlans.rows};
  const broad=hasRole(actor,'admin','auditor','quality_manager');
  if(!broad){
    data.audit=[];
    data.users=hasRole(actor,'production_manager')?users.rows.filter((u:any)=>u.roles.includes('operator')).map((u:any)=>({id:u.id,name:u.name,roles:u.roles})):[];
    if(!hasRole(actor,'shipping','warehouse')){data.customers=[];data.shipments=[];data.allocations=[];data.returns=[];data.recallActions=[];}
    if(!hasRole(actor,'shipping','quality_specialist','warehouse'))data.recalls=[];
    if(!hasRole(actor,'warehouse','quality_specialist')){data.suppliers=[];data.receipts=[];}
    if(!hasRole(actor,'quality_specialist')){data.checks=[];data.decisions=[];data.qualityPlans=[];}
    if(hasRole(actor,'operator')&&!hasRole(actor,'production_manager')){
      const assigned=new Set(orders.rows.filter((o:any)=>o.assigned_to===actor.id).map((o:any)=>o.id));
      data.orders=orders.rows.filter((o:any)=>assigned.has(o.id));
      data.runs=runs.rows.filter((r:any)=>assigned.has(r.order_id));
      const runIds=new Set(data.runs.map((r:any)=>r.id));
      data.reservations=reservations.rows.filter((r:any)=>assigned.has(r.order_id));
      data.consumptions=consumptions.rows.filter((r:any)=>runIds.has(r.run_id));
      data.steps=steps.rows.filter((s:any)=>runIds.has(s.run_id));
      const lotIds=new Set([...data.reservations.map((r:any)=>r.lot_id),...data.runs.map((r:any)=>r.finished_lot_id)].filter(Boolean));
      data.lots=lots.rows.filter((l:any)=>lotIds.has(l.id));
      data.balances=balances.rows.filter((b:any)=>lotIds.has(b.lot_id));
      data.holds=[];data.nonconformities=[];data.specs=specs.rows.filter((s:any)=>data.orders.some((o:any)=>o.spec_version_id===s.version_id));
    }
  }
  data.documents=(await Promise.all(documents.rows.map(async(d:any)=>await canAccessEntity(actor,d.entity_type,d.entity_id)?d:null))).filter(Boolean);
  return data;
}
