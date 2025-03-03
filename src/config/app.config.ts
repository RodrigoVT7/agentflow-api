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
  };
  powerPlatform: {
    baseUrl: string;
    botEndpoint: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    refreshTokenExpiresIn: string;
  };
  storage: {
    queuePath: string;
  };
  cors: {
    origin: string | string[];
    methods: string[];
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
    queuePath: process.env.QUEUE_STORAGE_PATH || path.join(__dirname, '../../data/queues_state.json'),
  },
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  },
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