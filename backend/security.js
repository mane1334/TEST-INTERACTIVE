// Funções de segurança puras, sem dependências, para serem testadas isoladamente.

const MAX_ITEMS_PER_ORDER = 50;
const MAX_QUANTITY_PER_ITEM = 50;

// Aceita apenas inteiros positivos (number ou string decimal). Tudo o resto devolve null.
function parsePositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

// Valida os itens de um pedido. Devolve { items } com itens agregados por prato,
// ou { error } com a mensagem a mostrar ao cliente.
function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'O pedido não tem itens.' };
  }
  if (items.length > MAX_ITEMS_PER_ORDER) {
    return { error: `O pedido tem itens a mais (máximo ${MAX_ITEMS_PER_ORDER}).` };
  }
  const merged = new Map();
  for (const raw of items) {
    const dishId = parsePositiveInt(raw && raw.dish_id);
    const quantity = parsePositiveInt(raw && raw.quantity);
    if (!dishId) return { error: 'Prato inválido no pedido.' };
    if (!quantity) return { error: 'Quantidade inválida: use um número inteiro maior que zero.' };
    const total = (merged.get(dishId) || 0) + quantity;
    if (total > MAX_QUANTITY_PER_ITEM) {
      return { error: `Quantidade máxima por prato: ${MAX_QUANTITY_PER_ITEM}.` };
    }
    merged.set(dishId, total);
  }
  return { items: Array.from(merged, ([dish_id, quantity]) => ({ dish_id, quantity })) };
}

// O desvio de autenticação para testes só existe fora de produção e com pedido explícito.
function authBypassEnabled(env = process.env) {
  return env.NODE_ENV === 'test' && env.TEST_AUTH_BYPASS === '1';
}

// Restaurante por omissão, apenas se o operador o configurar (instalações de um só restaurante).
function defaultRestaurantId(env = process.env) {
  return parsePositiveInt(env.DEFAULT_RESTAURANT_ID);
}

// Decide a identidade de uma ligação a partir de um token já verificado (ou null) e do cabeçalho.
// Com token válido, o restaurante vem sempre do token e o cabeçalho é ignorado.
function resolveTenant({ decoded, headerValue, env = process.env }) {
  if (decoded) {
    return { restaurantId: parsePositiveInt(decoded.restaurant_id), role: decoded.role || null, authenticated: true };
  }
  const fromHeader = parsePositiveInt(headerValue);
  if (fromHeader) return { restaurantId: fromHeader, role: null, authenticated: false };
  return { restaurantId: defaultRestaurantId(env), role: null, authenticated: false };
}

// Rotas /api que não precisam de restaurante identificado.
const TENANT_EXEMPT = [/^\/api\/auth(\/|$)/, /^\/api\/health$/, /^\/api\/backend\/heartbeat$/, /^\/api\/superadmin(\/|$)/, /^\/api\/database(\/|$)/];

function tenantRequired(path) {
  return path.startsWith('/api/') && !TENANT_EXEMPT.some((re) => re.test(path));
}

// Hub de WebSocket: cada ligação fica associada a um restaurante; as mensagens
// só chegam às ligações do mesmo restaurante. Logs só para superadmin.
function attachWsHub({ wss, server, verifyToken, WebSocket, env = process.env }) {
  const OPEN = WebSocket.OPEN;

  wss.broadcastTo = function broadcastTo(restaurantId, data) {
    const rid = parsePositiveInt(restaurantId);
    if (!rid) return;
    wss.clients.forEach((client) => {
      if (client.readyState === OPEN && client.restaurantId === rid) client.send(data, () => {});
    });
  };

  wss.broadcastLogs = function broadcastLogs(data) {
    wss.clients.forEach((client) => {
      if (client.readyState === OPEN && client.isSuperadmin) client.send(data, () => {});
    });
  };

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch (_) {
      socket.destroy();
      return;
    }
    const authHeader = request.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || url.searchParams.get('token');
    let decoded = null;
    if (token) {
      try { decoded = verifyToken(token); } catch (_) { decoded = null; }
      if (!decoded) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const headerValue = request.headers['x-restaurant-id'] || url.searchParams.get('restaurant_id');
    const tenant = resolveTenant({ decoded, headerValue, env });
    const isSuperadmin = Boolean(decoded && decoded.role === 'superadmin');
    if (!tenant.restaurantId && !isSuperadmin) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.restaurantId = tenant.restaurantId;
      ws.isStaff = tenant.authenticated;
      ws.isSuperadmin = isSuperadmin;
      wss.emit('connection', ws, request);
    });
  });
}

module.exports = {
  MAX_ITEMS_PER_ORDER,
  MAX_QUANTITY_PER_ITEM,
  parsePositiveInt,
  normalizeOrderItems,
  authBypassEnabled,
  defaultRestaurantId,
  resolveTenant,
  tenantRequired,
  attachWsHub,
};
