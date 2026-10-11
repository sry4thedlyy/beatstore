ALTER TABLE documents ADD COLUMN renderer_version text NOT NULL DEFAULT 'license-pdf-v1';
ALTER TABLE documents ADD COLUMN lease_token uuid;
ALTER TABLE documents ADD COLUMN lease_until timestamptz;
ALTER TABLE documents ADD COLUMN attempted_at timestamptz;

CREATE FUNCTION immutable_ready_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'READY' THEN
    RAISE EXCEPTION 'Ready documents are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER documents_no_ready_change BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION immutable_ready_document();

INSERT INTO documents (order_id,template_version_id)
SELECT id,(snapshot->'terms'->>'id')::uuid FROM orders
WHERE status IN ('PAID','REFUNDED') AND purchase_kind <> 'DRUMKIT'
ON CONFLICT (order_id) DO NOTHING;

ALTER TABLE free_acceptances DROP CONSTRAINT free_acceptances_user_id_product_id_key;
ALTER TABLE free_acceptances ADD CONSTRAINT free_acceptances_version_key
  UNIQUE (user_id,product_id,terms_version_id);
