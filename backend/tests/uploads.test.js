const path = require('path');
const fs = require('fs');
const request = require('supertest');
const sharp = require('sharp');

// Mock DB to avoid real database dependency
jest.mock('../db', () => {
  const dishes = [];
  let nextId = 1;
  const match = (sql) => sql.toLowerCase();
  return {
    pool: { end: jest.fn().mockResolvedValue() },
    query: jest.fn(async (text, params = []) => {
      const sql = match(text);
      if (sql.includes('select 1')) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (sql.includes('select * from dishes')) {
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

const uploadsDir = path.join(__dirname, '..', 'uploads');

function fileSizeMB(p) {
  const stat = fs.statSync(p);
  return stat.size / (1024 * 1024);
}

describe('Image upload and cleanup flow', () => {
  beforeAll(() => {
    // Ensure uploads dir exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir);
    }
  });

  afterAll(async () => {
    // Close pg pool if open to allow Jest to exit
    try { await db.pool.end(); } catch (_) {}
  });

  test('POST /api/uploads resizes to webp <= 1280px and stores <= 2MB', async () => {
    // Generate a large-dimension test image (>1280px width) but keep size under 2MB to pass multer
    const tmpInput = path.join(uploadsDir, 'tmp-test-input.jpg');
    const buffer = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#ff00aa' } })
      .jpeg({ quality: 80 })
      .toBuffer();
    fs.writeFileSync(tmpInput, buffer);

    const res = await request(app)
      .post('/api/uploads')
      .attach('file', tmpInput);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('path');
    expect(res.body.path.startsWith('/uploads/')).toBe(true);

    const saved = path.join(__dirname, '..', res.body.path.replace(/^\/+/, ''));
    expect(fs.existsSync(saved)).toBe(true);

    // Verify it is webp and width <= 1280
    const meta = await sharp(saved).metadata();
    expect(meta.format).toBe('webp');
    expect((meta.width || 0)).toBeLessThanOrEqual(1280);
    expect(fileSizeMB(saved)).toBeLessThanOrEqual(2);

    // Cleanup tmp file
    try { fs.unlinkSync(tmpInput); } catch (_) {}
  });

  test('Multer rejects non-image or >2MB files', async () => {
    // Create a >2MB text file
    const bigTxt = path.join(uploadsDir, 'big.txt');
    const bigBuf = Buffer.alloc(3 * 1024 * 1024, 65); // 3MB of 'A'
    fs.writeFileSync(bigTxt, bigBuf);

    const res = await request(app)
      .post('/api/uploads')
      .attach('file', bigTxt, { contentType: 'text/plain' });

    // Either 400 (no file accepted) or 500 if processing attempted
    expect([400, 500]).toContain(res.status);

    try { fs.unlinkSync(bigTxt); } catch (_) {}
  });
});

