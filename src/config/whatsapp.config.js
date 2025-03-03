"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/config/whatsapp.config.ts
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Cargar variables de entorno si no se ha hecho ya
if (!process.env.WHATSAPP_TOKEN) {
    dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
}
const whatsappConfig = {
    token: process.env.WHATSAPP_TOKEN || '',
    verifyToken: process.env.VERIFY_TOKEN || 'developer-seed',
    graphApiVersion: process.env.GRAPH_API_VERSION || 'v17.0',
    graphApiBaseUrl: 'https://graph.facebook.com',
    messageRetryAttempts: parseInt(process.env.WHATSAPP_MESSAGE_RETRY_ATTEMPTS || '3', 10),
    messageRetryDelay: parseInt(process.env.WHATSAPP_MESSAGE_RETRY_DELAY || '1000', 10),
    messageTimeout: parseInt(process.env.WHATSAPP_MESSAGE_TIMEOUT || '30000', 10)
};
// Validar configuración
if (!whatsappConfig.token) {
    console.warn('⚠️ No se ha configurado el token de WhatsApp. La integración no funcionará correctamente.');
    if (process.env.NODE_ENV === 'production') {
        throw new Error('WHATSAPP_TOKEN es obligatorio en entorno de producción');
    }
}
exports.default = whatsappConfig;
