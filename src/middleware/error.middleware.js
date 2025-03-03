"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncHandler = exports.notFoundHandler = exports.errorHandler = exports.HttpError = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
// Error personalizado con código HTTP
class HttpError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.HttpError = HttpError;
// Middleware para respuestas de error
const errorHandler = (err, req, res, next) => {
    var _a;
    // Obtener información de la solicitud para el registro
    const requestInfo = {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userId: ((_a = req.agent) === null || _a === void 0 ? void 0 : _a.id) || 'unauthenticated'
    };
    // Si el error es un HttpError, usar su código de estado
    const statusCode = 'statusCode' in err ? err.statusCode : 500;
    // Registro del error
    if (statusCode >= 500) {
        logger_1.default.error(`Error ${statusCode} en ${requestInfo.method} ${requestInfo.url}: ${err.message}`, {
            error: err.stack,
            request: requestInfo
        });
    }
    else {
        logger_1.default.warn(`Error ${statusCode} en ${requestInfo.method} ${requestInfo.url}: ${err.message}`, {
            request: requestInfo
        });
    }
    // Respuesta al cliente
    // En producción, no devolver el stack trace
    const responseError = {
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
        timestamp: new Date().toISOString()
    };
    res.status(statusCode).json({
        error: responseError
    });
};
exports.errorHandler = errorHandler;
// Middleware para rutas no encontradas
const notFoundHandler = (req, res, next) => {
    const error = new HttpError(`Ruta no encontrada - ${req.originalUrl}`, 404);
    next(error);
};
exports.notFoundHandler = notFoundHandler;
// Middleware para manejo de errores asíncronos
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};
exports.asyncHandler = asyncHandler;
