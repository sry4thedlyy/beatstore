ALTER TABLE products ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE FUNCTION preserve_exclusive_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'EXCLUSIVE_SOLD' AND NEW.status <> 'EXCLUSIVE_SOLD' THEN
    RAISE EXCEPTION 'An exclusive sale cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_preserve_exclusive BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION preserve_exclusive_sale();
