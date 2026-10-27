const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const db = require('./db');
const {
  getChatResponse,
  getChatResponseStream,
  getRestaurantInsights,
  transcribeAudio,
  textToSpeech
} = require('ai-module');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken, JWT_SECRET } = require('./middleware/auth');
const { isLocalPath, deleteIfUnused } = require('./utils/imageCleanup');

let helmet = null;
let rateLimit = null;

try {
  helmet = require('helmet');
} catch (error) {
  console.warn('helmet não está instalado. Aplicando apenas headers básicos de segurança.');
}

try {
  rateLimit = require('express-rate-limit');
} catch (error) {
  console.warn('express-rate-limit não está instalado. Aplicando rate limiting em memória simplificado.');
}

// --- Global Error Handlers to prevent crash ---
process.on('uncaughtException', (err) => {
  console.error('CRITICAL ERROR (Uncaught Exception):', err);
  // Keep alive logic or graceful shutdown depending on preference.
  // For this user request "server crashes too much", we try to keep it alive but log heavily.
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL ERROR (Unhandled Rejection) at:', promise, 'reason:', reason);
});

// Configuração do Multer para upload de arquivos
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const aiAudioDir = process.env.AI_AUDIO_DIR || path.join(uploadDir, 'ai-audio');
if (!fs.existsSync(aiAudioDir)) {
  fs.mkdirSync(aiAudioDir, { recursive: true });
}
// Multer genérico já utilizado para uploads de áudio, etc.
const upload = multer({ dest: uploadDir });
// Multer específico para imagens com limites e filtro de tipo
const imageUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file && file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
});

const app = express();
const server = http.createServer(app);
const requestBuckets = new Map();

const createFallbackRateLimiter = ({ windowMs, max }) => (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = requestBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    requestBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (bucket.count >= max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', retryAfterSeconds);
    return res.status(429).json({ error: 'Muitas requisições. Tente novamente em instantes.' });
  }

  bucket.count += 1;
  return next();
};

const apiLimiter = rateLimit
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      max: Number(process.env.API_RATE_LIMIT_MAX || 300),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Muitas requisições. Tente novamente em instantes.' },
    })
  : createFallbackRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: Number(process.env.API_RATE_LIMIT_MAX || 300),
    });

// CORS: Configuração melhorada para desenvolvimento e produção
const isDevelopment = process.env.NODE_ENV !== 'production';

if (isDevelopment) {
  // Em desenvolvimento: permitir todas as origens para facilitar testes
  console.log(' Modo desenvolvimento: CORS liberado para todas as origens');
  app.use(cors({
    origin: true, // Permite qualquer origem em desenvolvimento
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    credentials: true,
  }));
} else {
  // Em produção: usar whitelist configurável
  console.log(' Modo produção: CORS restritivo ativado');

  // 1) Leia da env CORS_ORIGIN como lista separada por vírgula
  const configuredOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(v => v && v.trim())
    .filter(Boolean);

  // 2) Se não houver, derive automaticamente a partir de PUBLIC_HOST/IP com portas padrão
  const publicHost = process.env.PUBLIC_HOST || process.env.HOST;
  const derivedOrigins = [];
  if (publicHost) {
    // Suporte a http/https e portas dos frontends por padrão
    const candidateBases = [
      `http://${publicHost}:3001`,
      `http://${publicHost}:3002`,
      `http://${publicHost}:5173`, // Vite dev server
      `https://${publicHost}`,
      `http://${publicHost}`,
    ];
    derivedOrigins.push(...candidateBases);
  }

  // 3) Sempre permita localhost em portas comuns como fallback (útil em VPS com tunel ou preview)
  const fallbackOrigins = [
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:5173',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:5173',
    'http://155.138.208.164:3000', // VPS IP - Backend
    'http://155.138.208.164',      // VPS IP - Frontend default
  ];

  const whitelist = Array.from(new Set([...configuredOrigins, ...derivedOrigins, ...fallbackOrigins]));

  console.log(' Origens CORS permitidas:', whitelist);

  const corsOptions = {
    origin: function (origin, callback) {
      // Permitir requisições sem header Origin (ex.: curl, healthchecks, Postman)
      if (!origin) return callback(null, true);

      // Log para debug
      console.log(` Requisição de origem: ${origin}`);

      if (whitelist.includes(origin)) {
        console.log(`✅ Origem permitida: ${origin}`);
        return callback(null, true);
      }

      console.log(`❌ Origem bloqueada: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    credentials: true,
  };
  app.use(cors(corsOptions));
}

if (helmet) {
  app.use(helmet({
    crossOriginResourcePolicy: false,
  }));
}

app.use('/api', apiLimiter);
app.use(express.json());

// Adiciona cabeçalhos de segurança recomendados
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


const port = process.env.PORT || 3000; // porta via env, fallback 3000

server.on('error', (error) => {
  console.error('Erro no servidor HTTP:', error);
});

const wss = new WebSocket.Server({ noServer: true });
const WS_HEARTBEAT_INTERVAL_MS = Number(process.env.WS_HEARTBEAT_INTERVAL_MS || 30000);

// Função para broadcast de mensagens para todos os clientes
wss.broadcast = function broadcast(data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, (err) => {
        if (err) {
          console.error('Erro ao enviar mensagem para o cliente:', err);
        }
      });
    }
  });
};

const sendWsJson = (ws, payload) => {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify(payload), (err) => {
    if (err) {
      console.error('Erro ao enviar mensagem WebSocket:', err);
    }
  });
};

// Anexar o servidor WebSocket ao servidor HTTP
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

// Lógica de conexão WebSocket
// Tratamento de erro geral para o servidor WebSocket
wss.on('error', error => {
  console.error('Erro no servidor WebSocket:', error);
});

const wsHeartbeatTimer = process.env.NODE_ENV !== 'test'
  ? setInterval(() => {
      wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }

        ws.isAlive = false;
        try {
          ws.ping();
        } catch (_) {
          ws.terminate();
        }
      });
    }, WS_HEARTBEAT_INTERVAL_MS)
  : null;

wsHeartbeatTimer?.unref?.();

// --- Lógica para Streaming de Logs ---

const logFiles = {
  stdout: path.join(__dirname, 'server.out.log'),
  stderr: path.join(__dirname, 'server.err.log'),
};

// Função para enviar o conteúdo de um log para um cliente específico
const sendLogFile = (ws, source) => {
  const filePath = logFiles[source];
  if (!fs.existsSync(filePath)) return;

  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      console.error(`Erro ao ler o arquivo de log ${source}:`, err);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'LOG_DATA',
        payload: { source, content }
      }), (err) => {
        if (err) console.error(`Erro ao enviar dados de log (${source}) para o cliente:`, err);
      });
    }
  });
};

// Função para observar um arquivo de log e transmitir alterações
const watchLogFile = (source) => {
  const filePath = logFiles[source];

  // Garante que o arquivo exista antes de observá-lo
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, ``, 'utf8');
    console.log(`Arquivo de log criado: ${filePath}`);
  }

  fs.watch(filePath, (eventType) => {
    if (eventType === 'change') {
      fs.readFile(filePath, 'utf8', (err, content) => {
        if (err) {
          console.error(`Erro ao ler o arquivo de log ${source} após alteração:`, err);
          return;
        }
        // Transmite a atualização para todos os clientes
        wss.broadcast(JSON.stringify({
          type: 'LOG_DATA',
          payload: { source, content }
        }));
      });
    }
  });
};

// Inicia a observação dos arquivos de log
if (process.env.NODE_ENV !== 'test') {
  watchLogFile('stdout');
  watchLogFile('stderr');
}

// Modifica a lógica de conexão para enviar os logs iniciais
wss.on('connection', ws => {
  console.log('Cliente WebSocket conectado e recebendo logs.');
  ws.isAlive = true;

  // Envia o conteúdo atual dos logs assim que o cliente se conecta
  sendLogFile(ws, 'stdout');
  sendLogFile(ws, 'stderr');

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data && data.type === 'PING') {
        ws.isAlive = true;
        sendWsJson(ws, { type: 'PONG' });
      }
      if (data && data.type === 'PONG') ws.isAlive = true;
    } catch (_) {
      // ignora mensagens que não são JSON
    }
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    console.log('Cliente WebSocket desconectado do stream de logs.');
  });

  ws.on('error', error => {
    console.error('Erro no WebSocket do cliente (logs):', error);
  });
});





// --- Middleware SaaS (Multi-tenant) ---
const extractTenant = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.restaurant_id = decoded.restaurant_id;
      req.user_role = decoded.role;
    } catch (e) { }
  } else {
    // Check header for ClientApp
    const clientAppHeader = req.headers['x-restaurant-id'];
    if (clientAppHeader) {
       req.restaurant_id = parseInt(clientAppHeader, 10);
    }
  }
  
  // Safeguard: fallback para Restaurante 1 se não vier (Backward-compatible antes de ClientApp update)
  if (!req.restaurant_id) {
     req.restaurant_id = 1; 
  }
  next();
};

app.use(extractTenant);

const requireAuthenticated = (req, res, next) => {
  if (process.env.NODE_ENV === 'test') return next();
  return authenticateToken(req, res, next);
};

const requireSuperadminAuth = (req, res, next) => {
  if (process.env.NODE_ENV === 'test') return next();
  if ((req.user?.role || req.user_role) !== 'superadmin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas superadmins.' });
  }
  return next();
};

const protectMethods = (methods) => (req, res, next) => (
  methods.includes(req.method) ? requireAuthenticated(req, res, next) : next()
);

app.use('/api/categories', protectMethods(['POST', 'PUT', 'PATCH', 'DELETE']));
app.use('/api/dishes', protectMethods(['POST', 'PUT', 'PATCH', 'DELETE']));
app.use('/api/uploads', requireAuthenticated);
app.use('/api/ratings', protectMethods(['PUT', 'PATCH', 'DELETE']));
app.use('/api/settings', protectMethods(['PUT', 'PATCH', 'DELETE']));
app.use('/api/ads', protectMethods(['POST', 'PUT', 'PATCH', 'DELETE']));
app.use('/api/waiter-calls', requireAuthenticated);
app.use('/api/orders', (req, res, next) => {
  const isPublicOrderCreate = req.method === 'POST' && req.path === '/';
  const isPublicOrderCancel = req.method === 'POST' && /^\/\d+\/cancel$/.test(req.path);
  const isPublicOrderDetail = req.method === 'GET' && /^\/\d+$/.test(req.path);

  if (isPublicOrderCreate || isPublicOrderCancel || isPublicOrderDetail) return next();
  return requireAuthenticated(req, res, next);
});
app.use('/api/superadmin', requireAuthenticated, requireSuperadminAuth);
app.use('/api/database', requireAuthenticated, requireSuperadminAuth);

const normalizeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const BACKEND_SERVICE_NAME = 'backend';
const HEARTBEAT_INTERVAL_MS = Number(process.env.BACKEND_HEARTBEAT_INTERVAL_MS || 30000);
const MEMORY_CONTEXT_LIMIT = Number(process.env.AI_MEMORY_CONTEXT_LIMIT || 12);
const MEMORY_PRELOAD_LIMIT = Number(process.env.AI_MEMORY_PRELOAD_LIMIT || 25);
const HEARTBEAT_HISTORY_LIMIT = Number(process.env.BACKEND_HEARTBEAT_HISTORY_LIMIT || 100);
const runtimeMemoryCache = new Map();
const backendStartedAt = new Date().toISOString();
const backendHeartbeatState = {
  service_name: BACKEND_SERVICE_NAME,
  started_at: backendStartedAt,
  status: 'starting',
  details: 'Backend inicializando.',
  heartbeat_at: null,
  metadata: {}
};

const safeJsonParse = (value, fallback = null) => {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
};

const uniqueValues = (values) => [...new Set((values || []).filter(Boolean))];

function normalizeMemoryEntry(row = {}) {
  return {
    id: row.id,
    restaurant_id: Number(row.restaurant_id) || 1,
    scope: row.scope || 'general',
    source: row.source || 'system',
    kind: row.kind || 'note',
    content: row.content || '',
    metadata: safeJsonParse(row.metadata, {}),
    created_at: row.created_at || new Date().toISOString()
  };
}

function buildMemorySummary(entries = []) {
  const normalizedEntries = entries
    .map(normalizeMemoryEntry)
    .filter(entry => entry.content);

  const recent = normalizedEntries.slice(-MEMORY_CONTEXT_LIMIT);
  const topics = uniqueValues(recent.flatMap((entry) => {
    const rawTopics = Array.isArray(entry.metadata?.topics) ? entry.metadata.topics : [];
    if (rawTopics.length > 0) {
      return rawTopics.map(topic => String(topic).trim()).filter(Boolean);
    }

    const snippet = entry.content
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);

    return snippet ? [snippet] : [];
  })).slice(0, 6);

  return {
    entries: recent,
    shortSummary: topics.length > 0
      ? topics.join(' | ')
      : 'Sem memória operacional relevante registrada ainda.',
    updatedAt: recent.length > 0 ? recent[recent.length - 1].created_at : null
  };
}

async function ensureBackendContextTables() {
  const isPostgres = db.getDbType() === 'postgresql';

  if (isPostgres) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_memory_entries (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id INTEGER DEFAULT 1,
        scope VARCHAR(50) DEFAULT 'general',
        source VARCHAR(50) DEFAULT 'system',
        kind VARCHAR(50) DEFAULT 'note',
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS backend_heartbeats (
        id BIGSERIAL PRIMARY KEY,
        service_name VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'ok',
        details TEXT,
        started_at TIMESTAMP,
        heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT
      )
    `);
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER DEFAULT 1,
      scope TEXT DEFAULT 'general',
      source TEXT DEFAULT 'system',
      kind TEXT DEFAULT 'note',
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS backend_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name TEXT NOT NULL,
      status TEXT DEFAULT 'ok',
      details TEXT,
      started_at DATETIME,
      heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    )
  `);
}

async function loadRestaurantMemory(restaurantId) {
  const id = Number.parseInt(restaurantId, 10) || 1;
  const { rows } = await db.query(
    `SELECT id, restaurant_id, scope, source, kind, content, metadata, created_at
     FROM ai_memory_entries
     WHERE restaurant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [id, MEMORY_PRELOAD_LIMIT]
  );

  const orderedEntries = (rows || []).slice().reverse().map(normalizeMemoryEntry);
  const summary = buildMemorySummary(orderedEntries);
  runtimeMemoryCache.set(id, summary);
  return summary;
}

async function preloadRuntimeMemoryCache() {
  const { rows } = await db.query(
    `SELECT DISTINCT restaurant_id
     FROM ai_memory_entries
     ORDER BY restaurant_id ASC`
  );

  await Promise.all((rows || []).map((row) => loadRestaurantMemory(row.restaurant_id)));
}

async function persistMemoryEntry({
  restaurantId,
  scope = 'general',
  source = 'system',
  kind = 'note',
  content,
  metadata = {}
}) {
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  if (!trimmedContent) return null;

  const id = Number.parseInt(restaurantId, 10) || 1;
  const serializedMetadata = JSON.stringify(metadata || {});

  await db.query(
    `INSERT INTO ai_memory_entries (restaurant_id, scope, source, kind, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
    [id, scope, source, kind, trimmedContent, serializedMetadata]
  );

  return loadRestaurantMemory(id);
}

async function getRuntimeMemorySummary(restaurantId) {
  const id = Number.parseInt(restaurantId, 10) || 1;
  if (runtimeMemoryCache.has(id)) {
    return runtimeMemoryCache.get(id);
  }
  return loadRestaurantMemory(id);
}

async function recordHeartbeat(status = 'ok', details = 'Backend operacional.', metadata = {}) {
  const heartbeatAt = new Date().toISOString();
  const payload = {
    service_name: BACKEND_SERVICE_NAME,
    started_at: backendStartedAt,
    status,
    details,
    heartbeat_at: heartbeatAt,
    metadata: metadata || {}
  };

  backendHeartbeatState.status = payload.status;
  backendHeartbeatState.details = payload.details;
  backendHeartbeatState.heartbeat_at = payload.heartbeat_at;
  backendHeartbeatState.metadata = payload.metadata;

  await db.query(
    `INSERT INTO backend_heartbeats (service_name, status, details, started_at, heartbeat_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      payload.service_name,
      payload.status,
      payload.details,
      payload.started_at,
      payload.heartbeat_at,
      JSON.stringify(payload.metadata)
    ]
  );

  await db.query(
    `DELETE FROM backend_heartbeats
     WHERE id NOT IN (
       SELECT id
       FROM backend_heartbeats
       WHERE service_name = $1
       ORDER BY heartbeat_at DESC, id DESC
       LIMIT $2
     )
     AND service_name = $1`,
    [BACKEND_SERVICE_NAME, HEARTBEAT_HISTORY_LIMIT]
  ).catch(() => {});

  return payload;
}

async function initializeBackendRuntimeContext() {
  await ensureBackendContextTables();
  await preloadRuntimeMemoryCache();
  await recordHeartbeat('ok', 'Backend inicializado com memória carregada.', {
    cached_restaurants: runtimeMemoryCache.size
  });
}

const mapSettings = (rows = []) => rows.reduce((acc, row) => {
  acc[row.key] = row.value;
  return acc;
}, {});

const splitInsights = (text = '') => text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(0, 5);

const extractMemoryTopics = (text = '') => uniqueValues(
  text
    .split(/[\n.!?]/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
);

const safeAudioUrl = (audioResponsePath) => {
  if (!audioResponsePath) return null;
  return `/audio/${path.basename(audioResponsePath)}`;
};

async function gatherRestaurantContext(restaurantId) {
  const id = Number.parseInt(restaurantId, 10) || 1;

  const [
    restaurantResult,
    settingsResult,
    menuResult,
    ordersResult,
    orderItemsResult,
    ratingsResult,
  ] = await Promise.all([
    db.query('SELECT id, name, cuisine_type FROM restaurants WHERE id = $1', [id]),
    db.query(
      `SELECT key, value
       FROM settings
       WHERE restaurant_id = $1
         AND key IN ('restaurant_name', 'currency_symbol', 'open_time', 'close_time', 'opening_hours', 'closing_hours')`,
      [id]
    ),
    db.query(
      `SELECT d.id, d.name, d.description, d.price, d.category_id, c.name AS category_name
       FROM dishes d
       LEFT JOIN categories c ON c.id = d.category_id
       WHERE d.restaurant_id = $1 AND d.is_available = TRUE
       ORDER BY d.name ASC`,
      [id]
    ),
    db.query(
      `SELECT id, status, total_price, created_at, updated_at
       FROM orders
       WHERE restaurant_id = $1`,
      [id]
    ),
    db.query(
      `SELECT oi.order_id, oi.dish_id, oi.quantity, d.name
       FROM order_items oi
       JOIN dishes d ON d.id = oi.dish_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = $1`,
      [id]
    ),
    db.query(
      `SELECT r.dish_id, r.rating, r.created_at, d.name
       FROM ratings r
       JOIN dishes d ON d.id = r.dish_id
       WHERE r.restaurant_id = $1`,
      [id]
    ),
  ]);

  const restaurant = restaurantResult.rows?.[0] || {};
  const settings = mapSettings(settingsResult.rows);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentOrders = (ordersResult.rows || []).filter((order) => {
    const createdAt = order.created_at ? new Date(order.created_at) : null;
    return createdAt && !Number.isNaN(createdAt.getTime()) && createdAt >= thirtyDaysAgo;
  });

  const recentOrderIds = new Set(recentOrders.map((order) => Number(order.id)));
  const recentOrderItems = (orderItemsResult.rows || []).filter((item) => recentOrderIds.has(Number(item.order_id)));
  const recentRatings = (ratingsResult.rows || []).filter((rating) => {
    const createdAt = rating.created_at ? new Date(rating.created_at) : null;
    return createdAt && !Number.isNaN(createdAt.getTime()) && createdAt >= thirtyDaysAgo;
  });

  const totalOrders = recentOrders.length;
  const totalRevenue = recentOrders.reduce((sum, order) => (
    order.status === 'cancelled' ? sum : sum + normalizeNumber(order.total_price)
  ), 0);
  const cancelledOrders = recentOrders.filter((order) => order.status === 'cancelled').length;

  const salesByDish = recentOrderItems.reduce((acc, item) => {
    const key = `${item.dish_id}:${item.name}`;
    if (!acc[key]) {
      acc[key] = { id: item.dish_id, name: item.name, total: 0 };
    }
    acc[key].total += normalizeNumber(item.quantity);
    return acc;
  }, {});

  const ratedByDish = recentRatings.reduce((acc, item) => {
    const key = `${item.dish_id}:${item.name}`;
    if (!acc[key]) {
      acc[key] = { id: item.dish_id, name: item.name, totalRating: 0, count: 0 };
    }
    acc[key].totalRating += normalizeNumber(item.rating);
    acc[key].count += 1;
    return acc;
  }, {});

  const topDishes = Object.values(salesByDish)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, 5);

  const worstDishes = Object.values(salesByDish)
    .sort((a, b) => a.total - b.total || a.name.localeCompare(b.name))
    .slice(0, 5);

  const ratedList = Object.values(ratedByDish).map((item) => ({
    id: item.id,
    name: item.name,
    avg_rating: item.count > 0 ? item.totalRating / item.count : 0,
    count: item.count,
  }));

  const topRated = ratedList
    .slice()
    .sort((a, b) => b.avg_rating - a.avg_rating || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);

  const worstRated = ratedList
    .slice()
    .sort((a, b) => a.avg_rating - b.avg_rating || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);

  const peakHours = Object.entries(
    recentOrders.reduce((acc, order) => {
      const createdAt = order.created_at ? new Date(order.created_at) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime())) return acc;
      const hour = String(createdAt.getHours()).padStart(2, '0');
      acc[hour] = (acc[hour] || 0) + 1;
      return acc;
    }, {})
  )
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count || a.hour.localeCompare(b.hour))
    .slice(0, 5);

  const completedDurations = recentOrders
    .filter((order) => order.status === 'completed' && order.updated_at && order.created_at)
    .map((order) => {
      const createdAt = new Date(order.created_at);
      const updatedAt = new Date(order.updated_at);
      if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) return null;
      return Math.max(0, Math.round((updatedAt.getTime() - createdAt.getTime()) / 1000));
    })
    .filter((value) => value !== null);

  const avgServiceTime = completedDurations.length > 0
    ? completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length
    : 0;

  const memory = await getRuntimeMemorySummary(id).catch(() => ({
    entries: [],
    shortSummary: 'Sem memória operacional relevante registrada ainda.',
    updatedAt: null
  }));

  return {
    restaurantId: id,
    restaurantName: settings.restaurant_name || restaurant.name || 'Nosso Restaurante',
    cuisineType: restaurant.cuisine_type || 'Variada',
    openTime: settings.open_time || settings.opening_hours || '09:00',
    closeTime: settings.close_time || settings.closing_hours || '22:00',
    currency: settings.currency_symbol || 'MT',
    menu: menuResult.rows || [],
    totalOrders,
    totalRevenue,
    cancelledOrders,
    topDishes,
    worstDishes,
    topRated,
    worstRated,
    peakHours,
    avgServiceTime,
    memorySummary: memory.shortSummary,
    memoryUpdatedAt: memory.updatedAt,
    recentMemory: memory.entries.map((entry) => ({
      source: entry.source,
      kind: entry.kind,
      content: entry.content,
      created_at: entry.created_at
    })),
  };
}

// --- Autenticação (Admin) ---

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Credenciais inválidas.' });

    if (user.role !== 'superadmin') {
      try {
        const restaurantResult = await db.query('SELECT id, is_active FROM restaurants WHERE id = $1', [user.restaurant_id]);
        const restaurantStatus = restaurantResult.rows?.[0];
        if (restaurantStatus && Number(restaurantStatus.is_active) === 0) {
          return res.status(403).json({ error: 'Este restaurante está desativado no momento.' });
        }
      } catch (restaurantError) {
        console.error('Falha ao verificar status do restaurante no login:', restaurantError);
      }
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, restaurant_id: user.restaurant_id }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, restaurant_id: user.restaurant_id } });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno no login.' });
  }
});

// Setup Inicial (Criar primeiro admin se não existir)
app.post('/api/auth/setup', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'superadmin'");
    if (parseInt(rows[0].count) > 0) return res.status(403).json({ error: 'Setup já realizado.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username, password_hash, role, restaurant_id) VALUES ($1, $2, $3, $4)', [username, hashedPassword, 'superadmin', 1]);
    res.json({ message: 'Superadmin inicial criado com sucesso.' });
  } catch (err) {
    console.error('Erro no setup:', err);
    res.status(500).json({ error: 'Erro ao criar admin inicial.' });
  }
});

app.post('/api/auth/register-restaurant', async (req, res) => {
  const {
    owner_name,
    phone_number,
    email,
    address,
    cuisine_type,
    tax_id,
    restaurant_name,
    username,
    password,
  } = req.body || {};

  if (!owner_name || !phone_number || !email || !address || !cuisine_type || !tax_id || !restaurant_name || !username || !password) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios: nome, telefone, email, morada, tipo de cozinha, NUIT, restaurante, usuário e senha.' });
  }

  try {
    const existingUser = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Este usuário já está em uso.' });
    }

    let createdRestaurant;
    try {
      createdRestaurant = await db.query(
        'INSERT INTO restaurants (name, owner_name, phone_number, email, address, cuisine_type, tax_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, owner_name, phone_number, email, address, cuisine_type, tax_id, is_active, created_at',
        [restaurant_name, owner_name, phone_number, email, address, cuisine_type, tax_id]
      );
    } catch (insertError) {
      createdRestaurant = await db.query(
        'INSERT INTO restaurants (name, owner_name, phone_number) VALUES ($1, $2, $3) RETURNING id, name, owner_name, phone_number, created_at',
        [restaurant_name, owner_name, phone_number]
      );
    }

    let restaurant = createdRestaurant.rows?.[0] || null;
    const restaurantId = restaurant?.id || createdRestaurant.rows?.[0]?.id;

    if (!restaurant && restaurantId) {
      let lookup;
      try {
        lookup = await db.query(
          'SELECT id, name, owner_name, phone_number, email, address, cuisine_type, tax_id, is_active, created_at FROM restaurants WHERE id = $1',
          [restaurantId]
        );
      } catch (lookupError) {
        lookup = await db.query(
          'SELECT id, name, created_at FROM restaurants WHERE id = $1',
          [restaurantId]
        );
      }
      restaurant = lookup.rows?.[0] || null;
    }

    if (!restaurant?.id) {
      let fallbackLookup;
      try {
        fallbackLookup = await db.query(
          'SELECT id, name, owner_name, phone_number, email, address, cuisine_type, tax_id, is_active, created_at FROM restaurants WHERE name = $1 ORDER BY id DESC LIMIT 1',
          [restaurant_name]
        );
      } catch (fallbackLookupError) {
        fallbackLookup = await db.query(
          'SELECT id, name, created_at FROM restaurants WHERE name = $1 ORDER BY id DESC LIMIT 1',
          [restaurant_name]
        );
      }
      restaurant = fallbackLookup.rows?.[0] || null;
    }

    if (!restaurant?.id) {
      throw new Error('Falha ao criar restaurante.');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const createdUser = await db.query(
      'INSERT INTO users (username, password_hash, role, restaurant_id) VALUES ($1, $2, $3, $4) RETURNING id, username, role, restaurant_id',
      [username, hashedPassword, 'admin', restaurant.id]
    );

    let user = createdUser.rows?.[0] || null;
    if (!user?.id) {
      const userLookup = await db.query(
        'SELECT id, username, role, restaurant_id FROM users WHERE username = $1',
        [username]
      );
      user = userLookup.rows?.[0] || null;
    }

    if (!user?.id) {
      throw new Error('Falha ao criar usuário administrador.');
    }

    const initialSettings = {
      restaurant_name: restaurant.name,
      open_time: '09:00',
      close_time: '22:00',
      opening_hours: '09:00',
      closing_hours: '22:00',
      currency_symbol: 'MT',
      default_prep_time: '20',
      cancellation_window: '5',
      menu_theme: 'default',
      default_language: 'pt',
      tables_count: '20',
      enable_ai_chat: 'true',
      enable_customer_ratings: 'true',
      enable_ads_module: 'true',
      screen_lock_enabled: 'false',
      screen_lock_pin: '',
      onboarding_completed: 'false',
    };

    await Promise.all(
      Object.entries(initialSettings).map(([key, value]) =>
        db.query(
          `INSERT INTO settings (key, value, restaurant_id, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (key, restaurant_id) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
          [key, value, restaurant.id]
        )
      )
    );

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, restaurant_id: user.restaurant_id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(201).json({
      token,
      user,
      restaurant,
      next_step: '/onboarding',
    });
  } catch (err) {
    console.error('Erro ao registrar restaurante:', err);
    res.status(500).json({ error: 'Erro ao registrar restaurante.' });
  }
});


// --- Rotas da API ---

// Upload de imagens
app.post('/api/uploads', imageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado ou tipo inválido.' });
    }

    const id = crypto.randomUUID();
    const outputFilename = `${id}.webp`;
    const outputPath = path.join(uploadDir, outputFilename);

    await sharp(req.file.path)
      .resize({ width: 1280, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(outputPath);

    // Remove arquivo temporário
    try { fs.unlinkSync(req.file.path); } catch (_) { }

    return res.json({ path: `/uploads/${outputFilename}` });
  } catch (err) {
    console.error('Erro no upload de imagem:', err);
    console.error('File info:', req.file);
    return res.status(500).json({ error: 'Erro ao processar a imagem.' });
  }
});

// Cardápio para Clientes
app.get('/api/menu', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*, c.name as category_name 
      FROM dishes d 
      LEFT JOIN categories c ON d.category_id = c.id 
      WHERE d.is_available = TRUE AND d.restaurant_id = $1
    `, [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar o cardápio.' });
  }
});

// --- Gerenciamento de Categorias (CRUD) ---

app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY id ASC', [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar categorias:', err);
    res.status(500).json({ error: 'Erro ao buscar categorias.' });
  }
});

app.post('/api/categories', async (req, res) => {
  const { name } = req.body;
  try {
    const { rows } = await db.query(
      'INSERT INTO categories (name, restaurant_id) VALUES ($1, $2) RETURNING *',
      [name, req.restaurant_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro ao criar categoria:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Categoria já existe.' });
    }
    res.status(500).json({ error: 'Erro ao criar categoria.' });
  }
});

app.put('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE categories SET name = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *',
      [name, id, req.restaurant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Categoria não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar categoria:', err);
    res.status(500).json({ error: 'Erro ao atualizar categoria.' });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM categories WHERE id = $1 AND restaurant_id = $2', [id, req.restaurant_id]);
    res.status(204).send();
  } catch (err) {
    console.error('Erro ao deletar categoria:', err);
    res.status(500).json({ error: 'Erro ao deletar categoria.' });
  }
});

// --- Gerenciamento de Pratos (CRUD) ---

// Obter todos os pratos (Read)
app.get('/api/dishes', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*, c.name as category_name 
      FROM dishes d 
      LEFT JOIN categories c ON d.category_id = c.id 
      WHERE d.restaurant_id = $1
      ORDER BY d.id ASC
    `, [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar pratos.' });
  }
});

// Criar um novo prato (Create)
app.post('/api/dishes', async (req, res) => {
  const { name, description, price, category_id, image_url, image_urls, is_available, preparation_time, calories, is_spicy, is_vegetarian, is_gluten_free } = req.body;
  const normalizedImageUrls = Array.isArray(image_urls) ? JSON.stringify(image_urls.filter(Boolean)) : (image_urls || null);
  const hasImageUrls = Object.prototype.hasOwnProperty.call(req.body, 'image_urls');
  console.log('Attempting to create new dish with data:', req.body);
  try {
    const { rows } = hasImageUrls
      ? await db.query(
          'INSERT INTO dishes (name, description, price, category_id, image_url, image_urls, is_available, preparation_time, calories, is_spicy, is_vegetarian, is_gluten_free, restaurant_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP) RETURNING *',
          [name, description, price, category_id, image_url, normalizedImageUrls, is_available, preparation_time, calories, is_spicy || false, is_vegetarian || false, is_gluten_free || false, req.restaurant_id]
        )
      : await db.query(
          'INSERT INTO dishes (name, description, price, category_id, image_url, is_available, preparation_time, calories, is_spicy, is_vegetarian, is_gluten_free, restaurant_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP) RETURNING *',
          [name, description, price, category_id, image_url, is_available, preparation_time, calories, is_spicy || false, is_vegetarian || false, is_gluten_free || false, req.restaurant_id]
        );
    console.log('Dish created successfully:', rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro ao criar prato:', err);
    res.status(500).json({ error: 'Erro ao criar prato.' });
  }
});

// Atualizar um prato (Update)
app.put('/api/dishes/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category_id, image_url, image_urls, is_available, preparation_time, calories, is_spicy, is_vegetarian, is_gluten_free } = req.body;
  const normalizedImageUrls = Array.isArray(image_urls) ? JSON.stringify(image_urls.filter(Boolean)) : (image_urls || null);
  const hasExtendedFields = ['preparation_time', 'calories', 'is_spicy', 'is_vegetarian', 'is_gluten_free', 'image_urls']
    .some(field => Object.prototype.hasOwnProperty.call(req.body, field));
  console.log(`Attempting to update dish ${id} with data:`, req.body);
  try {
    // Fetch current image_url before updating
    const { rows: existingRows } = await db.query('SELECT image_url FROM dishes WHERE id = $1 AND restaurant_id = $2', [id, req.restaurant_id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Prato não encontrado.' });
    }
    const oldImagePath = existingRows[0].image_url;

    const { rows } = hasExtendedFields
      ? await db.query(
          'UPDATE dishes SET name = $1, description = $2, price = $3, category_id = $4, image_url = $5, image_urls = $6, is_available = $7, preparation_time = $8, calories = $9, is_spicy = $10, is_vegetarian = $11, is_gluten_free = $12, updated_at = CURRENT_TIMESTAMP WHERE id = $13 AND restaurant_id = $14 RETURNING *',
          [name, description, price, category_id, image_url, normalizedImageUrls, is_available, preparation_time, calories, is_spicy || false, is_vegetarian || false, is_gluten_free || false, id, req.restaurant_id]
        )
      : await db.query(
          'UPDATE dishes SET name = $1, description = $2, price = $3, category_id = $4, image_url = $5, is_available = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 AND restaurant_id = $8 RETURNING *',
          [name, description, price, category_id, image_url, is_available, id, req.restaurant_id]
        );

    const updated = rows[0];
    console.log('Dish updated successfully:', updated);

    // After successful update, delete old local image if it is no longer used and differs from new value
    const newImagePath = updated ? updated.image_url : image_url;
    if (oldImagePath && isLocalPath(oldImagePath) && oldImagePath !== newImagePath) {
      deleteIfUnused(oldImagePath).catch(err => {
        console.error('Erro ao limpar imagem antiga (update):_ ', err);
      });
    }

    res.json(updated);
  } catch (err) {
    console.error('Erro ao atualizar prato:', err);
    res.status(500).json({ error: 'Erro ao atualizar prato.' });
  }
});

// Deletar um prato (Delete)
app.delete('/api/dishes/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`Attempting to delete dish with ID: ${id}`);
  try {
    // Fetch current image_url before delete
    const { rows: existingRows } = await db.query('SELECT image_url FROM dishes WHERE id = $1 AND restaurant_id = $2', [id, req.restaurant_id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Prato não encontrado.' });
    }
    const oldImagePath = existingRows[0].image_url;

    await db.query('DELETE FROM dishes WHERE id = $1 AND restaurant_id = $2', [id, req.restaurant_id]);
    console.log(`Dish with ID ${id} deleted successfully.`);

    // After successful delete, delete old local image if unused
    if (oldImagePath && isLocalPath(oldImagePath)) {
      deleteIfUnused(oldImagePath).catch(err => {
        console.error('Erro ao limpar imagem antiga (delete):_ ', err);
      });
    }

    res.status(204).send(); // Sem conteúdo
  } catch (err) {
    console.error(`Erro ao deletar prato com ID ${id}:`, err);
    res.status(500).json({ error: 'Erro ao deletar prato.' });
  }
});

// --- Ratings ---

// Criar uma nova avaliação
app.post('/api/ratings', async (req, res) => {
  const { dish_id, order_id, rating, comment } = req.body;

  if (!rating) {
    return res.status(400).json({ error: 'rating é obrigatório.' });
  }
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'A avaliação deve ser entre 1 e 5.' });
  }

  try {
    // Query simplificada que funciona em ambos os bancos após a conversão de placeholders pela função `convertQuery`
    const queryText = 'INSERT INTO ratings (dish_id, order_id, rating, comment, restaurant_id) VALUES ($1, $2, $3, $4, $5)';
    await db.query(queryText, [dish_id, order_id, rating, comment, req.restaurant_id]);
    res.status(201).json({ success: true, message: 'Avaliação salva com sucesso.' });
  } catch (err) {
    console.error('Erro ao salvar avaliação:', err);
    res.status(500).json({ error: 'Erro ao salvar avaliação.' });
  }
});

// Obter todas as avaliações (para o admin panel)
app.get('/api/ratings', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.rating, r.comment, r.created_at, d.name as dish_name, r.order_id
      FROM ratings r
      LEFT JOIN dishes d ON r.dish_id = d.id
      WHERE r.restaurant_id = $1
      ORDER BY r.created_at DESC
    `, [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar avaliações:', err);
    res.status(500).json({ error: 'Erro ao buscar avaliações.' });
  }
});

// Obter dados agregados de avaliações (para o dashboard)
app.get('/api/ratings/summary', async (req, res) => {
  try {
    const avgPerDishQuery = `
      SELECT 
        d.name as dish_name,
        COALESCE(AVG(r.rating), 0) as average_rating,
        COUNT(r.id) as rating_count
      FROM dishes d
      LEFT JOIN ratings r ON d.id = r.dish_id AND r.restaurant_id = $1
      WHERE d.restaurant_id = $1
      GROUP BY d.id, d.name
      ORDER BY average_rating DESC, rating_count DESC
    `;

    const distributionQuery = `
      SELECT 
        rating,
        COUNT(id) as count
      FROM ratings
      WHERE restaurant_id = $1
      GROUP BY rating
      ORDER BY rating DESC
    `;

    const [avgPerDishResult, distributionResult] = await Promise.all([
      db.query(avgPerDishQuery, [req.restaurant_id]),
      db.query(distributionQuery, [req.restaurant_id])
    ]);

    res.json({
      averageRatingsPerDish: avgPerDishResult.rows,
      ratingDistribution: distributionResult.rows
    });

  } catch (err) {
    console.error('Erro ao buscar resumo das avaliações:', err);
    res.status(500).json({ error: 'Erro ao buscar resumo das avaliações.' });
  }
});


// Pedidos
app.post('/api/orders', async (req, res) => {
  const { table_number, items, prep_time_seconds: requestedPrepSeconds } = req.body;

  if (!table_number || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Dados do pedido inválidos.' });
  }

  // Abstração para suportar tanto Pool (Postgres) quanto Client único (SQLite)
  const isPostgres = db.getDbType() === 'postgresql';
  let client;

  if (isPostgres) {
    client = await db.pool.connect();
  } else {
    // Mock client para SQLite
    client = {
      query: async (text, params) => db.query(text, params),
      release: () => { }
    };
  }

  try {
    if (isPostgres) await client.query('BEGIN');
    else await client.query('BEGIN TRANSACTION');

    // 1. Validar preços (Fetching all dishes to filter in memory - compatible with both)
    // Evita problemas com ANY() no SQLite
    const dishesResult = await client.query('SELECT id, price FROM dishes WHERE restaurant_id = $1', [req.restaurant_id]);
    const priceMap = new Map(dishesResult.rows.map(p => [p.id, parseFloat(p.price)]));

    let totalPrice = 0;
    for (const item of items) {
      if (!priceMap.has(item.dish_id)) {
        throw new Error(`Prato com ID ${item.dish_id} não encontrado.`);
      }
      totalPrice += priceMap.get(item.dish_id) * item.quantity;
    }

    // 2. Tempo de preparo
    let defaultPrepSeconds = Number.isFinite(requestedPrepSeconds) && requestedPrepSeconds > 0
      ? Math.floor(requestedPrepSeconds)
      : null;
    let cancellationWindowMinutes = 5;

    if (!defaultPrepSeconds) {
      // Tenta buscar das configurações
      const settingsRes = await client.query("SELECT key, value FROM settings WHERE key IN ('default_prep_time', 'cancellation_window') AND restaurant_id = $1", [req.restaurant_id]);
      if (settingsRes.rows.length > 0) {
        settingsRes.rows.forEach((row) => {
          const val = parseInt(row.value, 10);
          if (row.key === 'default_prep_time' && !isNaN(val) && val > 0) {
            defaultPrepSeconds = val * 60;
          }
          if (row.key === 'cancellation_window' && !isNaN(val) && val >= 0) {
            cancellationWindowMinutes = val;
          }
        });
      }
    }
    if (!defaultPrepSeconds) defaultPrepSeconds = 20 * 60;

    // 3. Inserir Pedido
    let orderId;
    let orderData;

    if (isPostgres) {
      const orderResult = await client.query(
        `INSERT INTO orders (table_number, total_price, prep_time_seconds, cancel_until, restaurant_id)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 minute'), $5) 
           RETURNING id, created_at, prep_time_seconds, cancel_until`,
        [table_number, totalPrice, defaultPrepSeconds, cancellationWindowMinutes, req.restaurant_id]
      );
      orderId = orderResult.rows[0].id;
      orderData = orderResult.rows[0];
    } else {
      // SQLite: Insert then Select (Wrapper returns { rows: [{id: lastID}] } for insert)
      const insertRes = await client.query(
        `INSERT INTO orders (table_number, total_price, prep_time_seconds, cancel_until, restaurant_id)
           VALUES ($1, $2, $3, datetime('now', $4), $5)`,
        [table_number, totalPrice, defaultPrepSeconds, `+${cancellationWindowMinutes} minutes`, req.restaurant_id]
      );
      orderId = insertRes.rows[0].id; // lastID from wrapper

      // Fetch back
      const fetchRes = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      orderData = fetchRes.rows[0];
    }

    // 4. Inserir Itens
    for (const item of items) {
      const itemPrice = priceMap.get(item.dish_id);
      await client.query(
        'INSERT INTO order_items (order_id, dish_id, quantity, item_price) VALUES ($1, $2, $3, $4)',
        [orderId, item.dish_id, item.quantity, itemPrice]
      );
    }

    if (isPostgres) await client.query('COMMIT');
    else await client.query('COMMIT');

    // Notifica
    wss.broadcast(JSON.stringify({
      type: 'NEW_ORDER',
      payload: {
        order_id: orderId,
        table_number,
        prep_time_seconds: orderData.prep_time_seconds,
        cancel_until: orderData.cancel_until
      }
    }));

    res.status(201).json({
      message: 'Pedido criado com sucesso!',
      order_id: orderId,
      prep_time_seconds: orderData.prep_time_seconds,
      cancel_until: orderData.cancel_until
    });

  } catch (err) {
    if (isPostgres) await client.query('ROLLBACK');
    else {
      try { await client.query('ROLLBACK'); } catch (_) { }
    }

    console.error('CRITICAL ERROR creating order:', err);
    console.error('Order Data:', JSON.stringify({ table_number, items, prep_time_seconds: requestedPrepSeconds }));
    res.status(500).json({ error: 'Erro ao criar o pedido. Verifique os logs do servidor.' });
  } finally {
    client.release();
  }
});

// Atualizar status do pedido
app.put('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, cancellation_reason } = req.body;
  const validStatuses = new Set(['pending', 'preparing', 'completed', 'cancelled']);

  if (!validStatuses.has(status)) {
    return res.status(400).json({ error: 'Status invalido. Use pending, preparing, completed ou cancelled.' });
  }

  try {
    const { rows } = await db.query(
      'UPDATE orders SET status = $1, cancellation_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND restaurant_id = $4 RETURNING *',
      [status, status === 'cancelled' ? cancellation_reason : null, id, req.restaurant_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    const updatedOrder = rows[0];

    // Notificar via WebSocket
    let eventName = 'ORDER_STATUS_UPDATE';
    if (status === 'cancelled') eventName = 'ORDER_CANCELLED';

    wss.broadcast(JSON.stringify({
      type: eventName,
      payload: updatedOrder
    }));
    res.json(updatedOrder);
  } catch (err) {
    console.error('Erro ao atualizar status do pedido:', err);
    res.status(500).json({ error: 'Erro ao atualizar status do pedido.' });
  }
});

// Ajustar tempo de preparo (admin/cozinha)
// ... keeping next endpoint ...
app.put('/api/orders/:id/prep-time', async (req, res) => {
  const { id } = req.params;
  const { add_minutes, set_minutes } = req.body || {};

  try {
    // Decide novo valor
    let query;
    let params;
    if (Number.isFinite(set_minutes)) {
      const seconds = Math.max(0, Math.floor(set_minutes * 60));
      query = `UPDATE orders SET prep_time_seconds = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND restaurant_id = $3 RETURNING *`;
      params = [seconds, id, req.restaurant_id];
    } else if (Number.isFinite(add_minutes)) {
      const addSeconds = Math.floor(add_minutes * 60);
      query = `UPDATE orders SET prep_time_seconds = GREATEST(0, COALESCE(prep_time_seconds, 0) + $1), updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND restaurant_id = $3 RETURNING *`;
      params = [addSeconds, id, req.restaurant_id];
    } else {
      return res.status(400).json({ error: 'Informe add_minutes ou set_minutes.' });
    }

    const { rows } = await db.query(query, params);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    const updated = rows[0];

    // Broadcast atualização
    const increased = Number.isFinite(add_minutes) && add_minutes > 0;
    wss.broadcast(JSON.stringify({
      type: 'PREP_TIME_UPDATE',
      payload: { order_id: updated.id, prep_time_seconds: updated.prep_time_seconds }
    }));
    if (increased) {
      wss.broadcast(JSON.stringify({
        type: 'COURTESY_MESSAGE',
        payload: {
          order_id: updated.id,
          message: 'Pedimos desculpa pelo atraso, seu prato ficará pronto em breve.'
        }
      }));
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar tempo de preparo.' });
  }
});

// Cancelamento pelo cliente dentro de 5 minutos
app.post('/api/orders/:id/cancel', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query('SELECT id, status, cancel_until FROM orders WHERE id = $1 AND restaurant_id = $2', [id, req.restaurant_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const order = rows[0];
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Pedido já cancelado.' });
    }

    const now = new Date();
    const cancelUntil = order.cancel_until ? new Date(order.cancel_until) : null;
    if (!cancelUntil || now > cancelUntil) {
      return res.status(403).json({ error: 'Janela de cancelamento expirada.' });
    }

    const { rows: updatedRows } = await db.query(
      `UPDATE orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
      [id, req.restaurant_id]
    );

    const updated = updatedRows[0];
    // Broadcast cancelamento
    wss.broadcast(JSON.stringify({ type: 'ORDER_CANCELLED', payload: updated }));
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cancelar pedido.' });
  }
});

// Chamada de Garçom
app.post('/api/call-waiter', async (req, res) => {
  const { table_number, reason } = req.body;
  const callReason = reason || 'Chamado Geral';
  console.log(`Mesa ${table_number} está chamando o garçom. Motivo: ${callReason}`);

  try {
    // Inserir chamada no banco de dados
    const { rows } = await db.query(
      'INSERT INTO waiter_calls (table_number, reason, restaurant_id) VALUES ($1, $2, $3) RETURNING *',
      [table_number, callReason, req.restaurant_id]
    );

    const newCall = rows[0];

    // Notifica o painel via WebSocket
    wss.broadcast(JSON.stringify({ type: 'CALL_WAITER', payload: { id: newCall.id, table_number, reason: callReason, created_at: newCall.created_at } }));

    res.status(200).json({ message: `Notificação enviada para a mesa ${table_number}`, call: newCall });
  } catch (err) {
    console.error('Erro ao registrar chamada de garçom:', err);
    res.status(500).json({ error: 'Erro ao registrar chamada.' });
  }
});

// Obter chamadas de garçom pendentes
app.get('/api/waiter-calls', async (req, res) => {
  const { status } = req.query;
  try {
    let query = "SELECT * FROM waiter_calls WHERE restaurant_id = $1";
    let params = [req.restaurant_id];

    if (status === 'resolved') {
      query += " AND status = 'resolved' ORDER BY created_at DESC LIMIT 50";
    } else {
      query += " AND status = 'pending' ORDER BY created_at DESC";
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar chamadas:', err);
    res.status(500).json({ error: 'Erro ao buscar chamadas.' });
  }
});

// Marcar chamada como atendida
app.put('/api/waiter-calls/:id/resolve', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      "UPDATE waiter_calls SET status = 'resolved' WHERE id = $1 AND restaurant_id = $2 RETURNING *",
      [id, req.restaurant_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Chamada não encontrada.' });
    }

    // Broadcast update
    wss.broadcast(JSON.stringify({ type: 'WAITER_CALL_RESOLVED', payload: { id: rows[0].id, table_number: rows[0].table_number } }));

    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao resolver chamada:', err);
    res.status(500).json({ error: 'Erro ao resolver chamada.' });
  }
});

// --- Configurações ---
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT key, value FROM settings WHERE restaurant_id = $1', [req.restaurant_id]);
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    res.json(settings);
  } catch (err) {
    console.error('Erro ao buscar configurações:', err);
    res.status(500).json({ error: 'Erro ao buscar configurações.' });
  }
});

app.put('/api/settings', async (req, res) => {
  const settings = req.body;
  try {
    const updatePromises = Object.entries(settings).map(([key, value]) => {
      if (db.getDbType() === 'postgresql') {
        return db.query(
          `INSERT INTO settings (key, value, restaurant_id, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (key, restaurant_id) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
          [key, value, req.restaurant_id]
        );
      } else {
        // SQLite
        return db.query(
          `INSERT INTO settings (key, value, restaurant_id, updated_at) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(key, restaurant_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          [key, value, req.restaurant_id]
        );
      }
    });
    await Promise.all(updatePromises);
    res.status(200).json({ message: 'Configurações atualizadas com sucesso!' });
  } catch (err) {
    console.error('Erro ao atualizar configurações:', err);
    res.status(500).json({ error: 'Erro ao atualizar configurações.' });
  }
});
// --- Categorias (rota duplicada desativada; use /api/categories acima) ---
app.get('/api/categories-legacy-disabled', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY name ASC', [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar categorias:', err);
    res.status(500).json({ error: 'Erro ao buscar categorias.' });
  }
});

// --- Avaliações ---
app.get('/api/ratings-legacy-disabled', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.*, d.name as dish_name 
      FROM ratings r 
      LEFT JOIN dishes d ON r.dish_id = d.id 
      WHERE r.restaurant_id = $1
      ORDER BY r.created_at DESC LIMIT 50
    `, [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar avaliações:', err);
    res.status(500).json({ error: 'Erro ao buscar avaliações.' });
  }
});

app.post('/api/ratings-legacy-disabled', async (req, res) => {
  const { dish_id, order_id, rating, comment } = req.body;
  try {
    if (db.getDbType() === 'postgresql') {
      await db.query(
        'INSERT INTO ratings (dish_id, order_id, rating, comment, restaurant_id) VALUES ($1, $2, $3, $4, $5)',
        [dish_id, order_id, rating, comment, req.restaurant_id]
      );
    } else {
      await db.query(
        'INSERT INTO ratings (dish_id, order_id, rating, comment, restaurant_id) VALUES (?, ?, ?, ?, ?)',
        [dish_id, order_id, rating, comment, req.restaurant_id]
      );
    }
    res.status(201).json({ message: 'Avaliação enviada com sucesso!' });
  } catch (err) {
    console.error('Erro ao salvar avaliação:', err);
    res.status(500).json({ error: 'Erro ao salvar avaliação.' });
  }
});


// --- Analytics ---
app.get('/api/analytics', async (req, res) => {
  const dbType = db.getDbType();
  const { startDate, endDate } = req.query; // YYYY-MM-DD

  try {
    let dateFilter = "";
    let dateParams = [];
    let compareDateFilter = "";
    let compareParams = [];

    // Configura filtros de data se fornecidos, senão usa padrão 7 dias
    if (startDate && endDate) {
      if (dbType === 'postgresql') {
        dateFilter = "AND created_at BETWEEN $1::date AND $2::date + INTERVAL '1 day'";
        dateParams = [startDate, endDate];
        // Para comparação (período anterior)
        compareDateFilter = "AND created_at BETWEEN $1::date - INTERVAL '1 day' * ($2::date - $1::date) AND $1::date";
        compareParams = [startDate, endDate];
      } else {
        dateFilter = "AND created_at BETWEEN ? AND datetime(?, '+1 day')";
        dateParams = [startDate, endDate];
        // sqlite comparison logic simplified for now
      }
    } else {
      // Default: Last 7 days
      if (dbType === 'postgresql') {
        dateFilter = "AND created_at >= NOW() - INTERVAL '7 days'";
      } else {
        dateFilter = "AND created_at >= date('now', '-7 days')";
      }
    }

    // Helper para queries (simplificado para SQLite focado)
    const runQuery = async (sql, params = []) => {
      // Substitui WHERE ... se necessário ou adiciona AND
      // Aqui vamos assumir queries base que já têm WHERE ou não
      const finalSql = sql.replace('{DATE_FILTER}', dateFilter);
      return db.query(finalSql, dateParams.length > 0 ? dateParams : params);
    };

    let ordersByDay, topDishes, dailySummary, monthlySummary, avgServiceTime;
    let revenueByCategory, peakHours, topRated;
    let comparisonSummary; // Dados do período anterior para comparação

    if (dbType === 'postgresql') {
      // ... (PostgreSQL logic omitted for brevity as user uses SQLite mostly, but should follow similar pattern if needed)
      // Mantendo lógica original para PostgreSQL por enquanto para não quebrar compatibilidade se mudar DB
      [ordersByDay, topDishes, dailySummary, monthlySummary, avgServiceTime, revenueByCategory, peakHours, topRated] = await Promise.all([
        db.query(`SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as pedidos, SUM(total_price) as faturamento, COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as pedidos_cancelados, SUM(CASE WHEN status = 'cancelled' THEN total_price ELSE 0 END) as faturamento_perdido FROM orders WHERE 1=1 ${dateFilter} GROUP BY day ORDER BY day ASC`, dateParams),
        db.query(`SELECT d.name, SUM(oi.quantity) as total FROM order_items oi JOIN dishes d ON oi.dish_id = d.id JOIN orders o ON oi.order_id = o.id WHERE 1=1 ${dateFilter.replace('created_at', 'o.created_at')} GROUP BY d.name ORDER BY total DESC LIMIT 5`, dateParams),
        db.query(`SELECT COUNT(*) as total_pedidos_dia, SUM(total_price) as faturamento_dia FROM orders WHERE created_at::date = CURRENT_DATE`), // Mantém KPI de 'Hoje' fixo
        db.query(`SELECT COUNT(*) as total_pedidos_mes, SUM(total_price) as faturamento_mes FROM orders WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`),
        db.query(`SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds FROM orders WHERE status = 'completed' AND updated_at IS NOT NULL ${dateFilter}`, dateParams),
        db.query(`SELECT c.name, SUM(oi.quantity * oi.item_price) as revenue FROM order_items oi JOIN dishes d ON oi.dish_id = d.id JOIN categories c ON d.category_id = c.id JOIN orders o ON oi.order_id = o.id WHERE 1=1 ${dateFilter.replace('created_at', 'o.created_at')} GROUP BY c.name`, dateParams),
        db.query(`SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count FROM orders WHERE 1=1 ${dateFilter} GROUP BY hour ORDER BY hour ASC`, dateParams),
        db.query(`SELECT d.name, AVG(r.rating) as avg_rating, COUNT(r.id) as count FROM ratings r JOIN dishes d ON r.dish_id = d.id WHERE 1=1 ${dateFilter.replace('created_at', 'r.created_at')} GROUP BY d.id, d.name HAVING COUNT(r.id) > 0 ORDER BY avg_rating DESC LIMIT 5`, dateParams)
      ]);
    } else { // SQLite
      // Ajuste das queries para usar o filtro dinâmico

      const ordersQuery = `SELECT strftime('%Y-%m-%d', created_at) as day, COUNT(*) as pedidos, SUM(total_price) as faturamento, COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as pedidos_cancelados, SUM(CASE WHEN status = 'cancelled' THEN total_price ELSE 0 END) as faturamento_perdido FROM orders WHERE restaurant_id = ${req.restaurant_id} ${dateFilter} GROUP BY day ORDER BY day ASC`;

      const topDishesQuery = `SELECT d.name, SUM(oi.quantity) as total FROM order_items oi JOIN dishes d ON oi.dish_id = d.id JOIN orders o ON oi.order_id = o.id WHERE o.restaurant_id = ${req.restaurant_id} ${dateFilter.replace('created_at', 'o.created_at')} GROUP BY d.name ORDER BY total DESC LIMIT 5`;

      const avgTimeQuery = `SELECT AVG(strftime('%s', updated_at) - strftime('%s', created_at)) as avg_seconds FROM orders WHERE status = 'completed' AND restaurant_id = ${req.restaurant_id} AND updated_at IS NOT NULL ${dateFilter}`;

      const revCatQuery = `SELECT c.name, SUM(oi.quantity * oi.item_price) as revenue FROM order_items oi JOIN dishes d ON oi.dish_id = d.id JOIN categories c ON d.category_id = c.id JOIN orders o ON oi.order_id = o.id WHERE o.restaurant_id = ${req.restaurant_id} ${dateFilter.replace('created_at', 'o.created_at')} GROUP BY c.name`;

      const peakHoursQuery = `SELECT strftime('%H', created_at) as hour, COUNT(*) as count FROM orders WHERE restaurant_id = ${req.restaurant_id} ${dateFilter} GROUP BY hour ORDER BY hour ASC`;

      const topRatedQuery = `SELECT d.name, AVG(r.rating) as avg_rating, COUNT(r.id) as count FROM ratings r JOIN dishes d ON r.dish_id = d.id WHERE r.restaurant_id = ${req.restaurant_id} ${dateFilter.replace('created_at', 'r.created_at')} GROUP BY d.id, d.name ORDER BY avg_rating DESC LIMIT 5`;

      // KPIs de "Hoje" e "Mês" fixos para manter o overview imediato
      const dailySummaryPromise = db.query(`SELECT COUNT(*) as total_pedidos_dia, SUM(total_price) as faturamento_dia FROM orders WHERE restaurant_id = ${req.restaurant_id} AND date(created_at) = date('now')`);
      const monthlySummaryPromise = db.query(`SELECT COUNT(*) as total_pedidos_mes, SUM(total_price) as faturamento_mes FROM orders WHERE restaurant_id = ${req.restaurant_id} AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`);

      // KPI do período SELECIONADO (Filtered Summary)
      const filteredSummaryQuery = `SELECT COUNT(*) as total_pedidos, SUM(total_price) as faturamento FROM orders WHERE restaurant_id = ${req.restaurant_id} ${dateFilter}`;

      const results = await Promise.all([
        db.query(ordersQuery, dateParams),
        db.query(topDishesQuery, dateParams),
        dailySummaryPromise,
        monthlySummaryPromise,
        db.query(avgTimeQuery, dateParams),
        db.query(revCatQuery, dateParams),
        db.query(peakHoursQuery, dateParams),
        db.query(topRatedQuery, dateParams),
        db.query(filteredSummaryQuery, dateParams)
      ]);

      [ordersByDay, topDishes, dailySummary, monthlySummary, avgServiceTime, revenueByCategory, peakHours, topRated, comparisonSummary] = results;
    }

    res.json({
      ordersByDay: ordersByDay.rows,
      topDishes: topDishes.rows,
      dailySummary: dailySummary.rows[0],
      monthlySummary: monthlySummary.rows[0],
      filteredSummary: comparisonSummary ? comparisonSummary.rows[0] : null, // Novo campo com totais do filtro
      avgServiceTime: avgServiceTime.rows[0].avg_seconds,
      revenueByCategory: revenueByCategory.rows,
      peakHours: peakHours.rows,
      topRated: topRated.rows
    });
  } catch (err) {
    console.error('Erro ao buscar dados analíticos:', err);
    res.status(500).json({ error: 'Erro ao buscar dados analíticos.' });
  }
});

// --- Histórico de Pedidos ---
app.get('/api/orders', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status; // Optional status filter ('pending', 'preparing', 'completed', 'cancelled', 'all')

  try {
    // Build WHERE clause sequentially to avoid $N gaps (SQLite limitation)
    const whereParts = [`o.restaurant_id = $1`];
    const queryParams = [req.restaurant_id];

    if (status && status !== 'all') {
      queryParams.push(status);
      whereParts.push(`o.status = $${queryParams.length}`);
    }

    queryParams.push(limit);
    const limitPlaceholder = `$${queryParams.length}`;
    queryParams.push(offset);
    const offsetPlaceholder = `$${queryParams.length}`;

    const whereClause = whereParts.join(' AND ');

    const ordersResult = await db.query(`
      SELECT o.id, o.table_number, o.status, o.total_price, o.created_at, o.updated_at,
        o.prep_time_seconds, o.cancel_until
      FROM orders o
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `, queryParams);

    // For each order, fetch its items separately (SQLite-safe alternative to json_agg)
    const orders = await Promise.all(ordersResult.rows.map(async (order) => {
      const itemsResult = await db.query(
        `SELECT d.name, oi.quantity, oi.item_price as price
         FROM order_items oi
         JOIN dishes d ON oi.dish_id = d.id
         WHERE oi.order_id = $1`,
        [order.id]
      );
      return { ...order, items: itemsResult.rows };
    }));

    res.json({ orders });
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: 'Erro ao buscar pedidos.' });
  }
});

// Exportar histórico de pedidos para CSV
app.get('/api/orders/export', async (req, res) => {
  const { Parser } = require('json2csv');
  const status = req.query.status;

  let query = `
    SELECT o.id, o.table_number, o.status, o.total_price, o.created_at,
      json_agg(json_build_object('name', d.name, 'quantity', oi.quantity)) as items
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN dishes d ON oi.dish_id = d.id
    WHERE o.restaurant_id = $1
  `;
  const queryParams = [req.restaurant_id];

  if (status && status !== 'all') {
    query += ` AND o.status = $2`;
    queryParams.push(status);
  }

  query += ` GROUP BY o.id ORDER BY o.created_at DESC`;

  try {
    const { rows: orders } = await db.query(query, queryParams);

    if (orders.length === 0) {
      res.status(404).send('Nenhum pedido encontrado para exportar com os filtros selecionados.');
      return;
    }

    // Formatar os dados para o CSV
    const formattedData = orders.map(order => ({
      'ID do Pedido': order.id,
      'Mesa': order.table_number,
      'Status': order.status,
      'Valor Total': order.total_price,
      'Data': new Date(order.created_at).toLocaleString('pt-MZ'),
      'Itens': order.items.map(item => `${item.name} (x${item.quantity})`).join(', ')
    }));

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(formattedData);

    res.header('Content-Type', 'text/csv');
    res.attachment('historico_pedidos.csv');
    res.status(200).send(csv);

  } catch (err) {
    console.error('Erro ao exportar pedidos:', err);
    res.status(500).json({ error: 'Erro ao gerar o arquivo de exportação.' });
  }
});

// Obter pedido por ID
app.get('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.table_number, o.status, o.total_price, o.created_at, o.updated_at, o.prep_time_seconds, o.cancel_until
      FROM orders o
      WHERE o.id = $1 AND o.restaurant_id = $2
    `, [id, req.restaurant_id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar pedido.' });
  }
});

// Legacy duplicate kept disabled; the active status route above validates statuses and emits cancellation events.
app.put('/api/orders/:id/status-legacy-disabled', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status é obrigatório.' });
  }

  try {
    const { rows } = await db.query(
      'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND restaurant_id = $3 RETURNING *'
      , [status, id, req.restaurant_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    // Notify via WebSocket about status change
    wss.broadcast(JSON.stringify({ type: 'ORDER_STATUS_UPDATE', payload: rows[0] }));
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar status do pedido.' });
  }
});

// --- Gerenciamento de Anúncios (CRUD) ---

// Obter todos os anúncios (Read)
app.get('/api/ads', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM advertisements WHERE restaurant_id = $1 ORDER BY id ASC', [req.restaurant_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar anúncios.' });
  }
});

// Criar um novo anúncio (Create)
app.post('/api/ads', async (req, res) => {
  const { title, content, image_url, start_date, end_date, is_active } = req.body;
  try {
    const { rows } = await db.query(
      'INSERT INTO advertisements (title, content, image_url, start_date, end_date, is_active, restaurant_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING *',
      [title, content, image_url, start_date, end_date, is_active, req.restaurant_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar anúncio.' });
  }
});

// Atualizar um anúncio (Update)
app.put('/api/ads/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content, image_url, start_date, end_date, is_active } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE advertisements SET title = $1, content = $2, image_url = $3, start_date = $4, end_date = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 AND restaurant_id = $8 RETURNING *',
      [title, content, image_url, start_date, end_date, is_active, id, req.restaurant_id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar anúncio.' });
  }
});

// Deletar um anúncio (Delete)
app.delete('/api/ads/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM advertisements WHERE id = $1 AND restaurant_id = $2', [id, req.restaurant_id]);
    res.status(204).send(); // Sem conteúdo
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar anúncio.' });
  }
});

// Middleware de autenticação para rotas da IA
const authenticateAI = (req, res, next) => {
  const expectedKey = process.env.AI_MODULE_API_KEY;
  if (!expectedKey) {
    console.warn('AI_MODULE_API_KEY não configurado. Rotas de IA sem proteção.');
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === expectedKey) {
    return next();
  }
  return res.status(401).json({ error: 'Não autorizado.' });
};

// Rota de Chat com IA (Voz)
app.post('/api/chat/voice', authenticateAI, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo de áudio enviado.' });
  }

  try {
    const audioFilePath = req.file.path;
    const transcribedText = await transcribeAudio(audioFilePath);

    if (!transcribedText) {
      throw new Error('A transcrição falhou.');
    }

    await persistMemoryEntry({
      restaurantId: req.restaurant_id,
      scope: 'ai_chat',
      source: 'user',
      kind: 'voice_transcript',
      content: transcribedText,
      metadata: { channel: 'voice', topics: extractMemoryTopics(transcribedText) }
    });

    const restaurantContext = await gatherRestaurantContext(req.restaurant_id);
    const chatResponse = await getChatResponse(transcribedText, restaurantContext);

    await persistMemoryEntry({
      restaurantId: req.restaurant_id,
      scope: 'ai_chat',
      source: 'assistant',
      kind: 'reply',
      content: chatResponse,
      metadata: { channel: 'voice', topics: extractMemoryTopics(chatResponse) }
    });

    // Converte a resposta do chat em áudio
    const audioResponsePath = await textToSpeech(chatResponse);

    res.json({
      reply: chatResponse,
      transcription: transcribedText,
      audio_url: safeAudioUrl(audioResponsePath)
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar o áudio.' });
  } finally {
    // Limpa o arquivo de áudio após o processamento
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) { }
    }
  }
});

// Rota de Chat com IA (Texto)
app.post('/api/chat', authenticateAI, async (req, res) => {
  const { message, mode } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'A mensagem do usuário é obrigatória.' });
  }

  try {
    await persistMemoryEntry({
      restaurantId: req.restaurant_id,
      scope: 'ai_chat',
      source: 'user',
      kind: 'message',
      content: message,
      metadata: { channel: 'text', mode: mode || 'default', topics: extractMemoryTopics(message) }
    });

    const restaurantContext = await gatherRestaurantContext(req.restaurant_id);
    const response = await getChatResponse(message, restaurantContext, { mode });

    await persistMemoryEntry({
      restaurantId: req.restaurant_id,
      scope: 'ai_chat',
      source: 'assistant',
      kind: 'reply',
      content: response,
      metadata: { channel: 'text', mode: mode || 'default', topics: extractMemoryTopics(response) }
    });

    // Converte a resposta do chat em áudio
    const audioResponsePath = await textToSpeech(response);

    res.json({ reply: response, audio_url: safeAudioUrl(audioResponsePath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar a mensagem.' });
  }
});

app.post('/api/chat/stream', async (req, res) => {
  const { message, mode } = req.body || {};
  const restaurantId = req.restaurant_id || 1;

  if (!message) {
    return res.status(400).json({ error: 'A mensagem do usuário é obrigatória.' });
  }

  console.log(`[AI] Iniciando stream para restaurante ${restaurantId}, modo: "${mode || 'default'}", mensagem: "${message}"`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await persistMemoryEntry({
      restaurantId,
      scope: 'ai_chat',
      source: 'user',
      kind: 'message',
      content: message,
      metadata: { channel: 'stream', mode: mode || 'default', topics: extractMemoryTopics(message) }
    });

    const restaurantContext = await gatherRestaurantContext(restaurantId);
    writeEvent({ type: 'start' });
    let fullResponse = '';

    for await (const chunk of getChatResponseStream(message, restaurantContext, { mode })) {
      fullResponse += chunk;
      writeEvent({ type: 'chunk', content: chunk });
    }

    await persistMemoryEntry({
      restaurantId,
      scope: 'ai_chat',
      source: 'assistant',
      kind: 'reply',
      content: fullResponse,
      metadata: { channel: 'stream', mode: mode || 'default', topics: extractMemoryTopics(fullResponse) }
    });

    writeEvent({ type: 'done' });
    console.log('[AI] Stream concluído com sucesso');
    res.end();
  } catch (error) {
    console.error('[AI] Erro crítico no chat streaming:', error);
    writeEvent({ type: 'error', message: 'Erro ao processar a mensagem em streaming.' });
    res.end();
  }
});

app.get('/api/ai/memory', authenticateAI, async (req, res) => {
  try {
    const memory = await getRuntimeMemorySummary(req.restaurant_id);
    res.json({
      restaurant_id: req.restaurant_id,
      summary: memory.shortSummary,
      updated_at: memory.updatedAt,
      entries: memory.entries
    });
  } catch (error) {
    console.error('Erro ao carregar memÃ³ria operacional:', error);
    res.status(500).json({ error: 'Erro ao carregar a memÃ³ria operacional.' });
  }
});

app.post('/api/ai/memory', authenticateAI, async (req, res) => {
  const { content, scope, kind, source, metadata } = req.body || {};

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content Ã© obrigatÃ³rio.' });
  }

  try {
    const memory = await persistMemoryEntry({
      restaurantId: req.restaurant_id,
      scope: scope || 'operations',
      source: source || 'system',
      kind: kind || 'note',
      content,
      metadata: {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        topics: extractMemoryTopics(content)
      }
    });

    res.status(201).json({
      restaurant_id: req.restaurant_id,
      summary: memory?.shortSummary || null,
      updated_at: memory?.updatedAt || null,
      entries: memory?.entries || []
    });
  } catch (error) {
    console.error('Erro ao registrar memÃ³ria operacional:', error);
    res.status(500).json({ error: 'Erro ao registrar a memÃ³ria operacional.' });
  }
});

app.get('/api/backend/heartbeat', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, service_name, status, details, started_at, heartbeat_at, metadata
       FROM backend_heartbeats
       WHERE service_name = $1
       ORDER BY heartbeat_at DESC, id DESC
       LIMIT 10`,
      [BACKEND_SERVICE_NAME]
    );

    res.json({
      current: backendHeartbeatState,
      history: (rows || []).map((row) => ({
        ...row,
        metadata: safeJsonParse(row.metadata, {})
      }))
    });
  } catch (error) {
    console.error('Erro ao carregar heartbeat do backend:', error);
    res.status(500).json({ error: 'Erro ao carregar heartbeat do backend.' });
  }
});

app.get('/api/ai/greeting', async (req, res) => {
  try {
    const restaurantContext = await gatherRestaurantContext(req.restaurant_id);
    const prompt = `Gere uma saudação inicial curta (máximo 15 palavras) para o chat do assistente virtual do restaurante "${restaurantContext.restaurantName}". Seja convidativo e mencione o nome do restaurante. Use emojis simpáticos.`;
    const greeting = await getChatResponse(prompt, "Você é um assistente de recepção simpático e conciso.");
    res.json({ greeting });
  } catch (error) {
    console.error('Erro ao gerar saudação IA:', error);
    res.json({ greeting: 'Olá! Sou seu assistente virtual. Como posso ajudar você hoje?' });
  }
});

app.get('/api/ai/insights', authenticateToken, async (req, res) => {
  try {
    const restaurantContext = await gatherRestaurantContext(req.restaurant_id);
    const insightsText = await getRestaurantInsights(restaurantContext);

    res.json({
      generated_at: new Date().toISOString(),
      restaurant_id: req.restaurant_id,
      insights: insightsText,
      items: splitInsights(insightsText),
      context_summary: {
        total_orders: restaurantContext.totalOrders,
        total_revenue: restaurantContext.totalRevenue,
        cancelled_orders: restaurantContext.cancelledOrders,
        avg_service_time: restaurantContext.avgServiceTime,
      }
    });
  } catch (error) {
    console.error('Erro ao gerar insights da IA:', error);
    res.status(500).json({ error: 'Erro ao gerar insights da IA.' });
  }
});

// --- Super Admin ---
const SUPERADMIN_PERIOD_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

const requireSuperadmin = (req, res) => {
  if (req.user_role !== 'superadmin') {
    res.status(403).json({ error: 'Acesso negado. Apenas superadmins.' });
    return false;
  }

  return true;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseDateSafe = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateKey = (value) => {
  const date = parseDateSafe(value);
  if (!date) return null;
  return date.toISOString().slice(0, 10);
};

const calculateGrowth = (currentValue, previousValue) => {
  if (!previousValue && !currentValue) return 0;
  if (!previousValue) return 100;
  return ((currentValue - previousValue) / previousValue) * 100;
};

const parseSuperadminRange = (query) => {
  const endDate = query.end_date ? parseDateSafe(`${query.end_date}T23:59:59.999Z`) : new Date();

  if (query.start_date) {
    const startDate = parseDateSafe(`${query.start_date}T00:00:00.000Z`) || new Date(endDate.getTime() - 29 * 86400000);
    const durationMs = Math.max(86400000, endDate.getTime() - startDate.getTime() + 1);
    return {
      period: 'custom',
      startDate,
      endDate,
      previousStartDate: new Date(startDate.getTime() - durationMs),
      previousEndDate: new Date(startDate.getTime() - 1),
      label: `${query.start_date} até ${query.end_date || endDate.toISOString().slice(0, 10)}`,
    };
  }

  const period = query.period && (query.period in SUPERADMIN_PERIOD_DAYS || query.period === 'all') ? query.period : '30d';
  if (period === 'all') {
    return {
      period,
      startDate: null,
      endDate: null,
      previousStartDate: null,
      previousEndDate: null,
      label: 'Todo o histórico',
    };
  }

  const days = SUPERADMIN_PERIOD_DAYS[period];
  const startDate = new Date(endDate.getTime() - (days - 1) * 86400000);
  const previousStartDate = new Date(startDate.getTime() - days * 86400000);
  const previousEndDate = new Date(startDate.getTime() - 1);

  return {
    period,
    startDate,
    endDate,
    previousStartDate,
    previousEndDate,
    label: `Últimos ${days} dias`,
  };
};

const isInRange = (value, startDate, endDate) => {
  if (!startDate && !endDate) return true;
  const date = parseDateSafe(value);
  if (!date) return false;
  if (startDate && date < startDate) return false;
  if (endDate && date > endDate) return false;
  return true;
};

const filterBySearchAndStatus = (restaurants, search, status) => {
  const normalizedSearch = String(search || '').trim().toLowerCase();
  return restaurants.filter((restaurant) => {
    const matchesSearch = !normalizedSearch
      || [restaurant.name, restaurant.owner_name, restaurant.phone_number]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(normalizedSearch));

    const activeFlag = Number(restaurant.is_active ?? 1) === 1;
    const matchesStatus = status === 'inactive'
      ? !activeFlag
      : status === 'active'
        ? activeFlag
        : true;

    return matchesSearch && matchesStatus;
  });
};

const buildRestaurantAnalytics = (restaurant, allOrders, allDishSales, range) => {
  const restaurantOrders = allOrders.filter((order) => Number(order.restaurant_id) === Number(restaurant.id));
  const restaurantDishSales = allDishSales.filter((item) => Number(item.restaurant_id) === Number(restaurant.id));

  const currentOrders = restaurantOrders.filter((order) => isInRange(order.created_at, range.startDate, range.endDate));
  const previousOrders = range.previousStartDate
    ? restaurantOrders.filter((order) => isInRange(order.created_at, range.previousStartDate, range.previousEndDate))
    : [];
  const currentDishSales = restaurantDishSales.filter((item) => isInRange(item.created_at, range.startDate, range.endDate));

  const totalSales = currentOrders.reduce((sum, order) => sum + toNumber(order.total_price), 0);
  const previousSales = previousOrders.reduce((sum, order) => sum + toNumber(order.total_price), 0);
  const totalOrders = currentOrders.length;
  const previousOrdersCount = previousOrders.length;
  const averageTicket = totalOrders > 0 ? totalSales / totalOrders : 0;

  const dailyTrendMap = currentOrders.reduce((acc, order) => {
    const day = formatDateKey(order.created_at);
    if (!day) return acc;

    if (!acc[day]) {
      acc[day] = { day, revenue: 0, orders: 0 };
    }

    acc[day].revenue += toNumber(order.total_price);
    acc[day].orders += 1;
    return acc;
  }, {});

  const dailyTrend = Object.values(dailyTrendMap).sort((a, b) => a.day.localeCompare(b.day));
  const bestDays = [...dailyTrend].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  const bestSellingItemsMap = currentDishSales.reduce((acc, item) => {
    if (!acc[item.dish_name]) {
      acc[item.dish_name] = { name: item.dish_name, quantity: 0, revenue: 0 };
    }

    acc[item.dish_name].quantity += toNumber(item.quantity);
    acc[item.dish_name].revenue += toNumber(item.quantity) * toNumber(item.item_price);
    return acc;
  }, {});

  const bestSellingItems = Object.values(bestSellingItemsMap)
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
    .slice(0, 5);

  const lastOrderAt = restaurantOrders
    .map((order) => parseDateSafe(order.created_at))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())
    .at(-1)?.toISOString() || null;

  return {
    ...restaurant,
    is_active: Number(restaurant.is_active ?? 1) === 1,
    metrics: {
      total_sales: totalSales,
      previous_total_sales: previousSales,
      total_orders: totalOrders,
      previous_total_orders: previousOrdersCount,
      average_ticket: averageTicket,
      sales_growth: calculateGrowth(totalSales, previousSales),
      orders_growth: calculateGrowth(totalOrders, previousOrdersCount),
      last_order_at: lastOrderAt,
      best_selling_items: bestSellingItems,
      best_days: bestDays,
      daily_trend: dailyTrend,
    },
  };
};

const fetchSuperadminDatasets = async () => {
  let restaurantsResult;
  try {
    restaurantsResult = await db.query(
      'SELECT id, name, owner_name, phone_number, email, address, cuisine_type, tax_id, is_active, created_at FROM restaurants ORDER BY created_at DESC, id DESC'
    );
  } catch (restaurantsError) {
    try {
      restaurantsResult = await db.query(
        'SELECT id, name, owner_name, phone_number, is_active, created_at FROM restaurants ORDER BY created_at DESC, id DESC'
      );
    } catch (fallbackError) {
      restaurantsResult = await db.query(
        'SELECT id, name, created_at FROM restaurants ORDER BY created_at DESC, id DESC'
      );
    }
  }

  const ordersResult = await db.query(`
    SELECT
      id,
      restaurant_id,
      total_price,
      status,
      created_at
    FROM orders
    WHERE status != 'cancelled'
  `);

  const cancelledOrdersResult = await db.query(`
    SELECT
      id,
      restaurant_id,
      total_price,
      created_at
    FROM orders
    WHERE status = 'cancelled'
  `);

  const dishSalesResult = await db.query(`
    SELECT
      o.restaurant_id,
      o.created_at,
      d.name AS dish_name,
      d.category_id,
      oi.quantity,
      oi.item_price
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN dishes d ON d.id = oi.dish_id
    WHERE o.status != 'cancelled'
  `);

  let ratingsResult = { rows: [] };
  try {
    ratingsResult = await db.query(`
      SELECT
        r.restaurant_id,
        r.rating,
        r.comment,
        r.created_at,
        d.name AS dish_name
      FROM ratings r
      JOIN dishes d ON d.id = r.dish_id
    `);
  } catch (ratingsError) {
    console.error('Erro ao buscar ratings para superadmin:', ratingsError.message);
  }

  let categoriesResult = { rows: [] };
  try {
    categoriesResult = await db.query('SELECT id, name, restaurant_id FROM categories');
  } catch (catError) {
    console.error('Erro ao buscar categorias para superadmin:', catError.message);
  }

  return {
    restaurants: (restaurantsResult.rows || []).map((restaurant) => ({
      ...restaurant,
      is_active: Number(restaurant.is_active ?? 1) === 1,
    })),
    orders: ordersResult.rows || [],
    cancelledOrders: cancelledOrdersResult.rows || [],
    dishSales: dishSalesResult.rows || [],
    ratings: ratingsResult.rows || [],
    categories: categoriesResult.rows || [],
  };
};

const buildSuperadminResponse = ({ restaurants, orders, cancelledOrders, dishSales, ratings, categories, query }) => {
  const range = parseSuperadminRange(query);
  const filteredRestaurants = filterBySearchAndStatus(restaurants, query.search, query.status);
  const enrichedRestaurants = filteredRestaurants.map((restaurant) => buildRestaurantAnalytics(restaurant, orders, dishSales, range));

  const totalSales = enrichedRestaurants.reduce((sum, restaurant) => sum + toNumber(restaurant.metrics.total_sales), 0);
  const previousTotalSales = enrichedRestaurants.reduce((sum, restaurant) => sum + toNumber(restaurant.metrics.previous_total_sales), 0);
  const totalOrders = enrichedRestaurants.reduce((sum, restaurant) => sum + toNumber(restaurant.metrics.total_orders), 0);
  const previousTotalOrders = enrichedRestaurants.reduce((sum, restaurant) => sum + toNumber(restaurant.metrics.previous_total_orders), 0);

  const topRestaurant = [...enrichedRestaurants].sort((a, b) => b.metrics.total_sales - a.metrics.total_sales)[0] || null;
  const mostProfitableDays = enrichedRestaurants
    .flatMap((restaurant) =>
      restaurant.metrics.best_days.map((day) => ({
        ...day,
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name,
      }))
    )
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // --- Top Dishes Network (ranking global de pratos) ---
  const filteredDishSales = dishSales.filter((item) => isInRange(item.created_at, range.startDate, range.endDate));
  const dishNetworkMap = {};
  filteredDishSales.forEach((item) => {
    const key = item.dish_name;
    if (!dishNetworkMap[key]) {
      dishNetworkMap[key] = { name: key, quantity: 0, revenue: 0, restaurants: new Set() };
    }
    dishNetworkMap[key].quantity += toNumber(item.quantity);
    dishNetworkMap[key].revenue += toNumber(item.quantity) * toNumber(item.item_price);
    dishNetworkMap[key].restaurants.add(Number(item.restaurant_id));
  });
  const topDishesNetwork = Object.values(dishNetworkMap)
    .map((dish) => ({ ...dish, restaurant_count: dish.restaurants.size, restaurants: undefined }))
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
    .slice(0, 10);

  // --- Network Ratings (avaliações globais) ---
  const filteredRatings = ratings.filter((r) => isInRange(r.created_at, range.startDate, range.endDate));
  const totalRatings = filteredRatings.length;
  const avgRating = totalRatings > 0 ? filteredRatings.reduce((sum, r) => sum + toNumber(r.rating), 0) / totalRatings : 0;
  const ratingDistribution = [5, 4, 3, 2, 1].map((star) => ({
    rating: star,
    count: filteredRatings.filter((r) => toNumber(r.rating) === star).length,
  }));
  const dishRatingMap = {};
  filteredRatings.forEach((r) => {
    if (!dishRatingMap[r.dish_name]) {
      dishRatingMap[r.dish_name] = { name: r.dish_name, total: 0, count: 0 };
    }
    dishRatingMap[r.dish_name].total += toNumber(r.rating);
    dishRatingMap[r.dish_name].count += 1;
  });
  const topRatedDishes = Object.values(dishRatingMap)
    .map((d) => ({ name: d.name, avg_rating: d.count > 0 ? d.total / d.count : 0, count: d.count }))
    .filter((d) => d.count >= 1)
    .sort((a, b) => b.avg_rating - a.avg_rating || b.count - a.count)
    .slice(0, 10);
  const worstRatedDishes = Object.values(dishRatingMap)
    .map((d) => ({ name: d.name, avg_rating: d.count > 0 ? d.total / d.count : 0, count: d.count }))
    .filter((d) => d.count >= 1)
    .sort((a, b) => a.avg_rating - b.avg_rating || b.count - a.count)
    .slice(0, 5);

  const networkRatings = {
    total_ratings: totalRatings,
    average_rating: avgRating,
    distribution: ratingDistribution,
    top_rated: topRatedDishes,
    worst_rated: worstRatedDishes,
  };

  // --- Category Insights (categorias mais lucrativas da rede) ---
  const categoryMap = {};
  categories.forEach((cat) => {
    categoryMap[cat.id] = cat.name;
  });
  const categoryRevenueMap = {};
  filteredDishSales.forEach((item) => {
    const catName = categoryMap[item.category_id] || 'Sem categoria';
    if (!categoryRevenueMap[catName]) {
      categoryRevenueMap[catName] = { name: catName, revenue: 0, quantity: 0 };
    }
    categoryRevenueMap[catName].revenue += toNumber(item.quantity) * toNumber(item.item_price);
    categoryRevenueMap[catName].quantity += toNumber(item.quantity);
  });
  const categoryInsights = Object.values(categoryRevenueMap)
    .sort((a, b) => b.revenue - a.revenue);

  // --- Cancellation Rate per Restaurant ---
  const filteredCancelledOrders = (cancelledOrders || []).filter((o) => isInRange(o.created_at, range.startDate, range.endDate));
  const cancellationByRestaurant = enrichedRestaurants.map((restaurant) => {
    const cancelled = filteredCancelledOrders.filter((o) => Number(o.restaurant_id) === Number(restaurant.id)).length;
    const valid = restaurant.metrics.total_orders;
    const total = valid + cancelled;
    return {
      id: restaurant.id,
      name: restaurant.name,
      cancelled_orders: cancelled,
      total_orders: total,
      cancellation_rate: total > 0 ? (cancelled / total) * 100 : 0,
      lost_revenue: filteredCancelledOrders
        .filter((o) => Number(o.restaurant_id) === Number(restaurant.id))
        .reduce((sum, o) => sum + toNumber(o.total_price), 0),
    };
  }).sort((a, b) => b.cancellation_rate - a.cancellation_rate);

  const comparisonIds = String(query.compare_ids || '')
    .split(',')
    .map((value) => Number(value))
    .filter(Number.isFinite);

  const comparisons = enrichedRestaurants
    .filter((restaurant) => comparisonIds.includes(Number(restaurant.id)))
    .slice(0, 4)
    .map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      is_active: restaurant.is_active,
      total_sales: restaurant.metrics.total_sales,
      total_orders: restaurant.metrics.total_orders,
      average_ticket: restaurant.metrics.average_ticket,
      sales_growth: restaurant.metrics.sales_growth,
      orders_growth: restaurant.metrics.orders_growth,
    }));

  return {
    filters: {
      search: query.search || '',
      status: query.status || 'all',
      period: range.period,
      start_date: range.startDate ? range.startDate.toISOString().slice(0, 10) : null,
      end_date: range.endDate ? range.endDate.toISOString().slice(0, 10) : null,
      label: range.label,
    },
    summary: {
      total_restaurants: enrichedRestaurants.length,
      active_restaurants: enrichedRestaurants.filter((restaurant) => restaurant.is_active).length,
      inactive_restaurants: enrichedRestaurants.filter((restaurant) => !restaurant.is_active).length,
      total_sales: totalSales,
      total_orders: totalOrders,
      sales_growth: calculateGrowth(totalSales, previousTotalSales),
      orders_growth: calculateGrowth(totalOrders, previousTotalOrders),
      top_restaurant: topRestaurant
        ? {
            id: topRestaurant.id,
            name: topRestaurant.name,
            total_sales: topRestaurant.metrics.total_sales,
            sales_growth: topRestaurant.metrics.sales_growth,
          }
        : null,
      most_profitable_days: mostProfitableDays,
    },
    top_dishes_network: topDishesNetwork,
    network_ratings: networkRatings,
    category_insights: categoryInsights,
    cancellation_by_restaurant: cancellationByRestaurant,
    comparisons,
    restaurants: enrichedRestaurants,
  };
};

app.get('/api/superadmin/restaurants', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;

  try {
    const datasets = await fetchSuperadminDatasets();
    const response = buildSuperadminResponse({ ...datasets, query: req.query });
    res.json({
      filters: response.filters,
      restaurants: response.restaurants.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.name,
        owner_name: restaurant.owner_name,
        phone_number: restaurant.phone_number,
        email: restaurant.email,
        address: restaurant.address,
        cuisine_type: restaurant.cuisine_type,
        tax_id: restaurant.tax_id,
        created_at: restaurant.created_at,
        is_active: restaurant.is_active,
        metrics: restaurant.metrics,
      })),
    });
  } catch (err) {
    console.error('Erro ao listar restaurantes do superadmin:', err);
    res.status(500).json({ error: 'Erro ao listar restaurantes.' });
  }
});

app.get('/api/superadmin/restaurants/:id', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;

  try {
    const datasets = await fetchSuperadminDatasets();
    const response = buildSuperadminResponse({ ...datasets, query: req.query });
    const restaurant = response.restaurants.find((item) => Number(item.id) === Number(req.params.id));

    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurante não encontrado.' });
    }

    res.json({
      filters: response.filters,
      restaurant,
    });
  } catch (err) {
    console.error('Erro ao carregar detalhe do restaurante:', err);
    res.status(500).json({ error: 'Erro ao carregar detalhe do restaurante.' });
  }
});

app.patch('/api/superadmin/restaurants/:id/status', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;

  const { id } = req.params;
  const isActive = req.body?.is_active === true || req.body?.is_active === 1 || req.body?.is_active === '1';

  try {
    let updateResult;
    try {
      updateResult = await db.query(
        'UPDATE restaurants SET is_active = $1 WHERE id = $2 RETURNING id, name, owner_name, phone_number, email, address, cuisine_type, tax_id, is_active, created_at',
        [isActive ? 1 : 0, id]
      );
    } catch (updateError) {
      await db.query('UPDATE restaurants SET is_active = $1 WHERE id = $2', [isActive ? 1 : 0, id]);
      updateResult = await db.query(
        'SELECT id, name, owner_name, phone_number, email, address, cuisine_type, tax_id, is_active, created_at FROM restaurants WHERE id = $1',
        [id]
      );
    }

    const restaurant = updateResult.rows?.[0];
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurante não encontrado.' });
    }

    res.json({
      message: isActive ? 'Restaurante ativado com sucesso.' : 'Restaurante desativado com sucesso.',
      restaurant: {
        ...restaurant,
        is_active: Number(restaurant.is_active ?? 1) === 1,
      },
    });
  } catch (err) {
    console.error('Erro ao atualizar status do restaurante:', err);
    res.status(500).json({ error: 'Erro ao atualizar status do restaurante.' });
  }
});

app.get('/api/superadmin/overview', async (req, res) => {
  if (!requireSuperadmin(req, res)) return;

  try {
    const datasets = await fetchSuperadminDatasets();
    const response = buildSuperadminResponse({ ...datasets, query: req.query });
    res.json(response);
  } catch (err) {
    console.error('Erro no overview Super Admin:', err);
    res.status(500).json({ error: 'Erro ao gerar overview do Super Admin.' });
  }
});

app.get('/api/superadmin/export', async (req, res) => {
  if (req.user_role !== 'superadmin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas superadmins.' });
  }

  try {
    // Busca dados agregados de vendas por restaurante
    const restaurantsResult = await db.query('SELECT * FROM restaurants ORDER BY id ASC');
    const ordersResult = await db.query(`
      SELECT 
        o.restaurant_id, 
        r.name as restaurant_name, 
        COUNT(o.id) as total_pedidos, 
        SUM(o.total_price) as faturamento_total,
        MAX(o.created_at) as ultimo_pedido
      FROM orders o
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE o.status != 'cancelled'
      GROUP BY o.restaurant_id, r.name
      ORDER BY faturamento_total DESC
    `);

    res.json({
      restaurants: restaurantsResult.rows,
      metrics: ordersResult.rows
    });
  } catch (err) {
    console.error('Erro na exportação Super Admin:', err);
    res.status(500).json({ error: 'Erro ao gerar exportação Super Admin.' });
  }
});

// Healthcheck abrangente para diagnosticar conectividade e serviços
app.get('/api/health', async (req, res) => {
  const http = require('http');

  // Função para verificar um serviço externo via HTTP
  const checkExternalService = (url, serviceName) => {
    return new Promise((resolve) => {
      if (!url) {
        resolve({ name: serviceName, status: 'disabled', details: 'URL não configurada.' });
        return;
      }

      const request = http.get(url, { timeout: 1500 }, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve({ name: serviceName, status: 'ok' });
          } else {
            resolve({ name: serviceName, status: 'error', details: `Status code: ${resp.statusCode}` });
          }
        });
      });

      request.on('error', (err) => {
        resolve({ name: serviceName, status: 'error', details: err.message });
      });

      request.on('timeout', () => {
        request.destroy();
        resolve({ name: serviceName, status: 'error', details: 'Timeout de 3 segundos excedido.' });
      });
    });
  };

  // Lista de verificações a serem executadas
  const checks = [
    // 1. API Principal (este serviço)
    Promise.resolve({ name: 'API Principal', status: 'ok' }),

    // 2. Módulo de IA (integrado, não um serviço externo)
    Promise.resolve({ name: 'Módulo de IA', status: 'ok', details: 'Integrado' }),

    // 3. Banco de Dados
    db.query('SELECT 1')
      .then(() => ({ name: 'Banco de Dados', status: 'ok' }))
      .catch(err => ({ name: 'Banco de Dados', status: 'error', details: err.message })),

    // 4. Módulo de Anúncios (serviço externo)
    checkExternalService(process.env.ADS_MODULE_URL, 'Módulo de Anúncios'),

    // 5. Frontend do Painel Admin
    checkExternalService(process.env.ADMIN_PANEL_URL, 'Painel do Administrador'),

    // 6. Frontend do Cliente Web
    checkExternalService(process.env.CLIENT_WEB_URL, 'App do Cliente')
  ];

  // Executa todas as verificações em paralelo
  const results = await Promise.allSettled(checks);

  const serviceStatuses = results.map(result => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Isso não deve acontecer com a configuração atual, mas é um fallback
    return { name: 'Unknown', status: 'error', details: 'Falha na verificação interna.' };
  });

  // Determina o status geral
  const hasError = serviceStatuses.some(s => s.status === 'error');
  const overallStatus = hasError ? 'degraded' : 'healthy';

  res.status(hasError ? 503 : 200).json({
    status: overallStatus,
    services: serviceStatuses,
    heartbeat: backendHeartbeatState,
    timestamp: new Date().toISOString()
  });
});

// --- Gerenciamento de Banco de Dados ---

// Função auxiliar para formatar bytes
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// Status do banco de dados
app.get('/api/database/status', async (req, res) => {
  try {
    // Testar conexão
    await db.query('SELECT 1');
    const dbType = db.getDbType();

    // Verificar tabelas existentes
    let tables = [];
    try {
      if (dbType === 'postgresql') {
        const tablesResult = await db.query(`
          SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
        `);
        tables = tablesResult.rows.map(row => row.table_name);
      } else if (dbType === 'sqlite') {
        const tablesResult = await db.query(`
          SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
        `);
        tables = tablesResult.rows.map(row => row.name);
      }
    } catch (tableError) {
      console.log('Erro ao buscar tabelas:', tableError.message);
    }

    // Calcular tamanho do banco de dados
    let dbSize = 0;
    if (dbType === 'postgresql') {
      const sizeResult = await db.query('SELECT pg_database_size(current_database()) as size');
      dbSize = sizeResult.rows[0] ? parseInt(sizeResult.rows[0].size, 10) : 0;
    } else if (dbType === 'sqlite') {
      try {
        const dbPath = path.join(__dirname, 'database.sqlite');
        if (fs.existsSync(dbPath)) {
          dbSize = fs.statSync(dbPath).size;
        }
      } catch (sizeError) {
        console.error('Erro ao calcular tamanho do arquivo SQLite:', sizeError);
      }
    }

    res.json({
      connected: true,
      type: dbType,
      tables: tables,
      size: dbSize,
      size_pretty: formatBytes(dbSize),
      config: {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'restaurantes',
        username: process.env.DB_USER || 'postgres'
      }
    });
  } catch (error) {
    console.error('Erro no status do banco:', error.message);
    res.json({
      connected: false,
      type: 'unknown',
      error: error.message,
      tables: [],
      size: 0,
      size_pretty: '0 Bytes'
    });
  }
});

// Testar conexão com banco
app.post('/api/database/test', async (req, res) => {
  const { type, host, port, database, username, password, ssl } = req.body;

  try {
    let testDb;

    if (type === 'postgresql') {
      const { Pool } = require('pg');
      testDb = new Pool({
        user: username,
        host: host,
        database: database,
        password: password,
        port: parseInt(port),
        ssl: ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 5000
      });
    } else if (type === 'sqlite') {
      const sqlite3 = require('sqlite3').verbose();
      const path = require('path');
      const dbPath = path.join(__dirname, 'database.sqlite');
      testDb = new sqlite3.Database(dbPath);
    }

    // Testar conexão
    if (type === 'postgresql') {
      const client = await testDb.connect();
      await client.query('SELECT 1');
      client.release();
      await testDb.end();
    } else if (type === 'sqlite') {
      await new Promise((resolve, reject) => {
        testDb.get('SELECT 1', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      testDb.close();
    }

    res.json({ success: true, message: 'Conexão bem-sucedida' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Exportar banco de dados
app.get('/api/database/export', async (req, res) => {
  const dbType = db.getDbType();
  const today = new Date().toISOString().slice(0, 10);
  const filename = `backup-${dbType}-${today}.sql`;

  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  if (dbType === 'sqlite') {
    const { exec } = require('child_process');
    const dbPath = path.join(__dirname, 'database.sqlite');

    const command = `sqlite3 "${dbPath}" .dump`;

    const child = exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Erro ao exportar SQLite: ${error.message}`);
        res.status(500).end('Erro ao gerar o backup do SQLite.');
        return;
      }
      if (stderr) {
        console.warn(`Stderr do dump SQLite: ${stderr}`);
      }
    });

    child.stdout.pipe(res);

  } else if (dbType === 'postgresql') {
    // A implementação com pg_dump é mais complexa e depende do ambiente.
    // Retornando um erro claro por enquanto.
    try {
      const tablesResult = await db.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const escapeSql = (value) => {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        return `'${String(value).replace(/'/g, "''")}'`;
      };
      const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
      const chunks = ['-- Logical PostgreSQL export generated by backend\n'];

      for (const table of tablesResult.rows.map(row => row.table_name)) {
        const rowsResult = await db.query(`SELECT * FROM ${quoteIdent(table)}`);
        chunks.push(`\n-- Table: ${table}\n`);
        for (const row of rowsResult.rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) continue;
          chunks.push(`INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(column => escapeSql(row[column])).join(', ')});\n`);
        }
      }

      res.status(200).send(chunks.join(''));
    } catch (error) {
      console.error('Erro ao exportar PostgreSQL:', error);
      res.status(500).send('-- Erro ao gerar o backup do PostgreSQL.\n');
    }

  } else {
    res.status(400).send('-- Tipo de banco de dados desconhecido.\n');
  }
});


// Configurar banco de dados
app.post('/api/database/setup', async (req, res) => {
  const { type, host, port, database, username, password, ssl } = req.body;

  try {
    let newDb;

    if (type === 'postgresql') {
      const { Pool } = require('pg');
      newDb = new Pool({
        user: username,
        host: host,
        database: database,
        password: password,
        port: parseInt(port),
        ssl: ssl ? { rejectUnauthorized: false } : false
      });
    } else if (type === 'sqlite') {
      const sqlite3 = require('sqlite3').verbose();
      const path = require('path');
      const dbPath = path.join(__dirname, 'database.sqlite');
      newDb = new sqlite3.Database(dbPath);
    }

    // Executar schema se for PostgreSQL
    if (type === 'postgresql') {
      const client = await newDb.connect();

      // Ler e executar schema
      const fs = require('fs');
      const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');

      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await client.query(schema);
      } else {
        // Schema básico se não existir arquivo
        const basicSchema = `
          CREATE TABLE IF NOT EXISTS dishes (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            price DECIMAL(10,2) NOT NULL,
            category_id INTEGER,
            image_url VARCHAR(500),
            is_available BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          
          CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            table_number INTEGER NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            total_price DECIMAL(10,2) NOT NULL,
            prep_time_seconds INTEGER DEFAULT 1200,
            cancel_until TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          
          CREATE TABLE IF NOT EXISTS order_items (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
            dish_id INTEGER REFERENCES dishes(id),
            quantity INTEGER NOT NULL,
            item_price DECIMAL(10,2) NOT NULL
          );
          
          CREATE TABLE IF NOT EXISTS settings (
            id SERIAL PRIMARY KEY,
            key VARCHAR(255) NOT NULL,
            restaurant_id INTEGER DEFAULT 1,
            value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(key, restaurant_id)
          );
          
          CREATE TABLE IF NOT EXISTS advertisements (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            content TEXT,
            image_url VARCHAR(500),
            start_date DATE,
            end_date DATE,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `;
        await client.query(basicSchema);
      }

      client.release();
      await newDb.end();
    }

    // Salvar configuração nas variáveis de ambiente (temporário)
    // Em produção, isso deveria ser salvo em um arquivo de configuração seguro
    process.env.DB_TYPE = type;
    process.env.DB_HOST = host;
    process.env.DB_PORT = port;
    process.env.DB_NAME = database;
    process.env.DB_USER = username;
    process.env.DB_PASSWORD = password;
    process.env.DB_SSL = ssl ? 'true' : 'false';

    res.json({ success: true, message: 'Banco de dados configurado com sucesso' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Rota para servir arquivos de áudio
app.use('/audio', express.static(aiAudioDir));

// Rota raiz para verificação rápida
app.get('/', (req, res) => {
  res.json({
    message: 'Interactive Restaurant Backend is Online 🚀',
    uptime: process.uptime(),
    heartbeat: backendHeartbeatState,
    timestamp: new Date()
  });
});

if (process.env.NODE_ENV !== 'test') {
  initializeBackendRuntimeContext().catch((error) => {
  console.error('Falha ao inicializar memÃ³ria/heartbeat do backend:', error);
  backendHeartbeatState.status = 'degraded';
  backendHeartbeatState.details = 'Falha ao inicializar memÃ³ria/heartbeat.';
  });
}

const heartbeatTimer = process.env.NODE_ENV !== 'test'
  ? setInterval(() => {
      recordHeartbeat('ok', 'Backend operacional.', {
        uptime_seconds: Math.round(process.uptime()),
        cached_restaurants: runtimeMemoryCache.size
      }).catch((error) => {
        console.error('Falha ao registrar heartbeat do backend:', error);
      });
    }, HEARTBEAT_INTERVAL_MS)
  : null;

heartbeatTimer?.unref?.();

// Iniciar o servidor
if (process.env.NODE_ENV !== 'test') {
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor backend rodando!`);
    console.log(`   - Local:    http://localhost:${port}`);

    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`   - Network:  http://${net.address}:${port}`);
        }
      }
    }
    console.log(`\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ PORTA ${port} JÁ ESTÁ EM USO!`);
      console.error(`   Mate o processo que usa a porta com: npx kill-port ${port}`);
      console.error(`   Ou use: Stop-Process -Name node -Force (PowerShell)\n`);
      process.exit(1); // Exit cleanly so concurrently can restart
    } else {
      console.error('Erro no servidor HTTP:', err);
    }
  });
}

process.on('uncaughtException', (error) => {
  console.error('Erro não capturado (uncaughtException): ', error);
  process.exit(1);
});

module.exports = { app, server };
