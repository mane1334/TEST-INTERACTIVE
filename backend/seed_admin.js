const db = require('./db');
const bcrypt = require('bcryptjs');

async function seedAdmin() {
    try {
        const { rows } = await db.query('SELECT COUNT(*) as count FROM users');
        if (parseInt(rows[0].count) > 0) {
            console.log('Users already exist. Skipping seed.');
            return;
        }

        const hashedPassword = await bcrypt.hash('admin123', 10);
        await db.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', ['admin', hashedPassword, 'admin']);
        console.log('✅ Admin user created: admin / admin123');
    } catch (err) {
        console.error('Error seeding admin:', err);
    }
}

seedAdmin();
