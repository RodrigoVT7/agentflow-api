// src/database/repositories/sqlite.repository.ts
import { IRepository } from './base.repository';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';
import { initDatabaseConnection } from '../connection';

/**
 * Repositorio que almacena datos en SQLite
 */
export class SQLiteRepository<T> implements IRepository<T> {
  private tableName: string;
  private idField: string;
  
  /**
   * Constructor
   * @param tableName Nombre de la tabla en SQLite
   * @param idField Nombre del campo que sirve como ID/clave primaria (por defecto: 'id')
   */
  constructor(tableName: string, idField: string = 'id') {
    this.tableName = tableName;
    this.idField = idField;
  }

  /**
   * Crear un nuevo registro
   */
  async create(data: T): Promise<T> {
    try {
      const db = await initDatabaseConnection();
      
      // Generar ID si no existe
      const newItem = { ...data } as any;
      if (!newItem[this.idField]) {
        newItem[this.idField] = uuidv4();
      }
      
      // Convertir objeto a pares columna-valor
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
      
      // Crear consulta
      const placeholders = columns.map(() => '?').join(', ');
      const query = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
      
      // Ejecutar consulta
      await db.run(query, values);
      
      return newItem;
    } catch (error) {
      logger.error(`Error al crear en ${this.tableName}`, { error });
      throw error;
    }
  }

  /**
   * Buscar por ID
   */
  async findById(id: string): Promise<T | null> {
    try {
      const db = await initDatabaseConnection();
      
      const query = `SELECT * FROM ${this.tableName} WHERE ${this.idField} = ?`;
      const item = await db.get(query, [id]);
      
      if (!item) {
        return null;
      }
      
      // Convertir campos JSON a objetos
      return this.parseJsonFields(item);
    } catch (error) {
      logger.error(`Error al buscar por ID en ${this.tableName}`, { error, id });
      throw error;
    }
  }

  /**
   * Buscar todos los registros
   */
  async findAll(filter?: Partial<T>): Promise<T[]> {
    try {
      const db = await initDatabaseConnection();
      
      let query = `SELECT * FROM ${this.tableName}`;
      let params: any[] = [];
      
      // Aplicar filtro si existe
      if (filter && Object.keys(filter).length > 0) {
        const conditions: string[] = [];
        
        for (const [key, value] of Object.entries(filter)) {
          if (value === null || value === undefined) {
            conditions.push(`${key} IS NULL`);
          } else if (typeof value === 'object') {
            // No podemos filtrar directamente por campos JSON, se aplica postfiltro más adelante
            continue;
          } else {
            conditions.push(`${key} = ?`);
            params.push(value);
          }
        }
        
        if (conditions.length > 0) {
          query += ` WHERE ${conditions.join(' AND ')}`;
        }
      }
      
      const items = await db.all(query, params);
      
      // Convertir campos JSON a objetos
      const result = items.map((item: any) => this.parseJsonFields(item));
      
      // Aplicar filtro adicional para campos de tipo objeto
      if (filter && Object.keys(filter).length > 0) {
        return result.filter((item: any) => {
          for (const [key, value] of Object.entries(filter)) {
            if (value === null || value === undefined) {
              continue; // Ya filtrado en la consulta SQL
            }
            
            if (typeof value === 'object') {
              // Comparar objetos como JSON strings
              const itemValueStr = JSON.stringify(item[key as keyof T]);
              const filterValueStr = JSON.stringify(value);
              
              if (itemValueStr !== filterValueStr) {
                return false;
              }
            }
          }
          return true;
        });
      }
      
      return result;
    } catch (error) {
      logger.error(`Error al buscar todos en ${this.tableName}`, { error });
      throw error;
    }
  }

  /**
   * Actualizar un registro
   */
  async update(id: string, data: Partial<T>): Promise<T | null> {
    try {
      const db = await initDatabaseConnection();
      
      // Comprobar que el item existe
      const existingItem = await this.findById(id);
      if (!existingItem) {
        return null;
      }
      
      // Preparar datos para actualización
      const columns: string[] = [];
      const values: any[] = [];
      
      for (const [key, value] of Object.entries(data)) {
        if (key === this.idField) continue; // No actualizar ID
        
        columns.push(`${key} = ?`);
        
        if (value === null || value === undefined) {
          values.push(null);
        } else if (typeof value === 'object') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
      }
      
      // Añadir ID al final para el WHERE
      values.push(id);
      
      // Ejecutar actualización
      const query = `UPDATE ${this.tableName} SET ${columns.join(', ')} WHERE ${this.idField} = ?`;
      await db.run(query, values);
      
      // Obtener item actualizado
      return this.findById(id);
    } catch (error) {
      logger.error(`Error al actualizar en ${this.tableName}`, { error, id });
      throw error;
    }
  }

  /**
   * Eliminar un registro
   */
  async delete(id: string): Promise<boolean> {
    try {
      const db = await initDatabaseConnection();
      
      // Comprobar que el item existe
      const existingItem = await this.findById(id);
      if (!existingItem) {
        return false;
      }
      
      // Ejecutar eliminación
      const query = `DELETE FROM ${this.tableName} WHERE ${this.idField} = ?`;
      await db.run(query, [id]);
      
      return true;
    } catch (error) {
      logger.error(`Error al eliminar en ${this.tableName}`, { error, id });
      throw error;
    }
  }

  /**
   * Buscar uno que cumpla con el filtro
   */
  async findOne(filter: Partial<T>): Promise<T | null> {
    try {
      const items = await this.findAll(filter);
      return items.length > 0 ? items[0] : null;
    } catch (error) {
      logger.error(`Error al buscar uno en ${this.tableName}`, { error });
      throw error;
    }
  }

  /**
   * Contar registros
   */
  async count(filter?: Partial<T>): Promise<number> {
    try {
      if (filter && Object.keys(filter).length > 0) {
        // Si hay filtros complejos, obtener todos y contar los filtrados
        const items = await this.findAll(filter);
        return items.length;
      }
      
      // Si no hay filtros, contar directamente en la BD
      const db = await initDatabaseConnection();
      const result = await db.get(`SELECT COUNT(*) as count FROM ${this.tableName}`);
      return result.count;
    } catch (error) {
      logger.error(`Error al contar en ${this.tableName}`, { error });
      throw error;
    }
  }

  /**
   * Convertir campos JSON a objetos
   */
  private parseJsonFields(item: any): T {
    const result: any = { ...item };
    
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string') {
        try {
          // Intentar parsear como JSON
          if (value.startsWith('[') || value.startsWith('{')) {
            result[key] = JSON.parse(value);
          }
        } catch (e) {
          // No es JSON válido, mantener como string
        }
      }
    }
    
    return result as T;
  }
}