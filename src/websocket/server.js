"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketService = void 0;
exports.setupWebSocketServer = setupWebSocketServer;
exports.getWebSocketService = getWebSocketService;
const ws_1 = __importDefault(require("ws"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const url_1 = __importDefault(require("url"));
const handlers_1 = require("./handlers");
const app_config_1 = __importDefault(require("../config/app.config"));
const logger_1 = __importDefault(require("../utils/logger"));
class WebSocketService {
    constructor(server) {
        this.connectedAgents = new Map();
        this.agentSocketMap = new Map();
        this.pingInterval = null;
        this.wss = new ws_1.default.Server({
            server,
            path: '/ws',
            clientTracking: true
        });
        this.setupWebSocketServer();
        this.startPingInterval();
        logger_1.default.info('Servidor WebSocket inicializado');
    }
    /**
     * Configurar servidor WebSocket
     */
    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            try {
                // Verificar token de autenticación
                const parsedUrl = url_1.default.parse(req.url || '', true);
                const token = parsedUrl.query.token;
                if (!token) {
                    logger_1.default.warn('Intento de conexión WebSocket sin token');
                    ws.close(1008, 'Token requerido');
                    return;
                }
                // Verificar token
                let decoded;
                try {
                    decoded = jsonwebtoken_1.default.verify(token, app_config_1.default.auth.jwtSecret);
                }
                catch (error) {
                    logger_1.default.warn('Token WebSocket inválido', { error });
                    ws.close(1008, 'Token inválido');
                    return;
                }
                const agentId = decoded.agentId;
                // Registrar conexión del agente
                this.registerConnection(agentId, ws);
                // Manejar la conexión del agente
                (0, handlers_1.handleAgentConnection)(ws, agentId, this);
                // Manejar cierre de conexión
                ws.on('close', (code, reason) => {
                    const reasonStr = reason instanceof Buffer ? reason.toString() : reason;
                    this.handleDisconnection(ws, agentId, code, reasonStr);
                });
                // Manejar errores
                ws.on('error', (error) => {
                    logger_1.default.error(`Error en WebSocket para agente ${agentId}`, { error });
                });
                // Enviar confirmación de conexión
                this.sendToSocket(ws, 'connection:established', {
                    agentId,
                    timestamp: Date.now()
                });
                logger_1.default.info(`Agente conectado vía WebSocket: ${agentId}`);
            }
            catch (error) {
                logger_1.default.error('Error al procesar conexión WebSocket', { error });
                ws.close(1011, 'Error interno');
            }
        });
        this.wss.on('error', (error) => {
            logger_1.default.error('Error en servidor WebSocket', { error });
        });
    }
    /**
     * Registrar conexión de agente
     */
    registerConnection(agentId, ws) {
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
    handleDisconnection(ws, agentId, code, reason) {
        this.connectedAgents.delete(agentId);
        this.agentSocketMap.delete(ws);
        logger_1.default.info(`Agente desconectado: ${agentId}`, { code, reason: reason.toString() });
    }
    /**
     * Iniciar intervalo de ping para mantener conexiones activas
     */
    startPingInterval() {
        // Cancelar intervalo existente si lo hay
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        // Enviar ping cada 30 segundos para mantener conexiones activas
        this.pingInterval = setInterval(() => {
            this.wss.clients.forEach(client => {
                if (client.readyState === ws_1.default.OPEN) {
                    client.ping();
                }
            });
        }, 30000);
    }
    /**
     * Enviar mensaje a un agente específico
     */
    sendToAgent(agentId, type, payload) {
        const ws = this.connectedAgents.get(agentId);
        if (!ws || ws.readyState !== ws_1.default.OPEN) {
            return false;
        }
        return this.sendToSocket(ws, type, payload);
    }
    /**
     * Enviar mensaje a un socket específico
     */
    sendToSocket(ws, type, payload) {
        try {
            const message = JSON.stringify({ type, payload, timestamp: Date.now() });
            ws.send(message);
            return true;
        }
        catch (error) {
            logger_1.default.error('Error al enviar mensaje WebSocket', { error, type });
            return false;
        }
    }
    /**
     * Enviar mensaje a todos los agentes conectados
     */
    broadcastToAgents(type, payload) {
        this.connectedAgents.forEach((ws, agentId) => {
            if (ws.readyState === ws_1.default.OPEN) {
                this.sendToSocket(ws, type, payload);
            }
        });
    }
    /**
     * Verificar si un agente está conectado
     */
    isAgentConnected(agentId) {
        const ws = this.connectedAgents.get(agentId);
        return !!ws && ws.readyState === ws_1.default.OPEN;
    }
    /**
     * Obtener número de agentes conectados
     */
    getConnectedAgentsCount() {
        return this.connectedAgents.size;
    }
    /**
     * Obtener lista de IDs de agentes conectados
     */
    getConnectedAgentIds() {
        return Array.from(this.connectedAgents.keys());
    }
    /**
     * Cerrar todas las conexiones
     */
    close() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        this.wss.clients.forEach(client => {
            client.close(1000, 'Servidor cerrando');
        });
        this.wss.close();
        logger_1.default.info('Servidor WebSocket cerrado');
    }
}
exports.WebSocketService = WebSocketService;
let wsServiceInstance = null;
/**
 * Configurar servidor WebSocket
 */
function setupWebSocketServer(server) {
    if (!wsServiceInstance) {
        wsServiceInstance = new WebSocketService(server);
    }
    return wsServiceInstance;
}
/**
 * Obtener instancia del servicio WebSocket
 */
function getWebSocketService() {
    return wsServiceInstance;
}
exports.default = WebSocketService;
