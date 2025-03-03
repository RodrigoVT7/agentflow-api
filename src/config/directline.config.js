"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/config/directline.config.ts
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Cargar variables de entorno si no se ha hecho ya
if (!process.env.DIRECTLINE_URL) {
    dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
}
const directlineConfig = {
    url: process.env.DIRECTLINE_URL || 'https://directline.botframework.com/v3/directline',
    tokenRefreshMinutes: parseInt(process.env.DIRECTLINE_TOKEN_REFRESH_MINUTES || '30', 10),
    streamUrlPath: '/conversations/{conversationId}/stream',
    reconnectAttempts: parseInt(process.env.DIRECTLINE_RECONNECT_ATTEMPTS || '5', 10),
    reconnectDelay: parseInt(process.env.DIRECTLINE_RECONNECT_DELAY || '3000', 10)
};
// Validar configuración
if (!directlineConfig.url || directlineConfig.url === 'https://directline.botframework.com/v3/directline') {
    console.warn('⚠️ Usando URL de DirectLine por defecto. Configura DIRECTLINE_URL para personalizar.');
}
exports.default = directlineConfig;
