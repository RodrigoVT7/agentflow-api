// src/services/conversation.service.ts
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { ConversationData, ConversationStatus } from '../models/conversation.model';
import { DirectLineConversation, DirectLineActivity, DirectLineToken } from '../models/directline.model';
import { WhatsAppService } from './whatsapp.service';
import { initQueueService } from './queue.service';
import { MessageSender } from '../models/message.model';
import config from '../config/app.config';
import logger from '../utils/logger';
import { initDatabaseConnection } from '../database/connection';

interface TokenResponse {
  token: string;
  expires_in?: number;
}

// Constantes para mejor mantenimiento y legibilidad
const TOKEN_EXPIRATION_MS = 55 * 60 * 1000; // 55 minutos (los tokens duran 60 minutos)
const INACTIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 horas
const MESSAGE_SPACING_MS = 1000; // Espacio entre mensajes (1 segundo)
const WEBSOCKET_RECONNECT_ATTEMPTS = 3;
const WEBSOCKET_RECONNECT_INTERVAL_MS = 5000; // 5 segundos entre intentos
const API_RETRY_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 1000; // 1 segundo entre reintentos

class ConversationService {
  private conversations: Map<string, ConversationData>;
  private whatsappService: WhatsAppService;
  private queueService = initQueueService();
  private messageProcessingQueues: Map<string, Promise<void>> = new Map();

  // Patrones para detectar escalamiento en mensajes del bot
  private escalationPatterns: string[] = [
    "la remisión a un agente por chat",
    "te comunicaré con un agente",
    "hablar con un agente",
    "hablar con una persona",
    "hablar con alguien",
    "devolver llamada",
    "llamar al servicio"
  ];

  constructor() {
    this.conversations = new Map<string, ConversationData>();
    this.whatsappService = new WhatsAppService();
    
    // Cargar conversaciones activas desde la base de datos
    this.loadConversationsFromDB().catch(error => {
      logger.error('Error al cargar conversaciones desde la base de datos', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined 
      });
    });
    
    // Iniciar limpieza periódica de conversaciones inactivas (cada hora)
    setInterval(() => this.cleanupInactiveConversations(), 60 * 60 * 1000);
    
    // Verificar tokens cada 15 minutos para renovación proactiva
    setInterval(() => this.checkAndRefreshTokens(), 15 * 60 * 1000);
  }

  /**
   * Verifica y refresca tokens que están por expirar
   */
  private async checkAndRefreshTokens(): Promise<void> {
    logger.info('Iniciando verificación de tokens...');
    
    for (const [from, conversation] of this.conversations.entries()) {
      try {
        // Si no tiene tokenTimestamp, es una conversación vieja sin control de expiración
        if (!conversation.tokenTimestamp) {
          conversation.tokenTimestamp = Date.now();
        }
        
        const tokenAge = Date.now() - conversation.tokenTimestamp;
        
        // Si el token tiene más de 55 minutos, renovarlo proactivamente
        if (tokenAge >= TOKEN_EXPIRATION_MS) {
          logger.info(`Token expirando para conversación ${conversation.conversationId} (${from}), refrescando...`);
          await this.refreshConversationToken(conversation);
          logger.info(`Token refrescado para conversación ${conversation.conversationId}`);
        }
      } catch (error) {
        logger.error(`Error al verificar/refrescar token para ${from}:`, {
          error: error instanceof Error ? error.message : String(error),
          conversationId: conversation.conversationId,
          tokenAge: conversation.tokenTimestamp ? Date.now() - conversation.tokenTimestamp : 'desconocido'
        });
      }
    }
    
    logger.info('Verificación de tokens completada');
  }

  /**
   * Obtener un nuevo token DirectLine
   */
  private async getDirectLineToken(): Promise<DirectLineToken> {
    try {
      const response = await this.retryApiCall(() => fetch(
        `${config.powerPlatform.baseUrl}${config.powerPlatform.botEndpoint}/directline/token?api-version=2022-03-01-preview`
      ));
      
      if (!response.ok) {
        throw new Error(`Error al obtener token DirectLine: ${response.statusText} (${response.status})`);
      }
      
      const data = await response.json() as TokenResponse;
      
      if (!data.token || typeof data.token !== 'string') {
        throw new Error('Token DirectLine inválido o vacío en respuesta');
      }
      
      return {
        token: data.token,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Error obteniendo token DirectLine:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Refrescar token para una conversación existente
   */
  private async refreshConversationToken(conversation: ConversationData): Promise<boolean> {
    try {
      // 1. Obtener nuevo token
      const tokenData = await this.getDirectLineToken();
      
      // 2. Actualizar en memoria
      conversation.token = tokenData.token;
      conversation.tokenTimestamp = tokenData.timestamp;
      
      // 3. Actualizar en base de datos
      const db = await initDatabaseConnection();
      db.prepare(
        `UPDATE conversations SET token = ?, tokenTimestamp = ? WHERE conversationId = ?`
      ).run(tokenData.token, tokenData.timestamp, conversation.conversationId);
      
      // 4. Reconectar WebSocket con nuevo token
      if (conversation.wsConnection) {
        try {
          // Cerrar el antiguo
          conversation.wsConnection.close();
        } catch (wsError) {
          logger.warn(`Error al cerrar WebSocket antigua para ${conversation.from}:`, { error: wsError });
        }
      }
      
      // 5. Crear nueva conexión WebSocket con el nuevo token
      conversation.wsConnection = await this.setupWebSocketConnection(
        conversation.conversationId,
        tokenData.token, 
        conversation.phone_number_id,
        conversation.from
      );
      
      logger.info(`Token refrescado exitosamente para conversación ${conversation.conversationId}`);
      return true;
    } catch (error) {
      logger.error(`Error al refrescar token para conversación ${conversation.conversationId}:`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined 
      });
      return false;
    }
  }

  /**
   * Cargar conversaciones activas desde la base de datos
   */
  private async loadConversationsFromDB(): Promise<void> {
    try {
      const db = await initDatabaseConnection();
      
      // Verificar si existe columna tokenTimestamp y añadirla si no existe
      const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
      const hasTokenTimestamp = tableInfo.some((col: any) => col.name === 'tokenTimestamp');
      
      if (!hasTokenTimestamp) {
        logger.info('Añadiendo columna tokenTimestamp a la tabla conversations');
        db.prepare("ALTER TABLE conversations ADD COLUMN tokenTimestamp INTEGER").run();
      }
      
      // Get active conversations (not completed) - use prepared statement
      const dbConversations = db.prepare(
        `SELECT * FROM conversations WHERE status != ?`
      ).all(ConversationStatus.COMPLETED);
      
      if (dbConversations && dbConversations.length > 0) {
        logger.info(`Encontradas ${dbConversations.length} conversaciones activas en base de datos`);
        
        for (const dbConv of dbConversations) {
          // Only load recent conversations (less than 24 hours)
          const lastActivity = dbConv.lastActivity;
          const now = Date.now();
          
          // Si conversación inactiva por más de 24 horas, marcar como completada
          if (now - lastActivity > INACTIVE_TIMEOUT_MS) {
            logger.info(`Conversación ${dbConv.conversationId} inactiva por más de 24h, marcando como completada`);
            
            db.prepare(
              `UPDATE conversations SET status = ? WHERE conversationId = ?`
            ).run(ConversationStatus.COMPLETED, dbConv.conversationId);
            continue;
          }
          
          // Verificar si el token sigue siendo válido
          const tokenTimestamp = dbConv.tokenTimestamp || dbConv.lastActivity; // Usar lastActivity como fallback
          const tokenAge = now - tokenTimestamp;
          
          if (tokenAge >= TOKEN_EXPIRATION_MS) {
            logger.info(`Token expirado para conversación ${dbConv.conversationId}, no se cargará (se creará nueva cuando sea necesario)`);
            continue;
          }
          
          // Cargar conversación activa en memoria
          const conversation: ConversationData = {
            conversationId: dbConv.conversationId,
            token: dbConv.token,
            tokenTimestamp: dbConv.tokenTimestamp || dbConv.lastActivity, // Fallback
            phone_number_id: dbConv.phone_number_id,
            from: dbConv.from_number,
            isEscalated: dbConv.isEscalated === 1,
            lastActivity: dbConv.lastActivity,
            status: dbConv.status as ConversationStatus
          };
          
          try {
            // Configurar WebSocket con manejo de errores
            conversation.wsConnection = await this.setupWebSocketConnection(
              conversation.conversationId,
              conversation.token,
              conversation.phone_number_id,
              conversation.from
            );
            
            this.conversations.set(dbConv.from_number, conversation);
            logger.info(`Conversación ${conversation.conversationId} cargada desde BD para ${dbConv.from_number}`);
          } catch (wsError) {
            logger.error(`Error al configurar WebSocket para conversación cargada ${dbConv.conversationId}:`, { 
              error: wsError instanceof Error ? wsError.message : String(wsError)
            });
            // No cargar esta conversación, se creará nueva cuando sea necesario
          }
        }
        
        logger.info(`${this.conversations.size} conversaciones activas cargadas en memoria`);
      } else {
        logger.info('No se encontraron conversaciones activas en la base de datos');
      }
    } catch (error) {
      logger.error('Error loading conversations from database', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error; // Propagar para manejo superior
    }
  }

  /**
   * Obtener o crear una conversación para un usuario
   */
  public async getOrCreateConversation(from: string, phone_number_id: string): Promise<ConversationData> {
    // Verificar si ya existe la conversación activa en memoria
    let conversation = this.conversations.get(from);
    
    // Si encontramos una conversación completada en memoria, eliminarla
    if (conversation && conversation.status === ConversationStatus.COMPLETED) {
      logger.info(`Conversación en memoria ${conversation.conversationId} para ${from} está completada, eliminando para crear una nueva`);
      this.conversations.delete(from);
      conversation = undefined;
    }
    
    // Si tenemos conversación en memoria, verificar validez del token
    if (conversation && conversation.tokenTimestamp) {
      const tokenAge = Date.now() - conversation.tokenTimestamp;
      
      // Si el token está expirado, refrescarlo
      if (tokenAge >= TOKEN_EXPIRATION_MS) {
        logger.info(`Token expirado para conversación ${conversation.conversationId}, refrescando...`);
        
        const tokenRefreshed = await this.refreshConversationToken(conversation);
        if (!tokenRefreshed) {
          logger.warn(`No se pudo refrescar token, se creará nueva conversación para ${from}`);
          this.conversations.delete(from);
          conversation = undefined;
        } else {
          logger.info(`Token refrescado exitosamente para ${from}`);
        }
      }
    }
    
    // Si no está en memoria o fue eliminada, verificar en la base de datos
    if (!conversation) {
      try {
        const db = await initDatabaseConnection();
        
        // Buscar SOLO conversaciones NO completadas para este número
        const dbConversation = db.prepare(
          `SELECT * FROM conversations 
           WHERE from_number = ? AND status != ? 
           ORDER BY lastActivity DESC LIMIT 1`
        ).get(from, ConversationStatus.COMPLETED);
        
        if (dbConversation) {
          logger.debug(`[CONV-VERIFICACION] Conversación activa encontrada en BD para ${from}:`, {
            id: dbConversation.conversationId,
            estado: dbConversation.status,
            lastActivity: new Date(dbConversation.lastActivity).toISOString(),
            isEscalated: dbConversation.isEscalated,
            tokenTimestamp: dbConversation.tokenTimestamp ? new Date(dbConversation.tokenTimestamp).toISOString() : 'no disponible'
          });
          
          // Verificar validez del token antes de cargar
          const tokenTimestamp = dbConversation.tokenTimestamp || dbConversation.lastActivity;
          const tokenAge = Date.now() - tokenTimestamp;
          
          if (tokenAge >= TOKEN_EXPIRATION_MS) {
            logger.info(`Token expirado para conversación ${dbConversation.conversationId} en BD, se creará nueva para ${from}`);
          } else {
            // Cargar conversación no completada encontrada en BD
            conversation = {
              conversationId: dbConversation.conversationId,
              token: dbConversation.token,
              tokenTimestamp: tokenTimestamp,
              phone_number_id: dbConversation.phone_number_id,
              from: dbConversation.from_number,
              isEscalated: dbConversation.isEscalated === 1,
              lastActivity: dbConversation.lastActivity,
              status: dbConversation.status as ConversationStatus
            };
            
            try {
              // Configurar WebSocket para esta conversación restaurada
              conversation.wsConnection = await this.setupWebSocketConnection(
                conversation.conversationId,
                conversation.token,
                phone_number_id,
                from
              );
              
              this.conversations.set(from, conversation);
              logger.info(`Conversación restaurada desde BD: ${conversation.conversationId} para ${from} (estado: ${conversation.status})`);
            } catch (wsError) {
              logger.error(`Error al configurar WebSocket para conversación restaurada ${dbConversation.conversationId}:`, { 
                error: wsError instanceof Error ? wsError.message : String(wsError)
              });
              // No usar esta conversación, se creará nueva
              conversation = undefined;
            }
          }
        } else {
          logger.info(`No hay conversaciones activas en BD para ${from}, se creará una nueva`);
        }
      } catch (error) {
        logger.error(`Error al verificar conversación en BD para ${from}:`, { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        // Continuamos para crear una nueva conversación
      }
    }
    
    // VERIFICACIÓN DE INACTIVIDAD: Si está inactiva por más de 24 horas
    if (conversation && Date.now() - conversation.lastActivity > INACTIVE_TIMEOUT_MS) {
      logger.info(`Conversación ${conversation.conversationId} inactiva para ${from}, creando una nueva`);
      
      // Marcar la conversación antigua como completada en la base de datos
      try {
        const db = await initDatabaseConnection();
        db.prepare(
          `UPDATE conversations SET status = ? WHERE conversationId = ?`
        ).run(ConversationStatus.COMPLETED, conversation.conversationId);
      } catch (error) {
        logger.error(`Error al marcar conversación antigua como completada: ${from}`, { error });
        // Continuamos a pesar del error para crear una nueva
      }
      
      // Eliminar de la memoria para que se cree una nueva
      this.conversations.delete(from);
      conversation = undefined;
    }
    
    // CREAR NUEVA: Si llegamos aquí sin una conversación válida, crear una nueva
    if (!conversation) {
      conversation = await this._startNewConversationForUser(from, phone_number_id);
    }
    
    if (!conversation) {
      throw new Error(`No se pudo obtener ni crear una conversación para ${from}`);
    }
    
    return conversation;
  }

  /**
   * Crear una nueva conversación para un usuario
   * (Método extraído para mejor modularidad)
   */
  private async _startNewConversationForUser(from: string, phone_number_id: string): Promise<ConversationData> {
    logger.info(`Creando nueva conversación para ${from}`);
    
    try {
      // 1. Obtener token DirectLine
      const tokenData = await this.getDirectLineToken();
      
      // 2. Crear una nueva conversación con DirectLine
      const directLineConversation = await this.createDirectLineConversation(tokenData.token);
      
      // 3. Configurar WebSocket para recibir respuestas del bot
      const wsConnection = await this.setupWebSocketConnection(
        directLineConversation.conversationId,
        tokenData.token,
        phone_number_id,
        from
      );
      
      // 4. Crear nueva conversación
      const conversation: ConversationData = {
        conversationId: directLineConversation.conversationId,
        token: tokenData.token,
        tokenTimestamp: tokenData.timestamp,
        wsConnection,
        phone_number_id,
        from,
        isEscalated: false,
        lastActivity: Date.now(),
        status: ConversationStatus.BOT
      };
      
      // 5. Guardar en memoria
      this.conversations.set(from, conversation);
      
      // 6. Persistir en la base de datos
      try {
        const db = await initDatabaseConnection();
        
        // Verificar si tokenTimestamp existe como columna
        const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
        const hasTokenTimestamp = tableInfo.some((col: any) => col.name === 'tokenTimestamp');
        
        let stmt;
        if (hasTokenTimestamp) {
          stmt = db.prepare(
            `INSERT INTO conversations 
             (conversationId, token, tokenTimestamp, phone_number_id, from_number, isEscalated, lastActivity, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          stmt.run(
            conversation.conversationId,
            conversation.token,
            conversation.tokenTimestamp,
            conversation.phone_number_id,
            conversation.from,
            conversation.isEscalated ? 1 : 0,
            conversation.lastActivity,
            conversation.status
          );
        } else {
          stmt = db.prepare(
            `INSERT INTO conversations 
             (conversationId, token, phone_number_id, from_number, isEscalated, lastActivity, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          stmt.run(
            conversation.conversationId,
            conversation.token,
            conversation.phone_number_id,
            conversation.from,
            conversation.isEscalated ? 1 : 0,
            conversation.lastActivity,
            conversation.status
          );
        }
        
        logger.info(`Nueva conversación creada y persistida: ${conversation.conversationId} para ${from}`);
      } catch (error) {
        logger.error(`Error al persistir nueva conversación: ${from}`, { error });
        // Continuamos a pesar del error para devolver la conversación ya creada
      }
      
      return conversation;
    } catch (error) {
      logger.error(`Error crítico al crear nueva conversación para ${from}:`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error(`No se pudo crear una nueva conversación: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Crear una nueva conversación DirectLine
   */
  private async createDirectLineConversation(token: string): Promise<DirectLineConversation> {
    try {
      const response = await this.retryApiCall(() => fetch(`${config.directline.url}/conversations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }));
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error al crear conversación DirectLine: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      // Definir explícitamente el tipo para evitar errores de 'unknown'
      const data = await response.json() as DirectLineConversation;
      
      // Validar datos recibidos
      if (!data || typeof data !== 'object' || !data.conversationId || !data.token) {
        throw new Error(`Respuesta inválida al crear conversación DirectLine: ${JSON.stringify(data)}`);
      }
      
      return data;
    } catch (error) {
      logger.error('Error al crear conversación DirectLine:', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Función para reintentar llamadas a APIs con backoff exponencial
   */
  private async retryApiCall<T>(
    apiCall: () => Promise<T>, 
    maxRetries: number = API_RETRY_ATTEMPTS
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        lastError = error;
        logger.warn(`Intento ${attempt}/${maxRetries} falló:`, { 
          error: error instanceof Error ? error.message : String(error)
        });
        
        if (attempt < maxRetries) {
          // Backoff exponencial: 1s, 2s, 4s...
          const delay = Math.min(API_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // Si llegamos aquí, todos los intentos fallaron
    throw lastError;
  }

  /**
   * Configurar conexión WebSocket para la conversación con manejo de reconexión
   */
  private async setupWebSocketConnection(
    conversationId: string,
    token: string,
    phone_number_id: string,
    from: string,
    reconnectAttempt: number = 0
  ): Promise<WebSocket> {
    // Crear una promesa que resuelve cuando la conexión está lista o rechaza en error
    return new Promise((resolve, reject) => {
      try {
        logger.debug(`Configurando WebSocket para conversación ${conversationId} (intento ${reconnectAttempt})`);
        
        const wsConnection = new WebSocket(
          `wss://directline.botframework.com/v3/directline/conversations/${conversationId}/stream?watermark=-1`,
          {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        // Set para rastrear IDs de mensajes ya procesados para esta conversación específica
        const processedMessageIds = new Set<string>();
        
        // Manejar evento de conexión abierta
        wsConnection.on('open', () => {
          logger.info(`WebSocket conectado para conversación ${conversationId} (${from})`);
          resolve(wsConnection); // Resolver la promesa con la conexión exitosa
        });
        
        // Manejar mensajes recibidos
        wsConnection.on('message', async (data: WebSocket.Data) => {
          this.handleWebSocketMessage(data, processedMessageIds, conversationId, from, phone_number_id);
        });
        
        // Manejar errores
        wsConnection.on('error', (error) => {
          logger.error(`Error en WebSocket para conversación ${conversationId}:`, { 
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
          
          // Solo rechazar si es el intento inicial y aún no se ha resuelto
          if (reconnectAttempt === 0) {
            reject(error);
          }
        });
        
        // Manejar cierre de conexión
        wsConnection.on('close', async (code: number, reason: string) => {
          logger.warn(`WebSocket cerrado para conversación ${conversationId} (${from}): Código ${code}, Razón: ${reason || 'No especificada'}`);
          
          // Obtener la conversación actual
          const conversation = this.getConversationByIdOrFrom(conversationId, from);
          
          if (!conversation) {
            logger.warn(`No se encontró conversación ${conversationId} (${from}) para reconectar WebSocket`);
            return;
          }
          
          // Si la conversación está completada o escalada, no reconectar
          if (conversation.status === ConversationStatus.COMPLETED || conversation.isEscalated) {
            logger.info(`No se reconectará WebSocket para conversación ${conversationId} (${from}): estado=${conversation.status}, escalada=${conversation.isEscalated}`);
            return;
          }
          
          // Intentar reconectar si no hemos alcanzado el máximo de intentos
          if (reconnectAttempt < WEBSOCKET_RECONNECT_ATTEMPTS) {
            logger.info(`Intentando reconexión WebSocket para ${conversationId} (${from}): intento ${reconnectAttempt + 1}/${WEBSOCKET_RECONNECT_ATTEMPTS}`);
            
            // Esperar antes de reconectar
            await new Promise(resolve => setTimeout(resolve, WEBSOCKET_RECONNECT_INTERVAL_MS));
            
            try {
              // Verificar token antes de reconectar
              const tokenAge = conversation.tokenTimestamp ? Date.now() - conversation.tokenTimestamp : Infinity;
              
              // Si el token está por expirar, renovarlo
              if (tokenAge >= TOKEN_EXPIRATION_MS) {
                logger.info(`Refrescando token antes de reconectar WebSocket para ${conversationId}`);
                await this.refreshConversationToken(conversation);
              }
              
              // Reconectar con nuevo intento
              conversation.wsConnection = await this.setupWebSocketConnection(
                conversationId,
                conversation.token,
                phone_number_id,
                from,
                reconnectAttempt + 1
              );
              
              logger.info(`WebSocket reconectado exitosamente para ${conversationId} (${from})`);
            } catch (reconnectError) {
              logger.error(`Error al reconectar WebSocket para ${conversationId} (${from}):`, { 
                error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
              });
            }
          } else {
            logger.error(`Máximos intentos de reconexión WebSocket alcanzados para ${conversationId} (${from})`);
          }
        });
      } catch (error) {
        logger.error(`Error al configurar WebSocket: ${conversationId}`, { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        reject(error);
      }
    });
  }

  /**
   * Obtener conversación por ID o número de teléfono
   */
  private getConversationByIdOrFrom(conversationId: string, from: string): ConversationData | undefined {
    // Primero intentar buscar por from (más rápido)
    let conversation = this.conversations.get(from);
    if (conversation) return conversation;
    
    // Si no, buscar por conversationId
    for (const [_, conv] of this.conversations.entries()) {
      if (conv.conversationId === conversationId) {
        return conv;
      }
    }
    
    return undefined;
  }

  /**
   * Procesar mensajes recibidos desde WebSocket
   */
  private async handleWebSocketMessage(
    data: WebSocket.Data, 
    processedMessageIds: Set<string>,
    conversationId: string, 
    from: string,
    phone_number_id: string
  ): Promise<void> {
    try {
      const dataStr = data.toString();
      if (!dataStr || dataStr.trim() === '') {
        logger.debug('Mensaje WebSocket vacío recibido, ignorando');
        return;
      }
      
      // Intentar parsear el JSON con manejo de errores
      let message;
      try {
        message = JSON.parse(dataStr);
      } catch (parseError) {
        logger.error('Error al parsear mensaje WebSocket:', { 
          error: parseError instanceof Error ? parseError.message : String(parseError),
          data: dataStr.substring(0, 200) + (dataStr.length > 200 ? '...' : '')
        });
        return;
      }
      
      if (!message.activities || !Array.isArray(message.activities) || message.activities.length === 0) {
        return; // No hay actividades para procesar
      }
      
      logger.debug(`Recibidas ${message.activities.length} actividades para ${from}`);
      
      // Filtrar solo los mensajes válidos del bot que no han sido procesados
      const botResponses = message.activities.filter((a: DirectLineActivity) => {
        return a.from?.role === 'bot' && 
               a.type === 'message' &&
               a.text &&
               a.id &&
               !processedMessageIds.has(a.id);
      });
      
      // Si no hay mensajes nuevos, salir
      if (botResponses.length === 0) {
        logger.debug(`No hay mensajes nuevos para procesar en este paquete`);
        return;
      }
      
      // Ordenar mensajes por timestamp
      const sortedMessages = [...botResponses].sort((a: DirectLineActivity, b: DirectLineActivity) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeA - timeB; // Ordenar de más antiguo a más reciente
      });
      
      logger.debug(`Procesando ${sortedMessages.length} mensajes ordenados por timestamp`);
      
      // Registrar los IDs para evitar procesamiento duplicado
      for (const message of sortedMessages) {
        if (message.id) {
          processedMessageIds.add(message.id);
        }
      }
      
      // Encolar mensajes para procesamiento secuencial
      this.enqueueMessagesForProcessing(sortedMessages, conversationId, from, phone_number_id);
    } catch (error) {
      logger.error(`Error al procesar mensaje WebSocket: ${conversationId}`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  /**
   * Encolar mensajes para procesamiento secuencial garantizado
   */
  private enqueueMessagesForProcessing(
    messages: DirectLineActivity[],
    conversationId: string,
    from: string,
    phone_number_id: string
  ): void {
    // Obtener o crear una promesa de procesamiento para esta conversación
    let processingPromise = this.messageProcessingQueues.get(from) || Promise.resolve();
    
    // Encadenar el procesamiento de nuevos mensajes
    messages.forEach(message => {
      processingPromise = processingPromise.then(async () => {
        try {
          // Verificar que el mensaje tiene texto antes de procesarlo
          if (!message.text) {
            logger.warn(`Mensaje sin texto recibido para ${from}, ignorando`, {
              messageId: message.id,
              type: message.type
            });
            return;
          }
          
          // Verificar escalamiento
          const isEscalation = this.isEscalationMessage(message.text);
          
          // Procesar según tipo
          if (isEscalation) {
            await this.handleEscalation(from, phone_number_id, message.text);
          } else {
            // Verificar si conversación está escalada antes de enviar
            const isCurrentlyEscalated = this.isEscalated(from);
            
            if (!isCurrentlyEscalated) {
              // Enviar mensaje a WhatsApp con timeout de seguridad
              await this.whatsappService.sendMessage(
                phone_number_id,
                from,
                message.text
              );
              
              // Guardar mensaje en base de datos
              const conversation = this.getConversationByIdOrFrom(conversationId, from);
              if (conversation) {
                await this.saveMessage(conversation.conversationId, 'bot', message.text);
              }
            }
          }
          
          // Actualizar timestamp de actividad
          await this.updateConversationActivity(from);
          
          // Esperar tiempo fijo entre mensajes para evitar problemas de orden
          await new Promise(resolve => setTimeout(resolve, MESSAGE_SPACING_MS));
        } catch (error) {
          logger.error(`Error procesando mensaje para ${from}:`, {
            error: error instanceof Error ? error.message : String(error),
            messageId: message.id
          });
          // No propagar el error para no bloquear la cola
        }
      });
    });
    
    // Actualizar la cola con la nueva cadena de promesas
    this.messageProcessingQueues.set(from, processingPromise);
    
    // Limpiar la referencia cuando termine el procesamiento
    processingPromise.finally(() => {
      if (this.messageProcessingQueues.get(from) === processingPromise) {
        this.messageProcessingQueues.delete(from);
      }
    });
  }

  /**
   * Guardar mensaje en la base de datos con verificación de duplicados
   */
  private async saveMessage(conversationId: string, from: string, text: string, agentId?: string): Promise<boolean> {
    if (!conversationId || !from || !text) {
      logger.error('Error al guardar mensaje: parámetros incompletos', {
        conversationId: conversationId || 'VACÍO',
        from: from || 'VACÍO',
        textLength: text ? text.length : 0
      });
      return false;
    }
    
    try {
      // Generar un messageId único
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const timestamp = Date.now();
      
      const db = await initDatabaseConnection();
      
      // PASO 1: Verificar si ya existe un mensaje similar para evitar duplicados
      // Buscamos mensajes con el mismo texto, de la misma fuente, en la misma conversación
      // y en un rango de tiempo cercano (10 segundos)
      const timeWindow = 10000; // 10 segundos en milisegundos
      const minTime = timestamp - timeWindow;
      
      const existingMessage = db.prepare(`
        SELECT id FROM messages 
        WHERE conversationId = ? 
        AND from_type = ? 
        AND text = ? 
        AND timestamp > ?
      `).get(conversationId, from, text, minTime);
      
      // Si ya existe un mensaje similar reciente, no insertar duplicado
      if (existingMessage) {
        logger.warn(`Evitando insertar mensaje duplicado para conversación ${conversationId}`, {
          existingId: existingMessage.id,
          newId: messageId,
          text: text.substring(0, 30) + (text.length > 30 ? '...' : '')
        });
        return true; // Consideramos éxito si ya existe
      }
      
      // PASO 2: Verificar si la conversación existe
      const conversationExists = db.prepare(
        'SELECT conversationId FROM conversations WHERE conversationId = ?'
      ).get(conversationId);
      
      if (!conversationExists) {
        logger.error(`No se puede guardar mensaje: Conversación ${conversationId} no existe en BD`);
        return false;
      }
      
      // PASO 3: Insertar el nuevo mensaje
      db.prepare(
        `INSERT INTO messages (id, conversationId, from_type, text, timestamp, agentId)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(messageId, conversationId, from, text, timestamp, agentId || null);
      
      logger.debug(`Mensaje guardado en base de datos: ${messageId} para conversationId=${conversationId}`);
      return true;
    } catch (error) {
      logger.error(`Error al guardar mensaje en base de datos: ${conversationId}`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        from,
        textPreview: text.substring(0, 30) + (text.length > 30 ? '...' : '')
      });
      return false;
    }
  }

  /**
   * Actualizar timestamp de actividad de una conversación
   */
  private async updateConversationActivity(from: string): Promise<void> {
    const conversation = this.conversations.get(from);
    if (!conversation) return;
    
    // Actualizar en memoria
    conversation.lastActivity = Date.now();
    
    // Actualizar en base de datos usando ID del sistema
    try {
      const db = await initDatabaseConnection();
      db.prepare(
        `UPDATE conversations SET lastActivity = ? WHERE conversationId = ?`
      ).run(conversation.lastActivity, conversation.conversationId);
    } catch (error) {
      logger.error(`Error al actualizar timestamp de actividad: ${from}`, { 
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Enviar mensaje a la conversación con manejo de expiración de token
   */
  public async sendMessage(from: string, phone_number_id: string, message: string): Promise<void> {
    try {
      // Verificar si existe conversación en memoria
      let conversation = this.conversations.get(from);
      
      // Si la conversación está completada, eliminarla para forzar la creación de una nueva
      if (conversation && conversation.status === ConversationStatus.COMPLETED) {
        logger.info(`Conversación en memoria ${conversation.conversationId} para ${from} está completada, eliminando para crear una nueva`);
        this.conversations.delete(from);
        conversation = undefined;
      }
      
      // Verificar expiración de token si la conversación existe
      if (conversation && conversation.tokenTimestamp) {
        const tokenAge = Date.now() - conversation.tokenTimestamp;
        
        // Si el token está expirado, refrescarlo
        if (tokenAge >= TOKEN_EXPIRATION_MS) {
          logger.info(`Token expirado para conversación ${conversation.conversationId}, refrescando...`);
          
          const tokenRefreshed = await this.refreshConversationToken(conversation);
          if (!tokenRefreshed) {
            logger.warn(`No se pudo refrescar token, se creará nueva conversación para ${from}`);
            this.conversations.delete(from);
            conversation = undefined;
          } else {
            logger.info(`Token refrescado exitosamente para ${from}`);
          }
        }
      }
      
      // Si no hay conversación en memoria, verificar en BD, solo buscando las no completadas
      if (!conversation) {
        try {
          const db = await initDatabaseConnection();
          const dbConversation = db.prepare(
            `SELECT * FROM conversations 
             WHERE from_number = ? AND status != ? 
             ORDER BY lastActivity DESC LIMIT 1`
          ).get(from, ConversationStatus.COMPLETED);
          
          if (dbConversation) {
            // Verificar validez del token
            const tokenTimestamp = dbConversation.tokenTimestamp || dbConversation.lastActivity;
            const tokenAge = Date.now() - tokenTimestamp;
            
            if (tokenAge >= TOKEN_EXPIRATION_MS) {
              logger.info(`Token expirado en BD para ${from}, se creará nueva conversación`);
            } else {
              // Restaurar conversación activa si existe en BD
              logger.info(`Restaurando conversación activa desde BD para ${from}: ${dbConversation.conversationId} (${dbConversation.status})`);
              
              // Crear objeto de conversación con tokenTimestamp
              const restoredConversation: ConversationData = {
                conversationId: dbConversation.conversationId,
                token: dbConversation.token,
                tokenTimestamp: tokenTimestamp,
                phone_number_id: dbConversation.phone_number_id,
                from: dbConversation.from_number,
                isEscalated: dbConversation.isEscalated === 1,
                lastActivity: dbConversation.lastActivity,
                status: dbConversation.status as ConversationStatus
              };
              
              // Configurar WebSocket para esta conversación restaurada
              try {
                restoredConversation.wsConnection = await this.setupWebSocketConnection(
                  restoredConversation.conversationId,
                  restoredConversation.token,
                  phone_number_id,
                  from
                );
                
                this.conversations.set(from, restoredConversation);
                conversation = restoredConversation;
                logger.info(`WebSocket configurado para conversación restaurada ${restoredConversation.conversationId}`);
              } catch (wsError) {
                logger.error(`Error al configurar WebSocket para conversación restaurada, creando nueva:`, { error: wsError });
                conversation = undefined; // Forzar creación nueva
              }
            }
          } else {
            logger.info(`No se encontraron conversaciones activas en BD para ${from}, se creará una nueva`);
          }
        } catch (error) {
          logger.error(`Error al verificar conversación en BD: ${from}`, { 
            error: error instanceof Error ? error.message : String(error) 
          });
          // Continuar el flujo para crear una nueva
        }
      }
      
      // Si tenemos una conversación escalada, enviar a la cola de agentes
      if (conversation && conversation.isEscalated) {
        logger.info(`Mensaje de ${from} enviado a conversación escalada ${conversation.conversationId}`);
        
        // Añadir a la cola para el agente
        await this.queueService.addMessage(conversation.conversationId, {
          from: MessageSender.USER,
          text: message
        });
        
        // Guardar mensaje en la base de datos
        await this.saveMessage(conversation.conversationId, 'user', message);
        
        // Actualizar timestamp de actividad
        conversation.lastActivity = Date.now();
        this.updateConversationActivity(from);
        
        return;
      }
      
      // Si llegamos aquí, necesitamos obtener o crear una conversación con el bot
      if (!conversation) {
        // Crear una nueva conversación con el bot
        conversation = await this.getOrCreateConversation(from, phone_number_id);
        logger.info(`Nueva conversación creada para ${from}: ${conversation.conversationId}`);
      }
      
      // Actualizar tiempo de actividad
      conversation.lastActivity = Date.now();
      this.updateConversationActivity(from);
      
      // Guardar mensaje en la base de datos
      await this.saveMessage(conversation.conversationId, 'user', message);
      
      // Enviar mensaje al bot con reintentos
      logger.info(`Enviando mensaje al bot para ${from}`, {
        conversationId: conversation.conversationId
      });
      
      try {
        await this.sendMessageToBot(conversation, message);
        logger.info(`Mensaje enviado exitosamente al bot para ${from} (conversationId=${conversation.conversationId})`);
      } catch (error) {
        // Si el error es de autenticación (401), intentar refrescar token y reintentar
        if (error instanceof Error && error.message.includes('401')) {
          logger.warn(`Error de autenticación (401) al enviar mensaje, refrescando token: ${from}`);
          
          const refreshed = await this.refreshConversationToken(conversation);
          if (refreshed) {
            // Reintentar con el nuevo token
            try {
              await this.sendMessageToBot(conversation, message);
              logger.info(`Mensaje enviado exitosamente al bot después de refrescar token: ${from}`);
              return;
            } catch (retryError) {
              logger.error(`Error al enviar mensaje después de refrescar token: ${from}`, { 
                error: retryError instanceof Error ? retryError.message : String(retryError)
              });
            }
          }
        }
        
        // Si llegamos aquí, los reintentos fallaron o no pudimos refrescar el token
        logger.error(`Error definitivo al enviar mensaje a DirectLine: ${from}`, { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error; // Re-lanzar para manejo superior
      }
    } catch (error) {
      logger.error(`Error en sendMessage: ${from}`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined 
      });
      throw error; // Re-lanzar para manejo superior
    }
  }

  /**
   * Enviar mensaje al bot con reintentos
   */
  private async sendMessageToBot(conversation: ConversationData, message: string): Promise<void> {
    try {
      const response = await this.retryApiCall(() => fetch(`${config.directline.url}/conversations/${conversation.conversationId}/activities`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${conversation.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'message',
          from: { id: conversation.from },
          text: message
        })
      }));
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error al enviar mensaje a DirectLine: ${response.status} ${response.statusText} - ${errorText}`);
      }
    } catch (error) {
      logger.error(`Error al enviar mensaje a DirectLine: ${conversation.conversationId}`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Verificar si un mensaje indica que se debe escalar la conversación
   */
  private isEscalationMessage(message: string | undefined): boolean {
    if (!message) return false;
    const lowerMessage = message.toLowerCase();
    return this.escalationPatterns.some(phrase => 
      lowerMessage.includes(phrase.toLowerCase())
    );
  }

  /**
   * Manejar el proceso de escalamiento
   */
  private async handleEscalation(from: string, phone_number_id: string, botMessage: string | undefined): Promise<void> {
    // Si no hay mensaje, usar un valor por defecto
    const escalationReason = botMessage || "Indicación de escalamiento detectada";

    // Verificar si la conversación ya está escalada para evitar duplicación
    const existingConversation = this.conversations.get(from);
    if (existingConversation && existingConversation.isEscalated) {
      logger.debug(`Conversación ${from} ya está escalada, ignorando nueva solicitud`);
      return;
    }

    // Actualizar estado de la conversación
    await this.updateConversationStatus(from, true);
    
    // Obtener la conversación para usar su ID del sistema
    const conversation = this.conversations.get(from);
    if (!conversation) {
      logger.error(`No se encontró conversación para ${from} al intentar escalar`);
      return;
    }
    
    // Verificación de escalamiento en BD para atomicidad
    try {
      const db = await initDatabaseConnection();
      const dbConversation = db.prepare(
        `SELECT isEscalated FROM conversations WHERE conversationId = ?`
      ).get(conversation.conversationId);
      
      // Verificación extra para evitar duplicación con otros procesos
      if (dbConversation && dbConversation.isEscalated === 1) {
        logger.debug(`Conversación ${conversation.conversationId} ya escalada según BD, evitando duplicación`);
        return;
      }
    } catch (error) {
      logger.error(`Error al verificar estado de escalación en BD: ${conversation.conversationId}`, { error });
      // Continuar a pesar del error
    }
    
    try {
      // Enviar mensaje de confirmación al usuario
      const escalationMsg = "Tu conversación ha sido transferida a un agente. Pronto te atenderán.";
      
      // CORRECCIÓN: Usar phone_number_id como emisor y from como destinatario
      await this.whatsappService.sendMessage(
        phone_number_id,  // ID del número de WhatsApp Business
        from,  // Número del usuario destinatario
        escalationMsg
      );
      
      // Guardar mensaje de sistema en la base de datos con ID del sistema
      await this.saveMessage(conversation.conversationId, 'system', escalationMsg);
      
      // Guardar mensaje del bot que provocó la escalación si no lo hicimos ya
      // Solo si es diferente al mensaje de confirmación y no es undefined
      if (botMessage && botMessage !== escalationMsg) {
        const db = await initDatabaseConnection();
        
        // Verificar si ya guardamos este mensaje para evitar duplicados
        const existingBotMessage = db.prepare(
          'SELECT id FROM messages WHERE conversationId = ? AND from_type = ? AND text = ? LIMIT 1'
        ).get(conversation.conversationId, 'bot', botMessage);
        
        if (!existingBotMessage) {
          await this.saveMessage(conversation.conversationId, 'bot', botMessage);
        }
      }
      
      logger.info(`Conversación escalada correctamente: ${from}`);
      
      // Añadir a la cola de agentes con toda la información necesaria
      await this.queueService.addToQueue({
        conversationId: conversation.conversationId,
        from,
        phone_number_id,
        assignedAgent: null,
        metadata: {
          escalationReason,
          customFields: {
            hasFullHistory: true
          }
        }
      });
      
      logger.info(`Conversación escalada a agente: ${from}`);
    } catch (error) {
      logger.error(`Error en proceso de escalación para ${from}:`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      
      // Intentar restaurar estado si falló el escalamiento
      try {
        await this.updateConversationStatus(from, false);
      } catch (restoreError) {
        logger.error(`Error al restaurar estado tras fallo de escalación: ${from}`, { error: restoreError });
      }
    }
  }

  /**
   * Verificar si una conversación está escalada
   */
  public isEscalated(from: string): boolean {
    const conversation = this.conversations.get(from);
    return conversation ? conversation.isEscalated : false;
  }

  /**
   * Actualizar estado de escalamiento de una conversación
   */
  public async updateConversationStatus(from: string, isEscalated: boolean): Promise<void> {
    const conversation = this.conversations.get(from);
    
    if (conversation) {
      // Actualizar en memoria
      conversation.isEscalated = isEscalated;
      conversation.status = isEscalated ? ConversationStatus.WAITING : ConversationStatus.BOT;
      conversation.lastActivity = Date.now();
      
      // Actualizar en base de datos
      try {
        const db = await initDatabaseConnection();
        db.prepare(
          `UPDATE conversations 
           SET isEscalated = ?, status = ?, lastActivity = ? 
           WHERE conversationId = ?`
        ).run(
          isEscalated ? 1 : 0,
          conversation.status,
          conversation.lastActivity,
          conversation.conversationId
        );
        
        logger.info(`Estado de conversación actualizado: ${from}, escalada: ${isEscalated}`);
      } catch (error) {
        logger.error(`Error al actualizar estado de conversación: ${from}`, { error });
        // Revertir cambio en memoria si falla la BD para consistencia
        conversation.isEscalated = !isEscalated;
        conversation.status = !isEscalated ? ConversationStatus.WAITING : ConversationStatus.BOT;
        throw error;
      }
    }
  }

  /**
   * Finalizar conversación con agente y volver al bot con transacción
   */
  public async completeAgentConversation(conversationId: string): Promise<boolean> {
    // Buscar conversación por ID o por número
    let conversation: ConversationData | undefined;
    let fromNumber: string | undefined;
    
    // Primero intentar buscar por conversationId directamente
    for (const [from, conv] of this.conversations.entries()) {
      if (conv.conversationId === conversationId) {
        conversation = conv;
        fromNumber = from;
        break;
      }
    }
    
    // Si no encontramos por conversationId, intentar buscar como si el conversationId fuera un número de teléfono
    if (!conversation && !fromNumber) {
      conversation = this.conversations.get(conversationId);
      if (conversation) {
        fromNumber = conversationId;
      }
    }
    
    // Si no encontramos por ninguno de los métodos anteriores, buscar directamente en la BD
    if (!conversation || !fromNumber) {
      try {
        const db = await initDatabaseConnection();
        const dbConversation = db.prepare(
          'SELECT * FROM conversations WHERE conversationId = ?'
        ).get(conversationId);
        
        if (dbConversation) {
          // Si la encontramos en BD, reconstruir objeto temporal
          conversation = {
            conversationId: dbConversation.conversationId,
            token: dbConversation.token,
            tokenTimestamp: dbConversation.tokenTimestamp,
            phone_number_id: dbConversation.phone_number_id,
            from: dbConversation.from_number,
            isEscalated: dbConversation.isEscalated === 1,
            lastActivity: dbConversation.lastActivity,
            status: dbConversation.status as ConversationStatus
          };
          fromNumber = dbConversation.from_number;
          
          logger.info(`Conversación ${conversationId} recuperada de BD para completar: fromNumber=${fromNumber}`);
        } else {
          logger.warn(`No se pudo encontrar la conversación ${conversationId} en BD`);
        }
      } catch (error) {
        logger.error(`Error al buscar conversación ${conversationId} en BD`, { error });
      }
    }
    
    // Si todavía no tenemos los datos necesarios, no podemos continuar
    if (!conversation || !fromNumber) {
      logger.warn(`No se puede completar la conversación ${conversationId}: datos insuficientes`);
      return false;
    }
    
    // Guardar info importante para envío de mensaje aunque se limpie de memoria
    const phoneNumberId = conversation.phone_number_id;
    const userPhoneNumber = conversation.from;
    const convId = conversation.conversationId;
    
    // Verificar que tenemos los datos mínimos para mensaje
    if (!phoneNumberId || !userPhoneNumber) {
      logger.error(`Datos incompletos para enviar mensaje de finalización: phoneNumberId=${phoneNumberId}, userNumber=${userPhoneNumber}`);
      return false;
    }
    
    try {
      // 1. PRIMER PASO: ACTUALIZAR BD CON TRANSACCIÓN
      // IMPORTANTE: Primero actualizamos para evitar condiciones de carrera
      const db = await initDatabaseConnection();
      
      // TRANSACCIÓN: Iniciar
      db.prepare('BEGIN TRANSACTION').run();
      
      try {
        // Verificar si ya está completada
        const currentStatus = db.prepare(
          'SELECT status FROM conversations WHERE conversationId = ?'
        ).get(convId);
        
        if (currentStatus && currentStatus.status === ConversationStatus.COMPLETED) {
          logger.info(`Conversación ${convId} ya estaba marcada como completada en BD`);
          db.prepare('ROLLBACK').run(); // No hacer cambios
        } else {
          // Actualizar estado a completada
          db.prepare(
            'UPDATE conversations SET status = ?, isEscalated = 0, lastActivity = ? WHERE conversationId = ?'
          ).run(ConversationStatus.COMPLETED, Date.now(), convId);
          
          // Eliminar de la cola en BD por si acaso
          db.prepare('DELETE FROM queue WHERE conversationId = ?').run(convId);
          
          // Commit transacción
          db.prepare('COMMIT').run();
          
          logger.info(`Transacción completada: Conversación ${convId} marcada como completada en BD`);
        }
      } catch (dbError) {
        // Rollback en caso de error
        db.prepare('ROLLBACK').run();
        logger.error(`Error en transacción, rollback aplicado: ${convId}`, { error: dbError });
        throw dbError; // Re-lanzar para manejo superior
      }
      
      // 2. SEGUNDO PASO: ELIMINAR DE COLA
      // Inicializar queueService para acceder a los métodos
      const queueService = initQueueService();
      
      // Eliminar de la cola si estaba ahí
      await queueService.completeConversation(convId);
      
      // 3. TERCER PASO: ENVIAR MENSAJE
      const completionMessage = "La conversación con el agente ha finalizado. ¿En qué más puedo ayudarte?";
      
      logger.info(`Enviando mensaje de finalización a ${userPhoneNumber} vía ${phoneNumberId}`);
      
      try {
        // Usar nuestro servicio de WhatsApp directamente
        const whatsappService = new WhatsAppService();
        
        const messageSent = await whatsappService.sendMessage(
          phoneNumberId,
          userPhoneNumber,
          completionMessage
        );
        
        if (messageSent) {
          logger.info(`Mensaje de finalización enviado exitosamente a ${userPhoneNumber}`);
          
          // Intentar guardar mensaje en la base de datos
          try {
            await this.saveMessage(convId, 'system', completionMessage);
            logger.debug(`Mensaje de finalización guardado en BD para ${convId}`);
          } catch (saveError) {
            logger.warn(`No se pudo guardar mensaje de finalización en BD: ${convId}`, { error: saveError });
            // Continuar aunque falle el guardado
          }
        } else {
          logger.error(`Error al enviar mensaje de finalización a ${userPhoneNumber}`);
        }
      } catch (msgError) {
        logger.error(`Excepción al enviar mensaje de finalización a ${userPhoneNumber}`, { 
          error: msgError instanceof Error ? msgError.message : String(msgError)
        });
        // Continuar con el proceso a pesar del error (ya actualizamos BD)
      }
      
      // 4. CUARTO PASO: ACTUALIZAR EN MEMORIA Y LIMPIAR
      // Actualizar estado en memoria antes de eliminar
      if (conversation) {
        conversation.status = ConversationStatus.COMPLETED;
      }
      
      // Eliminar de memoria
      if (this.conversations.has(fromNumber)) {
        // Cerrar WebSocket si existe
        if (conversation.wsConnection) {
          try {
            conversation.wsConnection.close();
          } catch (wsError) {
            logger.warn(`Error al cerrar WebSocket para ${fromNumber}:`, { error: wsError });
          }
        }
        
        this.conversations.delete(fromNumber);
        logger.info(`Conversación eliminada de la memoria: ${fromNumber}`);
      }
      
      return true;
    } catch (error) {
      logger.error(`Error general al completar conversación ${conversationId}`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined 
      });
      
      // Intentar limpiar memoria aunque haya error
      if (fromNumber && this.conversations.has(fromNumber)) {
        this.conversations.delete(fromNumber);
        logger.info(`Conversación eliminada de la memoria a pesar del error: ${fromNumber}`);
      }
      
      return false;
    }
  }

  /**
   * Limpiar conversaciones inactivas (24 horas)
   */
  private async cleanupInactiveConversations(): Promise<void> {
    const now = Date.now();
    
    for (const [from, conversation] of this.conversations.entries()) {
      if (now - conversation.lastActivity > INACTIVE_TIMEOUT_MS) {
        logger.info(`Cerrando conversación inactiva (24h): ${from}`);
        
        // Cerrar WebSocket si existe
        if (conversation.wsConnection) {
          try {
            conversation.wsConnection.close();
          } catch (error) {
            logger.error(`Error al cerrar WebSocket para ${from}:`, { error });
          }
        }
        
        // Si estaba escalada, completar en la cola de agentes
        if (conversation.isEscalated) {
          await this.queueService.completeConversation(conversation.conversationId);
        }
        
        // Usar transacción para actualizar BD
        try {
          const db = await initDatabaseConnection();
          
          // Iniciar transacción
          db.prepare('BEGIN TRANSACTION').run();
          
          try {
            // Marcar como completada
            db.prepare(
              `UPDATE conversations SET status = ?, lastActivity = ? WHERE conversationId = ?`
            ).run(ConversationStatus.COMPLETED, now, conversation.conversationId);
            
            // Si estaba en cola, eliminar
            if (conversation.isEscalated) {
              db.prepare('DELETE FROM queue WHERE conversationId = ?').run(conversation.conversationId);
            }
            
            // Commit
            db.prepare('COMMIT').run();
            
            logger.info(`BD actualizada: conversación ${conversation.conversationId} marcada como completada por inactividad`);
          } catch (txError) {
            // Rollback en caso de error
            db.prepare('ROLLBACK').run();
            throw txError;
          }
          
          // Enviar mensaje al usuario sobre cierre por inactividad
          try {
            const timeoutMessage = "Tu conversación ha sido cerrada automáticamente debido a inactividad (24 horas). Si necesitas ayuda nuevamente, envía un nuevo mensaje.";
            
            await this.whatsappService.sendMessage(
              conversation.phone_number_id,
              from,
              timeoutMessage
            );
            
            // Guardar mensaje de sistema en la base de datos
            await this.saveMessage(conversation.conversationId, 'system', timeoutMessage);
          } catch (msgError) {
            logger.error(`Error al enviar mensaje de cierre por inactividad: ${from}`, { error: msgError });
            // Continuar a pesar del error
          }
        } catch (error) {
          logger.error(`Error al marcar conversación como completada: ${from}`, { error });
        }
        
        // Eliminar de la memoria
        this.conversations.delete(from);
        logger.info(`Conversación ${from} eliminada de memoria por inactividad`);
      }
    }
    
    logger.info('Limpieza de conversaciones inactivas completada');
  }
}

// Singleton
let conversationServiceInstance: ConversationService | null = null;

export function initConversationService(): ConversationService {
  if (!conversationServiceInstance) {
    conversationServiceInstance = new ConversationService();
  }
  return conversationServiceInstance;
}

export default initConversationService;