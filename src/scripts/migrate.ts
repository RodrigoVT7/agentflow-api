// // src/scripts/migrate.ts
// import path from 'path';
// import { open } from 'sqlite';
// import sqlite3 from 'sqlite3';
// import fs from 'fs';
// import bcrypt from 'bcrypt';
// import config from '../config/app.config';
// import { AgentStatus } from '../models/agent.model';

// async function migrate() {
//   // Asegurar que el directorio existe
//   const dbDir = path.dirname(config.database.path);
//   if (!fs.existsSync(dbDir)) {
//     fs.mkdirSync(dbDir, { recursive: true });
//   }

//   console.log(`Inicializando base de datos SQLite en: ${config.database.path}`);

//   // Abrir conexión a la base de datos
//   const db = await open({
//     filename: config.database.path,
//     driver: sqlite3.Database
//   });

//   // Crear tablas
//   console.log('Creando tablas...');

//   // Tabla de agentes
//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS agents (
//       id TEXT PRIMARY KEY,
//       name TEXT NOT NULL,
//       email TEXT UNIQUE NOT NULL,
//       password TEXT NOT NULL,
//       status TEXT NOT NULL,
//       activeConversations TEXT NOT NULL,
//       maxConcurrentChats INTEGER NOT NULL,
//       role TEXT NOT NULL,
//       lastActivity INTEGER NOT NULL
//     )
//   `);

//   // Tabla de conversaciones
//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS conversations (
//       conversationId TEXT PRIMARY KEY,
//       token TEXT NOT NULL,
//       phone_number_id TEXT NOT NULL,
//       from_number TEXT NOT NULL,
//       isEscalated INTEGER NOT NULL,
//       lastActivity INTEGER NOT NULL,
//       status TEXT NOT NULL
//     )
//   `);

//   // Tabla de mensajes
//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS messages (
//       id TEXT PRIMARY KEY,
//       conversationId TEXT NOT NULL,
//       from_type TEXT NOT NULL,
//       text TEXT NOT NULL,
//       timestamp INTEGER NOT NULL,
//       agentId TEXT,
//       attachmentUrl TEXT,
//       metadata TEXT,
//       FOREIGN KEY (conversationId) REFERENCES conversations (conversationId)
//     )
//   `);

//   // Tabla para cola de espera
//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS queue (
//       conversationId TEXT PRIMARY KEY,
//       from_number TEXT NOT NULL,
//       phone_number_id TEXT NOT NULL,
//       startTime INTEGER NOT NULL,
//       priority INTEGER NOT NULL,
//       tags TEXT NOT NULL,
//       assignedAgent TEXT,
//       metadata TEXT NOT NULL,
//       FOREIGN KEY (conversationId) REFERENCES conversations (conversationId)
//     )
//   `);

//   // Crear índices para mejorar el rendimiento
//   await db.exec(`
//     CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
//     CREATE INDEX IF NOT EXISTS idx_conversations_from ON conversations(from_number);
//     CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversationId);
//     CREATE INDEX IF NOT EXISTS idx_queue_assigned_agent ON queue(assignedAgent);
//   `);

//   // Verificar si existen agentes
//   const agentCount = await db.get('SELECT COUNT(*) as count FROM agents');
  
//   // Crear agentes por defecto si no existen
//   if (agentCount.count === 0) {
//     console.log('Creando agentes predeterminados...');
    
//     const hashedPassword = await bcrypt.hash('agent123', 10);
//     const adminPassword = await bcrypt.hash('admin123', 10);
    
//     const defaultAgents = [
//       {
//         id: 'agent_1',
//         name: 'Agente 1',
//         email: 'agent1@example.com',
//         password: hashedPassword,
//         status: AgentStatus.ONLINE,
//         activeConversations: '[]',
//         maxConcurrentChats: 3,
//         role: 'agent',
//         lastActivity: Date.now()
//       },
//       {
//         id: 'agent_2',
//         name: 'Agente 2',
//         email: 'agent2@example.com',
//         password: hashedPassword,
//         status: AgentStatus.ONLINE,
//         activeConversations: '[]',
//         maxConcurrentChats: 3,
//         role: 'agent',
//         lastActivity: Date.now()
//       },
//       {
//         id: 'agent_3',
//         name: 'Agente 3',
//         email: 'agent3@example.com',
//         password: hashedPassword,
//         status: AgentStatus.ONLINE,
//         activeConversations: '[]',
//         maxConcurrentChats: 3,
//         role: 'agent',
//         lastActivity: Date.now()
//       },
//       {
//         id: 'supervisor_1',
//         name: 'Supervisor',
//         email: 'supervisor@example.com',
//         password: hashedPassword,
//         status: AgentStatus.ONLINE,
//         activeConversations: '[]',
//         maxConcurrentChats: 5,
//         role: 'supervisor',
//         lastActivity: Date.now()
//       },
//       {
//         id: 'admin_1',
//         name: 'Administrador',
//         email: 'admin@example.com',
//         password: adminPassword,
//         status: AgentStatus.ONLINE,
//         activeConversations: '[]',
//         maxConcurrentChats: 10,
//         role: 'admin',
//         lastActivity: Date.now()
//       }
//     ];
    
//     // Insertar agentes
//     for (const agent of defaultAgents) {
//       await db.run(
//         `INSERT INTO agents
//          (id, name, email, password, status, activeConversations, maxConcurrentChats, role, lastActivity)
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           agent.id, 
//           agent.name, 
//           agent.email, 
//           agent.password, 
//           agent.status, 
//           agent.activeConversations, 
//           agent.maxConcurrentChats, 
//           agent.role, 
//           agent.lastActivity
//         ]
//       );
//     }
    
//     console.log('5 agentes predeterminados creados correctamente');
//   } else {
//     console.log(`Ya existen ${agentCount.count} agentes en la base de datos`);
//   }

//   await db.close();
//   console.log('Migración completada exitosamente');
// }

// // Ejecutar la migración
// migrate().catch(error => {
//   console.error('Error en la migración:', error);
//   process.exit(1);
// });