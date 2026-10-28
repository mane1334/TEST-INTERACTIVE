const fs = require('fs');
const path = require('path');
const http = require('http');
const request = require('supertest');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

jest.mock('../db', () => ({
  pool: { end: jest.fn().mockResolvedValue() },
  query: jest.fn(async () => ({ rows: [] })),
  getDbType: jest.fn(() => 'sqlite'),
}));

const security = require('../security');
const { JWT_SECRET } = require('../middleware/auth');

// Estes testes correm SEM o desvio de autenticação e SEM restaurante por omissão.
const savedEnv = {};
beforeAll(() => {
  for (const k of ['TEST_AUTH_BYPASS', 'DEFAULT_RESTAURANT_ID']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { app, server, wss } = require('..');
const tokenFor = (restaurant_id, role = 'admin') => jwt.sign({ id: 1, role, restaurant_id }, JWT_SECRET, { expiresIn: '1h' });

describe('validação das quantidades do pedido', () => {
  const ok = (items) => security.normalizeOrderItems(items);

  test('aceita pedidos normais e agrega pratos repetidos', () => {
    expect(ok([{ dish_id: 1, quantity: 2 }, { dish_id: 1, quantity: 3 }, { dish_id: '2', quantity: '1' }]).items)
      .toEqual([{ dish_id: 1, quantity: 5 }, { dish_id: 2, quantity: 1 }]);
  });

  test.each([
    [[]], [null], [[{ dish_id: 1, quantity: 0 }]], [[{ dish_id: 1, quantity: -3 }]],
    [[{ dish_id: 1, quantity: 1.5 }]], [[{ dish_id: 1, quantity: 'abc' }]],
    [[{ dish_id: 1, quantity: 1e9 }]], [[{ dish_id: 1, quantity: 51 }]],
    [[{ dish_id: 1, quantity: 30 }, { dish_id: 1, quantity: 30 }]],
    [[{ dish_id: -1, quantity: 1 }]], [[{ quantity: 1 }]], [[null]],
  ])('recusa %j', (items) => {
    expect(ok(items).error).toBeTruthy();
  });

  test('recusa mais itens do que o limite', () => {
    const many = Array.from({ length: security.MAX_ITEMS_PER_ORDER + 1 }, (_, i) => ({ dish_id: i + 1, quantity: 1 }));
    expect(ok(many).error).toBeTruthy();
  });
});

describe('identificação do restaurante', () => {
  test('sem cabeçalho nem token, recusa (não assume o restaurante 1)', async () => {
    const res = await request(app).get('/api/menu');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TENANT_MISSING');
  });

  test('cabeçalho inválido também é recusado', async () => {
    for (const bad of ['abc', '-1', '0', '1.5', '1 OR 1=1']) {
      const res = await request(app).get('/api/menu').set('x-restaurant-id', bad);
      expect(res.status).toBe(400);
    }
  });

  test('cabeçalho válido é aceite', async () => {
    const res = await request(app).get('/api/menu').set('x-restaurant-id', '3');
    expect(res.status).not.toBe(400);
  });

  test('rotas de autenticação e health não precisam de restaurante', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.code).not.toBe('TENANT_MISSING');
  });

  test('com token válido, o restaurante vem do token e não do cabeçalho', () => {
    const t = security.resolveTenant({ decoded: { restaurant_id: 2, role: 'admin' }, headerValue: '9', env: {} });
    expect(t).toEqual({ restaurantId: 2, role: 'admin', authenticated: true });
  });

  test('DEFAULT_RESTAURANT_ID só vale se o operador o configurar', () => {
    expect(security.resolveTenant({ decoded: null, headerValue: undefined, env: {} }).restaurantId).toBeNull();
    expect(security.resolveTenant({ decoded: null, headerValue: undefined, env: { DEFAULT_RESTAURANT_ID: '4' } }).restaurantId).toBe(4);
  });
});

describe('autenticação sem desvio de testes', () => {
  test('o desvio está desligado', () => {
    expect(security.authBypassEnabled()).toBe(false);
    expect(security.authBypassEnabled({ NODE_ENV: 'production', TEST_AUTH_BYPASS: '1' })).toBe(false);
    expect(security.authBypassEnabled({ NODE_ENV: 'test', TEST_AUTH_BYPASS: '1' })).toBe(true);
  });

  test('escrita sem token devolve 401', async () => {
    const res = await request(app).put('/api/settings').set('x-restaurant-id', '1').send({});
    expect(res.status).toBe(401);
  });

  test('lista de pedidos sem token devolve 401', async () => {
    const res = await request(app).get('/api/orders').set('x-restaurant-id', '1');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/orders', () => {
  test('recusa quantidade negativa, zero e absurda', async () => {
    for (const quantity of [-5, 0, 1e9, 1.5, 'x']) {
      const res = await request(app).post('/api/orders').set('x-restaurant-id', '1')
        .send({ table_number: 3, items: [{ dish_id: 1, quantity }] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ORDER_ITEMS_INVALID');
    }
  });

  test('sem restaurante identificado, recusa', async () => {
    const res = await request(app).post('/api/orders').send({ table_number: 3, items: [{ dish_id: 1, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TENANT_MISSING');
  });
});

describe('POST /api/chat/stream', () => {
  test('exige restaurante e limita o tamanho da mensagem', async () => {
    const a = await request(app).post('/api/chat/stream').send({ message: 'olá' });
    expect(a.status).toBe(400);
    const b = await request(app).post('/api/chat/stream').set('x-restaurant-id', '1').send({ message: 'x'.repeat(1001) });
    expect(b.status).toBe(400);
  });
});

describe('WebSocket: autenticação e isolamento', () => {
  let port;
  const logFile = path.join(__dirname, '..', 'server.out.log');

  beforeAll((done) => {
    fs.writeFileSync(logFile, 'SEGREDO-NO-LOG');
    server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll((done) => {
    try { fs.unlinkSync(logFile); } catch (_) { /* já removido */ }
    wss.clients.forEach((c) => c.terminate());
    server.close(() => done());
  });

  // Liga e recolhe mensagens; resolve com { ws, messages } ou { error: statusCode }
  const connect = (opts = {}) => new Promise((resolve) => {
    const query = opts.token ? `?token=${opts.token}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { headers: opts.headers || {} });
    const messages = [];
    ws.on('message', (m) => messages.push(m.toString()));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ error: res.statusCode }); });
    ws.on('error', () => {});
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('sem restaurante nem token, a ligação é recusada', async () => {
    expect((await connect()).error).toBe(400);
  });

  test('token inválido é recusado com 401', async () => {
    expect((await connect({ token: 'lixo' })).error).toBe(401);
  });

  test('eventos de um restaurante não chegam a outro', async () => {
    const a = await connect({ headers: { 'x-restaurant-id': '1' } });
    const b = await connect({ headers: { 'x-restaurant-id': '2' } });
    const staffA = await connect({ token: tokenFor(1) });
    await wait(50);
    wss.broadcastTo(1, JSON.stringify({ type: 'NEW_ORDER', payload: { order_id: 7 } }));
    await wait(150);
    expect(a.messages.some((m) => m.includes('NEW_ORDER'))).toBe(true);
    expect(staffA.messages.some((m) => m.includes('NEW_ORDER'))).toBe(true);
    expect(b.messages.some((m) => m.includes('NEW_ORDER'))).toBe(false);
    [a, b, staffA].forEach((c) => c.ws.close());
  });

  test('o token manda: cabeçalho de outro restaurante é ignorado', async () => {
    const c = await connect({ token: tokenFor(2), headers: { 'x-restaurant-id': '1' } });
    await wait(50);
    wss.broadcastTo(1, JSON.stringify({ type: 'NEW_ORDER' }));
    await wait(150);
    expect(c.messages.some((m) => m.includes('NEW_ORDER'))).toBe(false);
    c.ws.close();
  });

  test('os logs do servidor só chegam ao superadmin', async () => {
    const normal = await connect({ token: tokenFor(1, 'admin') });
    const anon = await connect({ headers: { 'x-restaurant-id': '1' } });
    const root = await connect({ token: tokenFor(1, 'superadmin') });
    await wait(300);
    expect(normal.messages.join('')).not.toContain('SEGREDO-NO-LOG');
    expect(anon.messages.join('')).not.toContain('SEGREDO-NO-LOG');
    expect(root.messages.join('')).toContain('SEGREDO-NO-LOG');
    [normal, anon, root].forEach((c) => c.ws.close());
  });
});

describe('datas do SQLite (UTC sem fuso)', () => {
  const { parseDbDate } = security;
  test('lê "YYYY-MM-DD HH:MM:SS" como UTC, qualquer que seja o fuso do servidor', () => {
    expect(parseDbDate('2026-10-28 05:02:08').toISOString()).toBe('2026-10-28T05:02:08.000Z');
    expect(parseDbDate('2026-10-28T05:02:08').toISOString()).toBe('2026-10-28T05:02:08.000Z');
  });
  test('mantém datas com fuso e objetos Date', () => {
    expect(parseDbDate('2026-10-28T05:02:08+02:00').toISOString()).toBe('2026-10-28T03:02:08.000Z');
    const d = new Date(0);
    expect(parseDbDate(d)).toBe(d);
  });
});
