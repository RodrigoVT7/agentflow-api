// src/config/whatsapp.config.ts
import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno si no se ha hecho ya
if (!process.env.WHATSAPP_TOKEN) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

interface WhatsAppConfig {
  token: string;
  verifyToken: string;
  graphApiVersion: string;
  graphApiBaseUrl: string;
  messageRetryAttempts: number;
  messageRetryDelay: number;
  messageTimeout: number;
}

const whatsappConfig: WhatsAppConfig = {
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

export default whatsappConfig;