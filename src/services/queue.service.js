"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initQueueService = initQueueService;
// src/services/queue.service.ts
const events_1 = require("events");
const message_model_1 = require("../models/message.model");
const queue_repository_1 = require("../database/repositories/queue.repository");
const message_repository_1 = require("../database/repositories/message.repository");
const logger_1 = __importDefault(require("../utils/logger"));
class QueueService {
    constructor() {
        this.agentQueues = new Map();
        this.events = new events_1.EventEmitter();
        this.queueRepository = new queue_repository_1.QueueRepository();
        this.messageRepository = new message_repository_1.MessageRepository();
        // Cargar estado inicial
        this.loadInitialState();
        // Configurar guardado periódico
        setInterval(() => this.saveQueueState(), 5 * 60 * 1000); // cada 5 minutos
    }
    /**
     * Cargar estado inicial de la cola desde la base de datos
     */
    loadInitialState() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Cargar conversaciones en cola
                const queueItems = yield this.queueRepository.findAll();
                // Llenar el mapa en memoria
                for (const item of queueItems) {
                    // Cargar los mensajes asociados a esta conversación
                    const messages = yield this.messageRepository.findByConversation(item.conversationId);
                    // Actualizar con los mensajes más recientes
                    const queueItemWithMessages = Object.assign(Object.assign({}, item), { messages: messages || [] });
                    this.agentQueues.set(item.conversationId, queueItemWithMessages);
                }
                logger_1.default.info(`Cargadas ${this.agentQueues.size} conversaciones en cola desde la base de datos`);
            }
            catch (error) {
                logger_1.default.error('Error al cargar estado inicial de cola', { error });
            }
        });
    }
    /**
     * Guardar estado actual en la base de datos
     */
    saveQueueState() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const updatePromises = [];
                for (const [id, item] of this.agentQueues.entries()) {
                    // No guardar los mensajes en la tabla de cola para evitar duplicación
                    const { messages } = item, queueItemWithoutMessages = __rest(item, ["messages"]);
                    // Actualizar o crear en la base de datos
                    updatePromises.push(this.queueRepository.update(id, queueItemWithoutMessages)
                        .then(updated => {
                        if (!updated) {
                            // Si no existe, crear nuevo
                            return this.queueRepository.create(queueItemWithoutMessages);
                        }
                        return updated;
                    }));
                }
                yield Promise.all(updatePromises);
                logger_1.default.info(`Estado de cola guardado en base de datos (${this.agentQueues.size} conversaciones)`);
            }
            catch (error) {
                logger_1.default.error('Error al guardar estado de cola', { error });
            }
        });
    }
    /**
     * Añadir una conversación a la cola de espera
     */
    addToQueue(queueItem) {
        return __awaiter(this, void 0, void 0, function* () {
            const newQueueItem = Object.assign(Object.assign({}, queueItem), { startTime: Date.now(), messages: [], priority: 1, tags: [], metadata: queueItem.metadata || {} });
            // Guardar en memoria
            this.agentQueues.set(queueItem.conversationId, newQueueItem);
            // Guardar en base de datos
            yield this.queueRepository.create(newQueueItem);
            // Notificar a los agentes disponibles
            this.notifyQueueUpdated();
            logger_1.default.info(`Nueva conversación añadida a la cola: ${queueItem.conversationId}`);
            return newQueueItem;
        });
    }
    /**
     * Asignar un agente a una conversación
     */
    assignAgent(conversationId, agentId) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueItem = this.agentQueues.get(conversationId);
            if (!queueItem) {
                logger_1.default.warn(`Intento de asignar agente a conversación inexistente: ${conversationId}`);
                return false;
            }
            // Si ya está asignado a otro agente, no permitir reasignación
            if (queueItem.assignedAgent && queueItem.assignedAgent !== agentId) {
                logger_1.default.warn(`Conversación ${conversationId} ya asignada a ${queueItem.assignedAgent}, intento de asignación a ${agentId}`);
                return false;
            }
            // Actualizar en memoria
            queueItem.assignedAgent = agentId;
            // Actualizar en base de datos
            yield this.queueRepository.update(conversationId, { assignedAgent: agentId });
            // Añadir mensaje de sistema
            yield this.addSystemMessage(conversationId, `Agente ${agentId} se ha unido a la conversación`);
            // Notificar actualización
            this.notifyQueueUpdated();
            this.notifyConversationUpdated(conversationId);
            logger_1.default.info(`Conversación ${conversationId} asignada al agente ${agentId}`);
            return true;
        });
    }
    /**
     * Finalizar una conversación y eliminarla de la cola
     */
    completeConversation(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.agentQueues.has(conversationId)) {
                logger_1.default.warn(`Intento de completar conversación inexistente: ${conversationId}`);
                return false;
            }
            // Obtener la conversación antes de eliminarla
            const conversation = this.agentQueues.get(conversationId);
            // Eliminar de la memoria
            this.agentQueues.delete(conversationId);
            // Eliminar de la base de datos
            yield this.queueRepository.delete(conversationId);
            // No eliminamos los mensajes de la base de datos para mantener historial
            // Notificar actualización
            this.notifyQueueUpdated();
            logger_1.default.info(`Conversación ${conversationId} completada y eliminada de la cola`);
            // Emitir evento de conversación completada con datos para análisis
            if (conversation) {
                this.events.emit('conversation:completed', {
                    conversationId,
                    startTime: conversation.startTime,
                    endTime: Date.now(),
                    messageCount: conversation.messages.length,
                    assignedAgent: conversation.assignedAgent
                });
            }
            return true;
        });
    }
    /**
     * Añadir un mensaje a una conversación
     */
    addMessage(conversationId, message) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueItem = this.agentQueues.get(conversationId);
            if (!queueItem) {
                logger_1.default.warn(`Intento de añadir mensaje a conversación inexistente: ${conversationId}`);
                return null;
            }
            const newMessage = Object.assign(Object.assign({ id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, conversationId }, message), { timestamp: Date.now() });
            // Añadir a memoria
            queueItem.messages.push(newMessage);
            // Guardar en base de datos
            yield this.messageRepository.create(newMessage);
            // Notificar actualización
            this.notifyConversationUpdated(conversationId);
            // Emitir evento de nuevo mensaje
            this.events.emit('message:added', newMessage);
            logger_1.default.debug(`Nuevo mensaje añadido a conversación ${conversationId}`, {
                from: newMessage.from,
                messageId: newMessage.id
            });
            return newMessage;
        });
    }
    /**
     * Añadir un mensaje de sistema a una conversación
     */
    addSystemMessage(conversationId, text) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.addMessage(conversationId, {
                from: message_model_1.MessageSender.SYSTEM,
                text
            });
        });
    }
    /**
     * Obtener todas las conversaciones en cola
     */
    getQueue() {
        return Array.from(this.agentQueues.values());
    }
    /**
     * Obtener una conversación específica
     */
    getConversation(conversationId) {
        return this.agentQueues.get(conversationId);
    }
    /**
     * Obtener mensajes de una conversación
     */
    getMessages(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            // Primero intentar desde memoria
            const queueItem = this.agentQueues.get(conversationId);
            if (queueItem) {
                return queueItem.messages;
            }
            // Si no está en memoria, buscar en la base de datos
            return this.messageRepository.findByConversation(conversationId);
        });
    }
    /**
     * Actualizar prioridad de una conversación
     */
    updatePriority(conversationId, priority) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueItem = this.agentQueues.get(conversationId);
            if (!queueItem) {
                logger_1.default.warn(`Intento de actualizar prioridad de conversación inexistente: ${conversationId}`);
                return false;
            }
            // Validar prioridad
            if (priority < 1 || priority > 5) {
                logger_1.default.warn(`Valor de prioridad inválido: ${priority}`);
                return false;
            }
            // Actualizar en memoria
            queueItem.priority = priority;
            // Actualizar en base de datos
            yield this.queueRepository.update(conversationId, { priority });
            // Añadir mensaje de sistema si la prioridad es alta
            if (priority >= 3) {
                yield this.addSystemMessage(conversationId, `Prioridad actualizada a ${priority} (${priority >= 4 ? 'Urgente' : 'Alta'})`);
            }
            // Notificar actualización
            this.notifyQueueUpdated();
            logger_1.default.info(`Prioridad de conversación ${conversationId} actualizada a ${priority}`);
            return true;
        });
    }
    /**
     * Añadir o eliminar tags de una conversación
     */
    updateTags(conversationId, tags) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueItem = this.agentQueues.get(conversationId);
            if (!queueItem) {
                logger_1.default.warn(`Intento de actualizar tags de conversación inexistente: ${conversationId}`);
                return false;
            }
            // Actualizar en memoria
            queueItem.tags = tags;
            // Actualizar en base de datos
            yield this.queueRepository.update(conversationId, { tags });
            // Notificar actualización
            this.notifyQueueUpdated();
            logger_1.default.info(`Tags de conversación ${conversationId} actualizados: ${tags.join(', ')}`);
            return true;
        });
    }
    /**
     * Actualizar metadatos de una conversación
     */
    updateMetadata(conversationId, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueItem = this.agentQueues.get(conversationId);
            if (!queueItem) {
                logger_1.default.warn(`Intento de actualizar metadata de conversación inexistente: ${conversationId}`);
                return false;
            }
            // Actualizar en memoria
            queueItem.metadata = Object.assign(Object.assign({}, queueItem.metadata), metadata);
            // Actualizar en base de datos
            yield this.queueRepository.update(conversationId, {
                metadata: queueItem.metadata
            });
            logger_1.default.debug(`Metadata de conversación ${conversationId} actualizada`);
            return true;
        });
    }
    /**
     * Obtener conversaciones asignadas a un agente
     */
    getConversationsByAgent(agentId) {
        return __awaiter(this, void 0, void 0, function* () {
            const allConversations = this.getQueue();
            return allConversations.filter(item => item.assignedAgent === agentId);
        });
    }
    /**
     * Obtener conversaciones sin asignar
     */
    getUnassignedConversations() {
        return __awaiter(this, void 0, void 0, function* () {
            const allConversations = this.getQueue();
            return allConversations.filter(item => !item.assignedAgent);
        });
    }
    /**
     * Buscar conversación más antigua sin asignar
     */
    getOldestUnassignedConversation() {
        return __awaiter(this, void 0, void 0, function* () {
            const unassigned = yield this.getUnassignedConversations();
            if (unassigned.length === 0) {
                return null;
            }
            // Ordenar por prioridad (mayor primero) y luego por tiempo (más antiguo primero)
            return unassigned.sort((a, b) => {
                if (a.priority !== b.priority) {
                    return b.priority - a.priority;
                }
                return a.startTime - b.startTime;
            })[0];
        });
    }
    /**
     * Notificar a todos los agentes sobre actualización de la cola
     */
    notifyQueueUpdated() {
        // Emitir evento local
        this.events.emit('queue:updated', this.getQueue());
        // Notificar vía WebSocket si está disponible
        if (this.webSocketService) {
            this.webSocketService.broadcastToAgents('queue:updated', this.getQueue());
        }
    }
    /**
     * Notificar actualización de una conversación específica
     */
    notifyConversationUpdated(conversationId) {
        const conversation = this.getConversation(conversationId);
        if (!conversation)
            return;
        // Emitir evento local
        this.events.emit(`conversation:${conversationId}:updated`, conversation);
        // Notificar al agente asignado vía WebSocket
        if (this.webSocketService && conversation.assignedAgent) {
            this.webSocketService.sendToAgent(conversation.assignedAgent, 'conversation:updated', conversation);
        }
    }
    /**
     * Establecer servicio WebSocket para notificaciones
     */
    setWebSocketService(wsService) {
        this.webSocketService = wsService;
    }
    /**
     * Registrar manejador de eventos
     */
    on(event, listener) {
        this.events.on(event, listener);
    }
    /**
     * Obtener estadísticas de la cola
     */
    getQueueStats() {
        const queue = this.getQueue();
        const unassigned = queue.filter(item => !item.assignedAgent);
        const assigned = queue.filter(item => !!item.assignedAgent);
        // Calcular tiempos promedio
        const now = Date.now();
        const waitTimes = queue.map(item => now - item.startTime);
        const avgWaitTime = waitTimes.length > 0
            ? waitTimes.reduce((sum, time) => sum + time, 0) / waitTimes.length
            : 0;
        // Conversaciones por prioridad
        const byPriority = {
            1: queue.filter(item => item.priority === 1).length,
            2: queue.filter(item => item.priority === 2).length,
            3: queue.filter(item => item.priority === 3).length,
            4: queue.filter(item => item.priority === 4).length,
            5: queue.filter(item => item.priority === 5).length
        };
        return {
            total: queue.length,
            unassigned: unassigned.length,
            assigned: assigned.length,
            avgWaitTimeMs: avgWaitTime,
            byPriority
        };
    }
}
// Singleton para acceso global
let queueServiceInstance = null;
function initQueueService() {
    if (!queueServiceInstance) {
        queueServiceInstance = new QueueService();
    }
    return queueServiceInstance;
}
exports.default = initQueueService;
