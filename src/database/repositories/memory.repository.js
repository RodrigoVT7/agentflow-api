"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryRepository = void 0;
const uuid_1 = require("uuid");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * Repositorio que almacena datos en memoria con opción de persistir a archivo
 */
class MemoryRepository {
    /**
     * Constructor
     * @param entityName Nombre de la entidad para logs
     * @param persistPath Ruta del archivo para persistencia (opcional)
     * @param autoSave Guardar automáticamente en cada operación
     */
    constructor(entityName, persistPath, autoSave = true) {
        this.items = new Map();
        this.entityName = entityName;
        this.autoSave = autoSave;
        if (persistPath) {
            this.persistPath = path_1.default.resolve(persistPath);
            // Asegurar que el directorio existe
            const dir = path_1.default.dirname(this.persistPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            // Cargar datos si el archivo existe
            this.loadFromFile();
        }
    }
    /**
     * Crear un nuevo registro
     */
    create(data) {
        return __awaiter(this, void 0, void 0, function* () {
            // Generar ID si no existe
            const newItem = Object.assign({}, data);
            if (!newItem.id) {
                newItem.id = (0, uuid_1.v4)();
            }
            // Guardar en memoria
            this.items.set(newItem.id, newItem);
            // Persistir si está configurado
            if (this.autoSave) {
                yield this.saveToFile();
            }
            return newItem;
        });
    }
    /**
     * Buscar por ID
     */
    findById(id) {
        return __awaiter(this, void 0, void 0, function* () {
            const item = this.items.get(id);
            return item || null;
        });
    }
    /**
     * Buscar todos los registros
     */
    findAll(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            let result = Array.from(this.items.values());
            // Aplicar filtro si existe
            if (filter) {
                result = this.applyFilter(result, filter);
            }
            return result;
        });
    }
    /**
     * Actualizar un registro
     */
    update(id, data) {
        return __awaiter(this, void 0, void 0, function* () {
            const item = this.items.get(id);
            if (!item) {
                return null;
            }
            // Actualizar campos
            const updatedItem = Object.assign(Object.assign(Object.assign({}, item), data), { id });
            this.items.set(id, updatedItem);
            // Persistir si está configurado
            if (this.autoSave) {
                yield this.saveToFile();
            }
            return updatedItem;
        });
    }
    /**
     * Eliminar un registro
     */
    delete(id) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = this.items.delete(id);
            // Persistir si está configurado y se eliminó algo
            if (result && this.autoSave) {
                yield this.saveToFile();
            }
            return result;
        });
    }
    /**
     * Buscar uno que cumpla con el filtro
     */
    findOne(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            const items = Array.from(this.items.values());
            const filtered = this.applyFilter(items, filter);
            return filtered.length > 0 ? filtered[0] : null;
        });
    }
    /**
     * Contar registros
     */
    count(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!filter) {
                return this.items.size;
            }
            const items = Array.from(this.items.values());
            const filtered = this.applyFilter(items, filter);
            return filtered.length;
        });
    }
    /**
     * Crear múltiples registros en una operación
     */
    createMany(items) {
        return __awaiter(this, void 0, void 0, function* () {
            const newItems = items.map(item => {
                const newItem = Object.assign({}, item);
                if (!newItem.id) {
                    newItem.id = (0, uuid_1.v4)();
                }
                this.items.set(newItem.id, newItem);
                return newItem;
            });
            // Persistir si está configurado
            if (this.autoSave) {
                yield this.saveToFile();
            }
            return newItems;
        });
    }
    /**
     * Actualizar múltiples registros en una operación
     */
    updateMany(filter, data) {
        return __awaiter(this, void 0, void 0, function* () {
            const items = Array.from(this.items.values());
            const filtered = this.applyFilter(items, filter);
            filtered.forEach(item => {
                if (item.id) {
                    const updatedItem = Object.assign(Object.assign(Object.assign({}, item), data), { id: item.id });
                    this.items.set(item.id, updatedItem);
                }
            });
            // Persistir si está configurado
            if (this.autoSave) {
                yield this.saveToFile();
            }
            return filtered.length;
        });
    }
    /**
     * Eliminar múltiples registros en una operación
     */
    deleteMany(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            const items = Array.from(this.items.values());
            const filtered = this.applyFilter(items, filter);
            filtered.forEach(item => {
                if (item.id) {
                    this.items.delete(item.id);
                }
            });
            // Persistir si está configurado
            if (this.autoSave) {
                yield this.saveToFile();
            }
            return filtered.length;
        });
    }
    /**
     * Guardar todos los datos en archivo
     */
    saveToFile() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.persistPath) {
                return;
            }
            try {
                const data = JSON.stringify(Array.from(this.items.values()), null, 2);
                fs_1.default.writeFileSync(this.persistPath, data, 'utf8');
            }
            catch (error) {
                logger_1.default.error(`Error al guardar ${this.entityName} en archivo`, { error });
            }
        });
    }
    /**
     * Cargar datos desde archivo
     */
    loadFromFile() {
        if (!this.persistPath) {
            return;
        }
        try {
            if (fs_1.default.existsSync(this.persistPath)) {
                const data = fs_1.default.readFileSync(this.persistPath, 'utf8');
                const items = JSON.parse(data);
                // Limpiar mapa actual
                this.items.clear();
                // Cargar items
                items.forEach(item => {
                    if (item.id) {
                        this.items.set(item.id, item);
                    }
                });
                logger_1.default.info(`Cargados ${items.length} ${this.entityName} desde archivo`);
            }
        }
        catch (error) {
            logger_1.default.error(`Error al cargar ${this.entityName} desde archivo`, { error });
        }
    }
    /**
     * Aplicar filtro a una lista de items
     */
    applyFilter(items, filter) {
        return items.filter(item => {
            return Object.entries(filter).every(([key, value]) => {
                // Manejar caso especial de undefined o null
                if (value === undefined || value === null) {
                    return item[key] === value;
                }
                // Comprobar si es un objeto para comparación profunda
                if (typeof value === 'object' && value !== null) {
                    return JSON.stringify(item[key]) === JSON.stringify(value);
                }
                // Comparación simple
                return item[key] === value;
            });
        });
    }
}
exports.MemoryRepository = MemoryRepository;
