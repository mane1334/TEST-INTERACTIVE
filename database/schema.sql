-- Drop existing tables in reverse order of creation to handle dependencies
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS ratings CASCADE;
DROP TABLE IF EXISTS advertisements CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS dishes CASCADE;
DROP TABLE IF EXISTS categories CASCADE;

-- Tabela de Categorias de Pratos
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Pratos
CREATE TABLE IF NOT EXISTS dishes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL,
    category_id INTEGER REFERENCES categories(id),
    image_url VARCHAR(2048),
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Pedidos
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    table_number INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, preparing, ready, delivered, cancelled
    total_price NUMERIC(10, 2),
    -- Tempo de preparo estimado em segundos (ex.: 1200 = 20 minutos)
    prep_time_seconds INTEGER,
    -- Limite de cancelamento: até quando o cliente pode cancelar
    cancel_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Itens do Pedido (Tabela de Junção)
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    dish_id INTEGER REFERENCES dishes(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    item_price NUMERIC(10, 2) NOT NULL -- Preço no momento do pedido
);

-- Tabela de Usuários (Garçons, Administradores)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'waiter', -- waiter, admin
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Publicidade
CREATE TABLE IF NOT EXISTS advertisements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    image_url VARCHAR(2048),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Avaliações
CREATE TABLE IF NOT EXISTS ratings (
    id SERIAL PRIMARY KEY,
    dish_id INTEGER REFERENCES dishes(id),
    order_id INTEGER REFERENCES orders(id),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Configurações
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seeds básicos (execute uma vez)
-- Categorias
INSERT INTO categories (name, description) VALUES
  ('Entradas', 'Pratos leves para começar'),
  ('Pratos Principais', 'Seleção de pratos principais'),
  ('Sobremesas', 'Doces para finalizar'),
  ('Bebidas', 'Bebidas variadas')
ON CONFLICT DO NOTHING;

-- Configuração Padrão
INSERT INTO settings (key, value) VALUES
  ('restaurant_name', 'Restaurante Gêmeos')
ON CONFLICT (key) DO NOTHING;

-- Pratos
INSERT INTO dishes (name, description, price, category_id, image_url, is_available)
SELECT seed.name, seed.description, seed.price, seed.category_id, seed.image_url, seed.is_available
FROM (
  SELECT 'Bruschetta' AS name,
         'Pão italiano com tomate e manjericão' AS description,
         4.90::numeric AS price,
         (SELECT id FROM categories WHERE name = 'Entradas') AS category_id,
         'https://images.unsplash.com/photo-1604908554063-f0b6a6f5d1ea?q=80&w=1200&auto=format&fit=crop' AS image_url,
         TRUE AS is_available
  UNION ALL
  SELECT 'Spaghetti à Bolonhesa',
         'Massa com molho de carne',
         12.90::numeric,
         (SELECT id FROM categories WHERE name = 'Pratos Principais'),
         'https://images.unsplash.com/photo-1603133872878-684f208fbbe5?q=80&w=1200&auto=format&fit=crop',
         TRUE
  UNION ALL
  SELECT 'Risoto de Cogumelos',
         'Risoto cremoso com cogumelos',
         14.50::numeric,
         (SELECT id FROM categories WHERE name = 'Pratos Principais'),
         'https://images.unsplash.com/photo-1617196034796-73d3a23e37f2?q=80&w=1200&auto=format&fit=crop',
         TRUE
  UNION ALL
  SELECT 'Tiramisù',
         'Clássica sobremesa italiana',
         6.90::numeric,
         (SELECT id FROM categories WHERE name = 'Sobremesas'),
         'https://images.unsplash.com/photo-1612195735639-1b1d3f3f94a5?q=80&w=1200&auto=format&fit=crop',
         TRUE
  UNION ALL
  SELECT 'Suco de Laranja',
         'Suco natural',
         3.50::numeric,
         (SELECT id FROM categories WHERE name = 'Bebidas'),
         'https://images.unsplash.com/photo-1570158268183-d296b2892211?q=80&w=1200&auto=format&fit=crop',
         TRUE
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM dishes d WHERE d.name = seed.name
);

-- Anúncios
INSERT INTO advertisements (title, content, image_url, start_date, end_date, is_active)
SELECT seed.title, seed.content, seed.image_url, seed.start_date, seed.end_date, seed.is_active
FROM (
  SELECT 'Promoção de Almoço' AS title,
         'Desconto especial no almoço!' AS content,
         'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200&auto=format&fit=crop' AS image_url,
         CURRENT_DATE AS start_date,
         CURRENT_DATE + INTERVAL '7 day' AS end_date,
         TRUE AS is_active
  UNION ALL
  SELECT 'Sobremesa Grátis',
         'Na compra de 2 pratos principais',
         'https://images.unsplash.com/photo-1551024709-8f23befc6cf7?q=80&w=1200&auto=format&fit=crop',
         CURRENT_DATE,
         CURRENT_DATE + INTERVAL '14 day',
         TRUE
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM advertisements a WHERE a.title = seed.title
);

-- Vídeo por prato, nota do pedido e código de acesso do pedido
ALTER TABLE dishes ADD COLUMN IF NOT EXISTS video_url VARCHAR(2048);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS access_code VARCHAR(32);
