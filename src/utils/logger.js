"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContextLogger = exports.logDebug = exports.logHttp = exports.logInfo = exports.logWarning = exports.logError = void 0;
// src/utils/logger.ts
const winston_1 = __importDefault(require("winston"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// Crear directorio de logs si no existe
const logDir = path_1.default.join(__dirname, '../../logs');
if (!fs_1.default.existsSync(logDir)) {
    fs_1.default.mkdirSync(logDir, { recursive: true });
}
// Configuración de formato personalizado
const customFormat = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.splat(), winston_1.default.format.json());
// Configuración específica para logs de consola
const consoleFormat = winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.printf((_a) => {
    var { timestamp, level, message } = _a, rest = __rest(_a, ["timestamp", "level", "message"]);
    const restString = Object.keys(rest).length ?
        `\n${JSON.stringify(rest, null, 2)}` : '';
    return `${timestamp} ${level}: ${message}${restString}`;
}));
// Niveles de log personalizados
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
    silly: 5
};
// Determinar nivel de log basado en el entorno
const level = () => {
    const env = process.env.NODE_ENV || 'development';
    return env === 'development' ? 'debug' : 'http';
};
// Crear instancia del logger
const logger = winston_1.default.createLogger({
    level: level(),
    levels,
    format: customFormat,
    defaultMeta: { service: 'whatsapp-bot-escalation' },
    transports: [
        // Error logs - archivo separado para errores
        new winston_1.default.transports.File({
            filename: path_1.default.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5
        }),
        // Log combinado con todos los niveles
        new winston_1.default.transports.File({
            filename: path_1.default.join(logDir, 'combined.log'),
            maxsize: 20 * 1024 * 1024, // 20MB
            maxFiles: 10
        }),
        // Logs específicos para transacciones HTTP
        new winston_1.default.transports.File({
            filename: path_1.default.join(logDir, 'http.log'),
            level: 'http',
            maxsize: 20 * 1024 * 1024, // 20MB
            maxFiles: 5
        })
    ]
});
// Si no estamos en producción, mostrar logs en consola también
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston_1.default.transports.Console({
        format: consoleFormat,
        handleExceptions: true
    }));
}
else {
    // En producción, manejar excepciones no capturadas
    logger.exceptions.handle(new winston_1.default.transports.File({
        filename: path_1.default.join(logDir, 'exceptions.log'),
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5
    }));
}
// Métodos de ayuda para tipos de log comunes
const logError = (message, meta) => logger.error(message, meta);
exports.logError = logError;
const logWarning = (message, meta) => logger.warn(message, meta);
exports.logWarning = logWarning;
const logInfo = (message, meta) => logger.info(message, meta);
exports.logInfo = logInfo;
const logHttp = (message, meta) => logger.http(message, meta);
exports.logHttp = logHttp;
const logDebug = (message, meta) => logger.debug(message, meta);
exports.logDebug = logDebug;
// Función para crear un logger con contexto (ej: componente específico)
const createContextLogger = (context) => {
    return {
        error: (message, meta) => logger.error(`[${context}] ${message}`, meta),
        warn: (message, meta) => logger.warn(`[${context}] ${message}`, meta),
        info: (message, meta) => logger.info(`[${context}] ${message}`, meta),
        http: (message, meta) => logger.http(`[${context}] ${message}`, meta),
        debug: (message, meta) => logger.debug(`[${context}] ${message}`, meta),
        silly: (message, meta) => logger.silly(`[${context}] ${message}`, meta)
    };
};
exports.createContextLogger = createContextLogger;
exports.default = logger;
