const jwt = require('jsonwebtoken');

const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (isProduction ? undefined : 'super_secret_key_change_me_in_production');

if (!process.env.JWT_SECRET) {
    console.warn(
        isProduction
            ? 'JWT_SECRET não configurado. Configure JWT_SECRET antes de iniciar em produção.'
            : 'JWT_SECRET não configurado. Usando segredo fixo apenas para desenvolvimento local.'
    );
}

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) return res.status(401).json({ error: 'Token ausente.', code: 'TOKEN_MISSING' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.', code: 'TOKEN_INVALID' });
        req.user = user;
        next();
    });
};

module.exports = { authenticateToken, JWT_SECRET };
