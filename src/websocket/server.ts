// src/websocket/server.ts
import { Server as HttpServer } from 'http';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import url from 'url';
import { DecodedToken } from '../models/auth.model';
import { handleAgentConnection } from './handlers';
import config from '../config/app.config';
import logger from '../utils/logger';

export class WebSocketService {
  private wss: WebSocket.Server;
  private connectedAgents: Map<string, WebSocket> = new Map();
  private agentSocketMap: Map<WebSocket, string> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(server: HttpServer) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws',
      clientTracking: true
    });
    
    this.setupWebSocketServer();
    this.startPingInterval();
    
    logger.info('Servidor WebSocket inicializado');
  }

  /**
   * Configurar servidor WebSocket
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      try {
        // Verificar token de autenticación
        const parsedUrl = url.parse(req.url || '', true);
        const token = parsedUrl.query.token as string;
        
        if (!token) {
          logger.warn('Intento de conexión WebSocket sin token');
          ws.close(1008, 'Token requerido');
          return;
        }
        
        // Verificar token
        let decoded: DecodedToken;
        try {
          decoded = jwt.verify(token, config.auth.jwtSecret) as DecodedToken;
        } catch (error) {
          logger.warn('Token WebSocket inválido', { error });
          ws.close(1008, 'Token inválido');
          return;
        }
        
        const agentId = decoded.agentId;
        
        // Registrar conexión del agente
        this.registerConnection(agentId, ws);
        
        // Manejar la conexión del agente
        handleAgentConnection(ws, agentId, this);
        
        // Manejar cierre de conexión
        ws.on('close', (code, reason) => {
          const reasonStr = reason instanceof Buffer ? reason.toString() : reason;
          this.handleDisconnection(ws, agentId, code, reasonStr);
        });
        
        // Manejar errores
        ws.on('error', (error) => {
          logger.error(`Error en WebSocket para agente ${agentId}`, { error });
        });
        
        // Enviar confirmación de conexión
        this.sendToSocket(ws, 'connection:established', {
          agentId,
          timestamp: Date.now()
        });
        
        logger.info(`Agente conectado vía WebSocket: ${agentId}`);
      } catch (error) {
        logger.error('Error al procesar conexión WebSocket', { error });
        ws.close(1011, 'Error interno');
      }
    });
    
    this.wss.on('error', (error) => {
      logger.error('Error en servidor WebSocket', { error });
    });
  }

  /**
   * Registrar conexión de agente
   */
  private registerConnection(agentId: string, ws: WebSocket): void {
    // Si ya existe una conexión para este agente, cerrarla
    const existingConnection = this.connectedAgents.get(agentId);
    if (existingConnection) {
      existingConnection.close(1000, 'Nueva conexión establecida');
      this.agentSocketMap.delete(existingConnection);
    }
    
    // Registrar nueva conexión
    this.connectedAgents.set(agentId, ws);
    this.agentSocketMap.set(ws, agentId);
  }

  /**
   * Manejar desconexión de agente
   */
  private handleDisconnection(ws: WebSocket, agentId: string, code: number, reason: string | Buffer): void {
    this.connectedAgents.delete(agentId);
    this.agentSocketMap.delete(ws);
    
    logger.info(`Agente desconectado: ${agentId}`, { code, reason: reason.toString() });
  }

  /**
   * Iniciar intervalo de ping para mantener conexiones activas
   */
  private startPingInterval(): void {
    // Cancelar intervalo existente si lo hay
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Enviar ping cada 30 segundos para mantener conexiones activas
    this.pingInterval = setInterval(() => {
      this.wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      });
    }, 30000);
  }

  /**
   * Enviar mensaje a un agente específico
   */
  public sendToAgent(agentId: string, type: string, payload: any): boolean {
    const ws = this.connectedAgents.get(agentId);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    return this.sendToSocket(ws, type, payload);
  }

  /**
   * Enviar mensaje a un socket específico
   */
  public sendToSocket(ws: WebSocket, type: string, payload: any): boolean {
    try {
      const message = JSON.stringify({ type, payload, timestamp: Date.now() });
      ws.send(message);
      return true;
    } catch (error) {
      logger.error('Error al enviar mensaje WebSocket', { error, type });
      return false;
    }
  }

  /**
   * Enviar mensaje a todos los agentes conectados
   */
  public broadcastToAgents(type: string, payload: any): void {
    this.connectedAgents.forEach((ws, agentId) => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendToSocket(ws, type, payload);
      }
    });
  }

  /**
   * Verificar si un agente está conectado
   */
  public isAgentConnected(agentId: string): boolean {
    const ws = this.connectedAgents.get(agentId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Obtener número de agentes conectados
   */
  public getConnectedAgentsCount(): number {
    return this.connectedAgents.size;
  }

  /**
   * Obtener lista de IDs de agentes conectados
   */
  public getConnectedAgentIds(): string[] {
    return Array.from(this.connectedAgents.keys());
  }

  /**
   * Cerrar todas las conexiones
   */
  public close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    this.wss.clients.forEach(client => {
      client.close(1000, 'Servidor cerrando');
    });
    
    this.wss.close();
    
    logger.info('Servidor WebSocket cerrado');
  }
}

let wsServiceInstance: WebSocketService | null = null;

/**
 * Configurar servidor WebSocket
 */
export function setupWebSocketServer(server: HttpServer): WebSocketService {
  if (!wsServiceInstance) {
    wsServiceInstance = new WebSocketService(server);
  }
  return wsServiceInstance;
}

/**
 * Obtener instancia del servicio WebSocket
 */
export function getWebSocketService(): WebSocketService | null {
  return wsServiceInstance;
}

export default WebSocketService;