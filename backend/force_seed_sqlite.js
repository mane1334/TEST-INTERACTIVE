const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

async function forceSeed() {
    const hashedPassword = await bcrypt.hash('admin123', 10);

    db.serialize(() => {
        // Ensure table exists just in case
        db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

        // Check if user exists
        db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
            if (err) {
                console.error("Error checking user:", err);
                return;
            }

            if (row) {
                console.log("User 'admin' already exists in SQLite. Updating password...");
                db.run("UPDATE users SET password_hash = ? WHERE username = 'admin'", [hashedPassword], (err) => {
                    if (err) console.error("Error updating password:", err);
                    else console.log("✅ Password updated to 'admin123'");
                });
            } else {
                console.log("User 'admin' does not exist. Creating...");
                db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['admin', hashedPassword, 'admin'], (err) => {
                    if (err) console.error("Error creating user:", err);
                    else console.log("✅ Admin user created in SQLite: admin / admin123");
                });
            }
        });
    });
}

forceSeed();
