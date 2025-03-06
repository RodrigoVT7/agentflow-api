// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { DecodedToken } from '../models/auth.model';
import config from '../config/app.config';
import { initAgentService } from '../services/agent.service';

const agentService = initAgentService();

// Extender el tipo Request para incluir el agente autenticado
declare global {
  namespace Express {
    interface Request {
      agent?: {
        id: string;
        email: string;
        role: string;
      };
    }
  }
}

/**
 * Middleware para verificar token JWT
 */
export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  try {
    // Obtener token del header Authorization
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Se requiere token de autenticación' });
      return;
    }
    
    const token = authHeader.split(' ')[1];
    
    // Verificar token
    const decoded = jwt.verify(token, config.auth.jwtSecret) as DecodedToken;
    
    // Verificar que el agente existe
    const agent = agentService.getAgentById(decoded.agentId);
    if (!agent) {
      res.status(401).json({ error: 'Agente no encontrado' });
      return;
    }
    
    // Añadir información del agente al request
    req.agent = {
      id: decoded.agentId,
      email: decoded.email,
      role: decoded.role
    };
    
    next();
  } catch (error) {
    // Verificar si el error es de expiración
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expirado', expired: true });
    } else {
      res.status(401).json({ error: 'Token inválido' });
    }
  }
};

/**
 * Middleware para verificar roles de usuario
 */
export const roleMiddleware = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.agent) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }
    
    if (!allowedRoles.includes(req.agent.role)) {
      res.status(403).json({ error: 'No autorizado para esta acción' });
      return;
    }
    
    next();
  };
};

/**
 * Middleware para registrar intentos de autenticación fallidos
 */
export const loginAttemptMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Aquí se podría implementar un sistema para evitar ataques de fuerza bruta
  // Por ejemplo, limitar intentos por IP o por usuario
  next();
};

/**
 * Middleware para verificar CSRF
 */
export const csrfMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // En una implementación real, verificaríamos el token CSRF
  // Por simplicidad, no lo implementamos ahora
  next();
};