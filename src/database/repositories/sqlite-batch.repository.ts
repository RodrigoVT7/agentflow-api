// src/database/repositories/sqlite-batch.repository.ts
import { IBatchRepository } from './base.repository';
import { SQLiteRepository } from './sqlite.repository';
import logger from '../../utils/logger';
import { initDatabaseConnection } from '../connection';

/**
 * Repositorio SQLite con operaciones batch
 */
export class SQLiteBatchRepository<T> implements IBatchRepository<T> {
  private repository: SQLiteRepository<T>;
  private idField: string;
  
  /**
   * Constructor
   * @param tableName Nombre de la tabla en SQLite
   * @param idField Nombre del campo que sirve como ID/clave primaria (por defecto: 'id')
   */
  constructor(tableName: string, idField: string = 'id') {
    this.repository = new SQLiteRepository<T>(tableName, idField);
    this.idField = idField;
  }

  async create(data: T): Promise<T> {
    return this.repository.create(data);
  }

  async findById(id: string): Promise<T | null> {
    return this.repository.findById(id);
  }

  async findAll(filter?: Partial<T>): Promise<T[]> {
    return this.repository.findAll(filter);
  }

  async update(id: string, data: Partial<T>): Promise<T | null> {
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async findOne(filter: Partial<T>): Promise<T | null> {
    return this.repository.findOne(filter);
  }

  async count(filter?: Partial<T>): Promise<number> {
    return this.repository.count(filter);
  }

  /**
   * Crear múltiples registros
   */
  async createMany(items: T[]): Promise<T[]> {
    try {
      const db = await initDatabaseConnection();
      const results: T[] = [];
      
      // Use transaction for better performance
      const transaction = db.transaction((itemsList: T[]) => {
        for (const item of itemsList) {
          const newItem = { ...item } as any;
          
          // Generate ID if needed
          if (!newItem[this.idField]) {
            const { v4: uuidv4 } = require('uuid');
            newItem[this.idField] = uuidv4();
          }
          
          // Convert object to column-value pairs
          const columns = Object.keys(newItem);
          const values = Object.values(newItem).map(value => {
            if (value === null || value === undefined) {
              return null;
            }
            if (typeof value === 'object') {
              return JSON.stringify(value);
            }
            return value;
          });
          
          // Create query
          const placeholders = columns.map(() => '?').join(', ');
          const query = `INSERT INTO ${this.repository['tableName']} (${columns.join(', ')}) VALUES (${placeholders})`;
          
          // Execute query
          db.prepare(query).run(...values);
          
          // Add to results
          results.push(newItem);
        }
      });
      
      // Execute transaction
      transaction(items);
      
      return results;
    } catch (error) {
      logger.error('Error creating multiple items', { error });
      throw error;
    }
  }

  /**
   * Actualizar múltiples registros
   */
  async updateMany(filter: Partial<T>, data: Partial<T>): Promise<number> {
    try {
      // Buscar todos los items que coincidan con el filtro
      const items = await this.repository.findAll(filter);
      
      if (items.length === 0) {
        return 0;
      }
      
      const db = await initDatabaseConnection();
      
      // Preparar datos para actualización
      const columns: string[] = [];
      const baseValues: any[] = [];
      
      for (const [key, value] of Object.entries(data)) {
        if (key === this.idField) continue; // No actualizar ID
        
        columns.push(`${key} = ?`);
        
        if (value === null || value === undefined) {
          baseValues.push(null);
        } else if (typeof value === 'object') {
          baseValues.push(JSON.stringify(value));
        } else {
          baseValues.push(value);
        }
      }
      
      if (columns.length === 0) {
        return 0;
      }
      
      // Prepare update query
      const query = `UPDATE ${this.repository['tableName']} SET ${columns.join(', ')} WHERE ${this.idField} = ?`;
      const updateStmt = db.prepare(query);
      
      // Use transaction for better performance
      const transaction = db.transaction((itemsList: any[]) => {
        for (const item of itemsList) {
          const values = [...baseValues, item[this.idField]];
          updateStmt.run(...values);
        }
      });
      
      // Execute transaction
      transaction(items);
      
      return items.length;
    } catch (error) {
      logger.error('Error updating multiple items', { error });
      throw error;
    }
  }

  /**
   * Eliminar múltiples registros
   */
  async deleteMany(filter: Partial<T>): Promise<number> {
    try {
      // Buscar todos los items que coincidan con el filtro
      const items = await this.repository.findAll(filter);
      
      if (items.length === 0) {
        return 0;
      }
      
      const db = await initDatabaseConnection();
      
      // Prepare delete query
      const query = `DELETE FROM ${this.repository['tableName']} WHERE ${this.idField} = ?`;
      const deleteStmt = db.prepare(query);
      
      // Use transaction for better performance
      const transaction = db.transaction((itemsList: any[]) => {
        for (const item of itemsList) {
          deleteStmt.run(item[this.idField]);
        }
      });
      
      // Execute transaction
      transaction(items);
      
      return items.length;
    } catch (error) {
      logger.error('Error deleting multiple items', { error });
      throw error;
    }
  }
}