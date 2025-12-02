// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs').promises; 
const path = require('path');
const { EventEmitter } = require('events');
const qrcode = require('qrcode-terminal');
const logger = require('../conf/logger'); 
const config = require('../conf/config');

const stateManager = require('../utils/clientStateManager');
const reconnectionManager = require('../utils/reconnectionManager');
const WatchdogMonitor = require('../utils/watchdogMonitor');
const chatCache = require('../utils/chatCache');

class WhatsAppClient extends EventEmitter {
    static RECONNECT_DELAY = config.reconnectDelay || 5000;
    static MAX_RETRIES = config.maxRetries || 3;
    static CHROME_PATH = config.chromePath;
    static CLEANUP_TIMEOUT = 1000;

    constructor() {
        super();
        this.clients = new Map();
        this.clientReadyState = new Map();
        this.qrCodes = new Map();
        this.retryAttempts = new Map();
        this.authPath = config.authPath;
        this.messageQueue = new Map();
        this.rateLimiter = new Map();

        // Sistema de monitoreo
        this.watchdog = new WatchdogMonitor(this);
        this.browserCheckInterval = new Map();

        // Sistema de caché
        this.chatCache = chatCache;
        this.cacheInitScheduled = new Map();

        this.initialize().catch(error => 
            logger.error('Initialization failed:', error));
    }

    async initialize() {
        try {
            await this.ensureAuthDirectory();
            await this.loadExistingClients();

            this.watchdog.start();
            logger.info('Watchdog monitor started');
            
            return true;
        } catch (error) {
            logger.error('Failed to initialize WhatsApp clients:', error);
            throw error; 
        }
    }

    // Manejo de crash del browser
    async handleBrowserCrash(number) {
        logger.warn(`[Browser Event] Browser state changed for ${number}`);
        
        // Verificar primero si realmente es un crash o solo cierre de ventana
        const client = this.clients.get(number);
        if (!client) return;

        // Si el cliente tiene info, no es un crash real
        if (client.info && this.isAuthenticated(number)) {
            logger.info(`[Browser Event] ${number} is still authenticated, no action needed`);
            return;
        }

        const checkInterval = this.browserCheckInterval.get(number);
        if (checkInterval) {
            clearInterval(checkInterval);
            this.browserCheckInterval.delete(number);
        }

        logger.error(`[Browser Crash] Confirmed crash for ${number}`);
        stateManager.setState(number, stateManager.CLIENT_STATES.ERROR, {
            reason: 'Browser crash confirmed'
        });

        reconnectionManager.scheduleReconnection(number, async () => {
            await this.recoverClient(number);
        });
    }

    // Método de recuperación de cliente
    async recoverClient(number) {
        logger.info(`[Recovery] Starting recovery for ${number}`);
        
        try {
            stateManager.setState(number, stateManager.CLIENT_STATES.RECONNECTING);
            
            // Limpiar cliente actual
            const client = this.clients.get(number);
            if (client) {
                await this.cleanupClient(client);
            }
            
            this.clients.delete(number);
            this.clientReadyState.delete(number);
            
            // Recrear cliente
            const sessionDir = `session-${number}`;
            await this.createClient(number, sessionDir);
            
            logger.info(`[Recovery] Successfully recovered ${number}`);
            reconnectionManager.resetAttempts(number);
            
            return true;
        } catch (error) {
            logger.error(`[Recovery] Failed for ${number}:`, error);
            throw error;
        }
    }

    async ensureAuthDirectory() {
        try {
            await fs.access(this.authPath);
        } catch {
            await fs.mkdir(this.authPath, { recursive: true });
            logger.info(`Created auth directory at ${this.authPath}`);
        }
    }

    async loadExistingClients() {
        const clientDirectories = await fs.readdir(this.authPath);

        const validDirectories = await Promise.all(
            clientDirectories.map(async dir => {
                const dirPath = path.join(this.authPath, dir);
                const stats = await fs.stat(dirPath);
                return stats.isDirectory() && dir.startsWith('session-') ? dir : null;
            })
        );

        await Promise.all(
            validDirectories
                .filter(Boolean)
                .map(dir => this.addClient(dir.replace('session-', '')))
        );
    }

    async createClient(number, sessionDir) {
        const retryCount = this.retryAttempts.get(number) || 0;
        
        if (retryCount >= WhatsAppClient.MAX_RETRIES) {
            logger.error(`Max retry attempts reached for client ${number}`);
            this.retryAttempts.delete(number);
            throw new Error('Max retry attempts reached');
        }

        try {
            const clientConfig = {
                authStrategy: new LocalAuth({
                    clientId: number,
                    dataPath: path.join(this.authPath, sessionDir)
                }),
                puppeteer: {
                    headless: false, 
                    executablePath: WhatsAppClient.CHROME_PATH,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu'
                    ]
                }
            };
    
            const client = new Client(clientConfig);
            this.clients.set(number, client);
            this.setupClientEvents(client, number);
            await client.initialize();
            
            // Reset retry count on successful connection
            this.retryAttempts.delete(number);
            logger.info(`Client ${number} successfully initialized`);

            return client;
        } catch (error) {
            this.retryAttempts.set(number, retryCount + 1);
            logger.error(`Error creating client for number ${number}:`, error);
            throw error;
        }
    }

    setupClientEvents(client, number) {
        this.clientReadyState.set(number, false);
        stateManager.setState(number, stateManager.CLIENT_STATES.INITIALIZING);

        const events = {
            qr: (qr) => {
                console.log(`QR para ${number}:`, qr);
                this.qrCodes.set(number, qr);
                qrcode.generate(qr, { small: true });
                this.emit('qrUpdated', number, qr);
                
                // Actualizar estado
                stateManager.setState(number, stateManager.CLIENT_STATES.WAITING_QR);
            },
            
            ready: async () => {
                this.clientReadyState.set(number, true);
                this.emit('ready', { number });
                
                // Actualizar estado
                stateManager.setState(number, stateManager.CLIENT_STATES.READY);
                reconnectionManager.resetAttempts(number);
                
                logger.info(`✅ Client ${number} is ready`);

                // INICIALIZACIÓN DIFERIDA DEL CACHÉ
                if (!this.cacheInitScheduled.get(number)) {
                    this.cacheInitScheduled.set(number, true);
                    
                    // Esperar 2-3 segundos antes de cargar chats
                    const delay = 2000 + Math.random() * 1000;
                    
                    setTimeout(async () => {
                        try {
                            await this.initializeChatCache(number);
                        } catch (error) {
                            logger.error(`[Cache Init] Error para ${number}:`, error);
                        } finally {
                            this.cacheInitScheduled.delete(number);
                        }
                    }, delay);
                }
                
                this.processMessageQueue(number);
            },
            
            authenticated: () => {
                this.emit('authenticated', { number });
                stateManager.setState(number, stateManager.CLIENT_STATES.AUTHENTICATED);
            },
            
            auth_failure: (msg) => {
                this.emit('auth_failure', { number, message: msg });
                stateManager.setState(number, stateManager.CLIENT_STATES.AUTH_FAILURE, {
                    message: msg
                });
                this.handleAuthFailure(number);
            },
            
            message: (message) => {
                this.handleMessage(number, message);
                
                // ACTUALIZACIÓN DE CACHÉ BASADA EN EVENTOS
                this.updateCacheOnMessage(number, message);
            },
            
            disconnected: (reason) => this.handleDisconnection(number, reason),
            
            // Eventos adicionales de browser
            'loading_screen': (percent, message) => {
                logger.info(`[Loading] ${number}: ${percent}% - ${message}`);
                
                const currentState = stateManager.getState(number);
                if (currentState?.state !== stateManager.CLIENT_STATES.READY) {
                    stateManager.setState(number, stateManager.CLIENT_STATES.INITIALIZING, {
                        progress: percent,
                        message
                    });
                }
            }
        };

        Object.entries(events).forEach(([event, handler]) => {
            client.on(event, handler);
        });

        // Capturar errores de Puppeteer
        this.setupPuppeteerErrorHandlers(client, number);
        this.setupGroupEvents(client, number);
    }

    // Manejo de errores de Puppeteer
    setupPuppeteerErrorHandlers(client, number) {
        if (client.pupBrowser) {
            client.pupBrowser.on('disconnected', () => {
                logger.error(`[Puppeteer] Browser disconnected for ${number}`);
                this.handleBrowserCrash(number);
            });
        }

        if (client.pupPage) {
            client.pupPage.on('error', (error) => {
                logger.error(`[Puppeteer] Page error for ${number}:`, error);
                stateManager.setState(number, stateManager.CLIENT_STATES.ERROR, {
                    error: error.message
                });
            });

            client.pupPage.on('pageerror', (error) => {
                logger.error(`[Puppeteer] Page script error for ${number}:`, error);
            });

            // Detectar cierre manual de ventana
            client.pupPage.on('close', () => {
                logger.warn(`[Puppeteer] Page closed for ${number}`);
                this.handleBrowserCrash(number);
            });
        }
    }

    // Manejo mejorado de fallo de autenticación
    async handleAuthFailure(number) {
        logger.error(`[Auth Failure] Client ${number} authentication failed`);
        
        try {
            // Limpiar sesión corrupta
            const sessionDir = path.join(this.authPath, `session-${number}`);
            await this.removeDirectory(sessionDir);
            
            // Limpiar QR caché
            this.qrCodes.delete(number);
            
            // Programar regeneración de sesión
            reconnectionManager.scheduleReconnection(number, async () => {
                logger.info(`[Auth Failure] Regenerating session for ${number}`);
                await this.recoverClient(number);
            });
        } catch (error) {
            logger.error(`[Auth Failure] Error handling auth failure for ${number}:`, error);
        }
    }

    // Mejoras en el manejo de mensajes
    async sendMessage(number, to, message) {
        const client = this.getClient(number);
        if (!client) throw new Error('Client not found');

        if (this.isRateLimited(number)) {
            await this.addToMessageQueue(number, { to, message });
            return;
        }

        try {
            await client.sendMessage(to, message);
            this.updateRateLimit(number);
            
            // ACTUALIZAR CACHÉ: marcar como respondido
            this.chatCache.markAsRead(number, to);
            
        } catch (error) {
            logger.error(`Error sending message from ${number} to ${to}:`, error);
            await this.addToMessageQueue(number, { to, message });
        }
    }

    isRateLimited(number) {
        const lastSent = this.rateLimiter.get(number);
        return lastSent && (Date.now() - lastSent) < 1000; // 1 mensaje por segundo
    }

    updateRateLimit(number) {
        this.rateLimiter.set(number, Date.now());
    }

    async addToMessageQueue(number, message) {
        if (!this.messageQueue.has(number)) {
            this.messageQueue.set(number, []);
        }
        this.messageQueue.get(number).push(message);
    }

    async processMessageQueue(number) {
        const queue = this.messageQueue.get(number) || [];
        if (queue.length === 0) return;

        const message = queue.shift();
        await this.sendMessage(number, message.to, message.content);
        
        if (queue.length > 0) {
            setTimeout(() => this.processMessageQueue(number), 1000);
        }
    }

    setupGroupEvents(client, number) {
        const groupEvents = {
            'contact_changed': (msg, oldId, newId, isContact) => 
                this.emit('contactChanged', { number, oldId, newId, isContact }),
            
            // 🆕 ACTUALIZACIÓN DE METADATA EN CACHÉ
            'group_admin_changed': (notification) => {
                this.emit('groupAdminChanged', { number, notification });
                this.updateGroupFromNotification(number, notification);
            },
            
            // 🆕 ACTUALIZACIÓN CUANDO SE UNE A GRUPO
            'group_join': (notification) => {
                this.emit('groupJoin', { number, notification });
                
                // Agregar grupo al caché
                if (notification.chatId) {
                    this.addGroupToCache(number, notification.chatId);
                }
            },
            
            // 🆕 ACTUALIZACIÓN CUANDO SALE DE GRUPO
            'group_leave': (notification) => {
                this.emit('groupLeave', { number, notification });
                
                // Remover grupo del caché
                if (notification.chatId) {
                    this.chatCache.removeGroup(number, notification.chatId);
                }
            },
            
            // 🆕 ACTUALIZACIÓN CUANDO CAMBIA METADATA DE GRUPO
            'group_update': (notification) => {
                this.emit('groupUpdate', { number, notification });
                this.updateGroupFromNotification(number, notification);
            },
            
            'message_reaction': (reaction) => 
                this.emit('messageReaction', { number, reaction })
        };

        Object.entries(groupEvents).forEach(([event, handler]) => {
            client.on(event, handler);
        });
    }

    /**
     * 🆕 Actualizar grupo en caché desde notificación (sin llamadas a WhatsApp)
     */
    async updateGroupFromNotification(number, notification) {
        try {
            const groupId = notification.chatId;
            if (!groupId) return;

            // Actualizar timestamp en caché
            this.chatCache.updateChat(number, groupId, {
                timestamp: Date.now()
            });

            logger.debug(`[Group Event] ${number} - Grupo ${groupId} actualizado desde evento`);
        } catch (error) {
            logger.error(`[Group Event] Error actualizando grupo:`, error);
        }
    }

    /**
     * 🆕 Agregar grupo al caché cuando se une (sin getChats)
     */
    async addGroupToCache(number, chatId) {
        try {
            const client = this.clients.get(number);
            if (!client) return;

            // Obtener SOLO este chat específico
            const chat = await client.getChatById(chatId);
            
            if (chat && chat.isGroup) {
                this.chatCache.addGroup(number, chat);
                logger.info(`[Group Join] ${number} - Grupo ${chatId} agregado al caché`);
            }
        } catch (error) {
            logger.error(`[Group Join] Error agregando grupo al caché:`, error);
        }
    }

    async handleMessage(number, message) {
        try {
            if (message.from === 'status@broadcast') {
                this.emit('status', { number, message });
                return;
            }
            this.emit('message', { number, message });
        } catch (error) {
            logger.error(`Error processing message for ${number}:`, error);
        }
    }

    async handleDisconnection(number, reason) {
        try {
            const client = this.clients.get(number);
            if (!client) return;

            logger.info(`Client ${number} disconnected: ${reason}`);

            // Si es desconexión sin sesión, limpiar caché
            if (!client.info || !this.isAuthenticated(number)) {
                this.chatCache.clearCache(number);
                this.cacheInitScheduled.delete(number);
            }
            
            // Verificar si es desconexión real o solo cierre de ventana
            // Si el cliente aún tiene sesión, no reconectar inmediatamente
            if (client.info && this.isAuthenticated(number)) {
                logger.info(`[Disconnection] ${number} still has session, waiting before reconnecting`);
                
                stateManager.setState(number, stateManager.CLIENT_STATES.DISCONNECTED, {
                    reason,
                    hasSession: true
                });
                
                // Esperar 30 segundos antes de decidir si reconectar
                setTimeout(async () => {
                    const currentClient = this.clients.get(number);
                    if (currentClient && !this.isReady(number)) {
                        logger.info(`[Disconnection] ${number} not recovered, initiating reconnection`);
                        await this.initiateReconnection(number);
                    }
                }, 30000);
                
                return;
            }
            
            // Si no tiene sesión, es desconexión real
            await this.initiateReconnection(number);
            
        } catch (error) {
            logger.error(`Error handling disconnection for ${number}:`, error);
        }
    }

    async initiateReconnection(number) {
        stateManager.setState(number, stateManager.CLIENT_STATES.DISCONNECTED, {
            reason: 'Real disconnection detected'
        });
        
        const checkInterval = this.browserCheckInterval.get(number);
        if (checkInterval) {
            clearInterval(checkInterval);
            this.browserCheckInterval.delete(number);
        }
        
        const client = this.clients.get(number);
        if (client) {
            await this.cleanupClient(client);
        }
        
        this.emit('disconnected', { number });

        reconnectionManager.scheduleReconnection(number, async () => {
            await this.recoverClient(number);
        });
    }

    // Método para obtener métricas de salud
    getHealthMetrics(number = null) {
        return this.watchdog.getHealthReport(number);
    }

    // Método para forzar reconexión manual
    async forceReconnect(number) {
        logger.info(`[Manual] Forcing reconnection for ${number}`);
        reconnectionManager.resetAttempts(number);
        return await this.recoverClient(number);
    }

    // Cleanup mejorado al cerrar
    async shutdown() {
        logger.info('Shutting down WhatsApp client manager...');
        
        // Detener watchdog
        this.watchdog.stop();
        
        // Limpiar todos los health checks
        for (const [number, interval] of this.browserCheckInterval) {
            clearInterval(interval);
        }
        
        // Cerrar todos los clientes
        const cleanupPromises = Array.from(this.clients.entries()).map(
            async ([number, client]) => {
                try {
                    await this.cleanupClient(client);
                } catch (error) {
                    logger.error(`Error cleaning up ${number}:`, error);
                }
            }
        );
        
        await Promise.allSettled(cleanupPromises);
        logger.info('All clients cleaned up');
    }

    async cleanupClient(client) {
        try {
            if (client.pupBrowser?.process()) {
                client.pupBrowser.process().kill('SIGINT');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            await client.destroy();
        } catch (error) {
            logger.error('Error cleaning up client:', error);
        }
    }

    async addClient(number) {
        const sessionDir = `session-${number}`;
        const sessionPath = path.join(this.authPath, sessionDir);

        try {
            await fs.mkdir(sessionPath, { recursive: true });
            await this.createClient(number, sessionDir);
        } catch (error) {
            logger.error(`Failed to add client ${number}:`, error);
            throw error;
        }
    }

    getAuthenticatedAccountsInfo() {
        if (this.clients.size === 0) {
            logger.warn('No WhatsApp clients available');
            return [];
        }

        return Array.from(this.clients.entries())
            .filter(([number]) => this.isAuthenticated(number))
            .map(([number, client]) => ({
                number,
                display_name: client.info?.pushname || 'Not available',
                phone_number: client.info?.me?.user || 'Not available',
                serialized: client.info?.wid?._serialized,
                server: client.info?.server || 'c.us',
                status: client.getState(),
                last_seen: client.info?.lastSeen || null
            }));
    }

    async removeClient(number) {
        const client = this.clients.get(number);
        if (!client) {
            throw new Error('Client not found');
        }

        try {
            // Limpiar caché
            this.chatCache.clearCache(number);
            
            await client.logout();
            this.clients.delete(number);
            const sessionDir = path.join(this.authPath, `session-${number}`);
            await this.removeDirectory(sessionDir);
        } catch (error) {
            logger.error(`Failed to remove client ${number}:`, error);
            throw error;
        }
    }

    async removeDirectory(dirPath) {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            await Promise.all(entries.map(entry => {
                const fullPath = path.join(dirPath, entry.name);
                return entry.isDirectory() ? 
                    this.removeDirectory(fullPath) : 
                    fs.unlink(fullPath);
            }));
            await fs.rmdir(dirPath);
        } catch (error) {
            logger.error(`Failed to remove directory ${dirPath}:`, error);
            throw error;
        }
    }

    getClient(number) {
        return this.clients.get(number);
    }

    updateQrCache(number, qr) {
        this.qrCodes.set(number, qr);
        logger.info(`QR almacenado en caché para ${number}`);
    }

    getQr(number) {
        const qr = this.qrCodes.get(number);
        logger.info(`QR ${qr ? 'encontrado' : 'no encontrado'} en caché para ${number}`);
        return qr;
    }

    isReady(number) {
        const stateReady = this.clientReadyState.get(number) || false;
        const client = this.clients.get(number);
        
        if (!client) return false;
        
        // 🔹 FIX: Verificación completa de estado operacional
        const hasPage = Boolean(client.pupPage);
        const hasBrowser = Boolean(client.pupBrowser?.isConnected());
        const hasInfo = Boolean(client.info);
        
        const fullyReady = stateReady && hasPage && hasBrowser && hasInfo;
        
        if (!fullyReady && stateReady) {
            logger.warn(`[Estado] Cliente ${number} marcado como ready pero no operacional: page=${hasPage}, browser=${hasBrowser}, info=${hasInfo}`);
        }
        
        return fullyReady;
    }

    isAuthenticated(number) {
        const client = this.clients.get(number);
        return Boolean(client?.info?.pushname);
    }

    /**
     * Inicializar caché de chats (UNA SOLA VEZ por sesión)
     * @param {string} number - Número del cliente
     */
    async initializeChatCache(number) {
        const client = this.clients.get(number);
        if (!client) return;

        // Verificar si ya está cargado
        if (this.chatCache.isCacheReady(number)) {
            logger.info(`[Cache] ${number} ya estaba inicializado`);
            return;
        }

        try {
            logger.info(`[Cache] Cargando chats iniciales para ${number}...`);
            
            const chats = await Promise.race([
                client.getChats(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('getChats timeout')), 30000)
                )
            ]);

            if (!chats || !Array.isArray(chats)) {
                logger.warn(`[Cache] No se obtuvieron chats para ${number}`);
                return;
            }

            // Inicializar caché
            await this.chatCache.initializeCache(number, chats);
            
            logger.info(`[Cache] ✅ Inicialización completada para ${number}`);
        } catch (error) {
            logger.error(`[Cache] Error cargando chats para ${number}:`, error);
        }
    }

    /**
     * Actualizar caché cuando llega un mensaje (sin consultar WhatsApp)
     * 🆕 OPTIMIZADO PARA GRUPOS
     */
    async updateCacheOnMessage(number, message) {
        try {
            // Ignorar status
            if (message.from === 'status@broadcast') return;

            const chatId = message.from;
            const isFromMe = message.fromMe;

            // 🆕 Detectar si es grupo
            const isGroup = chatId.endsWith('@g.us');

            // Si el mensaje es ENTRANTE
            if (!isFromMe) {
                // Actualizar timestamp y datos básicos
                this.chatCache.updateChat(number, chatId, {
                    timestamp: message.timestamp,
                    lastMessage: message.body,
                    isGroup // 🆕 Asegurar que se marca como grupo
                });
                
                // Marcar como sin responder
                this.chatCache.markAsUnread(number, chatId);
            }
            // Si el mensaje es SALIENTE (respuesta nuestra)
            else {
                // Actualizar timestamp
                this.chatCache.updateChat(number, chatId, {
                    timestamp: message.timestamp,
                    lastMessage: message.body,
                    isGroup // 🆕 Asegurar que se marca como grupo
                });
                
                // Marcar como leído (respondido)
                this.chatCache.markAsRead(number, chatId);
            }
        } catch (error) {
            logger.error(`[Cache Update] Error para ${number}:`, error);
        }
    }
}

module.exports = new WhatsAppClient();