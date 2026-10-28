// Testa o db.js a sério, com uma base SQLite temporária (sem mocks).
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kt-sqlite-')), 'teste.sqlite');
process.env.SQLITE_PATH = tmp;
process.env.DB_TYPE = 'sqlite';

const db = require('../db');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => { await wait(400); }); // deixa as migrações assíncronas terminarem
afterAll(async () => {
  await new Promise((r) => db.sqliteDb.close(() => r()));
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

describe('db.query em SQLite', () => {
  test('arranque numa base nova cria as tabelas pela ordem certa', async () => {
    const { rows } = await db.query('SELECT id, name FROM restaurants WHERE id = $1', [1]);
    expect(rows[0].name).toBe('Restaurante Sede');
  });

  test('INSERT ... RETURNING devolve a linha completa', async () => {
    const { rows } = await db.query(
      'INSERT INTO restaurants (name, owner_name) VALUES ($1, $2) RETURNING id, name, owner_name',
      ['Teste', 'Dono']
    );
    expect(rows[0]).toMatchObject({ name: 'Teste', owner_name: 'Dono' });
    expect(rows[0].id).toBeGreaterThan(1);
  });

  test('UPDATE ... RETURNING devolve a linha atualizada (e não o último id inserido)', async () => {
    await db.query('INSERT INTO restaurants (name) VALUES ($1)', ['Outro']); // move o lastID
    const { rows } = await db.query('UPDATE restaurants SET name = $1 WHERE id = $2 RETURNING id, name', ['Renomeado', 1]);
    expect(rows).toEqual([{ id: 1, name: 'Renomeado' }]);
  });

  test('UPDATE que não encontra nada devolve zero linhas', async () => {
    const { rows } = await db.query('UPDATE restaurants SET name = $1 WHERE id = $2 RETURNING id', ['x', 99999]);
    expect(rows).toEqual([]);
  });

  test('INSERT sem RETURNING continua a devolver o id novo', async () => {
    const { rows } = await db.query('INSERT INTO restaurants (name) VALUES ($1)', ['Sem returning']);
    expect(rows[0].id).toBeGreaterThan(1);
  });
});
