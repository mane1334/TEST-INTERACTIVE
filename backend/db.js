const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

let dbType = process.env.DB_TYPE || 'sqlite';
let pool = null;
let sqliteDb = null;

// Função para inicializar PostgreSQL
const initPostgreSQL = () => {
  try {
    pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'restaurantes',
      password: process.env.DB_PASSWORD || '',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    console.log('✅ PostgreSQL inicializado');
    return true;
  } catch (error) {
    console.error('❌ Erro ao inicializar PostgreSQL:', error.message);
    return false;
  }
};

// Função para inicializar SQLite
const initSQLite = () => {
  try {
    // Load SQLite only when the application is configured to use SQLite.
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, 'database.sqlite');
    sqliteDb = new sqlite3.Database(dbPath);
    console.log('✅ SQLite inicializado');

    // Criar tabelas se não existirem
    createSQLiteTables();

    return true;
  } catch (error) {
    console.error('❌ Erro ao inicializar SQLite:', error.message);
    return false;
  }
};

// Função para criar tabelas SQLite
const createSQLiteTables = () => {
  const tables = [
    `CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_name TEXT,
      phone_number TEXT,
      email TEXT,
      address TEXT,
      cuisine_type TEXT,
      tax_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS dishes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      category_id INTEGER,
      image_url TEXT,
      image_urls TEXT,
      is_available INTEGER DEFAULT 1,
      preparation_time INTEGER,
      calories INTEGER,
      is_spicy INTEGER DEFAULT 0,
      is_vegetarian INTEGER DEFAULT 0,
      is_gluten_free INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      table_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_price REAL,
      prep_time_seconds INTEGER,
      cancel_until DATETIME,
      cancellation_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      dish_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1,
      item_price REAL NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'waiter',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS advertisements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      content TEXT,
      image_url TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      dish_id INTEGER,
      order_id INTEGER,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      restaurant_id INTEGER DEFAULT 1,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(key, restaurant_id)
    )`,

    `CREATE TABLE IF NOT EXISTS waiter_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      table_number INTEGER NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ai_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      scope TEXT DEFAULT 'general',
      source TEXT DEFAULT 'system',
      kind TEXT DEFAULT 'note',
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS backend_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name TEXT NOT NULL,
      status TEXT DEFAULT 'ok',
      details TEXT,
      started_at DATETIME,
      heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    )`
  ];

  tables.forEach(tableSQL => {
    sqliteDb.run(tableSQL, (err) => {
      if (err) {
        console.error('❌ Erro ao criar tabela:', err.message);
      }
    });
  });

  // Inserir dados básicos
  const insertDefaults = () => {
    // Inserir Restaurante Padrão
    sqliteDb.run(
      "INSERT OR IGNORE INTO restaurants (id, name) VALUES (1, 'Restaurante Sede')"
    );

    // Inserir categorias básicas
    const categories = [
      ['Entradas', 'Pratos leves para começar'],
      ['Pratos Principais', 'Seleção de pratos principais'],
      ['Sobremesas', 'Doces para finalizar'],
      ['Bebidas', 'Bebidas variadas']
    ];

    sqliteDb.get("SELECT COUNT(*) as count FROM categories", (err, row) => {
      if (!err && row.count === 0) {
        categories.forEach(([name, description]) => {
          sqliteDb.run(
            'INSERT INTO categories (name, description) VALUES (?, ?)',
            [name, description]
          );
        });
      }
    });

    // Inserir configuração padrão
    sqliteDb.run(
      "INSERT OR IGNORE INTO settings (key, value, restaurant_id) VALUES ('restaurant_name', 'Restaurante Sede', 1)"
    );
  };

  insertDefaults();

  // Executar migrações
  migrateTables();

  console.log('✅ Tabelas SQLite criadas/verificadas');
};

// Função para migrar tabelas (adicionar colunas novas em bancos existentes)
const migrateTables = () => {
  // Migração para tabela dishes (Adicionar preparation_time e calories)
  sqliteDb.all("PRAGMA table_info(dishes)", (err, rows) => {
    if (err) {
      console.error('Erro ao verificar esquema da tabela dishes:', err);
      return;
    }

    const hasPrepTime = rows.some(row => row.name === 'preparation_time');
    const hasCalories = rows.some(row => row.name === 'calories');

    if (!hasPrepTime) {
      console.log('🔄 Migrando: Adicionando column preparation_time em dishes...');
      sqliteDb.run("ALTER TABLE dishes ADD COLUMN preparation_time INTEGER", (err) => {
        if (err) console.error('Erro ao adicionar preparation_time:', err);
      });
    }

    if (!hasCalories) {
      console.log('🔄 Migrando: Adicionando column calories em dishes...');
      sqliteDb.run("ALTER TABLE dishes ADD COLUMN calories INTEGER", (err) => {
        if (err) console.error('Erro ao adicionar calories:', err);
      });
    }
  });

  // Migração Multi-tenant
  sqliteDb.all("PRAGMA table_info(dishes)", (err, rows) => {
    if (err || rows.length === 0) return;

    const additionalDishColumns = [
      ['image_urls', 'TEXT'],
      ['is_spicy', 'INTEGER DEFAULT 0'],
      ['is_vegetarian', 'INTEGER DEFAULT 0'],
      ['is_gluten_free', 'INTEGER DEFAULT 0'],
    ];

    additionalDishColumns.forEach(([colName, colDef]) => {
      if (!rows.some(row => row.name === colName)) {
        console.log(`Migrando: Adicionando column ${colName} em dishes...`);
        sqliteDb.run(`ALTER TABLE dishes ADD COLUMN ${colName} ${colDef}`, (alterErr) => {
          if (alterErr) console.error(`Erro ao adicionar ${colName}:`, alterErr);
        });
      }
    });
  });

  sqliteDb.all("PRAGMA table_info(orders)", (err, rows) => {
    if (err || rows.length === 0) return;

    if (!rows.some(row => row.name === 'cancellation_reason')) {
      console.log('Migrando: Adicionando column cancellation_reason em orders...');
      sqliteDb.run("ALTER TABLE orders ADD COLUMN cancellation_reason TEXT", (alterErr) => {
        if (alterErr) console.error('Erro ao adicionar cancellation_reason:', alterErr);
      });
    }
  });

  const tenantTables = ['categories', 'dishes', 'orders', 'users', 'advertisements', 'ratings', 'settings', 'waiter_calls', 'ai_memory_entries'];
  tenantTables.forEach(tableName => {
    // Note: waiter_calls might not exist in old versions, sqlite limits alter table but pragma table_info fails gracefully if missing.
    sqliteDb.all(`PRAGMA table_info(${tableName})`, (err, rows) => {
      if (err || rows.length === 0) return;
      const hasRestaurantId = rows.some(row => row.name === 'restaurant_id');
      if (!hasRestaurantId) {
        console.log(`🔄 Migrando: Adicionando column restaurant_id em ${tableName}...`);
        sqliteDb.run(`ALTER TABLE ${tableName} ADD COLUMN restaurant_id INTEGER DEFAULT 1`, (alterErr) => {
            if (alterErr) console.error(`Erro ao migrar ${tableName}:`, alterErr);
        });
      }
    });
  });

  sqliteDb.all("PRAGMA table_info(restaurants)", (err, rows) => {
    if (err || rows.length === 0) return;

    const migrateColumn = (colName, colDef) => {
      if (!rows.some(row => row.name === colName)) {
        console.log(`🔄 Migrando: Adicionando column ${colName} em restaurants...`);
        sqliteDb.run(`ALTER TABLE restaurants ADD COLUMN ${colName} ${colDef}`, (alterErr) => {
          if (alterErr) console.error(`Erro ao adicionar ${colName} em restaurants:`, alterErr);
        });
      }
    };

    migrateColumn('owner_name', 'TEXT');
    migrateColumn('phone_number', 'TEXT');
    migrateColumn('email', 'TEXT');
    migrateColumn('address', 'TEXT');
    migrateColumn('cuisine_type', 'TEXT');
    migrateColumn('tax_id', 'TEXT');
    migrateColumn('is_active', 'INTEGER DEFAULT 1');
  });

  sqliteDb.all("PRAGMA table_info(settings)", (err, rows) => {
    if (err || rows.length === 0) return;

    const hasId = rows.some(row => row.name === 'id');
    const keyIsPrimaryKey = rows.some(row => row.name === 'key' && row.pk === 1);

    if (!hasId || keyIsPrimaryKey) {
      sqliteDb.serialize(() => {
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS settings_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            restaurant_id INTEGER DEFAULT 1,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(key, restaurant_id)
          )
        `, (createErr) => {
          if (createErr) {
            console.error('Erro ao criar settings_v2:', createErr);
            return;
          }

          sqliteDb.run(`
            INSERT OR IGNORE INTO settings_v2 (key, restaurant_id, value, updated_at)
            SELECT key, COALESCE(restaurant_id, 1), value, updated_at FROM settings
          `, (copyErr) => {
            if (copyErr) {
              console.error('Erro ao migrar dados para settings_v2:', copyErr);
              return;
            }

            sqliteDb.run('DROP TABLE IF EXISTS settings', (dropErr) => {
              if (dropErr) {
                console.error('Erro ao remover tabela settings antiga:', dropErr);
                return;
              }

              sqliteDb.run('ALTER TABLE settings_v2 RENAME TO settings', (renameErr) => {
                if (renameErr) {
                  console.error('Erro ao renomear settings_v2:', renameErr);
                }
              });
            });
          });
        });
      });
    }
  });

  sqliteDb.all("PRAGMA table_info(backend_heartbeats)", (err, rows) => {
    if (err || rows.length === 0) return;

    const migrateColumn = (colName, colDef) => {
      if (!rows.some(row => row.name === colName)) {
        console.log(`ðŸ”„ Migrando: Adicionando column ${colName} em backend_heartbeats...`);
        sqliteDb.run(`ALTER TABLE backend_heartbeats ADD COLUMN ${colName} ${colDef}`, (alterErr) => {
          if (alterErr) console.error(`Erro ao adicionar ${colName} em backend_heartbeats:`, alterErr);
        });
      }
    };

    migrateColumn('details', 'TEXT');
    migrateColumn('started_at', 'DATETIME');
    migrateColumn('heartbeat_at', "DATETIME DEFAULT CURRENT_TIMESTAMP");
    migrateColumn('metadata', 'TEXT');
  });
};

// Função para converter query PostgreSQL para SQLite
const convertQuery = (text, params) => {
  if (dbType === 'sqlite') {
    let convertedText = text;

    // Converter placeholders $1, $2, etc. para ?
    let paramIndex = 1;
    while (convertedText.includes(`$${paramIndex}`)) {
      convertedText = convertedText.replace(new RegExp(`\$${paramIndex}`, 'g'), '?');
      paramIndex++;
    }

    // Funções de Data e Hora
    convertedText = convertedText.replace(/to_char\(([^,]+),\s*'YYYY-MM-DD'\)/g, "strftime('%Y-%m-%d', $1)");
    convertedText = convertedText.replace(/NOW\(\) - INTERVAL '(\d+) days'/g, "datetime('now', '-$1 days')");
    convertedText = convertedText.replace(/CURRENT_DATE/g, "date('now')");
    convertedText = convertedText.replace(/date_trunc\('month', ([^\)]+)\)/g, "date($1, 'start of month')");
    convertedText = convertedText.replace(/EXTRACT\(EPOCH FROM \(([^\s]+) - ([^\)]+)\)\)/g, "(strftime('%s', $1) - strftime('%s', $2))");
    convertedText = convertedText.replace(/EXTRACT\(EPOCH FROM ([^\)]+)\)/g, "strftime('%s', $1)");

    // Funções JSON
    convertedText = convertedText.replace(/json_build_object/g, 'json_object');
    convertedText = convertedText.replace(/json_agg/g, 'json_group_array');

    // Tipos de Dados e Casts
    convertedText = convertedText.replace(/::date/g, '');
    convertedText = convertedText.replace(/SERIAL\s+PRIMARY\s+KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');
    convertedText = convertedText.replace(/TIMESTAMP WITH TIME ZONE/g, 'DATETIME');
    convertedText = convertedText.replace(/NUMERIC\(\d+,\s*\d+\)/g, 'REAL');
    convertedText = convertedText.replace(/VARCHAR\(\d+\)/g, 'TEXT');
    convertedText = convertedText.replace(/BOOLEAN/g, 'INTEGER');
    convertedText = convertedText.replace(/\bTRUE\b/g, '1');
    convertedText = convertedText.replace(/\bFALSE\b/g, '0');

    return { text: convertedText, params };
  }
  return { text, params };
};

// Função de query unificada
const query = async (text, params = []) => {
  const { text: convertedText, params: convertedParams } = convertQuery(text, params);

  if (dbType === 'postgresql' && pool) {
    try {
      const result = await pool.query(convertedText, convertedParams);
      return result;
    } catch (error) {
      console.error('❌ Erro PostgreSQL:', error.message);
      // Fallback para SQLite se PostgreSQL falhar
      if (dbType === 'postgresql') {
        console.log('🔄 Tentando fallback para SQLite...');
        dbType = 'sqlite';
        if (initSQLite()) {
          return await query(text, params);
        }
      }
      throw error;
    }
  } else if (dbType === 'sqlite' && sqliteDb) {
    return new Promise((resolve, reject) => {
      if (convertedText.trim().toUpperCase().startsWith('SELECT')) {
        sqliteDb.all(convertedText, convertedParams, (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve({ rows });
          }
        });
      } else {
        sqliteDb.run(convertedText, convertedParams, function (err) {
          if (err) {
            reject(err);
          } else {
            resolve({
              rows: [{ id: this.lastID }],
              rowCount: this.changes
            });
          }
        });
      }
    });
  } else {
    throw new Error('Banco de dados não inicializado');
  }
};

// Inicializar banco de dados
const initDatabase = () => {
  if (dbType === 'postgresql') {
    if (!initPostgreSQL()) {
      console.log('🔄 PostgreSQL falhou, usando SQLite como fallback...');
      dbType = 'sqlite';
      initSQLite();
    }
  } else if (dbType === 'sqlite') {
    initSQLite();
  } else {
    // Se não especificado, usar SQLite por padrão
    console.log('🔄 Usando SQLite como padrão...');
    dbType = 'sqlite';
    initSQLite();
  }
};

// Inicializar na importação
initDatabase();

module.exports = {
  pool,
  sqliteDb,
  query,
  getDbType: () => dbType,
  setDbType: (type) => {
    dbType = type;
    if (type === 'postgresql') {
      initPostgreSQL();
    } else if (type === 'sqlite') {
      initSQLite();
    }
  }
};
