require('dotenv').config();

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { NotFoundError, ValidationError } = require('../utils/asyncHandler');
const logger = require('../conf/logger');
const { AES } = require('../utils/encryption');
const WhatsAppClient = require('../lib/whatsapp');

const stateManager = require('../utils/clientStateManager');
const reconnectionManager = require('../utils/reconnectionManager');
const chatCache = require('../utils/chatCache');

// Obtener la clave del archivo .env
const encryptionKey = process.env.PASS_ENCRYPTED;
if (!encryptionKey) {
  throw new Error("No se encontró la clave de cifrado en .env");
}
const aesInstance = new AES(encryptionKey);

class WhatsAppService {
  constructor() {
    this.CONTACTS_PER_PAGE = 30;
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();

    // Importar cola de media
    this.mediaQueue = require('../utils/mediaQueue');
    this.QUICK_DOWNLOAD_TIMEOUT = 3000; // Umbral para considerar descarga "rápida" (3 segundos)
  }

  /**
   * Get health metrics for monitoring
   * @param {string} number - Optional client number
   * @returns {Object} Health metrics
   */
  async getHealthMetrics(number = null) {
      return WhatsAppClient.getHealthMetrics(number);
  }

  /**
   * Force reconnection for a client
   * @param {string} number - Client number
   * @returns {Promise<boolean>}
   */
  async forceReconnect(number) {
    const client = WhatsAppClient.getClient(number);
    if (!client) {
      throw new NotFoundError(`Client ${number} not found`);
    }
    
    return await WhatsAppClient.forceReconnect(number);
  }

  /**
   * Get detailed state information for a client
   * @param {string} number - Client number
   * @returns {Object} State information
   */
  async getClientStateInfo(number) {
    const client = WhatsAppClient.getClient(number);
    if (!client) {
      throw new NotFoundError(`Client ${number} not found`);
    }

    const state = stateManager.getState(number);
    const history = stateManager.getHistory(number);
    const reconnectionStatus = reconnectionManager.getStatus(number);
    
    return {
      number,
      currentState: state,
      stateHistory: history.slice(-10), // Últimos 10 cambios
      reconnection: reconnectionStatus,
      isHealthy: stateManager.isHealthy(number),
      isRecoverable: stateManager.isRecoverable(number),
      browserConnected: client.pupBrowser?.isConnected() || false,
      hasInfo: Boolean(client.info),

      // Información adicional útil
      lastStateChange: state?.timestamp,
      stateAge: stateManager.getStateAge(number)
    };
  }

  /**
   * Get reconnection status for all clients
   * @returns {Array} Reconnection status for all clients
   */
  async getReconnectionStatus() {
    const clients = Array.from(WhatsAppClient.clients.keys());
    
    return clients.map(number => {
      const state = stateManager.getState(number);
      return {
        number,
        ...reconnectionManager.getStatus(number),
        currentState: state?.state,
        isHealthy: stateManager.isHealthy(number),
        stateAge: stateManager.getStateAge(number)
      };
    });
  }

  /**
   * Clean temporary media files older than specified days
   * @param {number} olderThanDays - Delete files older than this many days
   * @returns {Promise<Object>} Cleanup results
   */
  async cleanTempMediaFiles(olderThanDays) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      
      const files = await fs.readdir(this.tempDir);
      let deletedCount = 0;
      let bytesFreed = 0;
      const errors = [];

      for (const file of files) {
        try {
          const filePath = path.join(this.tempDir, file);
          const stats = await fs.stat(filePath);
          
          // Verificar si el archivo es más antiguo que el cutoff
          if (stats.mtime < cutoffDate) {
            bytesFreed += stats.size;
            await fs.unlink(filePath);
            deletedCount++;
            logger.info(`Deleted temp file: ${file} (${stats.size} bytes)`);
          }
        } catch (error) {
          logger.error(`Error deleting file ${file}:`, error);
          errors.push({ file, error: error.message });
        }
      }

      logger.info(`Temp cleanup completed: ${deletedCount} files deleted, ${bytesFreed} bytes freed`);
      
      return {
        deletedCount,
        bytesFreed,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      logger.error('Error in cleanTempMediaFiles:', error);
      throw error;
    }
  }

  /**
   * Check if client exists
   * @param {string} number - Phone number
   * @returns {Promise<boolean>} - Whether client exists
   */
  async checkClientExists(number) {
    const client = WhatsAppClient.getClient(number);
    return !!client;
  }

  async checkClientStatus(number) {
    const client = WhatsAppClient.getClient(number);
    
    if (!client) {
      return {
        exists: false,
        authenticated: false,
        ready: false,
        state: null,
        browserConnected: false
      };
    }

    const isAuthenticated = WhatsAppClient.isAuthenticated(number);
    const isReady = WhatsAppClient.isReady(number);
    const state = stateManager.getState(number);
    
    return {
      exists: true,
      authenticated: isAuthenticated,
      ready: isReady,
      state: state?.state,
      stateAge: stateManager.getStateAge(number),
      browserConnected: client.pupBrowser?.isConnected() || false,
      isHealthy: stateManager.isHealthy(number)
    };
  }

  /**
   * Refresh client to generate new QR
   * @param {string} number - Phone number
   */
  async refreshClient(number) {
    const client = WhatsAppClient.getClient(number);
    
    if (!client) {
      logger.info(`[Service] Creating new client for ${number}`);
      await WhatsAppClient.addClient(number);
      return;
    }

    logger.info(`[Service] Refreshing client ${number} to generate new QR`);
    
    // Actualizar estado
    stateManager.setState(number, stateManager.CLIENT_STATES.INITIALIZING, {
      reason: 'Manual refresh requested via service'
    });

    try {
      // Si el cliente existe pero no está autenticado
      if (!WhatsAppClient.isAuthenticated(number)) {
        // Usar el método de recuperación del cliente
        await WhatsAppClient.recoverClient(number);
      } else {
        // Si está autenticado pero se solicita refresh, reinicializar
        await client.initialize();
      }
    } catch (error) {
      logger.error(`[Service] Error refreshing client ${number}:`, error);
      
      // Si falla el refresh, intentar recuperación completa
      stateManager.setState(number, stateManager.CLIENT_STATES.ERROR, {
        reason: 'Refresh failed, attempting recovery',
        error: error.message
      });
      
      await WhatsAppClient.recoverClient(number);
    }
  }

  // Part I ----------------------------------------------------------------------------------------------------------------

  /**
   * Get client QR code
   * @param {string} number - Client number
   * @returns {Promise<string>} QR code
   */

  async getClientQr(number) {
    const qrCode = WhatsAppClient.getQr(number);
    // Para debugging
    console.log(`Obteniendo QR para ${number}: ${qrCode ? 'disponible' : 'no disponible'}`);
    return qrCode;
  }

  /**
   * Check client authentication status
   * @param {string} number - Client number
   * @returns {Promise<boolean>} Authentication status
   */

  async checkClientAuth(number) {
    return WhatsAppClient.isAuthenticated(number);
  }

  /**
   * Create new WhatsApp client
   * @param {string} number - Client number
   * @param {Object} sessionData - Client session data
   */

  async createClient(number) {
    try {
      await WhatsAppClient.addClient(number);
    } catch (error) {
      logger.error(`Error creating client: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete WhatsApp client
   * @param {string} number - Client number
   */

  async deleteClient(number) {
    try {
      await WhatsAppClient.removeClient(number);
    } catch (error) {
      logger.error(`Error removing client: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create contact for specific client
   * @param {string} clientNumber - Client number
   * @param {string} contactNumber - Contact number
   * @param {string} contactName - Contact name
   */

  async createContact(clientNumber, contactNumber, contactName) {
    const client = WhatsAppClient.getClient(clientNumber);
    if (!client) {
      throw new NotFoundError('Client not found');
    }

    const formattedNumber = this.formatContactNumber(contactNumber);
    const contact = await client.createContact(formattedNumber, contactName);
    
    if (!contact) {
      throw new Error('Failed to create contact');
    }
  }

  /**
   * Fetch unread chats with pagination
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Paginated unread chats
   */
  /*
  async fetchUnreadChats(page, limit) {
    try {
      const clients = Array.from(WhatsAppClient.clients.values());
      
      if (!clients || clients.length === 0) {
        logger.warn('No hay clientes disponibles');
        return {
          chats: [],
          totalUnreadChats: 0,
          totalPages: 0,
          currentPage: page,
          message: 'No clients available'
        };
      }

      // Filtrar clientes listos
      const readyClients = clients.filter(client => {
        const number = client.options?.authStrategy?.clientId;
        if (!number) return false;
        return WhatsAppClient.isReady(number) && 
              Boolean(client.pupPage) && 
              Boolean(client.pupBrowser?.isConnected());
      });

      if (readyClients.length === 0) {
        logger.warn('Ningún cliente está listo');
        return {
          chats: [],
          totalUnreadChats: 0,
          totalPages: 0,
          currentPage: page,
          message: 'No clients ready'
        };
      }

      let unreadChats = [];

      for (const client of readyClients) {
        try {
          const clientChats = await this.getClientUnreadChats(client);
          unreadChats = unreadChats.concat(clientChats);
        } catch (error) {
          const number = client.options?.authStrategy?.clientId;
          logger.error(`Error obteniendo chats no leídos del cliente ${number}:`, error.message);
        }
      }

      unreadChats.sort((a, b) => b.recentMessageDate - a.recentMessageDate);

      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const totalUnreadChats = unreadChats.length;

      return {
        chats: unreadChats.slice(startIndex, endIndex),
        totalUnreadChats,
        totalPages: Math.ceil(totalUnreadChats / limit),
        currentPage: page
      };
    } catch (error) {
      logger.error('Error al obtener chats no leídos:', error);
      throw new Error(`Failed to fetch unread chats: ${error.message}`);
    }
  }*/

    async fetchUnreadChats(page, limit) {
    try {
        const clients = Array.from(WhatsAppClient.clients.entries());
        
        if (!clients || clients.length === 0) {
            return {
                chats: [],
                totalUnreadChats: 0,
                totalPages: 0,
                currentPage: page,
                message: 'No clients available'
            };
        }

        let allUnreadChats = [];

        for (const [number, client] of clients) {
            try {
                // Verificar que el cliente esté operativo
                if (!WhatsAppClient.isReady(number)) {
                    logger.warn(`[Service] Cliente ${number} no está listo`);
                    continue;
                }

                // Verificar que el caché esté listo
                if (!chatCache.isCacheReady(number)) {
                    logger.warn(`[Service] Caché no listo para ${number}, omitiendo...`);
                    continue;
                }

                // Obtener IDs de chats sin responder desde caché (rápido)
                const unreadChatIds = chatCache.getUnreadChats(number);
                
                if (unreadChatIds.length === 0) continue;

                // Obtener datos COMPLETOS de cada chat sin responder
                const fullUnreadChats = await Promise.all(
                    unreadChatIds.map(async (cachedChat) => {
                        try {
                            // Obtener chat completo desde cliente
                            const fullChat = await chatCache.getFullChatData(
                                number, 
                                cachedChat.id, 
                                client
                            );

                            if (!fullChat) {
                                // Fallback: usar datos del caché
                                return await this.processChatFromCache(cachedChat, client, number);
                            }

                            // Procesar chat completo
                            return await this.processChat(fullChat, client);
                            
                        } catch (error) {
                            logger.warn(`[Service] Error procesando chat ${cachedChat.id}:`, error.message);
                            return null;
                        }
                    })
                );

                // Filtrar nulls y agregar a lista
                allUnreadChats = allUnreadChats.concat(
                    fullUnreadChats.filter(Boolean)
                );
                
            } catch (error) {
                logger.error(`[Service] Error obteniendo chats no leídos de ${number}:`, error.message);
            }
        }

        // Ordenar por timestamp
        allUnreadChats.sort((a, b) => b.timestamp - a.timestamp);

        // Paginación
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;
        const totalUnreadChats = allUnreadChats.length;

        return {
            chats: allUnreadChats.slice(startIndex, endIndex),
            totalUnreadChats,
            totalPages: Math.ceil(totalUnreadChats / limit),
            currentPage: page
        };
    } catch (error) {
        logger.error('[Service] Error en fetchUnreadChats:', error);
        throw new Error(`Failed to fetch unread chats: ${error.message}`);
    }
}

  /**
   * Get unread chats for specific client
   * @param {Object} client - WhatsApp client instance
   * @returns {Promise<Array>} Unread chats
   */
  async getClientUnreadChats(client) {
    try {
      const number = client.options?.authStrategy?.clientId;
      
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('getChats timeout')), 15000)
        )
      ]);
      
      if (!chats || !Array.isArray(chats)) {
        logger.warn(`No se obtuvieron chats del cliente ${number}`);
        return [];
      }

      const unreadChats = chats.filter(chat => chat.unreadCount > 0);
      return Promise.all(unreadChats.map(chat => this.processChat(chat, client)));
    } catch (error) {
      const number = client.options?.authStrategy?.clientId;
      logger.error(`Error obteniendo chats no leídos para ${number}:`, error.message);
      return [];
    }
  }

  /**
   * Get all group chats with their members
   * @param {string} clientId - Client ID
   * @returns {Promise<Array>} List of group chats with members
   */
  /*
  async getGroupChats(clientId) {
    try {
      const client = await this.getClientById(clientId);
      
      if (!client) {
        throw new NotFoundError('Client not found');
      }

      const chats = await client.getChats();
      const groupChats = chats.filter(chat => chat.isGroup);

      // Process each group chat
      const processedGroups = await Promise.all(
        groupChats.map(async (chat) => {
          try {
            // 🔹 Filtrar status@broadcast
            if (chat.id._serialized === 'status@broadcast') {
              return null;
            }

            const profilePicUrl = await this.getProfilePicture(client, chat.id._serialized);
            const recentMessageDate = await this.getRecentMessageDate(chat);
            
            // 🔹 FIX: Obtener metadata del grupo para acceder a participants
            let groupData = [];
            try {
              // Usar groupMetadata en lugar de participants directo
              const metadata = chat.groupMetadata || await chat.getGroupMetadata();
              if (metadata && metadata.participants) {
                groupData = await this.getGroupDataFromMetadata(metadata.participants, client);
              }
            } catch (metadataError) {
              logger.warn(`No se pudo obtener metadata del grupo ${chat.id._serialized}:`, metadataError.message);
            }

            return {
              id: chat.id._serialized,
              groupId: chat.id.user,
              name: chat.name,
              isGroup: chat.isGroup,
              unreadCount: chat.unreadCount || 0,
              timestamp: chat.timestamp,
              recentMessageDate,
              profilePicUrl,
              participants: groupData,
              participantCount: groupData.length,
              client: client.options.authStrategy.clientId
            };
          } catch (error) {
            logger.error(`Error processing group ${chat.id._serialized}:`, error.message);
            return null;
          }
        })
      );

      // Filter out null results (including status@broadcast) and sort by recent message date
      return processedGroups
        .filter(group => group !== null)
        .sort((a, b) => b.recentMessageDate - a.recentMessageDate);

    } catch (error) {
      logger.error('Error fetching group chats:', error);
      throw error;
    }
  }*/

  async getGroupChats(clientId) {
    try {
        const client = WhatsAppClient.getClient(clientId);
        
        if (!client) {
            throw new NotFoundError('Client not found');
        }

        // 🔹 VERIFICAR QUE EL CACHÉ ESTÉ LISTO
        if (!chatCache.areGroupsLoaded(clientId)) {
            logger.warn(`[Service] Caché de grupos no listo para ${clientId}, esperando...`);
            
            // Esperar hasta 3 segundos a que se cargue
            const maxWait = 3000;
            const startWait = Date.now();
            
            while (!chatCache.areGroupsLoaded(clientId) && (Date.now() - startWait) < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            if (!chatCache.areGroupsLoaded(clientId)) {
                // Si después de esperar no está listo, cargar ahora
                logger.info(`[Service] Forzando inicialización de caché para ${clientId}`);
                const chats = await client.getChats();
                await chatCache.initializeCache(clientId, chats);
            }
        }

        // 🚀 OBTENER GRUPOS DESDE CACHÉ (INSTANTÁNEO)
        const cachedGroups = chatCache.getAllGroups(clientId);
        
        logger.info(`[Service] ⚡ ${cachedGroups.length} grupos obtenidos desde caché en <50ms`);

        // 🔹 ENRIQUECER DATOS BAJO DEMANDA (solo lo necesario)
        const enrichedGroups = await Promise.all(
            cachedGroups.map(async (group) => {
                try {
                    // Si no tiene foto de perfil, obtenerla (solo una vez)
                    if (!group.profilePicUrl) {
                        try {
                            const profilePicUrl = await this.getProfilePicture(client, group.id);
                            group.profilePicUrl = profilePicUrl;
                            
                            // Guardar en caché para futuras consultas
                            chatCache.updateGroupProfilePic(clientId, group.id, profilePicUrl);
                        } catch (picError) {
                            group.profilePicUrl = this.getDefaultProfilePic();
                        }
                    }

                    // Si no tiene participantes Y se requieren, obtenerlos (lazy loading)
                    if (group.participants.length === 0) {
                        try {
                            // Obtener metadata solo si no está en caché
                            if (!group.metadata) {
                                const chat = await client.getChatById(group.id);
                                const metadata = chat.groupMetadata || await chat.getGroupMetadata();
                                
                                // Guardar metadata en caché
                                chatCache.updateGroupMetadata(clientId, group.id, metadata);
                                
                                group.participants = metadata.participants ? 
                                    metadata.participants.slice(0, 50).map(p => ({
                                        id: p.id._serialized,
                                        isAdmin: p.isAdmin || false,
                                        isSuperAdmin: p.isSuperAdmin || false,
                                        name: p.id.user || 'Usuario'
                                    })) : [];
                                
                                group.participantCount = metadata.participants?.length || 0;
                            } else {
                                // Usar metadata del caché
                                group.participantCount = group.participants.length;
                            }
                        } catch (metadataError) {
                            logger.warn(`[Service] No se pudo obtener metadata del grupo ${group.id}:`, metadataError.message);
                            group.participants = [];
                            group.participantCount = 0;
                        }
                    }

                    return {
                        id: group.id,
                        groupId: group.groupId,
                        name: group.name,
                        isGroup: true,
                        unreadCount: group.unreadCount || 0,
                        timestamp: group.timestamp,
                        recentMessageDate: group.timestamp,
                        profilePicUrl: group.profilePicUrl || this.getDefaultProfilePic(),
                        participants: group.participants,
                        participantCount: group.participantCount,
                        client: clientId
                    };
                } catch (error) {
                    logger.error(`[Service] Error procesando grupo ${group.id}:`, error.message);
                    return null;
                }
            })
        );

        // Filtrar nulls y ordenar
        return enrichedGroups
            .filter(group => group !== null)
            .sort((a, b) => b.recentMessageDate - a.recentMessageDate);

    } catch (error) {
        logger.error('[Service] Error fetching group chats:', error);
        throw error;
    }
  }

   /**
   * Fetch chats with pagination
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Paginated unread chats
   */
  /*
  async fetchChats(page, limit) {
    try {
      const clients = Array.from(WhatsAppClient.clients.values());
      
      if (!clients || clients.length === 0) {
        logger.warn('No hay clientes disponibles para obtener chats');
        return {
          chats: [],
          totalUnreadChats: 0,
          totalPages: 0,
          currentPage: page,
          message: 'No clients available'
        };
      }

      // 🔹 FIX: Filtrar solo clientes completamente listos
      const readyClients = clients.filter(client => {
        const number = client.options?.authStrategy?.clientId;
        if (!number) return false;
        return WhatsAppClient.isReady(number) && 
              Boolean(client.pupPage) && 
              Boolean(client.pupBrowser?.isConnected());
      });

      if (readyClients.length === 0) {
        logger.warn('Ningún cliente está listo para operaciones');
        return {
          chats: [],
          totalUnreadChats: 0,
          totalPages: 0,
          currentPage: page,
          message: 'No clients ready'
        };
      }

      let allChats = [];
    
      for (const client of readyClients) {
        try {
          const clientChats = await this.getClientChats(client);
          allChats = allChats.concat(clientChats);
        } catch (error) {
          const number = client.options?.authStrategy?.clientId;
          logger.error(`Error obteniendo chats del cliente ${number}:`, error.message);
          // Continuar con siguiente cliente
        }
      }
    
      allChats.sort((a, b) => b.timestamp - a.timestamp);
    
      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const totalUnreadChats = allChats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0);
    
      return {
        chats: allChats.slice(startIndex, endIndex),
        totalUnreadChats,
        totalPages: Math.ceil(allChats.length / limit),
        currentPage: page,
        totalChats: allChats.length
      };
    } catch (error) {
      logger.error('Error al obtener chats:', error);
      throw new Error(`Failed to fetch chats: ${error.message}`);
    }
  }*/

  async fetchChats(page, limit) {
    try {
        const clients = Array.from(WhatsAppClient.clients.entries());
        
        if (!clients || clients.length === 0) {
            return {
                chats: [],
                totalUnreadChats: 0,
                totalPages: 0,
                currentPage: page,
                totalChats: 0,
                message: 'No clients available'
            };
        }

        let allChats = [];

        for (const [number, client] of clients) {
            try {
                // Verificar que el cliente esté operativo
                if (!WhatsAppClient.isReady(number)) {
                    logger.warn(`[Service] Cliente ${number} no está listo`);
                    continue;
                }

                // Verificar que el caché esté listo
                if (!chatCache.isCacheReady(number)) {
                    logger.warn(`[Service] Caché no listo para ${number}, omitiendo...`);
                    continue;
                }

                // Obtener todos los chat IDs desde caché
                const cachedChats = chatCache.getAllChats(number);
                
                if (cachedChats.length === 0) continue;

                // Obtener datos COMPLETOS de cada chat
                const fullChats = await Promise.all(
                    cachedChats.map(async (cachedChat) => {
                        try {
                            // Obtener chat completo desde cliente
                            const fullChat = await chatCache.getFullChatData(
                                number, 
                                cachedChat.id, 
                                client
                            );

                            if (!fullChat) {
                                // Fallback: usar datos del caché
                                return await this.processChatFromCache(cachedChat, client, number);
                            }

                            // Procesar chat completo
                            return await this.processChat(fullChat, client);
                            
                        } catch (error) {
                            logger.warn(`[Service] Error procesando chat ${cachedChat.id}:`, error.message);
                            return null;
                        }
                    })
                );

                // Filtrar nulls y agregar a lista
                allChats = allChats.concat(fullChats.filter(Boolean));
                
            } catch (error) {
                logger.error(`[Service] Error obteniendo chats de ${number}:`, error.message);
            }
        }

        // Ordenar por timestamp
        allChats.sort((a, b) => b.timestamp - a.timestamp);

        // Paginación
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;
        
        const totalUnreadChats = allChats.reduce((sum, chat) => 
            sum + (chat.unreadCount || 0), 0
        );

        return {
            chats: allChats.slice(startIndex, endIndex),
            totalUnreadChats,
            totalPages: Math.ceil(allChats.length / limit),
            currentPage: page,
            totalChats: allChats.length
        };
    } catch (error) {
        logger.error('[Service] Error en fetchChats:', error);
        throw new Error(`Failed to fetch chats: ${error.message}`);
    }
  }

/**
 * Process chat from cache data (fallback when full chat not available)
 * @param {Object} cachedChat - Chat data from cache
 * @param {Object} client - WhatsApp client instance
 * @param {string} clientNumber - Client number
 * @returns {Promise<Object>} Processed chat
 * @private
 */
async processChatFromCache(cachedChat, client, clientNumber) {
    try {
        const profilePicUrl = await this.getProfilePicture(client, cachedChat.id);

        return {
            id: {
                server: cachedChat.isGroup ? 'g.us' : 'c.us',
                user: cachedChat.id.replace('@c.us', '').replace('@g.us', ''),
                _serialized: cachedChat.id
            },
            name: cachedChat.name || 'Unknown',
            isGroup: cachedChat.isGroup || false,
            isReadOnly: false,
            unreadCount: cachedChat.unreadCount || 0,
            timestamp: cachedChat.timestamp,
            archived: false,
            pinned: false,
            isMuted: false,
            muteExpiration: 0,
            lastMessage: cachedChat.lastMessage ? {
                body: cachedChat.lastMessage,
                timestamp: cachedChat.timestamp
            } : null,
            recentMessageDate: cachedChat.timestamp || 0,
            profilePicUrl: profilePicUrl || this.getDefaultProfilePic(),
            groupData: [],
            client: clientNumber
        };
    } catch (error) {
        logger.error('Error processing chat from cache:', error);
        return null;
    }
}

  /**
   * Get chats for specific client
   * @param {Object} client - WhatsApp client instance
   * @returns {Promise<Array>} Unread chats
   */
  
  async getClientChats(client) {
    try {
      const number = client.options?.authStrategy?.clientId;
      
      // 🔹 FIX: Agregar timeout
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('getChats timeout')), 15000)
        )
      ]);
      
      if (!chats || !Array.isArray(chats)) {
        logger.warn(`No se obtuvieron chats del cliente ${number}`);
        return [];
      }
      
      return Promise.all(chats.map(chat => this.processChat(chat, client)));
    } catch (error) {
      const number = client.options?.authStrategy?.clientId;
      logger.error(`Error obteniendo chats para ${number}:`, error.message);
      return []; 
    }
  }
  
  /**
   * Process chat to get additional details
   * @param {Object} chat - Chat object
   * @param {Object} client - WhatsApp client instance
   * @returns {Promise<Object>} Processed chat
   */

  async processChat(chat, client) {
    try {
      const contact = await chat.getContact();
      const profilePicUrl = await this.getProfilePicture(client, contact.id._serialized);
      const recentMessageDate = await this.getRecentMessageDate(chat);
      const groupData = chat.id.server === 'g.us' ? await this.getGroupData(chat, client) : [];

      return {
        ...chat,
        recentMessageDate,
        profilePicUrl,
        groupData,
        client: client.options.authStrategy.clientId
      };
    } catch (error) {
      logger.error(`Error processing chat: ${error.message}`);
      return this.getDefaultChatData(chat, client);
    }
  }

  /**
   * Mark chat as read
   * @param {string} clientId - Client ID
   * @param {string} tel - Phone number
   * @param {boolean} isGroup - Is group chat
   */

  async markChatRead(clientId, tel, isGroup) {
    const client = WhatsAppClient.getClient(clientId);
    if (!client) {
      throw new NotFoundError('Client not found');
    }

    const chatId = this.formatChatId(tel, isGroup);
    const chat = await client.getChatById(chatId);
    
    if (!chat) {
      throw new NotFoundError('Chat not found');
    }

    await chat.sendSeen();
  }

  /**
   * Mark chat as unread
   * @param {string} clientId - Client ID
   * @param {string} tel - Phone number
   * @param {boolean} isGroup - Is group chat
   */

  async markChatUnread(clientId, tel, isGroup) {
    const client = WhatsAppClient.getClient(clientId);
    if (!client) {
      throw new NotFoundError('Client not found');
    }

    const chatId = this.formatChatId(tel, isGroup);
    const chat = await client.getChatById(chatId);
    
    if (!chat) {
      throw new NotFoundError('Chat not found');
    }

    await chat.markUnread();
  }

  /**
   * Fetch contacts with pagination
   * @param {number} page - Page number
   * @returns {Promise<Array>} Contacts list
   */
  
  async fetchContacts(page) {
    try {
      const clients = Array.from(WhatsAppClient.clients.values());

      if (!clients || clients.length === 0) {
        logger.warn('No hay clientes de WhatsApp disponibles');
        // 🔹 FIX: Retornar estructura consistente
        return {
          contacts: [],
          totalContacts: 0,
          currentPage: page,
          message: 'No clients available'
        };
      }

      // 🔹 FIX: Verificar que los clientes estén REALMENTE listos
      const readyClients = clients.filter(client => {
        let number = 'unknown';
        try {
          number = client.options?.authStrategy?.clientId || 
                  client.info?.wid?.user || 
                  client.info?.me?.user || 
                  'unknown';
        } catch (e) {
          return false;
        }
        
        if (!number || number === 'unknown') {
          logger.warn('Cliente sin número identificable, omitiendo...');
          return false;
        }
        
        // Verificar que tenga el método getContacts
        if (!client.getContacts || typeof client.getContacts !== 'function') {
          logger.warn(`Cliente ${number} no tiene método getContacts`);
          return false;
        }
        
        const isReady = WhatsAppClient.isReady(number);
        const hasPage = Boolean(client.pupPage);
        const hasBrowser = Boolean(client.pupBrowser?.isConnected());
        
        const fullyReady = isReady && hasPage && hasBrowser;
        
        if (!fullyReady) {
          logger.warn(`Cliente ${number} no está completamente listo: ready=${isReady}, page=${hasPage}, browser=${hasBrowser}`);
        }
        
        return fullyReady;
      });

      if (readyClients.length === 0) {
        logger.warn('Ningún cliente está completamente listo para operaciones');
        // 🔹 FIX: Retornar estructura consistente
        return {
          contacts: [],
          totalContacts: 0,
          currentPage: page,
          message: 'No clients ready'
        };
      }

      const allContacts = await this.getAllContacts(readyClients);
      
      if (!allContacts || allContacts.length === 0) {
        logger.info('No se encontraron contactos');
        return {
          contacts: [],
          totalContacts: 0,
          currentPage: page,
          message: 'No contacts found'
        };
      }

      allContacts.sort((a, b) => {
        const nameA = (a.name || '').toString();
        const nameB = (b.name || '').toString();
        return nameA.localeCompare(nameB);
      });
      
      const start = (page - 1) * this.CONTACTS_PER_PAGE;
      const end = start + this.CONTACTS_PER_PAGE;
      const paginatedContacts = allContacts.slice(start, end);

      if (paginatedContacts.length === 0) {
        logger.info(`No hay contactos en la página ${page}`);
        return {
          contacts: [],
          totalContacts: allContacts.length,
          currentPage: page,
          totalPages: Math.ceil(allContacts.length / this.CONTACTS_PER_PAGE),
          message: 'No contacts in this page'
        };
      }

      const contactsWithPics = await this.addProfilePictures(paginatedContacts, readyClients);
      
      // 🔹 FIX: Retornar estructura completa
      return {
        contacts: contactsWithPics || [],
        totalContacts: allContacts.length,
        currentPage: page,
        totalPages: Math.ceil(allContacts.length / this.CONTACTS_PER_PAGE)
      };
      
    } catch (error) {
      logger.error('Error al obtener contactos:', error);
      // 🔹 FIX: Lanzar error en lugar de retornar array vacío
      throw new Error(`Failed to fetch contacts: ${error.message}`);
    }
  }

  async getAllAuthenticatedAccountsInfo() {
    try {
      const authenticatedAccountsInfo = await WhatsAppClient.getAuthenticatedAccountsInfo();
      return authenticatedAccountsInfo;
    } catch (error) {
      logger.error('Error al obtener información de las cuentas autenticadas:', error);
      return [];
    }
  }
  

  /**
   * Get all contacts - MÉTODO HÍBRIDO CON FALLBACK AUTOMÁTICO
   * Intenta primero el método principal, si falla usa el alternativo
   * @param {Array} clients - WhatsApp clients
   * @returns {Promise<Array>} Contacts list
   */
  async getAllContacts(clients) {
    if (!clients || clients.length === 0) {
      return [];
    }

    logger.info('🚀 Iniciando obtención de contactos con sistema de fallback...');

    try {
      // 🔹 INTENTO 1: Método principal (getContacts directo)
      logger.info('🎯 Intentando método PRINCIPAL (getContacts)...');
      const primaryContacts = await this.getAllContactsPrimary(clients);
      
      if (primaryContacts && primaryContacts.length > 0) {
        logger.info(`✅ Método PRINCIPAL exitoso: ${primaryContacts.length} contactos obtenidos`);
        return primaryContacts;
      }
      
      logger.warn('⚠️ Método PRINCIPAL no retornó contactos, activando FALLBACK...');
      
    } catch (primaryError) {
      const errorMsg = primaryError?.message || 'Error desconocido';
      logger.warn(`⚠️ Método PRINCIPAL falló: ${errorMsg}`);
      logger.info('🔄 Activando método ALTERNATIVO (desde chats)...');
    }

    try {
      // 🔹 INTENTO 2: Método alternativo (desde chats)
      const alternativeContacts = await this.getAllContactsAlternative(clients);
      
      if (alternativeContacts && alternativeContacts.length > 0) {
        logger.info(`✅ Método ALTERNATIVO exitoso: ${alternativeContacts.length} contactos obtenidos`);
        return alternativeContacts;
      }
      
      logger.warn('⚠️ Método ALTERNATIVO tampoco retornó contactos');
      return [];
      
    } catch (alternativeError) {
      const errorMsg = alternativeError?.message || 'Error desconocido';
      logger.error(`❌ Método ALTERNATIVO también falló: ${errorMsg}`);
      logger.error('❌ Ambos métodos fallaron, no se pudieron obtener contactos');
      return [];
    }
  }

  /**
   * Get all contacts - MÉTODO PRINCIPAL (original)
   * @param {Array} clients - WhatsApp clients
   * @returns {Promise<Array>} Contacts list
   */
  async getAllContactsPrimary(clients) {
    if (!clients || clients.length === 0) {
      return [];
    }

    const allContactsPromises = clients.map(async (client) => {
      let number = 'unknown';
      try {
        number = client.options?.authStrategy?.clientId || 
                client.info?.wid?.user || 
                client.info?.me?.user || 
                'unknown';
      } catch (e) {
        logger.warn('No se pudo obtener número de cliente');
      }

      if (!client.getContacts || typeof client.getContacts !== 'function') {
        logger.error(`Cliente ${number} no tiene el método getContacts disponible`);
        throw new Error('getContacts not available');
      }

      let retries = 3;
      
      while (retries > 0) {
        try {
          if (!client.pupPage || !client.pupBrowser?.isConnected()) {
            logger.warn(`Cliente ${number} no tiene página/browser disponible, esperando...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            retries--;
            continue;
          }

          logger.info(`🔄 [PRINCIPAL] Intentando obtener contactos del cliente ${number}...`);

          const contacts = await Promise.race([
            client.getContacts(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('getContacts timeout')), 20000)
            )
          ]);
          
          if (!contacts || !Array.isArray(contacts)) {
            logger.warn(`⚠️ Cliente ${number} retornó datos inválidos`);
            throw new Error('Invalid contacts data');
          }

          logger.info(`📥 [PRINCIPAL] Cliente ${number} retornó ${contacts.length} contactos sin filtrar`);

          const validContacts = contacts
            .filter(contact => {
              try {
                if (!contact || !contact.id || !contact.id._serialized) {
                  return false;
                }

                const serialized = contact.id._serialized;

                const isValidContact = 
                  !contact.isGroup && 
                  contact.isMyContact && 
                  !serialized.endsWith('@lid') &&
                  serialized.endsWith('@c.us');

                return isValidContact;
              } catch (filterError) {
                logger.warn(`Error filtrando contacto:`, filterError.message);
                return false;
              }
            })
            .map(contact => {
              try {
                return {
                  id: contact.id._serialized,
                  phone_number: contact.id.user,
                  name: contact.name || contact.pushname || contact.id.user || 'Sin nombre',
                  clientNumber: number,
                  clientId: client.id || number,
                  source: 'primary' // Marcador para saber de dónde vino
                };
              } catch (mapError) {
                logger.error(`❌ Error mapeando contacto:`, mapError.message);
                return null;
              }
            })
            .filter(contact => contact !== null);

          logger.info(`✅ [PRINCIPAL] Cliente ${number}: ${validContacts.length} contactos válidos obtenidos`);
          return validContacts;
              
        } catch (error) {
          retries--;
          const errorMsg = error?.message || 'Error desconocido';
          logger.error(`❌ [PRINCIPAL] Error para cliente ${number} (${retries} intentos restantes): ${errorMsg}`);
          
          if (retries > 0) {
            const waitTime = (4 - retries) * 2000;
            logger.info(`⏳ Esperando ${waitTime}ms antes de reintentar...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            // Si se agotan los reintentos, lanzar error para activar fallback
            throw new Error(`Primary method failed after retries: ${errorMsg}`);
          }
        }
      }
      
      throw new Error('Primary method exhausted retries');
    });

    const allContactsArrays = await Promise.all(allContactsPromises);
    const flatContacts = allContactsArrays.flat();
    
    logger.info(`📊 [PRINCIPAL] Total de contactos obtenidos: ${flatContacts.length}`);
    
    return flatContacts || [];
  }

  /**
   * Get all contacts - MÉTODO ALTERNATIVO (fallback)
   * @param {Array} clients - WhatsApp clients
   * @returns {Promise<Array>} Contacts list
   */
  async getAllContactsAlternative(clients) {
    if (!clients || clients.length === 0) {
      return [];
    }

    const allContactsPromises = clients.map(async (client) => {
      let number = 'unknown';
      try {
        number = client.options?.authStrategy?.clientId || 
                client.info?.wid?.user || 
                client.info?.me?.user || 
                'unknown';
      } catch (e) {
        logger.warn('No se pudo obtener número de cliente');
      }

      try {
        logger.info(`🔄 [ALTERNATIVO] Obteniendo contactos del cliente ${number}...`);

        const chats = await Promise.race([
          client.getChats(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('getChats timeout')), 20000)
          )
        ]);

        if (!chats || !Array.isArray(chats)) {
          logger.warn(`⚠️ [ALTERNATIVO] Cliente ${number} no retornó chats`);
          return [];
        }

        logger.info(`📥 [ALTERNATIVO] Cliente ${number} retornó ${chats.length} chats`);

        const contactsMap = new Map();

        for (const chat of chats) {
          try {
            if (chat.isGroup) continue;

            const contact = await chat.getContact();
            
            if (!contact || !contact.id || !contact.id._serialized) continue;

            const serialized = contact.id._serialized;

            if (!serialized.endsWith('@c.us') || serialized.endsWith('@lid')) {
              continue;
            }

            if (!contactsMap.has(serialized)) {
              contactsMap.set(serialized, {
                id: serialized,
                phone_number: contact.id.user || contact.number,
                name: contact.name || contact.pushname || contact.number || 'Sin nombre',
                clientNumber: number,
                clientId: client.id || number,
                isMyContact: contact.isMyContact || false,
                source: 'alternative' // Marcador para saber de dónde vino
              });
            }
          } catch (contactError) {
            continue;
          }
        }

        const validContacts = Array.from(contactsMap.values());
        logger.info(`✅ [ALTERNATIVO] Cliente ${number}: ${validContacts.length} contactos extraídos desde chats`);
        
        return validContacts;

      } catch (error) {
        const errorMsg = error?.message || 'Error desconocido';
        logger.error(`❌ [ALTERNATIVO] Error para cliente ${number}: ${errorMsg}`);
        return [];
      }
    });

    try {
      const allContactsArrays = await Promise.all(allContactsPromises);
      const flatContacts = allContactsArrays.flat();
      
      logger.info(`📊 [ALTERNATIVO] Total de contactos obtenidos: ${flatContacts.length}`);
      
      return flatContacts || [];
    } catch (error) {
      logger.error('❌ Error crítico en getAllContactsAlternative:', error.message);
      return [];
    }
  }

  /**
   * Add profile pictures to contacts
   * @param {Array} contacts - Contact list
   * @param {Array} clients - WhatsApp clients
   * @returns {Promise<Array>} Contacts with profile pictures
   */
  async addProfilePictures(contacts, clients) {
    if (!contacts || contacts.length === 0) {
      return [];
    }

    if (!clients || clients.length === 0) {
      logger.warn('No hay clientes disponibles para obtener fotos de perfil');
      return contacts.map(contact => ({
        ...contact,
        profilePicUrl: this.getDefaultProfilePic()
      }));
    }

    const contactsWithPics = await Promise.all(contacts.map(async (contact) => {
      try {
        const client = clients.find(c => c.id === contact.clientId);
        
        if (client) {
          try {
            const profilePicUrl = await client.getProfilePicUrl(contact.id);
            contact.profilePicUrl = profilePicUrl || this.getDefaultProfilePic();
          } catch (picError) {
            logger.warn(`Error obteniendo foto para ${contact.id}:`, picError.message);
            contact.profilePicUrl = this.getDefaultProfilePic();
          }
        } else {
          contact.profilePicUrl = this.getDefaultProfilePic();
        }
      } catch (error) {
        logger.warn(`Error procesando contacto ${contact.id}:`, error.message);
        contact.profilePicUrl = this.getDefaultProfilePic();
      }
      return contact;
    }));

    return contactsWithPics || [];
  }

  /**
   * Get default profile picture URL
   * @returns {string} Default profile picture URL
   */
  
  getDefaultProfilePic() {
    return 'https://cdn.playbuzz.com/cdn/913253cd-5a02-4bf2-83e1-18ff2cc7340f/c56157d5-5d8e-4826-89f9-361412275c35.jpg';
  }

  async getProfilePicture(client, id) {
    try {
      return await client.getProfilePicUrl(id);
    } catch (error) {
      return 'https://cdn.playbuzz.com/cdn/913253cd-5a02-4bf2-83e1-18ff2cc7340f/c56157d5-5d8e-4826-89f9-361412275c35.jpg';
    }
  }

  async getRecentMessageDate(chat) {
    const messages = await chat.fetchMessages({ limit: 1 });
    return messages.length > 0 ? messages[0].timestamp : 0;
  }

  /**
   * Get group participant data
   * @param {Object} chat - Chat object
   * @param {Object} client - WhatsApp client instance
   * @returns {Promise<Array>} Group participant data
   * @private
   */
  async getGroupData(chat, client) {
    try {
      // 🔹 FIX: Evitar llamadas innecesarias si ya tenemos metadata
      let metadata = chat.groupMetadata;
      
      if (!metadata) {
        try {
          metadata = await Promise.race([
            chat.getGroupMetadata(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Metadata timeout')), 5000)
            )
          ]);
        } catch (metadataError) {
          logger.warn(`No se pudo obtener metadata del grupo:`, metadataError.message);
          return [];
        }
      }
      
      if (!metadata || !metadata.participants) {
        return [];
      }

      // 🔹 Limitar número de participantes procesados para evitar sobrecarga
      const participantsToProcess = metadata.participants.slice(0, 50); // Máximo 50
      
      return await this.getGroupDataFromMetadata(participantsToProcess, client);
    } catch (error) {
      logger.warn(`Error getting group data:`, error.message);
      return [];
    }
  }

  /**
   * Get group participant data from metadata
   * @param {Array} participants - Array of participants from groupMetadata
   * @param {Object} client - WhatsApp client instance
   * @returns {Promise<Array>} Processed participant data
   * @private
   */
  async getGroupDataFromMetadata(participants, client) {
    if (!participants || !Array.isArray(participants)) return [];

    // 🔹 FIX: Procesar participantes con manejo robusto de errores
    const participantPromises = participants.map(async participant => {
      try {
        // Validar que el participante tenga ID válido
        if (!participant || !participant.id || !participant.id._serialized) {
          return {
            id: 'unknown',
            isAdmin: false,
            isSuperAdmin: false,
            name: 'Participante desconocido'
          };
        }

        const participantId = participant.id._serialized;
        
        // 🔹 FIX: No intentar obtener contacto si es LID o el mismo cliente
        // Los IDs que terminan en @lid son identificadores internos de WhatsApp
        // y no se pueden consultar como contactos normales
        if (participantId.endsWith('@lid')) {
          return {
            id: participantId,
            isAdmin: participant.isAdmin || false,
            isSuperAdmin: participant.isSuperAdmin || false,
            name: participant.id.user || 'Usuario'
          };
        }

        // 🔹 Intentar obtener información del contacto solo para IDs válidos
        try {
          const contact = await Promise.race([
            client.getContactById(participantId),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Contact fetch timeout')), 3000)
            )
          ]);

          return {
            id: participantId,
            isAdmin: participant.isAdmin || false,
            isSuperAdmin: participant.isSuperAdmin || false,
            name: contact.name || contact.pushname || contact.number || participant.id.user
          };
        } catch (contactError) {
          // Si falla obtener el contacto, usar información básica del participante
          return {
            id: participantId,
            isAdmin: participant.isAdmin || false,
            isSuperAdmin: participant.isSuperAdmin || false,
            name: participant.id.user || 'Usuario'
          };
        }
      } catch (error) {
        // Error general: retornar participante con datos mínimos
        return {
          id: participant?.id?._serialized || 'unknown',
          isAdmin: false,
          isSuperAdmin: false,
          name: 'Participante'
        };
      }
    });

    try {
      const results = await Promise.all(participantPromises);
      return results.filter(p => p !== null);
    } catch (error) {
      logger.error('Error processing group participants:', error.message);
      return [];
    }
  }

  // Part II ----------------------------------------------------------------------------------------------------------------

  /**
   * Ensure temp directory exists
   * @private
   */

  async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error('Error creating temp directory:', error);
    }
  }

  /**
   * Get group chat messages (OPTIMIZADO para respuesta rápida)
   * @param {string} number - Client number
   * @param {string} groupId - Group ID
   * @returns {Promise<Array>} Messages list (con media encolada)
   */
  async getGroupChatMessages(number, groupId) {
    const client = WhatsAppClient.getClient(number);

    if (!client) throw new Error('Client not found');

    const chatId = `${groupId}@g.us`;
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 30 });

    // Procesar mensajes sin bloquear
    return Promise.all(messages.map(msg => this.formatMessageFast(msg, number)));
  }
  
  /**
   * Get chat messages (OPTIMIZADO para respuesta rápida)
   * @param {string} clientId - Client ID
   * @param {string} tel - Phone number
   * @returns {Promise<Array>} Messages list (con media encolada)
   */
  async getChatMessages(clientId, tel) {
    const client = WhatsAppClient.getClient(clientId);

    if (!client) throw new Error('Client not found');

    const chatId = `${tel}@c.us`;
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 30 });

    // Procesar mensajes sin bloquear
    return Promise.all(messages.map(msg => this.formatMessageFast(msg, clientId)));
  }

   /**
   * Send message to individual chat
   * @param {string} clientId - Client ID
   * @param {string} tel - Phone number
   * @param {string} message - Message content
   */

   async sendMessage(clientId, tel, message) {
    const client = await this.getClientById(clientId);
    const chatId = `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    await client.sendMessage(chatId, message);
  }

  /**
   * Send message to group chat
   * @param {string} clientId - Client ID
   * @param {string} groupId - Group ID
   * @param {string} message - Message content
   */

  async sendGroupMessage(clientId, groupId, message) {
    const client = await this.getClientById(clientId);
    const chatId = `${groupId}@g.us`;

    if (!client) throw new Error('Client not found');

    const groupChat = await client.getChatById(chatId);
    if (!groupChat) {
      throw new NotFoundError('Group not found');
    }

    await client.sendMessage(chatId, message);
  }

  /**
   * Send file or message
   * @param {Object} params - Message parameters
   */

  async sendMessageOrFile(params) {
    const { clientId, chatId, message, fileName, fileContent, isGroup } = params;
    const client = await this.getClientById(clientId);

    if (!client) throw new Error('Client not found');

    try {
      // Caso 1: Archivo desde base64
      if (fileContent && fileName) {
        await this.sendFileFromBase64(client, chatId, fileName, fileContent, message, isGroup);
      }
      // Caso 2: Solo mensaje de texto
      else if (message) {
        await client.sendMessage(chatId, message);
      }
      else {
        throw new Error('Message or file content required');
      }
    } catch (error) {
      console.error('Error in sendMessageOrFile service:', error);
      throw error;
    }
  }

  /**
   * Send file from file path
   */
   /**
   * Send file from base64 content
   */
  async sendFileFromBase64(client, tel, fileName, fileContent, message, isGroup) {
    try {
          console.log(`📁 Processing file: ${fileName}`);
          const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

          // Procesar el archivo base64
          const media = await this.processBase64File(fileName, fileContent);
          
          // 🔹 Detectar si es un archivo de audio MP3
          const isAudioMP3 = fileName.toLowerCase().endsWith('.mp3');
          
          if (isAudioMP3) {
              console.log('🎵 Enviando archivo mp3: ' + fileName);
              
              // Enviar como mensaje de voz con configuración específica
              await client.sendMessage(chatId, media);
          } else {
              // Enviar como documento normal
              if (message) {
                  await client.sendMessage(chatId, media, { caption: message });
              } else {
                  await client.sendMessage(chatId, media);
              }
          }
          
          console.log(`✅ File sent successfully: ${fileName} to ${chatId}`);
          
      } catch (error) {
          console.error('❌ Error sending file from base64:', error);
          throw error;
      }
  }

  /**
   * Process base64 file (similar to processBase64Image)
   * @private
   */
  async processBase64File(fileName, fileData) {
    try {
      // Limpiar el base64 si viene con prefijo data:
      let base64Data = fileData;
      if (fileData.includes(',')) {
        base64Data = fileData.split(',')[1];
      }

      if (!base64Data) {
        throw new Error('Invalid base64 file data');
      }

      // Convertir a buffer
      const fileBuffer = Buffer.from(base64Data, 'base64');
      if (fileBuffer.length === 0) {
        throw new Error('Empty file data');
      }

      console.log(`📊 File size: ${(fileBuffer.length / (1024 * 1024)).toFixed(2)} MB`);

      // Crear archivo temporal
      const tempPath = path.join(this.tempDir, `temp_${Date.now()}_${fileName}`);
      await fs.writeFile(tempPath, fileBuffer);

      try {
        // Crear MessageMedia desde el archivo temporal
        const media = MessageMedia.fromFilePath(tempPath);
        
        // Eliminar archivo temporal
        await fs.unlink(tempPath);
        
        return media;
      } catch (error) {
        // Limpiar archivo temporal en caso de error
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      console.error('Error processing base64 file:', error);
      throw error;
    }
  }

  /**
   * Send media message (sticker/image)
   * @param {Object} params - Media message parameters
   */

  async sendMediaMessage(params) {
    const { clientId, tel, mediaPath, isGroup, type } = params;
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    if (!await fs.access(mediaPath).then(() => true).catch(() => false)) {
      throw new ValidationError('Media file not found');
    }

    const media = MessageMedia.fromFilePath(mediaPath);
    const options = type === 'sticker' ? { sendMediaAsSticker: true } : {};
    await client.sendMessage(chatId, media, options);
  }

  /**
   * Send product message with image
   * @param {Object} params - Product message parameters
   */

  async sendProductMessage(params) {
    const { clientId, tel, message, image, isGroup } = params;
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    const media = await this.processBase64Image(image);
    await client.sendMessage(chatId, message, { media });
  }

  async sendMessageProductGroup(params) {
    const { clientId, tel, message, image, isGroup } = params;
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    if (!isGroup) {
      const numberDetails = await client.getNumberId(chatId);
      if (!numberDetails) {
        throw new NotFoundError('Phone number not found');
      }
    }

    const media = await this.processBase64Image(image);
    await client.sendMessage(chatId, message, { media });
  }

  /**
   * Reply to message
   * @param {Object} params - Reply parameters
   */
  async replyToMessage(clientId, tel, messageId, reply, isGroup) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 10000 });
    const message = messages.find(msg => msg.id._serialized === messageId);

    if (!message) throw new Error('Mensaje no encontrado');

    await chat.sendMessage(reply, { quotedMessageId: message.id._serialized });
  }

  /**
   * Delete message
   * @param {Object} params - Delete parameters
   */
  async deleteMessage(clientId, tel, messageId, forEveryone, isGroup) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 10000 });
    const message = messages.find(msg => msg.id._serialized === messageId);

    if (!message) throw new Error('Mensaje no encontrado');

    await message.delete(forEveryone);
  }
/**
 * Forward messages
 * @param {Object} params - Forward parameters
 */
async forwardMessages(params) {
    const { clientId, fromTel, toTel, messageIds, isGroupFrom, isGroupTo } = params;
    const client = await this.getClientById(clientId);
    if (!client) throw new Error('Client not found');

    const fromChatId = isGroupFrom ? `${fromTel}@g.us` : `${fromTel}@c.us`;
    const toChatId = isGroupTo ? `${toTel}@g.us` : `${toTel}@c.us`;

    try {
        // Verificar que el chat destino existe
        const toChat = await client.getChatById(toChatId);
        if (!toChat) {
            throw new Error(`El chat de destino ${toChatId} no existe o no has conversado previamente con él`);
        }
        
        const notFound = [];
        const forwarded = [];
        const forwardedWithFallback = [];

        for (const msgId of messageIds) {
            try {
                // 🎯 MÉTODO MEJORADO: Obtener el mensaje completo usando getMessageById
                let message = null;
                
                // Intento 1: Usar getMessageById si está disponible
                if (typeof client.getMessageById === 'function') {
                    try {
                        message = await client.getMessageById(msgId);
                        console.log(`✅ Mensaje obtenido con getMessageById`);
                    } catch (getByIdError) {
                        console.warn(`⚠️ getMessageById falló: ${getByIdError.message}`);
                    }
                }
                
                // Intento 2: Buscar en fetchMessages si getMessageById no funcionó
                if (!message) {
                    const fromChat = await client.getChatById(fromChatId);
                    const messages = await fromChat.fetchMessages({ limit: 50000 });
                    message = messages.find(msg => msg.id._serialized === msgId);
                    
                    if (message) {
                        console.log(`✅ Mensaje encontrado en fetchMessages`);
                    }
                }
                
                if (!message) {
                    console.warn(`❌ Mensaje no encontrado: ${msgId}`);
                    notFound.push(msgId);
                    continue;
                }
                
                // 🎯 INTENTO 1: Usar el método nativo forward()
                try {
                    // Usar directamente el chatId en lugar del objeto chat
                    await message.forward(toChatId);
                    
                    forwarded.push(msgId);
                    
                } catch (nativeError) {
                    
                    // 🎯 INTENTO 2: Reenvío manual como fallback
                    await this.manualForward(message, toChat);
                    forwardedWithFallback.push(msgId);
                }
                
                // Pausa entre mensajes para evitar rate limiting
                await new Promise(r => setTimeout(r, 1500));
                
            } catch (messageError) {
                console.error(`❌ Error procesando mensaje ${msgId}:`, messageError.message);
                notFound.push(msgId);
            }
        }

        const totalForwarded = forwarded.length + forwardedWithFallback.length;

        if (notFound.length > 0 && totalForwarded === 0) {
            throw new Error(`No se pudieron reenviar los mensajes. IDs no encontrados o inválidos: ${notFound.join(', ')}`);
        }
        
        if (notFound.length > 0 && totalForwarded > 0) {
            console.warn(`⚠️ Algunos mensajes no se reenviaron: ${notFound.join(', ')}`);
        }
        
        return {
            forwarded: totalForwarded,
            forwardedNative: forwarded.length,
            forwardedFallback: forwardedWithFallback.length,
            notFound: notFound.length,
            details: { 
                forwarded, 
                forwardedWithFallback,
                notFound 
            }
        };
        
    } catch (error) {
        console.error(`❌ Error en forwardMessages:`, error);
        throw error;
    }
}

/**
 * Manual forward method (fallback when native forward fails)
 * @param {Object} message - Message object to forward
 * @param {Object} toChat - Destination chat
 * @private
 */
async manualForward(message, toChat) {
    if (message.hasMedia) {
        // Para mensajes con media
        const media = await message.downloadMedia();
        
        if (!media) {
            throw new Error('No se pudo descargar el media');
        }
        
        const options = {};
        
        // Agregar caption si existe
        if (message.body || message.caption) {
            options.caption = message.body || message.caption;
        }
        
        await toChat.sendMessage(media, options);
        
    } else if (message.type === 'location') {
        // Para ubicaciones
        const locationData = {
            latitude: message.location.latitude,
            longitude: message.location.longitude,
            description: message.location.description || message.body || 'Ubicación compartida'
        };
        
        await toChat.sendMessage(locationData);
        
    } else if (message.type === 'vcard') {
        // Para contactos vCard
        const vcardData = message.body;
        await toChat.sendMessage(vcardData);
        
    } else if (message.type === 'poll') {
        // Para encuestas - no se pueden reenviar directamente
        const pollText = `📊 Encuesta reenviada:\n${message.body}\n\nOpciones:\n${message.pollOptions.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}`;
        await toChat.sendMessage(pollText);
        
    } else {
        // Para mensajes de texto
        const forwardedText = message.body;
        await toChat.sendMessage(forwardedText);
    }
}

  /**
   * Mark message as important
   * @param {Object} params - Mark message parameters
   */
  async markMessageAsImportant(clientId, tel, messageId, isGroup){
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(msg => msg.id._serialized === messageId);

    if (!message) throw new Error('Mensaje no encontrado');

    await message.star();
  }

  /**
   * Unmark message
   * @param {Object} params - Unmark message parameters
   */
  async unmarkMessageAsImportant(clientId, tel, messageId, isGroup){
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Client not found');

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 1000 });
    const message = messages.find(msg => msg.id._serialized === messageId);

    if (!message) throw new Error('Mensaje no encontrado');

    await message.unstar();
  }

  /**
   * Edit message
   * @param {Object} params - Edit parameters
   */
  async editMessage (clientId, tel, messageId, newContent, isGroup) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Cliente no encontrado.');
  
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 1000 });
    const message = messages.find(msg => msg.id._serialized === messageId);
  
    if (!message) throw new Error('Mensaje no encontrado.');
  
    await message.edit(newContent);
  }
  
  /**
   * Mute chat
   * @param {Object} params - Mute chat parameters
   */
  async muteChat (clientId, tel, isGroup, unmuteDate) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Cliente no encontrado.');

    await client.muteChat(chatId, unmuteDate ? new Date(unmuteDate) : null);
  }

  /**
   * Pin chat
   * @param {Object} params - Pin chat parameters
   */
  async pinChat (clientId, tel, isGroup) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Cliente no encontrado.');
    
    await client.pinChat(chatId);
  }
  
  /**
   * Unpin chat
   * @param {Object} params - Unpin chat parameters
   */
  async unpinChat (clientId, tel, isGroup) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;

    if (!client) throw new Error('Cliente no encontrado.');
  
    await client.unpinChat(chatId);
  }

  async sendMessageWithMention (clientId, tel, isGroup, mentionTel, message) {
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;
    const mentionId = `${mentionTel}@c.us`;

    if (!client) throw new Error('Cliente no encontrado.');

    const chat = await client.getChatById(chatId);
    await chat.sendMessage(message, { mentions: [{ id: mentionId }] });
  };

  async getMessageInfo (clientId, tel, messageId, isGroup){
    const client = await this.getClientById(clientId);
    const chatId = isGroup ? `${tel}@g.us` : `${tel}@c.us`;
    
    if (!client) throw new Error('Cliente no encontrado.');
  
    try {
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 10000 });
      const message = messages.find(msg => msg.id._serialized === messageId);
  
      if (!message) {
        throw new Error('Mensaje no encontrado.');
      }
  
      return {
        id: message.id._serialized,
        body: message.body,
        type: message.type,
        timestamp: message.timestamp,
        from: message.from,
        to: message.to,
      };
    } catch (error) {
      throw new Error(`Error al obtener información del mensaje: ${error.message}`);
    }
  };
  
  // Helper methods (Metodos estaticos) ----------------------------------------------------------------------------------------------------------------
  formatContactNumber(number) {
    return number.includes('@c.us') ? number : `${number}@c.us`;
  }

  formatChatId(tel, isGroup) {
    return isGroup ? `${tel}@g.us` : `${tel}@c.us`;
  }

  getDefaultChatData(chat, client) {
    return {
      ...chat,
      recentMessageDate: 0,
      profilePicUrl: 'https://cdn.playbuzz.com/cdn/913253cd-5a02-4bf2-83e1-18ff2cc7340f/c56157d5-5d8e-4826-89f9-361412275c35.jpg',
      groupData: [],
      client: client.options.authStrategy.clientId
    };
  }

  // Private helper methods
  /**
   * Get client by ID
   * @private
   */
  async getClientById(clientId) {
    const client = WhatsAppClient.getClient(clientId);
  
    if (!client) {
      throw new NotFoundError('Client not found');
    }

    return client;
  }

  /**
   * Format message FAST - respuesta inmediata con encolado de media
   * @param {Object} message - Mensaje de whatsapp-web.js
   * @param {string} clientId - ID del cliente
   * @returns {Promise<Object>} Mensaje formateado sin bloqueo
   * @private
   */
  async formatMessageFast(message, clientId) {
    const formattedMessage = {
      id: message.id._serialized,
      body: message.body,
      timestamp: message.timestamp,
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      hasMedia: message.hasMedia,
      mediaType: message.type,
      mediaMimeType: message._data.mimetype,
      caption: message.caption || null,
      hasQuotedMsg: message.hasQuotedMsg,
      quotedParticipant: message._data.quotedParticipant || null,
      quotedStanzaID: message._data.quotedStanzaID || null,
      quotedMsg: message._data.quotedMsg || null,
      isStarred: message.isStarred,
      isForwarded: message.isForwarded
    };

    // Procesar vCard (rápido, no requiere descarga)
    if (message.type === 'vcard') {
      const vcardEnhancedBody = await this.enhanceVCardBody(message);
      formattedMessage.body = vcardEnhancedBody;
    }

    // ✨ ESTRATEGIA INTELIGENTE PARA MEDIA
    if (message.hasMedia) {
      const mediaStatus = await this.handleMediaSmart(message, clientId, formattedMessage);
      Object.assign(formattedMessage, mediaStatus);
    }

    // Ubicaciones (sin descarga)
    if (message.location) {
      formattedMessage.location = {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        description: message.location.description || null
      };
    }

    return formattedMessage;
  }
  
  /**
   * Manejo inteligente de media: descarga rápida vs encolado
   * @param {Object} message - Mensaje con media
   * @param {string} clientId - ID del cliente
   * @param {Object} formattedMessage - Mensaje en construcción
   * @returns {Promise<Object>} Estado de media (descargada o pendiente)
   * @private
   */
  async handleMediaSmart(message, clientId, formattedMessage) {
    const messageId = message.id._serialized;
    const type = message.type;

    // 1️⃣ Verificar si ya fue procesada antes
    const cachedStatus = this.mediaQueue.getStatus(messageId);
    if (cachedStatus.status === 'completed') {
      if (cachedStatus.data.error) {
        return {
          mediaStatus: 'error',
          mediaError: cachedStatus.data.message
        };
      }
      return {
        mediaStatus: 'ready',
        ...cachedStatus.data
      };
    }

    // 1.5️⃣ 🔹 NUEVO: Verificar si el archivo temporal ya existe
    const tempFileExists = await this.checkTempFileExists(messageId, type);
    if (tempFileExists) {
      logger.info(`✅ Archivo temporal ya existe para ${messageId}`);
      return {
        mediaStatus: 'ready',
        mediaType: type,
        mediaMimeType: message._data.mimetype,
        mediaTempUrl: tempFileExists.url,
        fileName: tempFileExists.fileName
      };
    }

    // 2️⃣ Tipos ligeros: intentar descarga rápida (stickers, audios cortos)
    if (['sticker', 'image', 'ptt'].includes(type)) {
      try {
        const quickMedia = await Promise.race([
          this.attemptDownloadMedia(message, 1),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Quick timeout')), this.QUICK_DOWNLOAD_TIMEOUT)
          )
        ]);

        if (quickMedia) {
          return {
            mediaStatus: 'ready',
            mediaType: type,
            mediaMimeType: quickMedia.mimetype,
            mediaBase64: `data:${quickMedia.mimetype};base64,${quickMedia.data}`
          };
        }
      } catch (error) {
        logger.warn(`Quick download falló para ${messageId}, encolando...`);
      }
    }

    // 3️⃣ Tipos pesados o descarga rápida fallida: ENCOLAR
    const queueResult = this.mediaQueue.enqueue(messageId, message, clientId, 
      type === 'video' ? 2 : 1
    );

    return {
      mediaStatus: queueResult.status,
      mediaType: type,
      mediaMimeType: message._data.mimetype,
      mediaQueuePosition: queueResult.status === 'queued' ? 
        this.mediaQueue.getStatus(messageId).position : undefined
    };
  }

  /**
   * Verificar si archivo temporal ya existe
   * @param {string} messageId - ID del mensaje
   * @param {string} type - Tipo de media
   * @returns {Promise<Object|null>} Datos del archivo si existe
   * @private
   */
  async checkTempFileExists(messageId, type) {
    try {
      const tempDir = path.join(__dirname, '../temp');
      const files = await fs.readdir(tempDir);
      
      // Buscar archivo que coincida con el messageId
      const matchingFile = files.find(file => file.includes(messageId));
      
      if (matchingFile) {
        const filePath = path.join(tempDir, matchingFile);
        const stats = await fs.stat(filePath);
        
        // Verificar que el archivo no esté corrupto (tamaño > 0)
        if (stats.size > 0) {
          return {
            url: `http://localhost:5000/temp/${matchingFile}`,
            fileName: matchingFile,
            size: stats.size
          };
        }
      }
      
      return null;
    } catch (error) {
      logger.warn(`Error verificando archivo temporal: ${error.message}`);
      return null;
    }
  }

  /**
   * Obtener estado de descarga de media
   * @param {string} messageId - ID del mensaje
   * @returns {Object} Estado actual de la media
   */
  async getMediaStatus(messageId) {
    return this.mediaQueue.getStatus(messageId);
  }

  /**
   * Obtener estadísticas de la cola
   * @returns {Object} Estadísticas generales
   */
  async getMediaQueueStats() {
    return this.mediaQueue.getStats();
  }

  /**
   * Enhance vCard body with profile picture and structured data
   * @private
   */
  async enhanceVCardBody(message) {
    let enhancedBody = message.body || '';
    
    const vcardInfo = {
      profilePicUrl: null,
      contactName: null,
      contactPhone: null
    };

    try {
      // Extraer información del contacto DESDE LA VCARD (no del remitente)
      const vcardBody = message.body || '';
      
      // 1. Extraer el nombre del contacto desde FN:
      const nameMatch = vcardBody.match(/FN:(.+)/);
      if (nameMatch) {
        vcardInfo.contactName = nameMatch[1].trim();
      }
      
      // 2. Extraer el número de teléfono desde waid (más confiable)
      let phoneNumber = null;
      const waidMatch = vcardBody.match(/waid=(\d+)/);
      
      if (waidMatch) {
        phoneNumber = waidMatch[1];
        vcardInfo.contactPhone = phoneNumber;
      } else {
        // Fallback: extraer desde TEL: si no hay waid
        const phoneRegexes = [
          /item\d+\.TEL[^:]*:([+\d\s()-]+)/,
          /TEL;type=[A-Z]+:([+\d\s()-]+)/,
          /TEL:([+\d\s()-]+)/
        ];
        
        for (const regex of phoneRegexes) {
          const phoneMatch = vcardBody.match(regex);
          if (phoneMatch) {
            const rawPhone = phoneMatch[1].trim();
            // Limpiar el número para obtener solo dígitos
            phoneNumber = rawPhone.replace(/[\s+()-]/g, '');
            vcardInfo.contactPhone = rawPhone;
            break;
          }
        }
      }

      // 3. Obtener la foto de perfil del CONTACTO DE LA VCARD (no del remitente)
      if (phoneNumber) {
        try {
          // 🔹 FIX: Verificar que message.getChat existe antes de usarlo
          if (!message.getChat || typeof message.getChat !== 'function') {
            logger.warn('message.getChat no está disponible, usando foto por defecto');
            vcardInfo.profilePicUrl = this.getDefaultProfilePic();
          } else {
            // Obtener el cliente de WhatsApp
            const chat = await message.getChat();
            
            // 🔹 FIX: Verificar que chat y chat.client existen
            if (!chat || !chat.client) {
              logger.warn('Chat o client no disponible para obtener foto de perfil');
              vcardInfo.profilePicUrl = this.getDefaultProfilePic();
            } else {
              const client = chat.client;
              
              // Construir el ID del contacto desde el número extraído
              const contactId = `${phoneNumber}@c.us`;
              
              // Obtener el contacto específico de la vCard
              const vcardContact = await client.getContactById(contactId);
              
              if (vcardContact) {
                // Intentar obtener la foto de perfil del contacto de la vCard
                try {
                  const profilePicUrl = await vcardContact.getProfilePicUrl();
                  vcardInfo.profilePicUrl = profilePicUrl || this.getDefaultProfilePic();
                } catch (picError) {
                  logger.warn(`No se pudo obtener foto de perfil para ${contactId}:`, picError.message);
                  vcardInfo.profilePicUrl = this.getDefaultProfilePic();
                }
                
                // Si no obtuvimos el nombre antes, intentar desde el contacto
                if (!vcardInfo.contactName) {
                  vcardInfo.contactName = vcardContact.pushname || vcardContact.name || 'Nombre desconocido';
                }
              } else {
                logger.warn(`No se encontró el contacto con ID: ${contactId}`);
                vcardInfo.profilePicUrl = this.getDefaultProfilePic();
              }
            }
          }
        } catch (error) {
          logger.error('Error al obtener contacto de la vCard:', error.message);
          vcardInfo.profilePicUrl = this.getDefaultProfilePic();
        }
      } else {
        logger.warn('No se pudo extraer número de teléfono de la vCard');
        vcardInfo.profilePicUrl = this.getDefaultProfilePic();
      }

      // Valores por defecto si no se obtuvo información
      if (!vcardInfo.contactName) {
        vcardInfo.contactName = 'Nombre desconocido';
      }
      if (!vcardInfo.contactPhone) {
        vcardInfo.contactPhone = 'Teléfono desconocido';
      }

    } catch (error) {
      logger.error('Error procesando vCard:', error.message);
      vcardInfo.profilePicUrl = this.getDefaultProfilePic();
      vcardInfo.contactName = vcardInfo.contactName || 'Nombre desconocido';
      vcardInfo.contactPhone = vcardInfo.contactPhone || 'Teléfono desconocido';
    }

    // Agregar la información al body en formato JSON al final
    const vcardInfoString = `\n__VCARD_INFO__${JSON.stringify(vcardInfo)}__END_VCARD_INFO__`;
    enhancedBody += vcardInfoString;

    return enhancedBody;
  }

  /**
   * Process message media
   * @private
   */
  async processMessageMedia(message) {
    const media = await this.attemptDownloadMedia(message);
    if (!media) return {};

    const mediaData = {
      mediaType: message.type,
      mediaMimeType: media.mimetype,
      caption: message.caption || null
    };

    if (['sticker', 'image', 'audio', 'ptt'].includes(message.type)) {
      mediaData.mediaBase64 = `data:${media.mimetype};base64,${media.data}`;
    } else if (['document', 'video'].includes(message.type)) {
      // 🔹 FIX: Manejar correctamente cuando filename es undefined
      const extension = media.filename 
        ? path.extname(media.filename) 
        : `.${media.mimetype.split('/')[1]}`;
      
      const fileName = media.filename || `documento${extension}`;
      const tempPath = await this.saveTempMedia(message.id._serialized, extension, media.data);
      
      mediaData.mediaTempUrl = `http://localhost:5000/temp/${path.basename(tempPath)}`;
      
      // Para documentos, incluir el nombre del archivo en el body
      if (message.type === 'document') {
        const textContent = message.caption || message.body || '';
        mediaData.fileName = fileName;
        
        if (textContent && textContent.trim() !== '') {
          mediaData.body = `${fileName} - ${textContent}`;
        } else {
          mediaData.body = fileName;
        }
      }
    }

    return mediaData;
  }

  /**
   * Process base64 image
   * @private
   */
  async processBase64Image(imageData) {
    let base64Data = imageData;
    if (imageData.startsWith('data:image/')) {
      base64Data = imageData.split(',')[1];
    }

    if (!base64Data) {
      throw new ValidationError('Invalid base64 image data');
    }

    const imageBuffer = Buffer.from(base64Data, 'base64');
    if (imageBuffer.length === 0) {
      throw new ValidationError('Empty image data');
    }

    console.log(`📊 File size: ${(imageBuffer.length / (1024 * 1024)).toFixed(2)} MB`);

    const tempPath = path.join(this.tempDir, `temp_${Date.now()}.jpg`);
    await fs.writeFile(tempPath, imageBuffer);

    try {
      const media = MessageMedia.fromFilePath(tempPath);
      await fs.unlink(tempPath);
      return media;
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Attempt to download media with retries 
   * @private
   */
  async attemptDownloadMedia(message, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const media = await message.downloadMedia();
        if (media) return media;
      } catch (error) {
        logger.error(`Media download attempt ${i + 1} failed:`, error);
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    return null;
  }

  /**
   * Save temporary media file
   * @private
   */
  async saveTempMedia(id, extension, data) {
    const tempPath = path.join(this.tempDir, `media_${id}${extension}`);
    await fs.writeFile(tempPath, Buffer.from(data, 'base64'));
    return tempPath;
  }


}

module.exports = WhatsAppService;