"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/config/app.config.ts
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Cargar variables de entorno
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
// Valores por defecto y validaciones
const config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    whatsapp: {
        token: process.env.WHATSAPP_TOKEN || '',
        verifyToken: process.env.VERIFY_TOKEN || 'developer-seed',
    },
    directline: {
        url: process.env.DIRECTLINE_URL || 'https://directline.botframework.com/v3/directline',
    },
    powerPlatform: {
        baseUrl: process.env.BASE_URL || '',
        botEndpoint: process.env.BOT_ENDPOINT || '',
    },
    auth: {
        jwtSecret: process.env.JWT_SECRET || 'super-secret-key-change-in-production',
        jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
        refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
    },
    storage: {
        queuePath: process.env.QUEUE_STORAGE_PATH || path_1.default.join(__dirname, '../../data/queues_state.json'),
    },
    cors: {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    },
};
// Validación de configuración crítica
const validateConfig = () => {
    const requiredEnvVars = [
        { key: 'WHATSAPP_TOKEN', value: config.whatsapp.token },
        { key: 'BASE_URL', value: config.powerPlatform.baseUrl },
        { key: 'BOT_ENDPOINT', value: config.powerPlatform.botEndpoint },
    ];
    const missingVars = requiredEnvVars.filter(({ value }) => !value);
    if (missingVars.length > 0) {
        const missingKeys = missingVars.map(({ key }) => key).join(', ');
        console.warn(`⚠️ Variables de entorno faltantes: ${missingKeys}`);
        if (config.nodeEnv === 'production') {
            throw new Error(`Variables de entorno requeridas faltantes: ${missingKeys}`);
        }
    }
    // Validar JWT Secret en producción
    if (config.nodeEnv === 'production' &&
        config.auth.jwtSecret === 'super-secret-key-change-in-production') {
        console.warn('⚠️ Usando JWT_SECRET predeterminado en producción. ¡Cámbielo inmediatamente!');
    }
};
// Si estamos en producción, validar la configuración
if (config.nodeEnv === 'production') {
    validateConfig();
}
exports.default = config;
