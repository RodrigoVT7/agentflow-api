// src/database/repositories/memory.repository.ts
import { IBatchRepository } from './base.repository';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';

/**
 * Repositorio que almacena datos en memoria con opción de persistir a archivo
 */
export class MemoryRepository<T extends { id?: string }> implements IBatchRepository<T> {
  private items: Map<string, T> = new Map();
  private persistPath?: string;
  private entityName: string;
  private autoSave: boolean;
  
  /**
   * Constructor
   * @param entityName Nombre de la entidad para logs
   * @param persistPath Ruta del archivo para persistencia (opcional)
   * @param autoSave Guardar automáticamente en cada operación
   */
  constructor(entityName: string, persistPath?: string, autoSave: boolean = true) {
    this.entityName = entityName;
    this.autoSave = autoSave;
    
    if (persistPath) {
      this.persistPath = path.resolve(persistPath);
      
      // Asegurar que el directorio existe
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Cargar datos si el archivo existe
      this.loadFromFile();
    }
  }

  /**
   * Crear un nuevo registro
   */
  async create(data: T): Promise<T> {
    // Generar ID si no existe
    const newItem = { ...data };
    if (!newItem.id) {
      newItem.id = uuidv4();
    }
    
    // Guardar en memoria
    this.items.set(newItem.id, newItem);
    
    // Persistir si está configurado
    if (this.autoSave) {
      await this.saveToFile();
    }
    
    return newItem;
  }

  /**
   * Buscar por ID
   */
  async findById(id: string): Promise<T | null> {
    const item = this.items.get(id);
    return item || null;
  }

  /**
   * Buscar todos los registros
   */
  async findAll(filter?: Partial<T>): Promise<T[]> {
    let result = Array.from(this.items.values());
    
    // Aplicar filtro si existe
    if (filter) {
      result = this.applyFilter(result, filter);
    }
    
    return result;
  }

  /**
   * Actualizar un registro
   */
  async update(id: string, data: Partial<T>): Promise<T | null> {
    const item = this.items.get(id);
    
    if (!item) {
      return null;
    }
    
    // Actualizar campos
    const updatedItem = { ...item, ...data, id };
    this.items.set(id, updatedItem);
    
    // Persistir si está configurado
    if (this.autoSave) {
      await this.saveToFile();
    }
    
    return updatedItem;
  }

  /**
   * Eliminar un registro
   */
  async delete(id: string): Promise<boolean> {
    const result = this.items.delete(id);
    
    // Persistir si está configurado y se eliminó algo
    if (result && this.autoSave) {
      await this.saveToFile();
    }
    
    return result;
  }

  /**
   * Buscar uno que cumpla con el filtro
   */
  async findOne(filter: Partial<T>): Promise<T | null> {
    const items = Array.from(this.items.values());
    const filtered = this.applyFilter(items, filter);
    
    return filtered.length > 0 ? filtered[0] : null;
  }

  /**
   * Contar registros
   */
  async count(filter?: Partial<T>): Promise<number> {
    if (!filter) {
      return this.items.size;
    }
    
    const items = Array.from(this.items.values());
    const filtered = this.applyFilter(items, filter);
    
    return filtered.length;
  }

  /**
   * Crear múltiples registros en una operación
   */
  async createMany(items: T[]): Promise<T[]> {
    const newItems = items.map(item => {
      const newItem = { ...item };
      if (!newItem.id) {
        newItem.id = uuidv4();
      }
      this.items.set(newItem.id, newItem);
      return newItem;
    });
    
    // Persistir si está configurado
    if (this.autoSave) {
      await this.saveToFile();
    }
    
    return newItems;
  }

  /**
   * Actualizar múltiples registros en una operación
   */
  async updateMany(filter: Partial<T>, data: Partial<T>): Promise<number> {
    const items = Array.from(this.items.values());
    const filtered = this.applyFilter(items, filter);
    
    filtered.forEach(item => {
      if (item.id) {
        const updatedItem = { ...item, ...data, id: item.id };
        this.items.set(item.id, updatedItem);
      }
    });
    
    // Persistir si está configurado
    if (this.autoSave) {
      await this.saveToFile();
    }
    
    return filtered.length;
  }

  /**
   * Eliminar múltiples registros en una operación
   */
  async deleteMany(filter: Partial<T>): Promise<number> {
    const items = Array.from(this.items.values());
    const filtered = this.applyFilter(items, filter);
    
    filtered.forEach(item => {
      if (item.id) {
        this.items.delete(item.id);
      }
    });
    
    // Persistir si está configurado
    if (this.autoSave) {
      await this.saveToFile();
    }
    
    return filtered.length;
  }

  /**
   * Guardar todos los datos en archivo
   */
  async saveToFile(): Promise<void> {
    if (!this.persistPath) {
      return;
    }
    
    try {
      const data = JSON.stringify(Array.from(this.items.values()), null, 2);
      fs.writeFileSync(this.persistPath, data, 'utf8');
    } catch (error) {
      logger.error(`Error al guardar ${this.entityName} en archivo`, { error });
    }
  }

  /**
   * Cargar datos desde archivo
   */
  private loadFromFile(): void {
    if (!this.persistPath) {
      return;
    }
    
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = fs.readFileSync(this.persistPath, 'utf8');
        const items = JSON.parse(data) as T[];
        
        // Limpiar mapa actual
        this.items.clear();
        
        // Cargar items
        items.forEach(item => {
          if (item.id) {
            this.items.set(item.id, item);
          }
        });
        
        logger.info(`Cargados ${items.length} ${this.entityName} desde archivo`);
      }
    } catch (error) {
      logger.error(`Error al cargar ${this.entityName} desde archivo`, { error });
    }
  }

  /**
   * Aplicar filtro a una lista de items
   */
  private applyFilter(items: T[], filter: Partial<T>): T[] {
    return items.filter(item => {
      return Object.entries(filter).every(([key, value]) => {
        // Manejar caso especial de undefined o null
        if (value === undefined || value === null) {
          return item[key as keyof T] === value;
        }
        
        // Comprobar si es un objeto para comparación profunda
        if (typeof value === 'object' && value !== null) {
          return JSON.stringify(item[key as keyof T]) === JSON.stringify(value);
        }
        
        // Comparación simple
        return item[key as keyof T] === value;
      });
    });
  }
}