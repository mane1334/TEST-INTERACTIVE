const request = require('supertest');

jest.mock('../db', () => {
  const aiMemoryEntries = [];
  const backendHeartbeats = [];
  let memoryId = 1;
  let heartbeatId = 1;

  const sortByCreatedDesc = (a, b) => {
    const aTime = new Date(a.created_at || 0).getTime();
    const bTime = new Date(b.created_at || 0).getTime();
    if (bTime !== aTime) return bTime - aTime;
    return (b.id || 0) - (a.id || 0);
  };

  return {
    pool: { end: jest.fn().mockResolvedValue() },
    getDbType: jest.fn(() => 'sqlite'),
    query: jest.fn(async (text, params = []) => {
      const sql = text.toLowerCase().replace(/\s+/g, ' ').trim();

      if (sql.startsWith('create table if not exists')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('delete from backend_heartbeats')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('select distinct restaurant_id from ai_memory_entries')) {
        const restaurantIds = [...new Set(aiMemoryEntries.map((entry) => entry.restaurant_id))]
          .sort((a, b) => a - b)
          .map((restaurant_id) => ({ restaurant_id }));
        return { rows: restaurantIds };
      }

      if (sql.includes('select id, restaurant_id, scope, source, kind, content, metadata, created_at from ai_memory_entries')) {
        const restaurantId = Number(params[0] || 1);
        const limit = Number(params[1] || 25);
        const rows = aiMemoryEntries
          .filter((entry) => entry.restaurant_id === restaurantId)
          .sort(sortByCreatedDesc)
          .slice(0, limit);
        return { rows };
      }

      if (sql.includes('insert into ai_memory_entries')) {
        const [restaurant_id, scope, source, kind, content, metadata] = params;
        const row = {
          id: memoryId++,
          restaurant_id: Number(restaurant_id || 1),
          scope,
          source,
          kind,
          content,
          metadata,
          created_at: new Date().toISOString()
        };
        aiMemoryEntries.push(row);
        return { rows: [row], rowCount: 1 };
      }

      if (sql.includes('insert into backend_heartbeats')) {
        const [service_name, status, details, started_at, heartbeat_at, metadata] = params;
        const row = {
          id: heartbeatId++,
          service_name,
          status,
          details,
          started_at,
          heartbeat_at,
          metadata
        };
        backendHeartbeats.push(row);
        return { rows: [row], rowCount: 1 };
      }

      if (sql.includes('select id, service_name, status, details, started_at, heartbeat_at, metadata from backend_heartbeats')) {
        const serviceName = params[0];
        const rows = backendHeartbeats
          .filter((entry) => entry.service_name === serviceName)
          .sort((a, b) => {
            const aTime = new Date(a.heartbeat_at || 0).getTime();
            const bTime = new Date(b.heartbeat_at || 0).getTime();
            if (bTime !== aTime) return bTime - aTime;
            return (b.id || 0) - (a.id || 0);
          })
          .slice(0, 10);
        return { rows };
      }

      return { rows: [], rowCount: 0 };
    })
  };
});

const { app } = require('..');
const db = require('../db');
const aiApiKey = process.env.AI_MODULE_API_KEY || 'test-ai-key';

describe('AI memory and backend heartbeat', () => {
  afterAll(async () => {
    try { await db.pool.end(); } catch (_) {}
  });

  test('POST/GET /api/ai/memory persists and returns summarized entries', async () => {
    const createRes = await request(app)
      .post('/api/ai/memory')
      .set('x-api-key', aiApiKey)
      .set('x-restaurant-id', '7')
      .send({
        content: 'Debatido ajuste do tempo de preparo e reforço no turno do almoço.',
        scope: 'operations',
        kind: 'decision',
        source: 'admin'
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.restaurant_id).toBe(7);
    expect(createRes.body.entries).toHaveLength(1);
    expect(createRes.body.summary).toContain('Debatido ajuste do tempo de preparo');

    const listRes = await request(app)
      .get('/api/ai/memory')
      .set('x-api-key', aiApiKey)
      .set('x-restaurant-id', '7');

    expect(listRes.status).toBe(200);
    expect(listRes.body.entries).toHaveLength(1);
    expect(listRes.body.entries[0].content).toContain('reforço no turno do almoço');
  });

  test('GET /api/backend/heartbeat returns current state and history', async () => {
    const res = await request(app).get('/api/backend/heartbeat');

    expect(res.status).toBe(200);
    expect(res.body.current).toBeDefined();
    expect(res.body.current.service_name).toBe('backend');
    expect(Array.isArray(res.body.history)).toBe(true);
    if (res.body.history.length > 0) {
      expect(res.body.history[0].service_name).toBe('backend');
    }
  });
});
