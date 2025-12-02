// utils/watchdogMonitor.js
const logger = require('../conf/logger');
const stateManager = require('./clientStateManager');
const reconnectionManager = require('./reconnectionManager');

class WatchdogMonitor {
    constructor(whatsappClient) {
        this.whatsappClient = whatsappClient;
        this.monitorInterval = null;
        this.checkInterval = process.env.WATCHDOG_INTERVAL || 60000; // 60 segundos (más conservador)
        this.healthChecks = new Map();
        this.metrics = new Map();
        
        // Umbrales de salud (MÁS CONSERVADORES)
        this.thresholds = {
            maxStateAge: parseInt(process.env.MAX_STATE_AGE) || 900000, // 15 minutos
            maxQrAge: parseInt(process.env.MAX_QR_AGE) || 180000, // 3 minutos esperando QR
            maxInitializationTime: parseInt(process.env.MAX_INIT_TIME) || 300000, // 5 minutos
            zombieTimeout: parseInt(process.env.ZOMBIE_TIMEOUT) || 600000 // 10 minutos
        };
        
        logger.info('[Watchdog] Initialized with thresholds:', this.thresholds);
    }

    start() {
        if (this.monitorInterval) {
            logger.warn('[Watchdog] Already running');
            return;
        }

        logger.info('[Watchdog] Starting monitor');
        this.monitorInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.checkInterval);
    }

    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            logger.info('[Watchdog] Stopped');
        }
    }

    async performHealthCheck() {
        const clients = Array.from(this.whatsappClient.clients.keys());
        
        logger.debug(`[Watchdog] Performing health check on ${clients.length} clients`);

        for (const number of clients) {
            try {
                await this.checkClientHealth(number);
            } catch (error) {
                logger.error(`[Watchdog] Error checking ${number}:`, error);
            }
        }

        this.updateMetrics();
    }

    async checkClientHealth(number) {
        const client = this.whatsappClient.getClient(number);
        const state = stateManager.getState(number);
        
        if (!client) {
            logger.warn(`[Watchdog] Client ${number} not found, cleaning up`);
            stateManager.clearState(number);
            return;
        }

        const checks = {
            processAlive: await this.checkProcessAlive(client, number),
            browserResponsive: await this.checkBrowserResponsive(client, number),
            stateValid: this.checkStateValid(number, state),
            websocketActive: this.checkWebSocketActive(client, number)
        };

        const isHealthy = Object.values(checks).every(Boolean);
        
        this.healthChecks.set(number, {
            timestamp: new Date(),
            checks,
            isHealthy,
            state: state?.state
        });

        if (!isHealthy) {
            logger.warn(`[Watchdog] Unhealthy client detected: ${number}`, checks);
            await this.attemptRecovery(number, checks);
        }

        return checks;
    }

    async checkProcessAlive(client, number) {
        try {
            if (!client.pupBrowser) return false;
            
            const browser = client.pupBrowser;
            const isConnected = browser.isConnected();
            
            if (!isConnected) {
                // Verificar si el cliente aún tiene sesión antes de marcar como zombie
                if (client.info && this.whatsappClient.isAuthenticated(number)) {
                    logger.info(`[Watchdog] Browser disconnected but ${number} still authenticated`);
                    return true; // Permitir que continúe, puede ser solo ventana cerrada
                }
                
                logger.warn(`[Watchdog] Browser disconnected for ${number}`);
                stateManager.setState(number, stateManager.CLIENT_STATES.ZOMBIE, {
                    reason: 'Browser disconnected'
                });
                return false;
            }

            return true;
        } catch (error) {
            logger.error(`[Watchdog] Process check failed for ${number}:`, error);
            return false;
        }
    }

    async checkBrowserResponsive(client, number) {
        try {
            if (!client.pupPage) return false;

            // Timeout de 5 segundos para evaluar JavaScript
            const isResponsive = await Promise.race([
                client.pupPage.evaluate(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 5000))
            ]);

            if (!isResponsive) {
                logger.warn(`[Watchdog] Browser not responsive for ${number}`);
                stateManager.setState(number, stateManager.CLIENT_STATES.ZOMBIE, {
                    reason: 'Browser unresponsive'
                });
            }

            return isResponsive;
        } catch (error) {
            logger.error(`[Watchdog] Responsiveness check failed for ${number}:`, error);
            return false;
        }
    }

    checkStateValid(number, state) {
        if (!state) return false;

        const stateAge = stateManager.getStateAge(number);
        
        // Estados que DEBEN ser de corta duración
        if (state.state === stateManager.CLIENT_STATES.WAITING_QR && 
            stateAge > this.thresholds.maxQrAge) {
            logger.warn(`[Watchdog] Client ${number} stuck waiting for QR (${stateAge}ms)`);
            return false;
        }

        if (state.state === stateManager.CLIENT_STATES.INITIALIZING && 
            stateAge > this.thresholds.maxInitializationTime) {
            logger.warn(`[Watchdog] Client ${number} stuck initializing (${stateAge}ms)`);
            return false;
        }

        // Estados transitorios que no deberían durar mucho
        const transitoryStates = [
            stateManager.CLIENT_STATES.AUTHENTICATING,
            stateManager.CLIENT_STATES.RECONNECTING,
            stateManager.CLIENT_STATES.DISCONNECTED
        ];

        if (transitoryStates.includes(state.state) && stateAge > this.thresholds.maxStateAge) {
            logger.warn(`[Watchdog] Client ${number} stuck in transitory state ${state.state} (${stateAge}ms)`);
            return false;
        }

        return true;
    }

    checkWebSocketActive(client, number) {
        try {
            const state = stateManager.getState(number);
            
            // Si está inicializando, autenticando o esperando QR, dar tiempo
            if (state && [
                stateManager.CLIENT_STATES.INITIALIZING,
                stateManager.CLIENT_STATES.AUTHENTICATING,
                stateManager.CLIENT_STATES.WAITING_QR
            ].includes(state.state)) {
                return true; // No considerar como problema durante inicialización
            }

            // Verificar que el cliente tenga una sesión activa
            const hasInfo = Boolean(client.info);
            const isReady = this.whatsappClient.isReady(number);

            return hasInfo || isReady;
        } catch (error) {
            logger.error(`[Watchdog] WebSocket check failed for ${number}:`, error);
            return false;
        }
    }

    async attemptRecovery(number, failedChecks) {
        const state = stateManager.getState(number);
        
        logger.info(`[Watchdog] Attempting recovery for ${number}`, {
            currentState: state?.state,
            failedChecks
        });

        // Si el proceso murió o el browser no responde, reiniciar completamente
        if (!failedChecks.processAlive || !failedChecks.browserResponsive) {
            stateManager.setState(number, stateManager.CLIENT_STATES.RECONNECTING, {
                reason: 'Process/Browser failure',
                failedChecks
            });

            return await this.fullRestart(number);
        }

        // Si solo es un estado inválido, intentar refrescar
        if (!failedChecks.stateValid) {
            return await this.refreshClient(number);
        }

        // Si el WebSocket está inactivo pero el resto funciona
        if (!failedChecks.websocketActive) {
            return await this.reconnectWebSocket(number);
        }
    }

    async fullRestart(number) {
        logger.info(`[Watchdog] Full restart initiated for ${number}`);
        
        try {
            // Limpiar cliente actual
            const client = this.whatsappClient.getClient(number);
            if (client) {
                await this.whatsappClient.cleanupClient(client);
            }

            // Eliminar de la lista
            this.whatsappClient.clients.delete(number);
            
            // Programar reconexión con backoff
            reconnectionManager.scheduleReconnection(number, async () => {
                await this.whatsappClient.addClient(number);
            });

            return true;
        } catch (error) {
            logger.error(`[Watchdog] Full restart failed for ${number}:`, error);
            return false;
        }
    }

    async refreshClient(number) {
        logger.info(`[Watchdog] Refreshing client ${number}`);
        
        try {
            const client = this.whatsappClient.getClient(number);
            if (!client) return false;

            // Intentar reinicializar sin destruir
            await client.initialize();
            
            stateManager.setState(number, stateManager.CLIENT_STATES.INITIALIZING, {
                reason: 'Watchdog refresh'
            });

            return true;
        } catch (error) {
            logger.error(`[Watchdog] Refresh failed for ${number}:`, error);
            return await this.fullRestart(number);
        }
    }

    async reconnectWebSocket(number) {
        logger.info(`[Watchdog] Reconnecting WebSocket for ${number}`);
        
        try {
            const client = this.whatsappClient.getClient(number);
            if (!client || !client.pupPage) return false;

            // Recargar la página de WhatsApp Web
            await client.pupPage.reload({ waitUntil: 'networkidle0' });
            
            stateManager.setState(number, stateManager.CLIENT_STATES.RECONNECTING, {
                reason: 'WebSocket reconnection'
            });

            return true;
        } catch (error) {
            logger.error(`[Watchdog] WebSocket reconnect failed for ${number}:`, error);
            return await this.fullRestart(number);
        }
    }

    updateMetrics() {
        const totalClients = this.whatsappClient.clients.size;
        const healthyClients = Array.from(this.healthChecks.values())
            .filter(check => check.isHealthy).length;
        
        const stateDistribution = {};
        for (const [number, _] of this.whatsappClient.clients) {
            const state = stateManager.getState(number);
            const stateName = state?.state || 'UNKNOWN';
            stateDistribution[stateName] = (stateDistribution[stateName] || 0) + 1;
        }

        this.metrics.set('summary', {
            timestamp: new Date(),
            totalClients,
            healthyClients,
            unhealthyClients: totalClients - healthyClients,
            stateDistribution
        });

        logger.debug('[Watchdog] Metrics updated', this.metrics.get('summary'));
    }

    getMetrics() {
        return {
            summary: this.metrics.get('summary'),
            healthChecks: Object.fromEntries(this.healthChecks),
            reconnectionStatus: Array.from(this.whatsappClient.clients.keys()).map(number => ({
                number,
                ...reconnectionManager.getStatus(number)
            }))
        };
    }

    getHealthReport(number) {
        if (number) {
            return {
                health: this.healthChecks.get(number),
                state: stateManager.getState(number),
                reconnection: reconnectionManager.getStatus(number)
            };
        }

        return this.getMetrics();
    }
}

module.exports = WatchdogMonitor;