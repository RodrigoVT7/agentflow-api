"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/app.ts
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
// Routes
const webhook_routes_1 = __importDefault(require("./routes/webhook.routes"));
const agent_routes_1 = __importDefault(require("./routes/agent.routes"));
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
// Middleware
const error_middleware_1 = require("./middleware/error.middleware");
const logging_middleware_1 = require("./middleware/logging.middleware");
// Services
const server_1 = require("./websocket/server");
const queue_service_1 = require("./services/queue.service");
class App {
    constructor() {
        this.app = (0, express_1.default)();
        this.port = process.env.PORT || 3000;
        this.initializeMiddlewares();
        this.initializeRoutes();
        this.initializeErrorHandling();
        this.setupStaticFiles();
    }
    initializeMiddlewares() {
        this.app.use((0, cors_1.default)());
        this.app.use((0, helmet_1.default)({
            contentSecurityPolicy: false, // Para permitir el panel de agentes con CDNs
        }));
        this.app.use((0, compression_1.default)());
        this.app.use(express_1.default.json());
        this.app.use(express_1.default.urlencoded({ extended: true }));
        this.app.use(logging_middleware_1.requestLogger);
    }
    initializeRoutes() {
        this.app.use('/webhook', webhook_routes_1.default);
        this.app.use('/agent', agent_routes_1.default);
        console.log('Registrando rutas de autenticación');
        this.app.use('/auth', auth_routes_1.default);
        auth_routes_1.default.stack.forEach((route) => {
            if (route.route) {
                console.log(`Ruta registrada: ${route.route.path} [${Object.keys(route.route).join(', ')}]`);
            }
        });
    }
    initializeErrorHandling() {
        this.app.use(error_middleware_1.errorHandler);
    }
    setupStaticFiles() {
        // Servir archivos estáticos del panel de agentes
        this.app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
        // Servir la aplicación Angular (para producción)
        this.app.use('/admin', express_1.default.static(path_1.default.join(__dirname, '../client/dist')));
        // Redireccionar cualquier ruta de Angular a index.html
        this.app.get('/admin/*', (req, res) => {
            res.sendFile(path_1.default.join(__dirname, '../client/dist/index.html'));
        });
    }
    listen() {
        this.server = this.app.listen(this.port, () => {
            console.log(`Servidor corriendo en puerto ${this.port}`);
        });
        // Inicializar WebSocket Server
        (0, server_1.setupWebSocketServer)(this.server);
        // Inicializar el servicio de cola
        (0, queue_service_1.initQueueService)();
        // Manejo de cierre limpio
        this.setupGracefulShutdown();
    }
    setupGracefulShutdown() {
        // Manejar señales de terminación para cerrar limpiamente
        process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
        process.on('uncaughtException', (error) => {
            console.error('Excepción no capturada:', error);
            this.gracefulShutdown('uncaughtException');
        });
    }
    gracefulShutdown(signal) {
        console.log(`${signal} recibido. Cerrando servidor...`);
        // Guardar estado de colas antes de cerrar
        (0, queue_service_1.initQueueService)().saveQueueState();
        this.server.close(() => {
            console.log('Servidor cerrado correctamente');
            process.exit(0);
        });
        // Forzar cierre después de 10 segundos
        setTimeout(() => {
            console.error('Cierre forzado después de 10s');
            process.exit(1);
        }, 10000);
    }
}
exports.default = App;
// Iniciar la aplicación si este archivo es ejecutado directamente
if (require.main === module) {
    const app = new App();
    app.listen();
}
