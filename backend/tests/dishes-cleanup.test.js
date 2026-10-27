const request = require('supertest');
const fs = require('fs');
const path = require('path');

// Mock DB to avoid real database dependency
jest.mock('../db', () => {
  const dishes = [];
  let nextId = 1;
  const match = (sql) => sql.toLowerCase();
  return {
    pool: { end: jest.fn().mockResolvedValue() },
    query: jest.fn(async (text, params = []) => {
      const sql = match(text);
      if (sql.includes('select * from dishes order by id asc')) {
        return { rows: dishes.slice().sort((a, b) => a.id - b.id) };
      }
      if (sql.includes('insert into dishes')) {
        const [name, description, price, category_id, image_url, is_available] = params;
        const row = { id: nextId++, name, description, price, category_id, image_url, is_available, updated_at: new Date().toISOString() };
        dishes.push(row);
        return { rows: [row] };
      }
      if (sql.includes('select image_url from dishes where id = $1')) {
        const id = Number(params[0]);
        const row = dishes.find(d => d.id === id);
        return { rows: row ? [{ image_url: row.image_url }] : [] };
      }
      if (sql.includes('update dishes set')) {
        const id = Number(params[6]);
        const row = dishes.find(d => d.id === id);
        if (!row) return { rows: [] };
        const [name, description, price, category_id, image_url, is_available] = params;
        Object.assign(row, { name, description, price, category_id, image_url, is_available, updated_at: new Date().toISOString() });
        return { rows: [row] };
      }
      if (sql.includes('delete from dishes where id = $1')) {
        const id = Number(params[0]);
        const idx = dishes.findIndex(d => d.id === id);
        if (idx >= 0) dishes.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.includes('select count(*)::int as count from dishes where image_url = $1')) {
        const image_url = params[0];
        const count = dishes.filter(d => d.image_url === image_url).length;
        return { rows: [{ count }] };
      }
      return { rows: [] };
    })
  };
});

const { app } = require('..');
const db = require('../db');
const { deleteIfUnused, isLocalPath } = require('../utils/imageCleanup');

// Helper to create a dish row directly via API
async function createDish(payload) {
  const res = await request(app).post('/api/dishes').send(payload);
  if (res.status !== 201) {
    throw new Error('Failed to create dish: ' + res.text);
  }
  return res.body;
}

function fileExists(relPath) {
  const abs = path.join(__dirname, '..', relPath.replace(/^\/+/, ''));
  try { return fs.existsSync(abs); } catch { return false; }
}

describe('Dish image cleanup on update/delete', () => {
  afterAll(async () => {
    try { await db.pool.end(); } catch (_) {}
  });

  test('Updating dish to new image removes old local image only when unreferenced', async () => {
    // Simulate two dishes referencing the same local image
    const shared = '/uploads/shared-test.webp';
    // Create a dummy shared image file
    const sharedAbs = path.join(__dirname, '..', shared.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(sharedAbs), { recursive: true });
    fs.writeFileSync(sharedAbs, Buffer.from('dummy'));

    const d1 = await createDish({ name: 'A', description: '', price: 1, category_id: 1, image_url: shared, is_available: true });
    const d2 = await createDish({ name: 'B', description: '', price: 2, category_id: 1, image_url: shared, is_available: true });

    // Create a new unique image file to switch d1 to
    const newImg = '/uploads/new-test.webp';
    const newAbs = path.join(__dirname, '..', newImg.replace(/^\/+/, ''));
    fs.writeFileSync(newAbs, Buffer.from('dummy2'));

    // Update d1 to point to newImg
    const updRes = await request(app).put(`/api/dishes/${d1.id}`).send({ ...d1, image_url: newImg });
    expect(updRes.status).toBe(200);

    // Old local file must still exist because d2 still references it
    expect(fileExists(shared)).toBe(true);

    // Now update d2 to an external URL (should not affect local files)
    const extUrl = 'https://example.com/pic.jpg';
    const upd2 = await request(app).put(`/api/dishes/${d2.id}`).send({ ...d2, image_url: extUrl });
    expect(upd2.status).toBe(200);

    // After updating d2, shared image becomes unreferenced and should be cleaned up by deleteIfUnused when update of d2 triggers it
    // The cleanup runs async; to be safe, poll a few times
    let cleaned = false;
    for (let i = 0; i < 5; i++) {
      if (!fileExists(shared)) { cleaned = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(cleaned).toBe(true);

    // New image should remain since d1 references it
    expect(fileExists(newImg)).toBe(true);
  });

  test('Deleting dish removes local image when unreferenced', async () => {
    const localPath = '/uploads/delete-me.webp';
    const localAbs = path.join(__dirname, '..', localPath.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(localAbs), { recursive: true });
    fs.writeFileSync(localAbs, Buffer.from('dummy3'));

    const dish = await createDish({ name: 'C', description: '', price: 3, category_id: 1, image_url: localPath, is_available: true });

    // Delete the dish
    const del = await request(app).delete(`/api/dishes/${dish.id}`);
    expect(del.status).toBe(204);

    // cleanup runs async, poll for deletion
    let removed = false;
    for (let i = 0; i < 5; i++) {
      if (!fileExists(localPath)) { removed = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(removed).toBe(true);
  });

  test('External URL dishes remain intact and not treated as local', async () => {
    const extUrl = 'https://images.example.com/x.png';
    const dish = await createDish({ name: 'D', description: '', price: 4, category_id: 1, image_url: extUrl, is_available: true });

    expect(isLocalPath(dish.image_url)).toBe(false);

    // Update to another external URL
    const upd = await request(app).put(`/api/dishes/${dish.id}`).send({ ...dish, image_url: 'https://cdn.example.com/y.jpg' });
    expect(upd.status).toBe(200);
  });
});

