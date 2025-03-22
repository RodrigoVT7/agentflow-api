// src/database/schema.ts
import { initDatabaseConnection } from './connection';
import logger from '../utils/logger';

/**
 * Initialize the database schema by creating all necessary tables if they don't exist
 */
export async function initializeSchema(): Promise<void> {
  try {
    const db = await initDatabaseConnection();
    
    // Create agents table
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        status TEXT NOT NULL,
        max_concurrent_chats INTEGER NOT NULL DEFAULT 3,
        role TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        socket_id TEXT
      );
      
      CREATE TABLE IF NOT EXISTS agent_conversations (
        agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, conversation_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      );
      
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        token TEXT,
        phone_number_id TEXT NOT NULL,
        from_number TEXT NOT NULL,
        is_escalated INTEGER NOT NULL DEFAULT 0,
        last_activity INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        from_sender TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        agent_id TEXT,
        attachment_url TEXT,
        metadata TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      );
      
      CREATE TABLE IF NOT EXISTS queue_items (
        conversation_id TEXT PRIMARY KEY,
        from_number TEXT NOT NULL,
        phone_number_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1,
        assigned_agent TEXT,
        metadata TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
        FOREIGN KEY (assigned_agent) REFERENCES agents(id)
      );
      
      CREATE TABLE IF NOT EXISTS queue_tags (
        queue_item_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (queue_item_id, tag),
        FOREIGN KEY (queue_item_id) REFERENCES queue_items(conversation_id)
      );
    `);
    
    logger.info('Database schema initialized successfully');
  } catch (error) {
    logger.error('Error initializing database schema', { error });
    throw error;
  }
}

export default { initializeSchema };