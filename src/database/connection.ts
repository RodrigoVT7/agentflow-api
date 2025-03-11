// src/database/connection.ts
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dbConfig from '../config/database.config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

// Variable para almacenar la conexión activa
let connection: any = null;

/**
 * Inicializar conexión a SQLite y crear tablas
 */
export async function initDatabaseConnection(): Promise<any> {
  if (connection) {
    return connection;
  }
  
  try {
    // Asegurar que el directorio existe
    const dir = path.dirname(dbConfig.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Conectar a SQLite
    connection = await open({
      filename: dbConfig.filePath,
      driver: sqlite3.Database
    });
    
    // Inicializar tablas
    await initializeTables(connection);
    
    logger.info('Conexión a SQLite establecida correctamente');
    return connection;
  } catch (error) {
    logger.error(`Error al conectar a SQLite`, { error });
    throw error;
  }
}

/**
 * Inicializar tablas en la base de datos
 */
async function initializeTables(db: any): Promise<void> {
  // Crear tabla de agentes
  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      status TEXT NOT NULL,
      activeConversations TEXT NOT NULL,
      maxConcurrentChats INTEGER NOT NULL,
      role TEXT NOT NULL,
      lastActivity INTEGER NOT NULL
    )
  `);
  
  // Crear tabla de conversaciones
  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversationId TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      phone_number_id TEXT NOT NULL,
      from_number TEXT NOT NULL,
      isEscalated INTEGER NOT NULL,
      lastActivity INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `);
  
  // Crear tabla de mensajes
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      from_type TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agentId TEXT,
      attachmentUrl TEXT,
      metadata TEXT,
      FOREIGN KEY (conversationId) REFERENCES conversations (conversationId)
    )
  `);
  
  // Crear tabla para cola de espera
  await db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      conversationId TEXT PRIMARY KEY,
      from_number TEXT NOT NULL,
      phone_number_id TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      tags TEXT NOT NULL,
      assignedAgent TEXT,
      metadata TEXT NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations (conversationId)
    )
  `);
  
  logger.info('Tablas SQLite inicializadas correctamente');
}

/**
 * Cerrar conexión a la base de datos
 */
export async function closeDatabaseConnection(): Promise<void> {
  if (!connection) {
    return;
  }
  
  try {
    await connection.close();
    connection = null;
    logger.info('Conexión a SQLite cerrada correctamente');
  } catch (error) {
    logger.error('Error al cerrar conexión a SQLite', { error });
    throw error;
  }
}

export default { initDatabaseConnection, closeDatabaseConnection };