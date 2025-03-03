"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
exports.QueueRepository = void 0;
// src/database/repositories/queue.repository.ts
const memory_repository_1 = require("./memory.repository");
const path_1 = __importDefault(require("path"));
const database_config_1 = __importStar(require("../../config/database.config"));
/**
 * Repositorio para gestión de cola de espera
 */
class QueueRepository {
    constructor() {
        switch (database_config_1.default.type) {
            case database_config_1.DatabaseType.MEMORY:
            default:
                this.repository = new memory_repository_1.MemoryRepository('queue', path_1.default.join(__dirname, '../../../data/queue.json'));
                break;
        }
    }
    create(data) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.create(data);
        });
    }
    findById(id) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findById(id);
        });
    }
    findAll(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findAll(filter);
        });
    }
    update(id, data) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.update(id, data);
        });
    }
    delete(id) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.delete(id);
        });
    }
    findOne(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findOne(filter);
        });
    }
    count(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.count(filter);
        });
    }
    createMany(items) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.createMany(items);
        });
    }
    updateMany(filter, data) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.updateMany(filter, data);
        });
    }
    deleteMany(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.deleteMany(filter);
        });
    }
    /**
     * Buscar conversaciones en cola sin asignar
     */
    findUnassigned() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findAll({ assignedAgent: null });
        });
    }
    /**
     * Buscar conversaciones asignadas a un agente específico
     */
    findByAgent(agentId) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findAll({ assignedAgent: agentId });
        });
    }
    /**
     * Buscar conversaciones por prioridad
     */
    findByPriority(priority) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findAll({ priority });
        });
    }
    /**
     * Encontrar la conversación más antigua sin asignar
     */
    findOldestUnassigned() {
        return __awaiter(this, void 0, void 0, function* () {
            const unassigned = yield this.findUnassigned();
            if (unassigned.length === 0) {
                return null;
            }
            // Ordenar por tiempo de inicio y prioridad
            return unassigned.sort((a, b) => {
                // Primero por prioridad (mayor primero)
                if (a.priority !== b.priority) {
                    return b.priority - a.priority;
                }
                // Luego por tiempo de espera (más antiguo primero)
                return a.startTime - b.startTime;
            })[0];
        });
    }
}
exports.QueueRepository = QueueRepository;
