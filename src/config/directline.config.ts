// src/config/directline.config.ts
import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno si no se ha hecho ya
if (!process.env.DIRECTLINE_URL) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

interface DirectLineConfig {
  url: string;
  tokenRefreshMinutes: number;
  streamUrlPath: string;
  reconnectAttempts: number;
  reconnectDelay: number;
}

const directlineConfig: DirectLineConfig = {
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

export default directlineConfig;