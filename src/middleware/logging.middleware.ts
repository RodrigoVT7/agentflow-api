// src/middleware/logging.middleware.ts
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

/**
 * Middleware para registrar información de cada solicitud
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  // Guardar tiempo de inicio para calcular duración
  const start = Date.now();
  
  // Registrar información básica de la solicitud
  logger.info(`Incoming ${req.method} ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    userId: req.agent?.id || 'unauthenticated'
  });
  
  // Función para registrar la respuesta
  const logResponse = () => {
    // Calcular duración
    const duration = Date.now() - start;
    // Comprobar si el código de estado indica error
    const isError = res.statusCode >= 400;
    // Registrar respuesta
    const logMethod = isError ? logger.warn : logger.info;
    
    logMethod(`Response ${res.statusCode} ${req.method} ${req.originalUrl} - ${duration}ms`, {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration,
      userId: req.agent?.id || 'unauthenticated'
    });
    
    // Limpiar listeners para evitar fugas de memoria
    res.removeListener('finish', logResponse);
    res.removeListener('close', logResponse);
  };
  
  // Registrar cuando se complete la respuesta
  res.on('finish', logResponse);
  res.on('close', logResponse);
  
  next();
};

/**
 * Middleware para registrar errores de forma detallada
 */
export const errorLogger = (err: any, req: Request, res: Response, next: NextFunction): void => {
  logger.error(`Error en ${req.method} ${req.originalUrl}: ${err.message}`, {
    error: err.stack,
    method: req.method,
    url: req.originalUrl,
    body: req.body,
    query: req.query,
    params: req.params,
    userId: req.agent?.id || 'unauthenticated'
  });
  
  next(err);
};

/**
 * Middleware para registrar acciones de agentes
 */
export const agentActionLogger = (req: Request, res: Response, next: NextFunction): void => {
  if (req.agent) {
    // Solo registrar acciones de agentes autenticados
    // Determinar qué tipo de acción es por la ruta y método
    let actionType = 'unknown';
    
    if (req.originalUrl.includes('/agent/assign')) {
      actionType = 'assign_conversation';
    } else if (req.originalUrl.includes('/agent/send')) {
      actionType = 'send_message';
    } else if (req.originalUrl.includes('/agent/complete')) {
      actionType = 'complete_conversation';
    }
    
    logger.info(`Agent action: ${actionType}`, {
      actionType,
      agentId: req.agent.id,
      method: req.method,
      url: req.originalUrl,
      body: req.body
    });
  }
  
  next();
};