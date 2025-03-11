// src/app.ts
import express, { Application } from 'express';
import path from 'path';
import { Server } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

// Routes
import webhookRoutes from './routes/webhook.routes';
import agentRoutes from './routes/agent.routes';
import authRoutes from './routes/auth.routes';

// Middleware
import { errorHandler } from './middleware/error.middleware';
import { requestLogger } from './middleware/logging.middleware';

// Services
import { setupWebSocketServer } from './websocket/server';
import { initQueueService } from './services/queue.service';
import { initAgentService } from './services/agent.service';
import { initConversationService } from './services/conversation.service';
import { initDatabaseConnection, closeDatabaseConnection } from './database/connection';
import logger from './utils/logger';

class App {
  public app: Application;
  public server!: Server;
  public port: number | string;

  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;

    // Inicializar base de datos SQLite
    this.initializeDatabase();
    
    // Inicializar servicios
    this.initializeServices();
    
    // Inicializar middleware y rutas
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
    this.setupStaticFiles();
  }

  /**
   * Inicializar la conexión a la base de datos SQLite
   */
  private async initializeDatabase(): Promise<void> {
    try {
      await initDatabaseConnection();
      logger.info('SQLite inicializada correctamente');
    } catch (error) {
      logger.error('Error al inicializar SQLite', { error });
      process.exit(1);
    }
  }

  /**
   * Inicializar los servicios principales
   */
  private initializeServices(): void {
    // La inicialización debe seguir este orden para evitar dependencias circulares
    const agentService = initAgentService();
    const queueService = initQueueService();
    const conversationService = initConversationService();
    
    logger.info('Servicios inicializados correctamente');
  }

  private initializeMiddlewares(): void {
    this.app.use(cors());
    this.app.use(helmet({
      contentSecurityPolicy: false, // Para permitir el panel de agentes con CDNs
    }));
    this.app.use(compression());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(requestLogger);
  }

  private initializeRoutes(): void {
    this.app.use('/webhook', webhookRoutes);
    this.app.use('/agent', agentRoutes);
    this.app.use('/auth', authRoutes);
  }

  private initializeErrorHandling(): void {
    this.app.use(errorHandler);
  }

  private setupStaticFiles(): void {
    // Servir archivos estáticos del panel de agentes
    this.app.use(express.static(path.join(__dirname, '../public')));
    // Servir la aplicación Angular (para producción)
    this.app.use('/admin', express.static(path.join(__dirname, '../client/dist')));
    // Redireccionar cualquier ruta de Angular a index.html
    this.app.get('/admin/*', (req, res) => {
      res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    });
  }

  public listen(): void {
    this.server = this.app.listen(this.port, () => {
      console.log(`Servidor corriendo en puerto ${this.port}`);
    });
    
    // Inicializar WebSocket Server
    const wsService = setupWebSocketServer(this.server);
    
    // Conectar servicios con WebSocket
    const queueService = initQueueService();
    queueService.setWebSocketService(wsService);
    
    // Manejo de cierre limpio
    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown(): void {
    // Manejar señales de terminación para cerrar limpiamente
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      console.error('Excepción no capturada:', error);
      this.gracefulShutdown('uncaughtException');
    });
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    console.log(`${signal} recibido. Cerrando servidor...`);
    
    // Cerrar conexiones de base de datos
    await closeDatabaseConnection();
    
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

export default App;

// Iniciar la aplicación si este archivo es ejecutado directamente
if (require.main === module) {
  const app = new App();
  app.listen();
}