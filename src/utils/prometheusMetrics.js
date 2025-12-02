// utils/prometheusMetrics.js
const client = require('prom-client');
const logger = require('../conf/logger');

class PrometheusMetrics {
    constructor() {
        // Crear registro
        this.register = new client.Registry();
        
        // Métricas por defecto del sistema
        client.collectDefaultMetrics({ register: this.register });

        // Métricas personalizadas para WhatsApp
        this.clientsTotal = new client.Gauge({
            name: 'whatsapp_clients_total',
            help: 'Total number of WhatsApp clients',
            registers: [this.register]
        });

        this.clientsHealthy = new client.Gauge({
            name: 'whatsapp_clients_healthy',
            help: 'Number of healthy WhatsApp clients',
            registers: [this.register]
        });

        this.clientsByState = new client.Gauge({
            name: 'whatsapp_clients_by_state',
            help: 'Number of clients grouped by state',
            labelNames: ['state'],
            registers: [this.register]
        });

        this.reconnectionAttempts = new client.Counter({
            name: 'whatsapp_reconnection_attempts_total',
            help: 'Total reconnection attempts',
            labelNames: ['number', 'success'],
            registers: [this.register]
        });

        this.messagesSent = new client.Counter({
            name: 'whatsapp_messages_sent_total',
            help: 'Total messages sent',
            labelNames: ['number'],
            registers: [this.register]
        });

        this.messagesReceived = new client.Counter({
            name: 'whatsapp_messages_received_total',
            help: 'Total messages received',
            labelNames: ['number'],
            registers: [this.register]
        });

        this.browserCrashes = new client.Counter({
            name: 'whatsapp_browser_crashes_total',
            help: 'Total browser crashes',
            labelNames: ['number'],
            registers: [this.register]
        });

        this.qrGenerations = new client.Counter({
            name: 'whatsapp_qr_generations_total',
            help: 'Total QR code generations',
            labelNames: ['number'],
            registers: [this.register]
        });

        this.authFailures = new client.Counter({
            name: 'whatsapp_auth_failures_total',
            help: 'Total authentication failures',
            labelNames: ['number'],
            registers: [this.register]
        });

        this.clientStateAge = new client.Gauge({
            name: 'whatsapp_client_state_age_seconds',
            help: 'Time in seconds since last state change',
            labelNames: ['number', 'state'],
            registers: [this.register]
        });
    }

    updateMetrics(metricsData) {
        try {
            const { summary, healthChecks } = metricsData;

            if (summary) {
                this.clientsTotal.set(summary.totalClients);
                this.clientsHealthy.set(summary.healthyClients);

                // Actualizar distribución por estado
                Object.entries(summary.stateDistribution).forEach(([state, count]) => {
                    this.clientsByState.set({ state }, count);
                });
            }

            // Actualizar edad de estados
            if (healthChecks) {
                Object.entries(healthChecks).forEach(([number, check]) => {
                    if (check.state) {
                        const ageInSeconds = (Date.now() - new Date(check.timestamp).getTime()) / 1000;
                        this.clientStateAge.set(
                            { number, state: check.state },
                            ageInSeconds
                        );
                    }
                });
            }
        } catch (error) {
            logger.error('Error updating Prometheus metrics:', error);
        }
    }

    recordReconnection(number, success) {
        this.reconnectionAttempts.inc({ number, success: success.toString() });
    }

    recordMessageSent(number) {
        this.messagesSent.inc({ number });
    }

    recordMessageReceived(number) {
        this.messagesReceived.inc({ number });
    }

    recordBrowserCrash(number) {
        this.browserCrashes.inc({ number });
    }

    recordQrGeneration(number) {
        this.qrGenerations.inc({ number });
    }

    recordAuthFailure(number) {
        this.authFailures.inc({ number });
    }

    async getMetrics() {
        return await this.register.metrics();
    }

    getContentType() {
        return this.register.contentType;
    }
}

module.exports = new PrometheusMetrics();