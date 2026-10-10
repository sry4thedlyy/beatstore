CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) > 3),
  artist_name text NOT NULL CHECK (length(trim(artist_name)) > 0),
  role text NOT NULL DEFAULT 'CUSTOMER' CHECK (role IN ('CUSTOMER', 'ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL, object_key text NOT NULL,
  original_name text NOT NULL, content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0), checksum text,
  kind text NOT NULL CHECK (kind IN ('COVER','THUMBNAIL','PREVIEW','MP3','WAV','STEMS','PROJECT','DRUMKIT','DOCUMENT')),
  status text NOT NULL CHECK (status IN ('PENDING','READY','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key),
  CHECK (status <> 'READY' OR (size_bytes > 0 AND checksum IS NOT NULL))
);

CREATE TABLE terms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('FREE_MP3','MP3','WAV','STEMS','EXCLUSIVE','DRUMKIT')),
  version text NOT NULL, body text NOT NULL, parameters jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version), CHECK (jsonb_typeof(parameters) = 'object')
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('BEAT','DRUMKIT')),
  title text NOT NULL CHECK (length(trim(title)) > 0), description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','UNPUBLISHED','EXCLUSIVE_SOLD')),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  cover_file_id uuid REFERENCES files(id), thumbnail_file_id uuid REFERENCES files(id),
  preview_file_id uuid REFERENCES files(id), duration_seconds integer CHECK (duration_seconds > 0),
  authors text[], bpm integer CHECK (bpm > 0), musical_key text,
  royalty_percent numeric(5,2) CHECK (royalty_percent BETWEEN 0 AND 100), project_requirements text,
  reserved_order_id uuid, reservation_expires_at timestamptz, exclusive_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reserved_order_id IS NULL) = (reservation_expires_at IS NULL)),
  CHECK (type = 'BEAT' OR (authors IS NULL AND bpm IS NULL AND musical_key IS NULL
    AND royalty_percent IS NULL AND project_requirements IS NULL AND reserved_order_id IS NULL
    AND exclusive_order_id IS NULL AND status <> 'EXCLUSIVE_SOLD'))
);
CREATE INDEX products_catalog_idx ON products (created_at DESC, id) WHERE status = 'PUBLISHED';

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id),
  kind text NOT NULL CHECK (kind IN ('MP3','WAV','STEMS','EXCLUSIVE','DRUMKIT')),
  base_price_kopecks integer CHECK (base_price_kopecks > 0),
  file_id uuid REFERENCES files(id), terms_version_id uuid REFERENCES terms_versions(id),
  UNIQUE (product_id, kind), UNIQUE (id, product_id)
);

CREATE TABLE free_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  product_id uuid REFERENCES products(id), product_snapshot jsonb NOT NULL,
  terms_version_id uuid NOT NULL REFERENCES terms_versions(id),
  accepted_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, product_id),
  CHECK (jsonb_typeof(product_snapshot) = 'object')
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  product_id uuid REFERENCES products(id), offer_id uuid,
  purchase_kind text NOT NULL CHECK (purchase_kind IN ('MP3','WAV','STEMS','EXCLUSIVE','DRUMKIT')),
  status text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK (status IN ('AWAITING_PAYMENT','PAID','CANCELLED','REFUNDED')),
  base_price_kopecks integer NOT NULL CHECK (base_price_kopecks > 0),
  discount_percent numeric(5,2) NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  total_kopecks integer NOT NULL CHECK (total_kopecks > 0), currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  paid_at timestamptz, refunded_at timestamptz,
  UNIQUE (id, product_id),
  FOREIGN KEY (offer_id, product_id) REFERENCES offers(id, product_id) MATCH FULL,
  CHECK (product_id IS NOT NULL OR (status = 'CANCELLED' AND paid_at IS NULL)),
  CHECK ((status IN ('PAID','REFUNDED')) = (paid_at IS NOT NULL)),
  CHECK ((status = 'REFUNDED') = (refunded_at IS NOT NULL)),
  CHECK (purchase_kind <> 'EXCLUSIVE' OR (discount_percent = 0 AND total_kopecks = base_price_kopecks)),
  CHECK (total_kopecks = round(base_price_kopecks * (100 - discount_percent) / 100))
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE UNIQUE INDEX orders_one_exclusive_sale ON orders (product_id)
  WHERE purchase_kind = 'EXCLUSIVE' AND paid_at IS NOT NULL;
ALTER TABLE products ADD CONSTRAINT products_reservation_fk
  FOREIGN KEY (reserved_order_id, id) REFERENCES orders(id, product_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE products ADD CONSTRAINT products_exclusive_fk
  FOREIGN KEY (exclusive_order_id, id) REFERENCES orders(id, product_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE order_files (
  order_id uuid NOT NULL REFERENCES orders(id), file_id uuid NOT NULL REFERENCES files(id),
  PRIMARY KEY (order_id, file_id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
  provider text NOT NULL, provider_payment_id text, idempotency_key text NOT NULL UNIQUE,
  environment text NOT NULL DEFAULT 'TEST' CHECK (environment = 'TEST'),
  status text NOT NULL CHECK (status IN ('CREATING','PENDING','SUCCEEDED','CANCELLED','FAILED','REFUNDED')),
  amount_kopecks integer NOT NULL CHECK (amount_kopecks > 0), currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, environment, provider_payment_id)
);
CREATE UNIQUE INDEX payments_one_active_attempt ON payments (order_id) WHERE status IN ('CREATING','PENDING');

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  template_version_id uuid NOT NULL REFERENCES terms_versions(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','READY','FAILED')),
  file_id uuid REFERENCES files(id), generated_at timestamptz, last_error text,
  CHECK (status <> 'READY' OR (file_id IS NOT NULL AND generated_at IS NOT NULL))
);

CREATE FUNCTION immutable_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Terms versions are immutable; insert a new version'; END;
$$;
CREATE TRIGGER terms_no_update BEFORE UPDATE OR DELETE ON terms_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_terms();

-- Deferred checks allow uploading assets and filling offers before publishing in one transaction.
CREATE FUNCTION validate_published_product(target_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; offer_count integer; valid_count integer;
BEGIN
  SELECT * INTO p FROM products WHERE id = target_id;
  IF NOT FOUND OR p.status <> 'PUBLISHED' THEN RETURN; END IF;
  IF p.duration_seconds IS NULL OR NOT EXISTS (
    SELECT 1 FROM files c, files t, files a
    WHERE c.id = p.cover_file_id AND t.id = p.thumbnail_file_id AND a.id = p.preview_file_id
      AND c.status = 'READY' AND t.status = 'READY' AND a.status = 'READY'
      AND c.kind = 'COVER' AND t.kind = 'THUMBNAIL' AND a.kind IN ('PREVIEW','MP3')
      AND c.content_type LIKE 'image/%' AND t.content_type LIKE 'image/%' AND a.content_type = 'audio/mpeg'
  ) THEN RAISE EXCEPTION 'Published product requires ready covers and MP3 preview'; END IF;
  IF p.type = 'BEAT' AND (coalesce(cardinality(p.authors),0) = 0 OR p.bpm IS NULL
    OR coalesce(trim(p.musical_key),'') = '' OR p.royalty_percent IS NULL OR p.project_requirements IS NULL)
  THEN RAISE EXCEPTION 'Published beat requires authors, BPM, key, royalties and project requirements'; END IF;
  SELECT count(*) INTO offer_count FROM offers WHERE product_id = p.id;
  SELECT count(*) INTO valid_count FROM offers o JOIN files f ON f.id = o.file_id
    JOIN terms_versions v ON v.id = o.terms_version_id
    WHERE o.product_id = p.id AND o.base_price_kopecks > 0 AND f.status = 'READY' AND v.kind = o.kind
      AND round(o.base_price_kopecks * (100 - CASE WHEN o.kind = 'EXCLUSIVE' THEN 0 ELSE p.discount_percent END) / 100) > 0
      AND ((p.type = 'BEAT' AND o.kind IN ('MP3','WAV','STEMS','EXCLUSIVE')) OR (p.type = 'DRUMKIT' AND o.kind = 'DRUMKIT'))
      AND ((o.kind = 'MP3' AND f.content_type = 'audio/mpeg' AND f.kind IN ('MP3','PREVIEW'))
        OR (o.kind = 'WAV' AND f.content_type = 'audio/wav' AND f.kind = 'WAV')
        OR (o.kind = 'STEMS' AND f.content_type = 'application/zip' AND f.kind = 'STEMS')
        OR (o.kind = 'EXCLUSIVE' AND f.content_type = 'application/zip' AND f.kind = 'PROJECT')
        OR (o.kind = 'DRUMKIT' AND f.content_type = 'application/zip' AND f.kind = 'DRUMKIT' AND f.size_bytes <= 524288000));
  IF offer_count <> (CASE WHEN p.type = 'BEAT' THEN 4 ELSE 1 END) OR valid_count <> offer_count
  THEN RAISE EXCEPTION 'Published product requires all valid offers'; END IF;
END;
$$;
CREATE FUNCTION check_product_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'products' THEN PERFORM validate_published_product(NEW.id);
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM validate_published_product(OLD.product_id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM validate_published_product(NEW.product_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER products_publication AFTER INSERT OR UPDATE ON products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_product_publication();
CREATE CONSTRAINT TRIGGER offers_publication AFTER INSERT OR UPDATE OR DELETE ON offers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_product_publication();

CREATE FUNCTION check_published_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  FOR target_id IN SELECT p.id FROM products p WHERE p.cover_file_id = NEW.id
    OR p.thumbnail_file_id = NEW.id OR p.preview_file_id = NEW.id
    OR EXISTS (SELECT 1 FROM offers o WHERE o.product_id = p.id AND o.file_id = NEW.id)
  LOOP PERFORM validate_published_product(target_id); END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER files_publication AFTER UPDATE ON files
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_published_file();
