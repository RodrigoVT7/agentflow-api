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
exports.AgentRepository = void 0;
// src/database/repositories/agent.repository.ts
const memory_repository_1 = require("./memory.repository");
const path_1 = __importDefault(require("path"));
const database_config_1 = __importStar(require("../../config/database.config"));
/**
 * Repositorio para gestión de agentes
 */
class AgentRepository {
    constructor() {
        // Según el tipo de base de datos, inicializar el repositorio correspondiente
        switch (database_config_1.default.type) {
            case database_config_1.DatabaseType.MEMORY:
            default:
                // Usar repositorio en memoria con persistencia a archivo
                this.repository = new memory_repository_1.MemoryRepository('agents', path_1.default.join(__dirname, '../../../data/agents.json'));
                break;
            // Aquí se pueden añadir implementaciones para otros tipos de base de datos
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
    /**
     * Buscar un agente por email
     */
    findByEmail(email) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findOne({ email });
        });
    }
    /**
     * Obtener agentes por estado
     */
    findByStatus(status) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.repository.findAll({ status });
        });
    }
    /**
     * Obtener agentes disponibles (online y no ocupados)
     */
    findAvailableAgents() {
        return __awaiter(this, void 0, void 0, function* () {
            // En una implementación real con SQL, esto sería una consulta más compleja
            const agents = yield this.repository.findAll();
            return agents.filter(agent => agent.status === 'online' &&
                agent.activeConversations.length < agent.maxConcurrentChats);
        });
    }
}
exports.AgentRepository = AgentRepository;
