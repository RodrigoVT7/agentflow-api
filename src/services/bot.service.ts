// src/services/bot.service.ts
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { DirectLineConversation, DirectLineActivity } from '../models/directline.model';
import directlineConfig from '../config/directline.config';
import config from '../config/app.config';
import logger from '../utils/logger';
import { EventEmitter } from 'events';

export class BotService {
  private directLineToken: string | null = null;
  private tokenExpiration: number = 0;
  private events: EventEmitter;

  constructor() {
    this.events = new EventEmitter();
    
    // Configurar renovación periódica del token
    if (directlineConfig.tokenRefreshMinutes > 0) {
      setInterval(() => {
        this.refreshDirectLineToken();
      }, directlineConfig.tokenRefreshMinutes * 60 * 1000);
    }
  }

  /**
   * Obtener un token de DirectLine, ya sea nuevo o el existente si es válido
   */
  public async getDirectLineToken(): Promise<string> {
    // Si ya tenemos un token válido, devolverlo
    if (this.directLineToken && Date.now() < this.tokenExpiration) {
      return this.directLineToken;
    }
    
    return this.refreshDirectLineToken();
  }

  /**
   * Forzar la renovación del token de DirectLine
   */
  private async refreshDirectLineToken(): Promise<string> {
    try {
      const response = await fetch(
        `${config.powerPlatform.baseUrl}${config.powerPlatform.botEndpoint}/directline/token?api-version=2022-03-01-preview`
      );
      
      if (!response.ok) {
        throw new Error(`Error al obtener token DirectLine: ${response.statusText}`);
      }
      
      const data: any = await response.json();
      
      this.directLineToken = data.token || '';
      
      // Establecer expiración (30 minutos menos que lo indicado para renovar antes)
      const expiresIn = (data.expiresIn || 3600) - 1800;
      this.tokenExpiration = Date.now() + (expiresIn * 1000);
      
      logger.info('Token DirectLine renovado correctamente');
      
      if (!this.directLineToken) {
        throw new Error('Token value is null');
      }

      return this.directLineToken;


    } catch (error) {
      logger.error('Error al renovar token DirectLine', { error });
      // Si hay un error y tenemos un token anterior, usarlo
      if (this.directLineToken) {
        return this.directLineToken;
      }
      throw error;
    }
  }

  /**
   * Crear una nueva conversación con el bot
   */
  public async createConversation(): Promise<DirectLineConversation> {
    const token = await this.getDirectLineToken();
    
    const response = await fetch(`${directlineConfig.url}/conversations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Error al crear conversación DirectLine: ${response.statusText}`);
    }
    
    const conversation = await response.json() as DirectLineConversation;
    logger.info(`Nueva conversación DirectLine creada: ${conversation.conversationId}`);
    
    return conversation;
  }

  /**
   * Enviar mensaje al bot
   */
  public async sendMessageToBot(
    conversationId: string, 
    from: string, 
    text: string
  ): Promise<void> {
    const token = await this.getDirectLineToken();
    
    const activity: DirectLineActivity = {
      type: 'message',
      from: { id: from },
      text: text
    };
    
    const response = await fetch(`${directlineConfig.url}/conversations/${conversationId}/activities`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(activity)
    });
    
    if (!response.ok) {
      throw new Error(`Error al enviar mensaje a DirectLine: ${response.statusText}`);
    }
    
    logger.debug(`Mensaje enviado a bot en conversación ${conversationId}`, { from, text });
  }

  /**
   * Configurar conexión WebSocket para recibir respuestas del bot
   */
  public async createWebSocketConnection(
    conversationId: string,
    token: string,
    onMessageReceived: (activity: DirectLineActivity) => void
  ): Promise<WebSocket> {
    // Preparar URL del WebSocket
    const streamUrl = directlineConfig.streamUrlPath.replace('{conversationId}', conversationId);
    const wsUrl = `wss://${directlineConfig.url.replace(/^https?:\/\//, '')}${streamUrl}?watermark=-1`;
    
    const wsConnection = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    let reconnectAttempts = 0;
    
    wsConnection.on('open', () => {
      logger.info(`Conexión WebSocket establecida para conversación ${conversationId}`);
      reconnectAttempts = 0;
      this.events.emit(`ws:connected:${conversationId}`);
    });
    
    wsConnection.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.activities && message.activities.length > 0) {
          message.activities.forEach((activity: DirectLineActivity) => {
            if (activity.from?.role === 'bot' && activity.type === 'message') {
              logger.debug(`Mensaje recibido del bot en conversación ${conversationId}`, {
                text: activity.text
              });
              
              onMessageReceived(activity);
              this.events.emit(`message:${conversationId}`, activity);
            }
          });
        }
      } catch (error) {
        logger.error(`Error al procesar mensaje WebSocket para conversación ${conversationId}`, { error });
      }
    });
    
    wsConnection.on('error', (error) => {
      logger.error(`Error en WebSocket para conversación ${conversationId}`, { error });
      this.events.emit(`ws:error:${conversationId}`, error);
    });
    
    wsConnection.on('close', (code, reason) => {
      logger.warn(`Conexión WebSocket cerrada para conversación ${conversationId}`, { code, reason });
      this.events.emit(`ws:closed:${conversationId}`, { code, reason });
      
      // Intentar reconectar si no fue un cierre limpio
      if (code !== 1000 && reconnectAttempts < directlineConfig.reconnectAttempts) {
        reconnectAttempts++;
        
        const delay = directlineConfig.reconnectDelay * Math.pow(2, reconnectAttempts - 1);
        logger.info(`Intentando reconectar WebSocket para conversación ${conversationId} en ${delay}ms (intento ${reconnectAttempts})`);
        
        setTimeout(() => {
          this.createWebSocketConnection(conversationId, token, onMessageReceived)
            .then(newWs => {
              this.events.emit(`ws:reconnected:${conversationId}`, newWs);
            })
            .catch(error => {
              logger.error(`Error al reconectar WebSocket para conversación ${conversationId}`, { error });
            });
        }, delay);
      }
    });
    
    return wsConnection;
  }

  /**
   * Suscribirse a eventos
   */
  public on(event: string, listener: (...args: any[]) => void): void {
    this.events.on(event, listener);
  }

  /**
   * Cancelar suscripción a eventos
   */
  public off(event: string, listener: (...args: any[]) => void): void {
    this.events.off(event, listener);
  }
}

// Instancia singleton
let botServiceInstance: BotService | null = null;

export function initBotService(): BotService {
  if (!botServiceInstance) {
    botServiceInstance = new BotService();
  }
  return botServiceInstance;
}

export default initBotService;