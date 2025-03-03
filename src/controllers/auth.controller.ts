// src/controllers/auth.controller.ts
import { Request, Response, NextFunction } from 'express';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentStatus } from '../models/agent.model';
import { AuthResponse, UserCredentials, DecodedToken } from '../models/auth.model';
import config from '../config/app.config';
import logger from '../utils/logger';

// Almacén temporal de agentes (en producción debe usarse una base de datos)
const agentsDB = new Map<string, Agent & { password: string }>();
// Almacén de tokens de refresco
const refreshTokens = new Map<string, { agentId: string, expiresAt: number }>();

// Añadir algunos agentes de prueba
if (process.env.NODE_ENV !== 'production') {
  // Crear un hash para la contraseña "admin123"
  const createTestAgents = async () => {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    
    agentsDB.set('agent_test_1', {
      id: 'agent_test_1',
      name: 'Agente de Prueba',
      email: 'agent@test.com',
      password: hashedPassword,
      status: AgentStatus.ONLINE,
      activeConversations: [],
      maxConcurrentChats: 3,
      role: 'agent',
      lastActivity: Date.now()
    });
    
    agentsDB.set('admin_test_1', {
      id: 'admin_test_1',
      name: 'Administrador',
      email: 'admin@test.com',
      password: hashedPassword,
      status: AgentStatus.ONLINE,
      activeConversations: [],
      maxConcurrentChats: 5,
      role: 'admin',
      lastActivity: Date.now()
    });
    
    logger.info('Agentes de prueba creados');
  };
  
  createTestAgents();
}

export class AuthController {
  /**
   * Iniciar sesión de agente
   */
  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body as UserCredentials;
      
      if (!email || !password) {
        res.status(400).json({ error: 'Se requieren email y password' });
        return;
      }
      
      // Buscar agente por email (en producción debería ser una consulta a la base de datos)
      const foundAgent = Array.from(agentsDB.values()).find(agent => agent.email === email);
      
      if (!foundAgent) {
        res.status(401).json({ error: 'Credenciales inválidas' });
        return;
      }
      
      // Verificar contraseña
      const isPasswordValid = await bcrypt.compare(password, foundAgent.password);
      
      if (!isPasswordValid) {
        res.status(401).json({ error: 'Credenciales inválidas' });
        logger.warn(`Intento de inicio de sesión fallido para ${email}`);
        return;
      }
      
      // Generar token JWT
      const token = jwt.sign(
        {
          agentId: foundAgent.id,
          email: foundAgent.email,
          role: foundAgent.role
        } as DecodedToken,
        config.auth.jwtSecret as Secret,
        { expiresIn: config.auth.jwtExpiresIn } as SignOptions
      );
      
      // Generar token de refresco
      const refreshToken = uuidv4();
      const refreshExpiresIn = 7 * 24 * 60 * 60 * 1000; // 7 días en milisegundos
      
      refreshTokens.set(refreshToken, {
        agentId: foundAgent.id,
        expiresAt: Date.now() + refreshExpiresIn
      });
      
      // Actualizar estado del agente
      const { password: _, ...agentWithoutPassword } = foundAgent;
      agentWithoutPassword.status = AgentStatus.ONLINE;
      agentWithoutPassword.lastActivity = Date.now();
      
      // Guardar agente actualizado
      agentsDB.set(foundAgent.id, {
        ...foundAgent,
        status: AgentStatus.ONLINE,
        lastActivity: Date.now()
      });
      
      logger.info(`Inicio de sesión exitoso para ${email}`);
      
      // Enviar respuesta
      const response: AuthResponse = {
        token,
        agent: agentWithoutPassword,
        expiresIn: parseInt(config.auth.jwtExpiresIn.replace(/\D/g, '')) * 1000 // convertir a milisegundos
      };
      
      // Enviar refresh token como cookie segura
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: refreshExpiresIn,
        sameSite: 'strict'
      });
      
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Refrescar token JWT
   */
  public refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Obtener refresh token de la cookie o del cuerpo
      const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
      
      if (!refreshToken) {
        res.status(400).json({ error: 'Se requiere token de refresco' });
        return;
      }
      
      // Verificar si el refresh token existe y es válido
      const tokenData = refreshTokens.get(refreshToken);
      
      if (!tokenData || tokenData.expiresAt < Date.now()) {
        refreshTokens.delete(refreshToken);
        res.status(401).json({ error: 'Token de refresco inválido o expirado' });
        return;
      }
      
      // Obtener agente
      const agent = agentsDB.get(tokenData.agentId);
      
      if (!agent) {
        refreshTokens.delete(refreshToken);
        res.status(404).json({ error: 'Agente no encontrado' });
        return;
      }
      
      // Generar nuevo token JWT
      const token = jwt.sign(
        {
          agentId: agent.id,
          email: agent.email,
          role: agent.role
        },
        config.auth.jwtSecret as Secret,
        { expiresIn: config.auth.jwtExpiresIn } as SignOptions
      );
      
      // Generar nuevo refresh token
      const newRefreshToken = uuidv4();
      const refreshExpiresIn = 7 * 24 * 60 * 60 * 1000; // 7 días en milisegundos
      
      // Guardar nuevo refresh token
      refreshTokens.set(newRefreshToken, {
        agentId: agent.id,
        expiresAt: Date.now() + refreshExpiresIn
      });
      
      // Eliminar el refresh token anterior
      refreshTokens.delete(refreshToken);
      
      // Actualizar última actividad del agente
      const { password: _, ...agentWithoutPassword } = agent;
      
      // Enviar respuesta
      const response: AuthResponse = {
        token: token,
        agent: agentWithoutPassword,
        expiresIn: parseInt(config.auth.jwtExpiresIn.replace(/\D/g, '')) * 1000 // convertir a milisegundos
      };
      
      // Enviar nuevo refresh token como cookie segura
      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: refreshExpiresIn,
        sameSite: 'strict'
      });
      
      res.json(response);
      
      logger.info(`Token refrescado para ${agent.email}`);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Cerrar sesión de agente
   */
  public logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Obtener refresh token de la cookie o del cuerpo
      const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
      
      if (refreshToken) {
        // Eliminar refresh token
        refreshTokens.delete(refreshToken);
      }
      
      // Obtener agente del token (si está autenticado)
      if (req.agent) {
        const agent = agentsDB.get(req.agent.id);
        
        if (agent) {
          // Actualizar estado del agente
          agentsDB.set(agent.id, {
            ...agent,
            status: AgentStatus.OFFLINE,
            lastActivity: Date.now()
          });
          
          logger.info(`Cierre de sesión para ${agent.email}`);
        }
      }
      
      // Limpiar cookie
      res.clearCookie('refreshToken');
      
      res.json({ success: true, message: 'Sesión cerrada correctamente' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Registrar un nuevo agente (solo para administradores)
   */
  public registerAgent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // En producción, verificar que el usuario es administrador
      // if (req.agent?.role !== 'admin') {
      //   res.status(403).json({ error: 'No autorizado para esta acción' });
      //   return;
      // }

      console.log('Método registerAgent ejecutándose');
      
      const { name, email, password, role = 'agent', maxConcurrentChats = 3 } = req.body;
      
      if (!name || !email || !password) {
        res.status(400).json({ error: 'Se requieren name, email y password' });
        return;
      }
      
      // Validar que el email no existe
      const existingAgent = Array.from(agentsDB.values()).find(agent => agent.email === email);
      
      if (existingAgent) {
        res.status(409).json({ error: 'Ya existe un agente con este email' });
        return;
      }
      
      // Validar rol
      if (!['agent', 'supervisor', 'admin'].includes(role)) {
        res.status(400).json({ error: 'Rol inválido. Debe ser agent, supervisor o admin' });
        return;
      }
      
      // Encriptar contraseña
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // Crear agente
      const newAgentId = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      const newAgent: Agent & { password: string } = {
        id: newAgentId,
        name,
        email,
        password: hashedPassword,
        status: AgentStatus.OFFLINE,
        activeConversations: [],
        maxConcurrentChats: maxConcurrentChats,
        role: role as 'agent' | 'supervisor' | 'admin',
        lastActivity: Date.now()
      };
      
      // Guardar agente
      agentsDB.set(newAgentId, newAgent);
      
      // Enviar respuesta sin la contraseña
      const { password: _, ...agentWithoutPassword } = newAgent;
      
      logger.info(`Nuevo agente registrado: ${email}`);
      res.status(201).json(agentWithoutPassword);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Cambiar contraseña
   */
  public changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.agent) {
        res.status(401).json({ error: 'No autenticado' });
        return;
      }
      
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Se requieren currentPassword y newPassword' });
        return;
      }
      
      // Obtener agente
      const agent = agentsDB.get(req.agent.id);
      
      if (!agent) {
        res.status(404).json({ error: 'Agente no encontrado' });
        return;
      }
      
      // Verificar contraseña actual
      const isPasswordValid = await bcrypt.compare(currentPassword, agent.password);
      
      if (!isPasswordValid) {
        res.status(401).json({ error: 'Contraseña actual incorrecta' });
        return;
      }
      
      // Encriptar nueva contraseña
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      
      // Actualizar contraseña
      agentsDB.set(agent.id, {
        ...agent,
        password: hashedPassword
      });
      
      logger.info(`Contraseña cambiada para ${agent.email}`);
      res.json({ success: true, message: 'Contraseña actualizada correctamente' });
    } catch (error) {
      next(error);
    }
  };
}

export default new AuthController();