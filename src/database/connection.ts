// src/database/connection.ts
import Database from 'better-sqlite3';
import dbConfig from '../config/database.config';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

// Variable to store the active connection
let connection: any = null;

/**
 * Initialize SQLite connection and create tables
 */
export async function initDatabaseConnection(): Promise<any> {
  if (connection) {
    return connection;
  }
  
  try {
    // Ensure directory exists
    const dir = path.dirname(dbConfig.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Connect to SQLite - better-sqlite3 is synchronous
    connection = new Database(dbConfig.filePath, { 
      verbose: process.env.NODE_ENV === 'development' ? console.log : undefined
    });
    
    // Enable foreign keys
    connection.pragma('foreign_keys = ON');
    
    // Initialize tables
    initializeTables(connection);
    
    const result = connection.prepare('SELECT * FROM agents').all();
    logger.info(`Test query successful. Found ${result.length} agents.`);
    return connection;
  } catch (error) {
    logger.error(`Error connecting to SQLite`, { error });
    throw error;
  }
}

/**
 * Initialize tables in the database
 */
function initializeTables(db: any): void {
  // Create agents table
  db.exec(`
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
  
  // Create conversations table
  db.exec(`
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
  
  // Create messages table
  db.exec(`
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
  
  // Create queue table
  db.exec(`
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
  
  logger.info('SQLite tables initialized successfully');
}

/**
 * Close database connection
 */
export async function closeDatabaseConnection(): Promise<void> {
  if (!connection) {
    return;
  }
  
  try {
    connection.close();
    connection = null;
    logger.info('SQLite connection closed successfully');
  } catch (error) {
    logger.error('Error closing SQLite connection', { error });
    throw error;
  }
}

export default { initDatabaseConnection, closeDatabaseConnection };