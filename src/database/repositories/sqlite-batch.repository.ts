// src/database/repositories/sqlite-batch.repository.ts
import { IBatchRepository } from './base.repository';
import { SQLiteRepository } from './sqlite.repository';
import logger from '../../utils/logger';

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
    // Implementar como operaciones individuales
    const results: T[] = [];
    
    for (const item of items) {
      try {
        const created = await this.repository.create(item);
        results.push(created);
      } catch (error) {
        logger.error('Error al crear múltiples elementos', { error, item });
        throw error;
      }
    }
    
    return results;
  }

  /**
   * Actualizar múltiples registros
   */
  async updateMany(filter: Partial<T>, data: Partial<T>): Promise<number> {
    try {
      // Buscar todos los items que coincidan con el filtro
      const items = await this.repository.findAll(filter);
      let updateCount = 0;
      
      // Actualizar cada elemento individualmente
      for (const item of items) {
        const itemAny = item as any;
        if (itemAny[this.idField]) {
          const updated = await this.repository.update(itemAny[this.idField], data);
          if (updated) updateCount++;
        }
      }
      
      return updateCount;
    } catch (error) {
      logger.error('Error al actualizar múltiples elementos', { error });
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
      let deleteCount = 0;
      
      // Eliminar cada elemento individualmente
      for (const item of items) {
        const itemAny = item as any;
        if (itemAny[this.idField]) {
          const deleted = await this.repository.delete(itemAny[this.idField]);
          if (deleted) deleteCount++;
        }
      }
      
      return deleteCount;
    } catch (error) {
      logger.error('Error al eliminar múltiples elementos', { error });
      throw error;
    }
  }
}