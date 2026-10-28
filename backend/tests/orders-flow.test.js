// Fluxo completo contra uma base SQLite real e temporária: vídeo por prato, nota e código do pedido.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-flow-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'flow.sqlite');
process.env.DB_TYPE = 'sqlite';

const saved = {};
beforeAll(async () => {
  for (const k of ['TEST_AUTH_BYPASS', 'DEFAULT_RESTAURANT_ID']) { saved[k] = process.env[k]; delete process.env[k]; }
  await new Promise((r) => setTimeout(r, 500)); // migrações do SQLite
});

const { app, server, wss } = require('..');
const db = require('../db');

const uploadsDir = path.join(__dirname, '..', 'uploads');
const created = [];
let token; let rid; let dishId; let dishId2;

afterAll(async () => {
  for (const f of created) { try { fs.unlinkSync(path.join(uploadsDir, f)); } catch (_) { /* já removido */ } }
  wss.clients.forEach((c) => c.terminate());
  await new Promise((r) => server.close(() => r()));
  await new Promise((r) => db.sqliteDb.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)]);

describe('preparação', () => {
  test('registar restaurante, categoria e pratos', async () => {
    const reg = await request(app).post('/api/auth/register-restaurant').send({
      owner_name: 'Dono', phone_number: '840000000', email: 'd@d.mz', address: 'Maputo', cuisine_type: 'Local',
      tax_id: '123456789', restaurant_name: 'Fluxo', username: 'fluxo1', password: 'senha-forte-123',
    });
    expect(reg.status).toBe(201);
    token = reg.body.token;
    rid = reg.body.restaurant.id;
    const cat = await request(app).post('/api/categories').set(auth()).send({ name: 'Pratos' });
    const d1 = await request(app).post('/api/dishes').set(auth()).send({ name: 'Frango', price: 650, category_id: cat.body.id, is_available: true });
    const d2 = await request(app).post('/api/dishes').set(auth()).send({ name: 'Sumo', price: 120, category_id: cat.body.id, is_available: true });
    expect(d1.status).toBe(201);
    dishId = d1.body.id; dishId2 = d2.body.id;
  });
});

describe('vídeo por prato', () => {
  test('upload de MP4 e WebM devolve caminho próprio', async () => {
    for (const [buf, ext] of [[mp4(), 'mp4'], [webm(), 'webm']]) {
      const res = await request(app).post('/api/uploads/video').set(auth()).attach('file', buf, { filename: 'x.bin', contentType: 'application/octet-stream' });
      expect(res.status).toBe(200);
      expect(res.body.path).toMatch(new RegExp(`^/uploads/[0-9a-f-]{36}\\.${ext}$`));
      created.push(path.basename(res.body.path));
    }
  });

  test('recusa ficheiros que não são vídeo, mesmo com nome .mp4', async () => {
    const res = await request(app).post('/api/uploads/video').set(auth()).attach('file', Buffer.from('<?php echo 1; ?>'.repeat(5)), { filename: 'virus.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(415);
  });

  test('recusa upload sem login', async () => {
    const res = await request(app).post('/api/uploads/video').set('x-restaurant-id', String(rid)).attach('file', mp4(), 'a.mp4');
    expect(res.status).toBe(401);
  });

  test('o vídeo fica no prato e aparece no menu público', async () => {
    const up = await request(app).post('/api/uploads/video').set(auth()).attach('file', mp4(), 'a.mp4');
    created.push(path.basename(up.body.path));
    const put = await request(app).put(`/api/dishes/${dishId}`).set(auth()).send({ name: 'Frango', price: 650, is_available: true, video_url: up.body.path });
    expect(put.status).toBe(200);
    expect(put.body.video_url).toBe(up.body.path);
    const menu = await request(app).get('/api/menu').set('x-restaurant-id', String(rid));
    expect(menu.body.find((d) => d.id === dishId).video_url).toBe(up.body.path);
    const served = await request(app).get(up.body.path);
    expect(served.status).toBe(200);
  });

  test('recusa video_url perigoso sem alterar o prato', async () => {
    for (const bad of ['javascript:alert(1)', 'http://inseguro/x.mp4', '/uploads/../../etc/passwd', '/uploads/x.mp4', 42]) {
      const res = await request(app).put(`/api/dishes/${dishId}`).set(auth()).send({ name: 'Frango', price: 650, is_available: true, video_url: bad });
      expect(res.status).toBe(400);
    }
    const res = await request(app).post('/api/dishes').set(auth()).send({ name: 'Mau', price: 1, video_url: 'javascript:1' });
    expect(res.status).toBe(400);
    const all = await request(app).get('/api/dishes').set(auth());
    expect(all.body.some((d) => d.name === 'Mau')).toBe(false);
  });

  test('video_url vazio remove o vídeo', async () => {
    const put = await request(app).put(`/api/dishes/${dishId}`).set(auth()).send({ name: 'Frango', price: 650, is_available: true, video_url: '' });
    expect(put.body.video_url).toBeNull();
  });
});

describe('pedido: nota e código de acesso', () => {
  let orderId; let code;
  const client = () => ({ 'x-restaurant-id': String(rid) });

  test('criar pedido devolve um código aleatório e guarda a nota', async () => {
    const res = await request(app).post('/api/orders').set(client()).send({ table_number: 4, notes: '  sem piri-piri \n', items: [{ dish_id: dishId, quantity: 1 }] });
    expect(res.status).toBe(201);
    orderId = res.body.order_id;
    code = res.body.access_code;
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const staff = await request(app).get(`/api/orders/${orderId}`).set(auth());
    expect(staff.body.notes).toBe('sem piri-piri');
  });

  test('notas longas são cortadas e vazias ficam sem nota', async () => {
    const a = await request(app).post('/api/orders').set(client()).send({ table_number: 4, notes: 'x'.repeat(500), items: [{ dish_id: dishId2, quantity: 1 }] });
    const sa = await request(app).get(`/api/orders/${a.body.order_id}`).set(auth());
    expect(sa.body.notes.length).toBe(200);
    const b = await request(app).post('/api/orders').set(client()).send({ table_number: 4, notes: '   ', items: [{ dish_id: dishId2, quantity: 1 }] });
    const sb = await request(app).get(`/api/orders/${b.body.order_id}`).set(auth());
    expect(sb.body.notes).toBeNull();
  });

  test('sem código (ou com código errado) o pedido parece não existir', async () => {
    expect((await request(app).get(`/api/orders/${orderId}`).set(client())).status).toBe(404);
    expect((await request(app).get(`/api/orders/${orderId}`).set(client()).set('x-order-code', 'errado1234ab')).status).toBe(404);
    expect((await request(app).get(`/api/orders/${orderId}`).set(client()).set('x-order-code', '')).status).toBe(404);
    expect((await request(app).get(`/api/orders/9999`).set(client())).status).toBe(404);
  });

  test('com o código certo o cliente vê o pedido, sem o código na resposta', async () => {
    const res = await request(app).get(`/api/orders/${orderId}`).set(client()).set('x-order-code', code);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orderId);
    expect(res.body.access_code).toBeUndefined();
  });

  test('o código de um restaurante não abre pedidos de outro', async () => {
    const res = await request(app).get(`/api/orders/${orderId}`).set('x-restaurant-id', '1').set('x-order-code', code);
    expect(res.status).toBe(404);
  });

  test('a lista do pessoal mostra a nota e nunca o código', async () => {
    const res = await request(app).get('/api/orders').set(auth());
    expect(res.status).toBe(200);
    const mine = res.body.orders.find((o) => o.id === orderId);
    expect(mine.notes).toBe('sem piri-piri');
    expect(JSON.stringify(res.body)).not.toContain(code);
  });

  test('cancelar exige o código', async () => {
    expect((await request(app).post(`/api/orders/${orderId}/cancel`).set(client()).send({})).status).toBe(404);
    expect((await request(app).post(`/api/orders/${orderId}/cancel`).set(client()).set('x-order-code', 'errado1234ab').send({})).status).toBe(404);
  });

  test('depois de a cozinha começar, o cliente já não cancela sozinho', async () => {
    const o = await request(app).post('/api/orders').set(client()).send({ table_number: 5, items: [{ dish_id: dishId, quantity: 1 }] });
    await request(app).put(`/api/orders/${o.body.order_id}/status`).set(auth()).send({ status: 'preparing' });
    const res = await request(app).post(`/api/orders/${o.body.order_id}/cancel`).set(client()).set('x-order-code', o.body.access_code).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  test('o cliente cancela o seu pedido novo com o código', async () => {
    const res = await request(app).post(`/api/orders/${orderId}/cancel`).set(client()).set('x-order-code', code).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.access_code).toBeUndefined();
  });
});

describe('tempo real: o que cada um recebe', () => {
  let port;
  beforeAll((done) => { server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); }); });

  const connect = (headers = {}, query = '') => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { headers });
    const messages = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, messages }));
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('cliente sem login só vê id/estado; pessoal vê o pedido; ninguém vê o código', async () => {
    const o = await request(app).post('/api/orders').set('x-restaurant-id', String(rid)).send({ table_number: 9, notes: 'segredo da cozinha', items: [{ dish_id: dishId, quantity: 2 }] });
    const anon = await connect({ 'x-restaurant-id': String(rid) });
    const staff = await connect({}, `?token=${token}`);
    await wait(50);
    await request(app).put(`/api/orders/${o.body.order_id}/status`).set(auth()).send({ status: 'preparing' });
    await wait(200);
    const a = anon.messages.find((m) => m.type === 'ORDER_STATUS_UPDATE');
    const s = staff.messages.find((m) => m.type === 'ORDER_STATUS_UPDATE');
    expect(a.payload).toEqual({ id: o.body.order_id, order_id: o.body.order_id, status: 'preparing', prep_time_seconds: expect.any(Number) });
    expect(s.payload.total_price).toBeGreaterThan(0);
    const everything = JSON.stringify([anon.messages, staff.messages]);
    expect(everything).not.toContain(o.body.access_code);
    expect(JSON.stringify(anon.messages)).not.toContain('total_price');
    anon.ws.close(); staff.ws.close();
  });
});
