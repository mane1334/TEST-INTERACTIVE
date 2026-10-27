const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log("Adding cancellation_reason column to orders table...");
    db.run("ALTER TABLE orders ADD COLUMN cancellation_reason VARCHAR(255)", (err) => {
        if (err) {
            if (err.message.includes("duplicate column name")) {
                console.log("Column already exists.");
            } else {
                console.error("Error adding column:", err);
            }
        } else {
            console.log("Column added successfully.");
        }
    });
});

db.close();
