const fs = require('fs').promises;
const path = require('path');
const db = require('../db');

const isLocalPath = p => typeof p === 'string' && p.startsWith('/uploads/');

async function deleteIfUnused(localPath) {
  try {
    if (!isLocalPath(localPath)) return false;

    // Check how many dishes still reference this image
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS count FROM dishes WHERE image_url = $1',
      [localPath]
    );
    const count = rows && rows[0] ? Number(rows[0].count) : 0;

    if (count > 0) return false;

    // Map '/uploads/xyz' -> backend/uploads/xyz (strip leading slash first)
    const relative = localPath.replace(/^\/+/, '');
    const absolutePath = path.join(__dirname, '..', relative);

    try {
      await fs.unlink(absolutePath);
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // File already gone
        return false;
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in deleteIfUnused for', localPath, error);
    return false;
  }
}

module.exports = { isLocalPath, deleteIfUnused };

