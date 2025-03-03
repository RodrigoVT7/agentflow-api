// src/database/connection.ts
import mongoose from 'mongoose';
import { Pool } from 'pg';
import { createConnection } from 'mysql2/promise';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dbConfig, { DatabaseType } from '../config/database.config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

// Variable para almacenar la conexión activa
let connection: any = null;

/**
 * Inicializar conexión a la base de datos según la configuración
 */
export async function initDatabaseConnection(): Promise<any> {
  if (connection) {
    return connection;
  }
  
  try {
    switch (dbConfig.type) {
      case DatabaseType.MONGODB:
        if (!dbConfig.url) {
          throw new Error('MongoDB URI no configurada');
        }
        
        // Conectar a MongoDB
        connection = await mongoose.connect(dbConfig.url, {
          dbName: dbConfig.database,
          ...dbConfig.options
        });
        
        logger.info('Conexión a MongoDB establecida correctamente');
        break;
        
      case DatabaseType.POSTGRES:
        // Conectar a PostgreSQL
        connection = new Pool({
          host: dbConfig.host,
          port: dbConfig.port,
          user: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database
        });
        
        // Verificar conexión
        const pgClient = await connection.connect();
        pgClient.release();
        
        logger.info('Conexión a PostgreSQL establecida correctamente');
        break;
        
      case DatabaseType.MYSQL:
        // Conectar a MySQL
        connection = await createConnection({
          host: dbConfig.host,
          port: dbConfig.port,
          user: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database,
          connectionLimit: 10
        });
        
        logger.info('Conexión a MySQL establecida correctamente');
        break;
        
      case DatabaseType.SQLITE:
        if (!dbConfig.filePath) {
          throw new Error('Ruta de archivo SQLite no configurada');
        }
        
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
        
        logger.info('Conexión a SQLite establecida correctamente');
        break;
        
      case DatabaseType.MEMORY:
      default:
        // "Conexión" en memoria (no se necesita realmente una conexión)
        connection = {
          type: 'memory',
          isConnected: true
        };
        
        logger.info('Utilizando almacenamiento en memoria');
        break;
    }
    
    return connection;
  } catch (error) {
    logger.error(`Error al conectar a la base de datos (${dbConfig.type})`, { error });
    throw error;
  }
}

/**
 * Cerrar conexión a la base de datos
 */
export async function closeDatabaseConnection(): Promise<void> {
  if (!connection) {
    return;
  }
  
  try {
    switch (dbConfig.type) {
      case DatabaseType.MONGODB:
        await mongoose.disconnect();
        break;
        
      case DatabaseType.POSTGRES:
        await connection.end();
        break;
        
      case DatabaseType.MYSQL:
        await connection.end();
        break;
        
      case DatabaseType.SQLITE:
        await connection.close();
        break;
        
      case DatabaseType.MEMORY:
      default:
        // No se necesita cerrar nada para almacenamiento en memoria
        break;
    }
    
    connection = null;
    logger.info(`Conexión a base de datos (${dbConfig.type}) cerrada correctamente`);
  } catch (error) {
    logger.error(`Error al cerrar conexión a base de datos (${dbConfig.type})`, { error });
    throw error;
  }
}

export default { initDatabaseConnection, closeDatabaseConnection };