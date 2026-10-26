-- MedTrace uses a direct PostgreSQL connection for all business data. Supabase
-- API roles must never receive direct access to these tables.
DO $$
DECLARE
  table_name text;
BEGIN
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL OR to_regrole('service_role') IS NULL THEN
    RETURN;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'organizations','profiles','roles','user_roles','sessions','units',
    'suppliers','customers','materials','products','warehouses','locations',
    'receipts','receipt_items','lots','specifications','specification_versions',
    'specification_items','process_templates','process_template_steps',
    'quality_plan_versions','production_orders','production_runs',
    'material_reservations','material_consumptions','production_step_records',
    'finished_lots','quality_checks','quality_check_results','quality_decisions',
    'lot_holds','inventory_movements','shipments','shipment_items',
    'shipment_lot_allocations','customer_returns','return_items',
    'nonconformities','recall_campaigns','recall_affected_lots',
    'recall_customer_actions','documents','document_versions','attachments',
    'notifications','status_history','audit_logs','idempotency_keys',
    'login_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, service_role, PUBLIC', table_name);
  END LOOP;

  REVOKE EXECUTE ON FUNCTION public.medtrace_guard_spec_version() FROM anon, authenticated, service_role, PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.medtrace_guard_spec_item() FROM anon, authenticated, service_role, PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.medtrace_append_only() FROM anon, authenticated, service_role, PUBLIC;
END $$;

-- On Supabase this owner is postgres; on other PostgreSQL installations this
-- remains a no-op for applications that do not expose the Supabase API roles.
DO $$
BEGIN
  IF to_regrole('anon') IS NOT NULL AND to_regrole('authenticated') IS NOT NULL AND to_regrole('service_role') IS NOT NULL THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
  END IF;
END $$;
