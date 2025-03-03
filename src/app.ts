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

class App {
  public app: Application;
  public server!: Server;
  public port: number | string;

  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;

    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
    this.setupStaticFiles();
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
    setupWebSocketServer(this.server);
    
    // Inicializar el servicio de cola
    initQueueService();
    
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

  private gracefulShutdown(signal: string): void {
    console.log(`${signal} recibido. Cerrando servidor...`);
    
    // Guardar estado de colas antes de cerrar
    initQueueService().saveQueueState();
    
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