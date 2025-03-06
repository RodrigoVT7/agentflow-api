// src/websocket/handlers.ts
import WebSocket from 'ws';
import { WebSocketService } from './server';
import { initQueueService } from '../services/queue.service';
import { initNotificationService } from '../services/notification.service';
import { AgentStatus } from '../models/agent.model';
import logger from '../utils/logger';
import { MessageSender } from '../models/message.model';
import { initAgentService } from '../services/agent.service';

// Servicios
const queueService = initQueueService();
const notificationService = initNotificationService();
const agentService = initAgentService();

/**
 * Manejar conexión WebSocket de un agente
 */
export function handleAgentConnection(ws: WebSocket, agentId: string, wsService: WebSocketService): void {
  // Enviar estado inicial
  sendInitialState(ws, agentId);
  
  // Configurar manejador de mensajes
  ws.on('message', (message: WebSocket.Data) => {
    try {
      const data = JSON.parse(message.toString());
      handleAgentMessage(data, agentId, wsService, ws);
    } catch (error) {
      logger.error(`Error al procesar mensaje WebSocket del agente ${agentId}`, { error, message: message.toString() });
      
      wsService.sendToSocket(ws, 'error', {
        message: 'Formato de mensaje inválido',
        originalMessage: message.toString().substring(0, 100) // Truncar por seguridad
      });
    }
  });
}

/**
 * Enviar estado inicial al agente que se conecta
 */
function sendInitialState(ws: WebSocket, agentId: string): void {
  try {
    // Enviar cola actual
    const queue = queueService.getQueue();
    
    // Buscar conversaciones asignadas a este agente
    const assignedConversations = queue.filter(item => item.assignedAgent === agentId);
    
    // Enviar datos iniciales
    ws.send(JSON.stringify({
      type: 'initial:state',
      payload: {
        queue,
        assignedConversations,
        timestamp: Date.now()
      }
    }));
    
    logger.debug(`Estado inicial enviado al agente ${agentId}`);
  } catch (error) {
    logger.error(`Error al enviar estado inicial al agente ${agentId}`, { error });
  }
}

/**
 * Manejar mensaje recibido de un agente
 */
function handleAgentMessage(
  data: any, 
  agentId: string, 
  wsService: WebSocketService,
  ws: WebSocket
): void {
  const { type, payload } = data;
  
  if (!type || !payload) {
    wsService.sendToSocket(ws, 'error', {
      message: 'Formato de mensaje inválido: se requieren type y payload',
      timestamp: Date.now()
    });
    return;
  }
  
  logger.debug(`Mensaje recibido del agente ${agentId}: ${type}`, { payload });
  
  // Manejar diferentes tipos de mensajes
  switch (type) {
    case 'ping':
      // Simple ping-pong para verificar conexión
      wsService.sendToSocket(ws, 'pong', { timestamp: Date.now() });
      break;
    
    case 'agent:status':
      // Actualizar estado del agente
      handleAgentStatusUpdate(agentId, payload.status, wsService);
      break;
    
    case 'conversation:request':
      // Solicitar detalles de una conversación
      handleConversationRequest(agentId, payload.conversationId, wsService);
      break;
    
    case 'conversation:assign':
      // Asignar conversación a este agente
      handleConversationAssign(agentId, payload.conversationId, wsService);
      break;
    
    case 'message:send':
      // Enviar mensaje a una conversación
      handleMessageSend(agentId, payload.conversationId, payload.message, wsService);
      break;
    
    case 'conversation:complete':
      // Finalizar conversación
      handleConversationComplete(agentId, payload.conversationId, wsService);
      break;
    
    case 'queue:request':
      // Solicitar lista actualizada de la cola
      handleQueueRequest(agentId, wsService);
      break;
    
    default:
      wsService.sendToSocket(ws, 'error', {
        message: `Tipo de mensaje no soportado: ${type}`,
        timestamp: Date.now()
      });
  }
}

/**
 * Manejar actualización de estado de agente
 */
function handleAgentStatusUpdate(
  agentId: string,
  status: string,
  wsService: WebSocketService
): void {
  // Verificar que el estado es válido
  if (!Object.values(AgentStatus).includes(status as AgentStatus)) {
    wsService.sendToAgent(agentId, 'error', {
      message: `Estado no válido: ${status}`,
      timestamp: Date.now()
    });
    return;
  }
  
  // Actualizar el estado del agente en el servicio
  const agent = agentService.getAgentWithPasswordById(agentId);
  if (agent) {
    // Actualizar estado
    const updatedAgent = {
      ...agent,
      status: status as AgentStatus,
      lastActivity: Date.now()
    };
    
    agentService.setAgent(updatedAgent);
    
    wsService.sendToAgent(agentId, 'agent:status:updated', {
      status,
      timestamp: Date.now()
    });
    
    logger.info(`Estado del agente ${agentId} actualizado a ${status}`);
  } else {
    wsService.sendToAgent(agentId, 'error', {
      message: 'Agente no encontrado',
      timestamp: Date.now()
    });
  }
}

/**
 * Manejar solicitud de detalles de conversación
 */
function handleConversationRequest(
  agentId: string,
  conversationId: string,
  wsService: WebSocketService
): void {
  try {
    // Obtener conversación
    const conversation = queueService.getConversation(conversationId);
    
    if (!conversation) {
      wsService.sendToAgent(agentId, 'error', {
        message: `Conversación no encontrada: ${conversationId}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Verificar si la conversación está asignada a otro agente
    if (conversation.assignedAgent && conversation.assignedAgent !== agentId) {
      wsService.sendToAgent(agentId, 'error', {
        message: `Conversación asignada a otro agente: ${conversation.assignedAgent}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Enviar detalles de la conversación
    wsService.sendToAgent(agentId, 'conversation:details', {
      conversation,
      timestamp: Date.now()
    });
    
    logger.debug(`Detalles de conversación ${conversationId} enviados al agente ${agentId}`);
  } catch (error) {
    logger.error(`Error al procesar solicitud de conversación ${conversationId} para agente ${agentId}`, { error });
    
    wsService.sendToAgent(agentId, 'error', {
      message: 'Error al obtener detalles de la conversación',
      timestamp: Date.now()
    });
  }
}

/**
 * Manejar asignación de conversación
 */
function handleConversationAssign(
  agentId: string,
  conversationId: string,
  wsService: WebSocketService
): void {
  try {
    // Verificar si la conversación existe
    const conversation = queueService.getConversation(conversationId);
    
    if (!conversation) {
      wsService.sendToAgent(agentId, 'error', {
        message: `Conversación no encontrada: ${conversationId}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Verificar si ya está asignada a otro agente
    if (conversation.assignedAgent && conversation.assignedAgent !== agentId) {
      wsService.sendToAgent(agentId, 'error', {
        message: `Conversación ya asignada a otro agente: ${conversation.assignedAgent}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Asignar agente
    const success = queueService.assignAgent(conversationId, agentId);
    
    if (!success) {
      wsService.sendToAgent(agentId, 'error', {
        message: `No se pudo asignar la conversación ${conversationId}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Obtener conversación actualizada
    const updatedConversation = queueService.getConversation(conversationId);
    
    // Actualizar estado del agente
    const agent = agentService.getAgentWithPasswordById(agentId);
    if (agent) {
      const updatedAgent = {
        ...agent,
        activeConversations: [...agent.activeConversations, conversationId],
        status: agent.activeConversations.length + 1 >= agent.maxConcurrentChats 
          ? AgentStatus.BUSY 
          : AgentStatus.ONLINE,
        lastActivity: Date.now()
      };
      
      agentService.setAgent(updatedAgent);
    }
    
    // Notificar al agente
    wsService.sendToAgent(agentId, 'conversation:assigned', {
      conversation: updatedConversation,
      timestamp: Date.now()
    });
    
    // Notificar a todos los agentes que la cola ha cambiado
    wsService.broadcastToAgents('queue:updated', queueService.getQueue());
    
    // Notificar mediante el servicio de notificaciones
    if (updatedConversation) {
      notificationService.notifyConversationAssigned(updatedConversation, agentId);
    }
    
    logger.info(`Conversación ${conversationId} asignada al agente ${agentId}`);
  } catch (error) {
    logger.error(`Error al asignar conversación ${conversationId} al agente ${agentId}`, { error });
    
    wsService.sendToAgent(agentId, 'error', {
      message: 'Error al asignar la conversación',
      timestamp: Date.now()
    });
  }
}

/**
 * Manejar envío de mensaje
 */
function handleMessageSend(
  agentId: string,
  conversationId: string,
  message: string,
  wsService: WebSocketService
): void {
  try {
    // Verificar mensaje
    if (!message || typeof message !== 'string' || message.trim() === '') {
      wsService.sendToAgent(agentId, 'error', {
        message: 'El mensaje no puede estar vacío',
        timestamp: Date.now()
      });
      return;
    }
    
    // Verificar conversación
    const conversation = queueService.getConversation(conversationId);
    
    if (!conversation) {
      wsService.sendToAgent(agentId, 'error', {
        message: `Conversación no encontrada: ${conversationId}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Verificar asignación
    if (conversation.assignedAgent !== agentId) {
      wsService.sendToAgent(agentId, 'error', {
        message: 'No estás asignado a esta conversación',
        timestamp: Date.now()
      });
      return;
    }
    
    // Añadir mensaje a la conversación
    const newMessage = queueService.addMessage(conversationId, {
      from: 'agent' as MessageSender,
      text: message,
      agentId
    });
    
    if (!newMessage) {
      wsService.sendToAgent(agentId, 'error', {
        message: 'Error al añadir mensaje a la conversación',
        timestamp: Date.now()
      });
      return;
    }
    
    // En una implementación real, aquí enviaríamos el mensaje a WhatsApp
    // a través del servicio correspondiente
    
    // Notificar al agente que el mensaje fue enviado
    wsService.sendToAgent(agentId, 'message:sent', {
      message: newMessage,
      conversationId,
      timestamp: Date.now()
    });
    
    // Obtener conversación actualizada
    const updatedConversation = queueService.getConversation(conversationId);
    
    // Actualizar última actividad del agente
    const agent = agentService.getAgentWithPasswordById(agentId);
    if (agent) {
      const updatedAgent = {
        ...agent,
        lastActivity: Date.now()
      };
      
      agentService.setAgent(updatedAgent);
    }
    
    // Notificar actualización de la conversación
    if (updatedConversation) {
      wsService.sendToAgent(agentId, 'conversation:updated', {
        conversation: updatedConversation,
        timestamp: Date.now()
      });
    }
    
    logger.info(`Mensaje enviado a conversación ${conversationId} por agente ${agentId}`);
  } catch (error) {
    logger.error(`Error al enviar mensaje a conversación ${conversationId} por agente ${agentId}`, { error });
    
    wsService.sendToAgent(agentId, 'error', {
      message: 'Error al enviar mensaje',
      timestamp: Date.now()
    });
  }
}

/**
 * Manejar finalización de conversación
 */
function handleConversationComplete(
  agentId: string,
  conversationId: string,
  wsService: WebSocketService
): void {
  try {
    // Verificar conversación
    const conversation = queueService.getConversation(conversationId);
    
    if (!conversation) {
      wsService.sendToAgent(agentId, 'error', {
        message: `Conversación no encontrada: ${conversationId}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Verificar asignación
    if (conversation.assignedAgent !== agentId) {
      wsService.sendToAgent(agentId, 'error', {
        message: 'No estás asignado a esta conversación',
        timestamp: Date.now()
      });
      return;
    }
    
    // Actualizar estado del agente
    const agent = agentService.getAgentWithPasswordById(agentId);
    if (agent) {
      const updatedAgent = {
        ...agent,
        activeConversations: agent.activeConversations.filter(id => id !== conversationId),
        status: agent.activeConversations.length <= 1 ? AgentStatus.ONLINE : AgentStatus.BUSY,
        lastActivity: Date.now()
      };
      
      agentService.setAgent(updatedAgent);
    }
    
    // Completar conversación
    const success = queueService.completeConversation(conversationId);
    
    if (!success) {
      wsService.sendToAgent(agentId, 'error', {
        message: `No se pudo completar la conversación ${conversationId}`,
        timestamp: Date.now()
      });
      return;
    }
    
    // Notificar al agente
    wsService.sendToAgent(agentId, 'conversation:completed', {
      conversationId,
      timestamp: Date.now()
    });
    
    // Notificar a todos los agentes que la cola ha cambiado
    wsService.broadcastToAgents('queue:updated', queueService.getQueue());
    
    logger.info(`Conversación ${conversationId} completada por agente ${agentId}`);
  } catch (error) {
    logger.error(`Error al completar conversación ${conversationId} por agente ${agentId}`, { error });
    
    wsService.sendToAgent(agentId, 'error', {
      message: 'Error al completar la conversación',
      timestamp: Date.now()
    });
  }
}

/**
 * Manejar solicitud de cola actualizada
 */
function handleQueueRequest(agentId: string, wsService: WebSocketService): void {
  try {
    // Obtener cola actualizada
    const queue = queueService.getQueue();
    
    // Enviar cola al agente
    wsService.sendToAgent(agentId, 'queue:updated', queue);
    
    logger.debug(`Cola actualizada enviada al agente ${agentId}`);
  } catch (error) {
    logger.error(`Error al enviar cola actualizada al agente ${agentId}`, { error });
    
    wsService.sendToAgent(agentId, 'error', {
      message: 'Error al obtener cola actualizada',
      timestamp: Date.now()
    });
  }
}