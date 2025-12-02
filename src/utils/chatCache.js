// utils/chatCache.js
const logger = require('../conf/logger');

/**
 * Sistema de caché inteligente para chats por cliente
 * Evita llamadas recurrentes a WhatsApp API
 * OPTIMIZADO PARA GRUPOS
 */
class ChatCacheManager {
    constructor() {
        // Caché principal: { clientNumber: Map<chatId, chatData> }
        this.chatCache = new Map();
        
        // Chats sin responder: { clientNumber: Set<chatId> }
        this.unreadChats = new Map();
        
        // 🆕 CACHÉ ESPECÍFICO PARA GRUPOS: { clientNumber: Map<groupId, groupData> }
        this.groupCache = new Map();
        
        // Timestamps de inicialización: { clientNumber: timestamp }
        this.initTimestamps = new Map();
        
        // Estado de carga: { clientNumber: boolean }
        this.isLoaded = new Map();
        
        // 🆕 Estado de carga de grupos: { clientNumber: boolean }
        this.groupsLoaded = new Map();
    }

    /**
     * Inicializar caché de un cliente (solo una vez)
     */
    async initializeCache(clientNumber, chats) {
        try {
            if (this.isLoaded.get(clientNumber)) {
                logger.warn(`[Cache] ${clientNumber} ya está inicializado`);
                return;
            }

            const chatMap = new Map();
            const unreadSet = new Set();
            const groupMap = new Map();

            for (const chat of chats) {
                const chatId = chat.id._serialized;
                
                // Filtrar status@broadcast
                if (chatId === 'status@broadcast') continue;

                const chatData = {
                    id: chatId,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    unreadCount: chat.unreadCount || 0,
                    timestamp: chat.timestamp,
                    lastMessage: null,
                    profilePicUrl: null
                };

                chatMap.set(chatId, chatData);

                // 🆕 Si es grupo, agregarlo al caché de grupos
                if (chat.isGroup) {
                    groupMap.set(chatId, {
                        ...chatData,
                        groupId: chat.id.user,
                        participants: [], // Se llenará bajo demanda
                        participantCount: 0,
                        metadata: null
                    });
                }

                // Si tiene mensajes sin leer, agregarlo
                if (chatData.unreadCount > 0) {
                    unreadSet.add(chatId);
                }
            }

            this.chatCache.set(clientNumber, chatMap);
            this.unreadChats.set(clientNumber, unreadSet);
            this.groupCache.set(clientNumber, groupMap);
            this.isLoaded.set(clientNumber, true);
            this.groupsLoaded.set(clientNumber, true);
            this.initTimestamps.set(clientNumber, Date.now());

            logger.info(`[Cache] ✅ Inicializado para ${clientNumber}: ${chatMap.size} chats (${groupMap.size} grupos), ${unreadSet.size} sin responder`);
        } catch (error) {
            logger.error(`[Cache] Error inicializando ${clientNumber}:`, error);
        }
    }

    /**
     * 🆕 Obtener todos los grupos desde caché (INSTANTÁNEO)
     */
    getAllGroups(clientNumber) {
        const groupMap = this.groupCache.get(clientNumber);
        if (!groupMap) return [];

        return Array.from(groupMap.values())
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * 🆕 Actualizar metadata de grupo (llamado SOLO desde eventos)
     */
    updateGroupMetadata(clientNumber, groupId, metadata) {
        const groupMap = this.groupCache.get(clientNumber);
        if (!groupMap) return;

        const group = groupMap.get(groupId);
        if (!group) return;

        if (metadata.participants) {
            group.participants = metadata.participants.map(p => ({
                id: p.id._serialized,
                isAdmin: p.isAdmin || false,
                isSuperAdmin: p.isSuperAdmin || false,
                name: p.id.user || 'Usuario'
            }));
            group.participantCount = group.participants.length;
        }

        group.metadata = metadata;
        group.name = metadata.subject || group.name;
        
        logger.debug(`[Cache] Metadata actualizada para grupo ${groupId}`);
    }

    /**
     * 🆕 Actualizar foto de perfil de grupo
     */
    updateGroupProfilePic(clientNumber, groupId, profilePicUrl) {
        const groupMap = this.groupCache.get(clientNumber);
        if (!groupMap) return;

        const group = groupMap.get(groupId);
        if (group) {
            group.profilePicUrl = profilePicUrl;
        }
    }

    /**
     * 🆕 Agregar grupo nuevo (desde evento group_join)
     */
    addGroup(clientNumber, groupData) {
        const groupMap = this.groupCache.get(clientNumber);
        const chatMap = this.chatCache.get(clientNumber);
        
        if (!groupMap || !chatMap) return;

        const groupId = groupData.id._serialized;
        
        const newGroup = {
            id: groupId,
            groupId: groupData.id.user,
            name: groupData.name,
            isGroup: true,
            unreadCount: 0,
            timestamp: Date.now(),
            lastMessage: null,
            profilePicUrl: null,
            participants: [],
            participantCount: 0,
            metadata: null
        };

        groupMap.set(groupId, newGroup);
        chatMap.set(groupId, {
            id: groupId,
            name: groupData.name,
            isGroup: true,
            unreadCount: 0,
            timestamp: Date.now(),
            lastMessage: null,
            profilePicUrl: null
        });

        logger.info(`[Cache] ➕ Nuevo grupo agregado: ${groupId}`);
    }

    /**
     * 🆕 Remover grupo (desde evento group_leave)
     */
    removeGroup(clientNumber, groupId) {
        const groupMap = this.groupCache.get(clientNumber);
        const chatMap = this.chatCache.get(clientNumber);
        
        if (groupMap) groupMap.delete(groupId);
        if (chatMap) chatMap.delete(groupId);
        
        logger.info(`[Cache] ➖ Grupo removido: ${groupId}`);
    }

    /**
     * 🆕 Verificar si los grupos están cargados
     */
    areGroupsLoaded(clientNumber) {
        return this.groupsLoaded.get(clientNumber) || false;
    }

    /**
     * Agregar/actualizar chat en caché (sin consultar WhatsApp)
     */
    updateChat(clientNumber, chatId, updates) {
        const clientCache = this.chatCache.get(clientNumber);
        if (!clientCache) return;

        const existing = clientCache.get(chatId) || {};
        const updated = { ...existing, ...updates, id: chatId };
        
        clientCache.set(chatId, updated);

        // 🆕 Si es grupo, actualizar también en caché de grupos
        if (updated.isGroup) {
            const groupMap = this.groupCache.get(clientNumber);
            if (groupMap) {
                const groupData = groupMap.get(chatId);
                if (groupData) {
                    Object.assign(groupData, updates);
                }
            }
        }
    }

    /**
     * Incrementar contador de no leídos (mensaje entrante)
     */
    markAsUnread(clientNumber, chatId, incrementBy = 1) {
        const clientCache = this.chatCache.get(clientNumber);
        const unreadSet = this.unreadChats.get(clientNumber);
        
        if (!clientCache || !unreadSet) return;

        // Actualizar contador
        const chat = clientCache.get(chatId);
        if (chat) {
            chat.unreadCount = (chat.unreadCount || 0) + incrementBy;
            chat.timestamp = Date.now();

            // 🆕 Si es grupo, actualizar también en caché de grupos
            if (chat.isGroup) {
                const groupMap = this.groupCache.get(clientNumber);
                const group = groupMap?.get(chatId);
                if (group) {
                    group.unreadCount = chat.unreadCount;
                    group.timestamp = chat.timestamp;
                }
            }
        }

        // Agregar a conjunto de sin responder
        unreadSet.add(chatId);
        
        logger.debug(`[Cache] ${clientNumber} - Chat ${chatId} marcado sin responder (${chat?.unreadCount || 0})`);
    }

    /**
     * Marcar como leído (mensaje saliente)
     */
    markAsRead(clientNumber, chatId) {
        const clientCache = this.chatCache.get(clientNumber);
        const unreadSet = this.unreadChats.get(clientNumber);
        
        if (!clientCache || !unreadSet) return;

        // Resetear contador
        const chat = clientCache.get(chatId);
        if (chat) {
            chat.unreadCount = 0;
            chat.timestamp = Date.now();

            // 🆕 Si es grupo, actualizar también en caché de grupos
            if (chat.isGroup) {
                const groupMap = this.groupCache.get(clientNumber);
                const group = groupMap?.get(chatId);
                if (group) {
                    group.unreadCount = 0;
                    group.timestamp = chat.timestamp;
                }
            }
        }

        // Remover de conjunto de sin responder
        unreadSet.delete(chatId);
        
        logger.debug(`[Cache] ${clientNumber} - Chat ${chatId} marcado como leído`);
    }

    /**
     * Obtener chats sin responder
     */
    getUnreadChats(clientNumber) {
        const clientCache = this.chatCache.get(clientNumber);
        const unreadSet = this.unreadChats.get(clientNumber);
        
        if (!clientCache || !unreadSet) return [];

        return Array.from(unreadSet)
            .map(chatId => clientCache.get(chatId))
            .filter(Boolean)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Obtener todos los chats
     */
    getAllChats(clientNumber) {
        const clientCache = this.chatCache.get(clientNumber);
        if (!clientCache) return [];

        return Array.from(clientCache.values())
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Verificar si está inicializado
     */
    isCacheReady(clientNumber) {
        return this.isLoaded.get(clientNumber) || false;
    }

    /**
     * Limpiar caché de un cliente
     */
    clearCache(clientNumber) {
        this.chatCache.delete(clientNumber);
        this.unreadChats.delete(clientNumber);
        this.groupCache.delete(clientNumber);
        this.isLoaded.delete(clientNumber);
        this.groupsLoaded.delete(clientNumber);
        this.initTimestamps.delete(clientNumber);
        
        logger.info(`[Cache] Limpiado para ${clientNumber}`);
    }

    /**
     * Obtener referencia al objeto chat original (si existe en cliente)
     */
    async getFullChatData(clientNumber, chatId, client) {
        try {
            const fullChat = await client.getChatById(chatId);
            return fullChat;
        } catch (error) {
            logger.warn(`[Cache] No se pudo obtener chat completo ${chatId}:`, error.message);
            return null;
        }
    }

    /**
     * Verificar si un chat existe en caché
     */
    hasChatInCache(clientNumber, chatId) {
        const clientCache = this.chatCache.get(clientNumber);
        return clientCache ? clientCache.has(chatId) : false;
    }

    /**
     * Obtener estadísticas
     */
    getStats(clientNumber) {
        const clientCache = this.chatCache.get(clientNumber);
        const unreadSet = this.unreadChats.get(clientNumber);
        const groupMap = this.groupCache.get(clientNumber);
        
        return {
            isLoaded: this.isLoaded.get(clientNumber) || false,
            totalChats: clientCache?.size || 0,
            totalGroups: groupMap?.size || 0,
            unreadCount: unreadSet?.size || 0,
            initTime: this.initTimestamps.get(clientNumber) || null
        };
    }
}

module.exports = new ChatCacheManager();