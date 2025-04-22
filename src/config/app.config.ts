// src/config/app.config.ts
import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface AppConfig {
  nodeEnv: string;
  port: number;
  whatsapp: {
    token: string;
    verifyToken: string;
  };
  directline: {
    url: string;
    tokenRefreshMinutes: number;
  };
  powerPlatform: {
    baseUrl: string;
    botEndpoint: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
  };
  database: {
    path: string;
  };
  conversation: {
    // Tiempo de inactividad para cerrar conversación (24 horas en milisegundos)
    inactivityTimeout: number;
    // Intervalo para revisar conversaciones inactivas (1 hora en milisegundos)
    cleanupInterval: number;
  };
  agentSupport: {
    responseTimeoutSeconds: number; // Tiempo en segundos antes del primer aviso
    waitingMessage: string;         // Mensaje a enviar después del primer timeout
    redirectTimeoutMultiplier: number; // Multiplicador para el segundo timeout
    redirectMessage: string;        // Mensaje enviado al usuario al redireccionar
    botMenuTrigger: string;         // Texto a enviar al bot para activar el menú
  };
}

// Valores por defecto y validaciones
const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    verifyToken: process.env.VERIFY_TOKEN || 'developer-seed',
  },
  directline: {
    url: process.env.DIRECTLINE_URL || 'https://directline.botframework.com/v3/directline',
    tokenRefreshMinutes: parseInt(process.env.DIRECTLINE_TOKEN_REFRESH_MINUTES || '30', 10),
  },
  powerPlatform: {
    baseUrl: process.env.BASE_URL || '',
    botEndpoint: process.env.BOT_ENDPOINT || '',
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'super-secret-key-change-in-production',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  },
  database: {
    path: process.env.DATABASE_PATH || path.join(__dirname, '../../data/database.sqlite'),
  },
  conversation: {
    inactivityTimeout: 24 * 60 * 60 * 1000, // 24 horas en milisegundos
    cleanupInterval: 60 * 60 * 1000, // 1 hora en milisegundos
  },
  agentSupport: {
    responseTimeoutSeconds: parseInt(process.env.AGENT_RESPONSE_TIMEOUT_SECONDS || '30', 10),
    waitingMessage: process.env.AGENT_WAITING_MESSAGE || 
      "Todos nuestros agentes están ocupados actualmente. Por favor, espere y atenderemos su interacción lo antes posible.",
    redirectTimeoutMultiplier: parseInt(process.env.AGENT_REDIRECT_TIMEOUT_MULTIPLIER || '2', 10),
    redirectMessage: process.env.AGENT_REDIRECT_MESSAGE || 
      "Debido a la inactividad, te regreso al menú principal.",
    botMenuTrigger: process.env.BOT_MENU_TRIGGER || "Menu"
  }
};

// Validación de configuración crítica
const validateConfig = (): void => {
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
  if (
    config.nodeEnv === 'production' && 
    config.auth.jwtSecret === 'super-secret-key-change-in-production'
  ) {
    console.warn('⚠️ Usando JWT_SECRET predeterminado en producción. ¡Cámbielo inmediatamente!');
  }
};

// Si estamos en producción, validar la configuración
if (config.nodeEnv === 'production') {
  validateConfig();
}

export default config;