"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
exports.initNotificationService = initNotificationService;
const queue_service_1 = require("./queue.service");
const events_1 = require("events");
const logger_1 = __importDefault(require("../utils/logger"));
/**
 * Servicio para gestionar notificaciones y alertas a agentes
 */
class NotificationService {
    constructor() {
        this.queueService = (0, queue_service_1.initQueueService)();
        // Umbrales de tiempo para alertas (en milisegundos)
        this.thresholds = {
            warning: 5 * 60 * 1000, // 5 minutos
            urgent: 15 * 60 * 1000, // 15 minutos
            critical: 30 * 60 * 1000 // 30 minutos
        };
        this.events = new events_1.EventEmitter();
        // Iniciar comprobación periódica de conversaciones en espera
        setInterval(() => this.checkWaitingConversations(), 60 * 1000); // cada minuto
    }
    /**
     * Establecer servicio WebSocket para enviar notificaciones
     */
    setWebSocketService(wsService) {
        this.webSocketService = wsService;
    }
    /**
     * Comprobar conversaciones en espera y enviar alertas
     */
    checkWaitingConversations() {
        const queue = this.queueService.getQueue();
        const now = Date.now();
        // Conversaciones sin asignar
        const unassignedConversations = queue.filter(item => !item.assignedAgent);
        // Agrupar por nivel de urgencia
        const waitingAlerts = {
            warning: [],
            urgent: [],
            critical: []
        };
        unassignedConversations.forEach(item => {
            const waitTime = now - item.startTime;
            if (waitTime >= this.thresholds.critical) {
                waitingAlerts.critical.push(item);
            }
            else if (waitTime >= this.thresholds.urgent) {
                waitingAlerts.urgent.push(item);
            }
            else if (waitTime >= this.thresholds.warning) {
                waitingAlerts.warning.push(item);
            }
        });
        // Enviar notificaciones si hay conversaciones en espera críticas o urgentes
        if (waitingAlerts.critical.length > 0) {
            this.sendAlertToAllAgents('critical', waitingAlerts.critical);
        }
        else if (waitingAlerts.urgent.length > 0) {
            this.sendAlertToAllAgents('urgent', waitingAlerts.urgent);
        }
        // Emitir evento con todas las alertas
        this.events.emit('waiting:alerts', waitingAlerts);
    }
    /**
     * Enviar alerta a todos los agentes conectados
     */
    sendAlertToAllAgents(level, conversations) {
        if (!this.webSocketService) {
            logger_1.default.warn('No se pueden enviar alertas: WebSocketService no configurado');
            return;
        }
        const alert = {
            type: 'waiting_alert',
            level,
            message: this.getAlertMessage(level, conversations.length),
            conversations: conversations.map(conv => ({
                id: conv.conversationId,
                waitTime: Date.now() - conv.startTime,
                from: conv.from
            }))
        };
        this.webSocketService.broadcastToAgents('notification:alert', alert);
        logger_1.default.info(`Alerta de espera ${level} enviada a todos los agentes`, {
            conversationCount: conversations.length
        });
    }
    /**
     * Obtener mensaje para la alerta según nivel y cantidad
     */
    getAlertMessage(level, count) {
        const messages = {
            warning: `Hay ${count} conversación(es) esperando por más de 5 minutos.`,
            urgent: `¡Atención! ${count} conversación(es) lleva(n) más de 15 minutos sin atención.`,
            critical: `¡URGENTE! ${count} conversación(es) lleva(n) más de 30 minutos sin ser atendida(s).`
        };
        return messages[level];
    }
    /**
     * Notificar a un agente sobre un nuevo mensaje
     */
    notifyNewMessage(agentId, conversation, message) {
        if (!this.webSocketService) {
            logger_1.default.warn('No se pueden enviar notificaciones: WebSocketService no configurado');
            return;
        }
        const notification = {
            type: 'new_message',
            conversationId: conversation.conversationId,
            from: message.from,
            timestamp: message.timestamp,
            preview: message.text.substring(0, 50) + (message.text.length > 50 ? '...' : '')
        };
        this.webSocketService.sendToAgent(agentId, 'notification:message', notification);
        logger_1.default.debug(`Notificación de nuevo mensaje enviada a agente ${agentId}`, {
            conversationId: conversation.conversationId
        });
    }
    /**
     * Notificar a todos los agentes sobre una nueva conversación en cola
     */
    notifyNewConversation(conversation) {
        if (!this.webSocketService) {
            logger_1.default.warn('No se pueden enviar notificaciones: WebSocketService no configurado');
            return;
        }
        const notification = {
            type: 'new_conversation',
            conversationId: conversation.conversationId,
            from: conversation.from,
            timestamp: conversation.startTime
        };
        this.webSocketService.broadcastToAgents('notification:new_conversation', notification);
        logger_1.default.info(`Notificación de nueva conversación enviada a todos los agentes`, {
            conversationId: conversation.conversationId
        });
    }
    /**
     * Notificar asignación de conversación
     */
    notifyConversationAssigned(conversation, agentId) {
        if (!this.webSocketService) {
            logger_1.default.warn('No se pueden enviar notificaciones: WebSocketService no configurado');
            return;
        }
        // Notificar a todos los agentes para actualizar la cola
        this.webSocketService.broadcastToAgents('queue:updated', this.queueService.getQueue());
        // Notificar específicamente al agente asignado
        const notification = {
            type: 'conversation_assigned',
            conversationId: conversation.conversationId,
            from: conversation.from,
            timestamp: Date.now()
        };
        this.webSocketService.sendToAgent(agentId, 'notification:assignment', notification);
        logger_1.default.info(`Notificación de asignación enviada a agente ${agentId}`, {
            conversationId: conversation.conversationId
        });
    }
    /**
     * Suscribirse a eventos de notificaciones
     */
    on(event, listener) {
        this.events.on(event, listener);
    }
}
exports.NotificationService = NotificationService;
// Instancia singleton
let notificationServiceInstance = null;
function initNotificationService() {
    if (!notificationServiceInstance) {
        notificationServiceInstance = new NotificationService();
    }
    return notificationServiceInstance;
}
exports.default = initNotificationService;
