// src/utils/logger.ts
import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Crear directorio de logs si no existe
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Configuración de formato personalizado
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Configuración específica para logs de consola
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...rest }) => {
    const restString = Object.keys(rest).length ? 
      `\n${JSON.stringify(rest, null, 2)}` : '';
    return `${timestamp} ${level}: ${message}${restString}`;
  })
);

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
const logger = winston.createLogger({
  level: level(),
  levels,
  format: customFormat,
  defaultMeta: { service: 'whatsapp-bot-escalation' },
  transports: [
    // Error logs - archivo separado para errores
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    
    // Log combinado con todos los niveles
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log'),
      maxsize: 20 * 1024 * 1024, // 20MB
      maxFiles: 10
    }),
    
    // Logs específicos para transacciones HTTP
    new winston.transports.File({
      filename: path.join(logDir, 'http.log'),
      level: 'http',
      maxsize: 20 * 1024 * 1024, // 20MB
      maxFiles: 5
    })
  ]
});

// Si no estamos en producción, mostrar logs en consola también
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    handleExceptions: true
  }));
} else {
  // En producción, manejar excepciones no capturadas
  logger.exceptions.handle(
    new winston.transports.File({ 
      filename: path.join(logDir, 'exceptions.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    })
  );
}

// Métodos de ayuda para tipos de log comunes
export const logError = (message: string, meta?: any) => logger.error(message, meta);
export const logWarning = (message: string, meta?: any) => logger.warn(message, meta);
export const logInfo = (message: string, meta?: any) => logger.info(message, meta);
export const logHttp = (message: string, meta?: any) => logger.http(message, meta);
export const logDebug = (message: string, meta?: any) => logger.debug(message, meta);

// Función para crear un logger con contexto (ej: componente específico)
export const createContextLogger = (context: string) => {
  return {
    error: (message: string, meta?: any) => logger.error(`[${context}] ${message}`, meta),
    warn: (message: string, meta?: any) => logger.warn(`[${context}] ${message}`, meta),
    info: (message: string, meta?: any) => logger.info(`[${context}] ${message}`, meta),
    http: (message: string, meta?: any) => logger.http(`[${context}] ${message}`, meta),
    debug: (message: string, meta?: any) => logger.debug(`[${context}] ${message}`, meta),
    silly: (message: string, meta?: any) => logger.silly(`[${context}] ${message}`, meta)
  };
};

export default logger;