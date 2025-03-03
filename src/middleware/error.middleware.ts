// src/middleware/error.middleware.ts
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

// Error personalizado con código HTTP
export class HttpError extends Error {
  statusCode: number;
  
  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Middleware para respuestas de error
export const errorHandler = (
  err: Error | HttpError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Obtener información de la solicitud para el registro
  const requestInfo = {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userId: req.agent?.id || 'unauthenticated'
  };
  
  // Si el error es un HttpError, usar su código de estado
  const statusCode = 'statusCode' in err ? err.statusCode : 500;
  
  // Registro del error
  if (statusCode >= 500) {
    logger.error(`Error ${statusCode} en ${requestInfo.method} ${requestInfo.url}: ${err.message}`, {
      error: err.stack,
      request: requestInfo
    });
  } else {
    logger.warn(`Error ${statusCode} en ${requestInfo.method} ${requestInfo.url}: ${err.message}`, {
      request: requestInfo
    });
  }
  
  // Respuesta al cliente
  // En producción, no devolver el stack trace
  const responseError = {
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    timestamp: new Date().toISOString()
  };
  
  res.status(statusCode).json({
    error: responseError
  });
};

// Middleware para rutas no encontradas
export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  const error = new HttpError(`Ruta no encontrada - ${req.originalUrl}`, 404);
  next(error);
};

// Middleware para manejo de errores asíncronos
export const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};