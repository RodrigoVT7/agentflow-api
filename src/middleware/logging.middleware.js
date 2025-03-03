"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentActionLogger = exports.errorLogger = exports.requestLogger = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * Middleware para registrar información de cada solicitud
 */
const requestLogger = (req, res, next) => {
    var _a;
    // Guardar tiempo de inicio para calcular duración
    const start = Date.now();
    // Registrar información básica de la solicitud
    logger_1.default.info(`Incoming ${req.method} ${req.originalUrl}`, {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        userId: ((_a = req.agent) === null || _a === void 0 ? void 0 : _a.id) || 'unauthenticated'
    });
    // Función para registrar la respuesta
    const logResponse = () => {
        var _a;
        // Calcular duración
        const duration = Date.now() - start;
        // Comprobar si el código de estado indica error
        const isError = res.statusCode >= 400;
        // Registrar respuesta
        const logMethod = isError ? logger_1.default.warn : logger_1.default.info;
        logMethod(`Response ${res.statusCode} ${req.method} ${req.originalUrl} - ${duration}ms`, {
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration,
            userId: ((_a = req.agent) === null || _a === void 0 ? void 0 : _a.id) || 'unauthenticated'
        });
        // Limpiar listeners para evitar fugas de memoria
        res.removeListener('finish', logResponse);
        res.removeListener('close', logResponse);
    };
    // Registrar cuando se complete la respuesta
    res.on('finish', logResponse);
    res.on('close', logResponse);
    next();
};
exports.requestLogger = requestLogger;
/**
 * Middleware para registrar errores de forma detallada
 */
const errorLogger = (err, req, res, next) => {
    var _a;
    logger_1.default.error(`Error en ${req.method} ${req.originalUrl}: ${err.message}`, {
        error: err.stack,
        method: req.method,
        url: req.originalUrl,
        body: req.body,
        query: req.query,
        params: req.params,
        userId: ((_a = req.agent) === null || _a === void 0 ? void 0 : _a.id) || 'unauthenticated'
    });
    next(err);
};
exports.errorLogger = errorLogger;
/**
 * Middleware para registrar acciones de agentes
 */
const agentActionLogger = (req, res, next) => {
    if (req.agent) {
        // Solo registrar acciones de agentes autenticados
        // Determinar qué tipo de acción es por la ruta y método
        let actionType = 'unknown';
        if (req.originalUrl.includes('/agent/assign')) {
            actionType = 'assign_conversation';
        }
        else if (req.originalUrl.includes('/agent/send')) {
            actionType = 'send_message';
        }
        else if (req.originalUrl.includes('/agent/complete')) {
            actionType = 'complete_conversation';
        }
        logger_1.default.info(`Agent action: ${actionType}`, {
            actionType,
            agentId: req.agent.id,
            method: req.method,
            url: req.originalUrl,
            body: req.body
        });
    }
    next();
};
exports.agentActionLogger = agentActionLogger;
