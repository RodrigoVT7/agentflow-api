"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.csrfMiddleware = exports.loginAttemptMiddleware = exports.roleMiddleware = exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_config_1 = __importDefault(require("../config/app.config"));
/**
 * Middleware para verificar token JWT
 */
const authMiddleware = (req, res, next) => {
    try {
        // Obtener token del header Authorization
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Se requiere token de autenticación' });
            return;
        }
        const token = authHeader.split(' ')[1];
        // Verificar token
        const decoded = jsonwebtoken_1.default.verify(token, app_config_1.default.auth.jwtSecret);
        // Añadir información del agente al request
        req.agent = {
            id: decoded.agentId,
            email: decoded.email,
            role: decoded.role
        };
        next();
    }
    catch (error) {
        // Verificar si el error es de expiración
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            res.status(401).json({ error: 'Token expirado', expired: true });
        }
        else {
            res.status(401).json({ error: 'Token inválido' });
        }
    }
};
exports.authMiddleware = authMiddleware;
/**
 * Middleware para verificar roles de usuario
 */
const roleMiddleware = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.agent) {
            res.status(401).json({ error: 'No autenticado' });
            return;
        }
        if (!allowedRoles.includes(req.agent.role)) {
            res.status(403).json({ error: 'No autorizado para esta acción' });
            return;
        }
        next();
    };
};
exports.roleMiddleware = roleMiddleware;
/**
 * Middleware para registrar intentos de autenticación fallidos
 */
const loginAttemptMiddleware = (req, res, next) => {
    // Aquí se podría implementar un sistema para evitar ataques de fuerza bruta
    // Por ejemplo, limitar intentos por IP o por usuario
    next();
};
exports.loginAttemptMiddleware = loginAttemptMiddleware;
/**
 * Middleware para verificar CSRF
 */
const csrfMiddleware = (req, res, next) => {
    // En una implementación real, verificaríamos el token CSRF
    // Por simplicidad, no lo implementamos ahora
    next();
};
exports.csrfMiddleware = csrfMiddleware;
