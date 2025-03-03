// src/database/repositories/base.repository.ts
/**
 * Interfaz genérica para repositorios de datos
 */
export interface IRepository<T> {
    /**
     * Crear un nuevo registro
     */
    create(data: T): Promise<T>;
    
    /**
     * Buscar por ID
     */
    findById(id: string): Promise<T | null>;
    
    /**
     * Buscar todos los registros
     */
    findAll(filter?: Partial<T>): Promise<T[]>;
    
    /**
     * Actualizar un registro
     */
    update(id: string, data: Partial<T>): Promise<T | null>;
    
    /**
     * Eliminar un registro
     */
    delete(id: string): Promise<boolean>;
    
    /**
     * Buscar uno que cumpla con el filtro
     */
    findOne(filter: Partial<T>): Promise<T | null>;
    
    /**
     * Contar registros
     */
    count(filter?: Partial<T>): Promise<number>;
  }
  
  /**
   * Interfaz para repositorios con funcionalidad de batch/bulk
   */
  export interface IBatchRepository<T> extends IRepository<T> {
    /**
     * Crear múltiples registros en una operación
     */
    createMany(items: T[]): Promise<T[]>;
    
    /**
     * Actualizar múltiples registros en una operación
     */
    updateMany(filter: Partial<T>, data: Partial<T>): Promise<number>;
    
    /**
     * Eliminar múltiples registros en una operación
     */
    deleteMany(filter: Partial<T>): Promise<number>;
  }